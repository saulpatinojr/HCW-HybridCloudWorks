#!/usr/bin/env bash
# Bootloader for migration-assessment (HCW-MigrateOrchestrator_AddOn / amo-guided-lab)
# Downloads and extracts the user's one-time assessment bundle via python3 zipfile
# (no unzip binary required) and writes the guided walkthrough README/START-HERE.
set -euo pipefail

LAB_ROOT="${1:-/tmp/home/lab}"
TARGET="${HCW_ASSESSMENT_DIR:-$LAB_ROOT/migration-assessment}"
mkdir -p "$TARGET"

if [ "${HCW_BOOT_OFFLINE:-0}" != "1" ] && [ -n "${HCW_BUNDLE_TOKEN:-}" ] && [ -n "${HCW_ASSESSMENT_ID:-}" ] && [ -n "${HCW_API_BASE_URL:-}" ]; then
  curl --proto '=https' --tlsv1.2 -fsSL \
    -H "x-bundle-token: ${HCW_BUNDLE_TOKEN}" \
    "${HCW_API_BASE_URL%/}/api/assessments/${HCW_ASSESSMENT_ID}/bundle.zip" \
    -o "$TARGET/bundle.zip"
  python3 -m zipfile -e "$TARGET/bundle.zip" "$TARGET"
  rm -f "$TARGET/bundle.zip"
fi

cat > "$TARGET/START-HERE.md" <<'MD'
# Guided migration inspection lab

1. Read `DEMO-NOT-FOR-PRODUCTION.md`.
2. Review `reports/executive-summary.md` and `reports/engineering-assessment.md`.
3. In `terraform/`: run `terraform init -backend=false && terraform validate` (no cloud access here).
4. In `scripts/`: read the dry-run scaffolding; nothing here can reach Azure (no credentials in this workspace).
5. In `terraform/state-impact/`: inspect how an ARM move would affect Terraform state.
6. In `runbooks/` and `validation/`: adapt the checklists to your own environment.
MD

if [ ! -f "$TARGET/README.md" ]; then
  cp "$TARGET/START-HERE.md" "$TARGET/README.md"
fi
