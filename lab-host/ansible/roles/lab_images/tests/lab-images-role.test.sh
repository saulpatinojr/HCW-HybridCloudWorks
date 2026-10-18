#!/usr/bin/env bash
# Tests the lab_images role configuration and lifecycle hardening (Issue #1134).
#
# Asserts that:
# 1. Defaults and argument specifications declare lab_images_defer_workspace_cleanup.
# 2. tasks/main.yml checks the publication-skipped runtime marker and sets
#    lab_images_effective_defer_cleanup.
# 3. tasks/main.yml passes --defer-workspace-cleanup when cleanup is deferred.
# 4. tasks/main.yml guards the sandbox image removal task when cleanup is deferred.
# 5. tasks/main.yml logs deferred images when cleanup is deferred.
# 6. roles/coder/tasks/main.yml sets coder_template_publication_skipped and manages
#    the runtime marker.
# 7. lab-images.mjs executes with --defer-workspace-cleanup and defers workspace removals.
# 8. The sandbox plan pulls the image every template under lab-host/coder/templates
#    pins, not hcw-lab's alone (#1268).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
defaults="${role}/defaults/main.yml"
tasks="${role}/tasks/main.yml"
specs="${role}/meta/argument_specs.yml"
helper="${role}/files/lab-images.mjs"
repo="$(cd "${here}/../../../../.." && pwd)"
coder_tasks="${role}/../coder/tasks/main.yml"

passed=0
failed=0

ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

# 1. Defaults declare lab_images_defer_workspace_cleanup
check "defaults/main.yml declares lab_images_defer_workspace_cleanup: false" \
  "grep -qE '^lab_images_defer_workspace_cleanup:[[:space:]]*false' '${defaults}'"

# 2. Argument specs declare the option
check "meta/argument_specs.yml documents lab_images_defer_workspace_cleanup" \
  "grep -q 'lab_images_defer_workspace_cleanup:' '${specs}' && grep -qE 'default:[[:space:]]*false' '${specs}'"

# 3. Tasks check runtime marker
check "tasks/main.yml checks /run/hcw-coder-template-publication-skipped" \
  "grep -qF '/run/hcw-coder-template-publication-skipped' '${tasks}'"

# 4. Tasks determine effective deferral fact
check "tasks/main.yml determines lab_images_effective_defer_cleanup" \
  "grep -qF 'lab_images_effective_defer_cleanup:' '${tasks}'"

# 5. Tasks pass --defer-workspace-cleanup to helper
check "tasks/main.yml passes --defer-workspace-cleanup when cleanup is deferred" \
  "grep -qF \"'--defer-workspace-cleanup'\" '${tasks}'"

# 6. Tasks guard removal when deferred
check "tasks/main.yml guards workspace image removal when deferred" \
  "grep -qF 'not (lab_images_effective_defer_cleanup | bool)' '${tasks}'"

# 7. Tasks log deferred images
check "tasks/main.yml announces deferred workspace images" \
  "grep -qF 'lab_images_sandbox_plan.deferred' '${tasks}'"

# 8. Coder role sets coder_template_publication_skipped and manages marker
check "coder role tasks record coder_template_publication_skipped and manage marker" \
  "grep -qF 'coder_template_publication_skipped:' '${coder_tasks}' && grep -qF '/run/hcw-coder-template-publication-skipped' '${coder_tasks}'"

# 9. Helper execution with --defer-workspace-cleanup
work="$(mktemp -d)"
finish() { rm -rf "${work}"; }
trap finish EXIT

cat > "${work}/docker.json" <<'EOF'
{
  "images": [
    {
      "Id": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
      "RepoTags": [],
      "RepoDigests": ["hybridcloudworks/hcw-lab@sha256:8888888888888888888888888888888888888888888888888888888888888888"]
    }
  ],
  "containers": []
}
EOF

if command -v node >/dev/null 2>&1; then
  plan="$(node "${helper}" --scope workspaces --defer-workspace-cleanup "${repo}" < "${work}/docker.json")"
  check "lab-images.mjs with --defer-workspace-cleanup defers workspace removal" \
    "node -e 'const p = JSON.parse(process.argv[1]); if (p.remove.length !== 0 || !p.deferred.some(d => d.includes(\"hybridcloudworks/hcw-lab@sha256:8888\"))) process.exit(1);' \"\${plan}\""

  # 10. Every template's pinned image is in the sandbox plan (#1268). The pin
  # is read here with grep, not the helper, so the two cannot share a blind
  # spot; the guided labs name the local default_image, hcw-lab names it image.
  templates=0
  for template in "${repo}"/lab-host/coder/templates/*/main.tf; do
    templates=$((templates + 1))
    digest="$(grep -E '^[[:space:]]*image_digest[[:space:]]*=[[:space:]]*"sha256:[0-9a-f]{64}"' "${template}" | sed -E 's/.*"(sha256:[0-9a-f]{64})".*/\1/')"
    repository="$(grep -E '^[[:space:]]*(default_)?image[[:space:]]*=[[:space:]]*"[^"@$]+@\$\{local\.image_digest\}"' "${template}" | sed -E 's/.*"([^"@$]+)@.*/\1/; s#^docker\.io/##')"
    check "lab-images.mjs plans ${template#"${repo}/"}'s image ${repository}@${digest:0:19} onto the sandbox daemon" \
      "[ -n '${digest}' ] && [ -n '${repository}' ] && node -e 'const p = JSON.parse(process.argv[1]); if (!p.pull.includes(process.argv[2])) process.exit(1);' \"\${plan}\" '${repository}@${digest}'"
  done
  check "lab-host/coder/templates holds more than the hcw-lab template" "[ ${templates} -ge 2 ]"
else
  echo "skip - node not on PATH; skipping CLI execution test"
fi

if [ "${failed}" -ne 0 ]; then
  echo "lab-images-role.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "lab-images-role.test.sh: all ${passed} checks passed"
