#!/usr/bin/env bash
# Bootloader for cloud-assessment (HCW-CloudAssessor_AddOn / ca-guided-lab)
# Downloads and extracts the user's one-time cloud assessment bundle via python3 zipfile
# (no unzip binary required) and writes the guided walkthrough README/START-HERE.
set -euo pipefail

LAB_ROOT="${1:-/tmp/home/lab}"
TARGET="${HCW_ASSESSMENT_DIR:-$LAB_ROOT/cloud-assessment}"
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
# Guided cloud assessment lab

1. Read `NOT-FOR-PRODUCTION.md` and `README.md`.
2. Open `report.md`: review Pillar scores, maturity posture, and prioritized WAF recommendations.
3. Inspect `assessment.json` and `findings.csv`: filter findings by WAF pillar, severity, or resource type.
4. Use `jq` or `python3` in the terminal to group findings and plan remediation (no cloud credentials or Azure access exist in this workspace).
MD

if [ ! -f "$TARGET/README.md" ]; then
  cp "$TARGET/START-HERE.md" "$TARGET/README.md"
fi
