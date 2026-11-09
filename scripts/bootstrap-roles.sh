#!/usr/bin/env bash
#
# bootstrap-roles.sh — creates or updates the custom Azure RBAC role
# definitions that Terraform reads by name and may not create itself.
#
# Usage:
#   ./scripts/bootstrap-roles.sh [<subscription-id>] [<management-subscription-id>]
#
# The role JSON files under infra/roles/ carry placeholder subscription ids
# (00000000-0000-0000-0000-00000000000N) in their AssignableScopes, because
# this repository is public and a real subscription id never goes in a
# tracked file (#1540). This script fills the real ids in at create time and
# the files never change:
#   - the workload subscription comes from the first argument, or from
#     `az account show` (the subscription az is signed in to);
#   - the management subscription comes from the second argument, or from
#     `az account list`, by its name sub-plat-mgmt-prod-cus (exactly one
#     subscription of that name must be visible).
# Nothing is read from a file in the repository.
#
# Success looks like one "Created" or "Updated" line per role, each followed
# by a read-back of the role from Azure at its first assignable scope showing
# the real scopes, and a final table of all of them; the script fails if a
# read-back does not match what it sent. That table is the evidence for a
# ticket's "roles unchanged afterwards" line.
set -euo pipefail

MGMT_SUBSCRIPTION_NAME="sub-plat-mgmt-prod-cus"
GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
PLACEHOLDER_RE='^00000000-0000-0000-0000-0000000000[0-9a-fA-F]{2}$'

SUBSCRIPTION_ID="${1:-}"
MGMT_SUBSCRIPTION_ID="${2:-}"

if [[ -z "$SUBSCRIPTION_ID" ]]; then
  echo "Resolving the workload subscription id from 'az account show'..."
  SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
  if [[ -z "$SUBSCRIPTION_ID" ]]; then
    echo "Error: no active Azure subscription. Run 'az login' or pass the subscription id as the first argument." >&2
    exit 1
  fi
fi

if [[ -z "$MGMT_SUBSCRIPTION_ID" ]]; then
  echo "Resolving the management subscription id from 'az account list' by its name ($MGMT_SUBSCRIPTION_NAME)..."
  mgmt_matches="$(az account list --query "[?name=='$MGMT_SUBSCRIPTION_NAME'].id" -o tsv 2>/dev/null || true)"
  mgmt_count="$(printf '%s' "$mgmt_matches" | grep -c . || true)"
  if [[ "$mgmt_count" -ne 1 ]]; then
    echo "Error: the signed-in account sees $mgmt_count subscription(s) named $MGMT_SUBSCRIPTION_NAME; expected exactly one. Run 'az login' with an account that sees it, or pass its id as the second argument." >&2
    exit 1
  fi
  MGMT_SUBSCRIPTION_ID="$mgmt_matches"
fi

SUBSCRIPTION_ID="$(echo "$SUBSCRIPTION_ID" | tr -d '[:space:]')"
MGMT_SUBSCRIPTION_ID="$(echo "$MGMT_SUBSCRIPTION_ID" | tr -d '[:space:]')"

for pair in "workload:$SUBSCRIPTION_ID" "management:$MGMT_SUBSCRIPTION_ID"; do
  label="${pair%%:*}"
  value="${pair#*:}"
  if ! [[ "$value" =~ $GUID_RE ]]; then
    echo "Error: the $label subscription id is not a GUID." >&2
    exit 1
  fi
  if [[ "$value" =~ $PLACEHOLDER_RE ]]; then
    echo "Error: the $label subscription id is the repository placeholder, not a real subscription. Pass the real id or sign in to the right account." >&2
    exit 1
  fi
done

echo "Bootstrapping custom role definitions for workload subscription $SUBSCRIPTION_ID (management: $MGMT_SUBSCRIPTION_ID)"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLES_DIR="$REPO_ROOT/infra/roles"

# <file>:<comma-separated AssignableScopes>. Every file under infra/roles is
# listed here; scripts/terraform-role-definitions.test.mjs fails CI if one is
# not. The scopes here replace the placeholders in the file.
roles=(
  "keyvault-secret-writer.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-sec-site-prod-cus"
  "function-config-refresh.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "function-settings-reader.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "static-web-app-deployer.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "alert-rule-reader.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus,/subscriptions/$MGMT_SUBSCRIPTION_ID/resourceGroups/rg-mgmt-plat-prod-cus"
  "storage-firewall-writer.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "arc-run-command-operator.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-lab-hybrid-prod-cus"
)

read_back=()

for entry in "${roles[@]}"; do
  file_name="${entry%%:*}"
  scopes_csv="${entry#*:}"
  first_scope="${scopes_csv%%,*}"
  role_file="$ROLES_DIR/$file_name"

  if [[ ! -f "$role_file" ]]; then
    echo "Error: role definition template not found: $role_file" >&2
    exit 1
  fi

  role_name="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).Name)" "$role_file")"

  echo ""
  echo "Processing role '$role_name'..."
  echo "  AssignableScopes: $scopes_csv"

  temp_file="$(mktemp)"
  node -e "
    const fs = require('fs');
    const [src, dest, scopes] = process.argv.slice(1);
    const role = JSON.parse(fs.readFileSync(src, 'utf8'));
    role.AssignableScopes = scopes.split(',');
    fs.writeFileSync(dest, JSON.stringify(role, null, 2));
  " "$role_file" "$temp_file" "$scopes_csv"

  # Looked up at the role's own first scope: a custom role assignable only at
  # a resource group is not reliably returned by a listing at the subscription.
  existing_id="$(az role definition list --name "$role_name" --scope "$first_scope" --query "[0].id" -o tsv 2>/dev/null || true)"

  if [[ -n "$existing_id" ]]; then
    echo "  Updating existing role definition..."
    az role definition update --role-definition "@$temp_file" --output none
    echo "  ✓ Updated successfully."
  else
    echo "  Creating new role definition..."
    az role definition create --role-definition "@$temp_file" --output none
    echo "  ✓ Created successfully."
  fi

  rm -f "$temp_file"

  # Read the role back from Azure at its first scope and check that the
  # scopes Azure holds are exactly the ones sent. `set -e` stops the script
  # if az fails here, so a role that cannot be read back is never reported.
  actual_scopes="$(az role definition list --name "$role_name" --scope "$first_scope" --query "[0].assignableScopes" -o json)"
  node -e "
    const [actualJson, expectedCsv, roleName] = process.argv.slice(1);
    const norm = (list) => list.map((s) => s.toLowerCase()).sort();
    const actual = norm(JSON.parse(actualJson) || []);
    const expected = norm(expectedCsv.split(','));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.error('Error: read-back of ' + roleName + ' differs from what was sent.');
      console.error('  sent:  ' + expected.join(', '));
      console.error('  Azure: ' + actual.join(', '));
      process.exit(1);
    }
  " "$actual_scopes" "$scopes_csv" "$role_name"
  echo "  Read back from Azure: $role_name -> $scopes_csv"
  read_back+=("$role_name | $scopes_csv")
done

echo ""
echo "Read-back of every role, as Azure holds it (this table is the evidence):"
printf '  %s\n' "${read_back[@]}"

echo ""
echo "All ${#read_back[@]} custom role definitions bootstrapped and read back."
