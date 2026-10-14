#!/usr/bin/env bash
# Tests ../templates/52hcw-unattended-upgrades.j2 (LAB-13, #959): rendered with
# the role's defaults, the override names the allowed origins itself (after
# clearing the list 50unattended-upgrades fills), does not reboot while a user
# is logged in, and still reboots at the role's hour. No root, no Docker; CI
# runs it in the `ansible-lint (lab-host)` job with the job's Python, which
# has Jinja2 and PyYAML from ansible-core.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
defaults="${role}/defaults/main.yml"
tasks="${role}/tasks/main.yml"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

python=''
for candidate in python3 python; do
  if command -v "${candidate}" > /dev/null && "${candidate}" -c 'import jinja2, yaml' 2> /dev/null; then
    python="$(command -v "${candidate}")"
    break
  fi
done
[ -n "${python}" ] || { echo "no Python with jinja2 and yaml on PATH; install ansible-core" >&2; exit 1; }

work="$(mktemp -d)"
finish() { rm -rf "${work}"; }
trap finish EXIT

rendered="${work}/52hcw-unattended-upgrades"
"${python}" - "${role}/templates/52hcw-unattended-upgrades.j2" "${defaults}" > "${rendered}" <<'PY'
import sys, jinja2, yaml
template, defaults = sys.argv[1], sys.argv[2]
values = yaml.safe_load(open(defaults, encoding="utf-8"))
values["ansible_managed"] = "Ansible managed"
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
sys.stdout.write(env.from_string(open(template, encoding="utf-8").read()).render(**values))
PY

reboot_time="$(sed -n 's/^hardening_unattended_reboot_time: "\(.*\)"$/\1/p' "${defaults}")"
origins="${work}/origins"
"${python}" - "${defaults}" > "${origins}" <<'PY'
import sys, yaml
values = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
for origin in values["hardening_unattended_allowed_origins"]:
    print(origin)
PY

check "the render holds no template syntax" "! grep -qE '\{\{|\{%' '${rendered}'"
check "the allowed-origins list is cleared before it is filled, so the override is the whole list" \
  "grep -qxF '#clear Unattended-Upgrade::Allowed-Origins;' '${rendered}'"
check "the defaults name at least the four Ubuntu origins" "[ \"\$(wc -l < '${origins}')\" -ge 4 ]"
while IFS= read -r origin; do
  check "the render allows ${origin}" "grep -qxF '  \"${origin}\";' '${rendered}'"
done < "${origins}"
check "the Ubuntu security origin is among them" "grep -qxF '\${distro_id}:\${distro_codename}-security' '${origins}'"
check "no origin outside the defaults is rendered" \
  "[ \"\$(grep -cE '^  \".*\";$' '${rendered}')\" -eq \"\$(wc -l < '${origins}')\" ]"
check "it reboots automatically" "grep -qxF 'Unattended-Upgrade::Automatic-Reboot \"true\";' '${rendered}'"
check "it does not reboot while a user is logged in" \
  "grep -qxF 'Unattended-Upgrade::Automatic-Reboot-WithUsers \"false\";' '${rendered}'"
check "it reboots at the role's hour" \
  "grep -qxF 'Unattended-Upgrade::Automatic-Reboot-Time \"${reboot_time}\";' '${rendered}'"
check "the role installs the override" \
  "grep -qF 'src: 52hcw-unattended-upgrades.j2' '${tasks}' && grep -qF 'dest: /etc/apt/apt.conf.d/52hcw-unattended-upgrades' '${tasks}'"

echo "# ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
