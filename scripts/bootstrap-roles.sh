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
#     `az account list`, by its name sub-plat-mgmt-prod-cus.
# Nothing is read from a file in the repository.
#
# Success looks like one "Created" or "Updated" line per role and a final
# read-back listing every HCW role with the real scopes; that listing is the
# evidence for a ticket's "roles unchanged afterwards" line.
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
  MGMT_SUBSCRIPTION_ID="$(az account list --query "[?name=='$MGMT_SUBSCRIPTION_NAME'].id | [0]" -o tsv 2>/dev/null || true)"
  if [[ -z "$MGMT_SUBSCRIPTION_ID" ]]; then
    echo "Error: the signed-in account does not see a subscription named $MGMT_SUBSCRIPTION_NAME. Run 'az login' with an account that does, or pass its id as the second argument." >&2
    exit 1
  fi
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
)

role_names=()

for entry in "${roles[@]}"; do
  file_name="${entry%%:*}"
  scopes_csv="${entry#*:}"
  role_file="$ROLES_DIR/$file_name"

  if [[ ! -f "$role_file" ]]; then
    echo "Error: role definition template not found: $role_file" >&2
    exit 1
  fi

  role_name="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).Name)" "$role_file")"
  role_names+=("$role_name")

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

  existing_id="$(az role definition list --name "$role_name" --scope "/subscriptions/$SUBSCRIPTION_ID" --query "[0].id" -o tsv 2>/dev/null || true)"

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
done

echo ""
echo "Read-back of every HCW custom role at /subscriptions/$SUBSCRIPTION_ID (this listing is the evidence):"
az role definition list --custom-role-only true --scope "/subscriptions/$SUBSCRIPTION_ID" \
  --query "[?starts_with(roleName, 'HCW ')].{role: roleName, scopes: join(', ', assignableScopes)}" -o table

echo ""
echo "All ${#role_names[@]} custom role definitions bootstrapped."
