#!/usr/bin/env bash
#
# bootstrap-roles.sh — Bootstraps custom Azure RBAC role definitions required by Terraform.
#
# Usage:
#   ./scripts/bootstrap-roles.sh [<subscription-id>] [<management-subscription-id>]
#
set -euo pipefail

SUBSCRIPTION_ID="${1:-}"
MGMT_SUBSCRIPTION_ID="${2:-02dfb8ad-ec22-42e3-8cdc-17fd6e00b17e}"

if [[ -z "$SUBSCRIPTION_ID" ]]; then
  echo "Resolving current Azure subscription ID via az account show..."
  SUBSCRIPTION_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
  if [[ -z "$SUBSCRIPTION_ID" ]]; then
    echo "Error: No active Azure subscription found. Run 'az login' or pass subscription id." >&2
    exit 1
  fi
fi

SUBSCRIPTION_ID="$(echo "$SUBSCRIPTION_ID" | tr -d '[:space:]')"
MGMT_SUBSCRIPTION_ID="$(echo "$MGMT_SUBSCRIPTION_ID" | tr -d '[:space:]')"
echo "Bootstrapping custom role definitions for subscription: $SUBSCRIPTION_ID"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLES_DIR="$REPO_ROOT/infra/roles"

roles=(
  "keyvault-secret-writer.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-sec-site-prod-cus"
  "function-config-refresh.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "function-settings-reader.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "static-web-app-deployer.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus"
  "alert-rule-reader.json:/subscriptions/$SUBSCRIPTION_ID/resourceGroups/rg-web-site-prod-cus,/subscriptions/$MGMT_SUBSCRIPTION_ID/resourceGroups/rg-mgmt-plat-prod-cus"
)

for entry in "${roles[@]}"; do
  file_name="${entry%%:*}"
  scopes_csv="${entry##*:}"
  role_file="$ROLES_DIR/$file_name"

  if [[ ! -f "$role_file" ]]; then
    echo "Error: Role definition template not found: $role_file" >&2
    exit 1
  fi

  role_name="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$role_file', 'utf8')).Name)")"

  echo ""
  echo "Processing role '$role_name'..."
  echo "  AssignableScopes: $scopes_csv"

  temp_file="$(mktemp)"
  node -e "
    const fs = require('fs');
    const role = JSON.parse(fs.readFileSync('$role_file', 'utf8'));
    role.AssignableScopes = '$scopes_csv'.split(',');
    fs.writeFileSync('$temp_file', JSON.stringify(role, null, 2));
  "

  existing_id="$(az role definition list --name "$role_name" --query "[0].id" -o tsv 2>/dev/null || true)"

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
echo "All custom role definitions bootstrapped and verified successfully."
