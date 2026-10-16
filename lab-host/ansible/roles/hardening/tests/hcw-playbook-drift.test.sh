#!/usr/bin/env bash
# Tests ../templates/hcw-playbook-drift.sh.j2, the nightly playbook drift detection
# this role renders to /usr/local/sbin/hcw-playbook-drift (LAB-4, #950), by
# rendering it and its service and timer with the role's own defaults and
# running the script against stub `ansible-playbook` and `logger` on PATH.
# The stubs record each invocation and the logger stub records each line it is
# asked to send, with its tag and priority.
#
# No root and no Docker needed. CI runs it in the `ansible-lint (lab-host)`
# job with the job's Python, which has Jinja2 and PyYAML from ansible-core.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
defaults="${role}/defaults/main.yml"
tasks="${role}/tasks/main.yml"
handlers="${role}/handlers/main.yml"
repo="$(cd "${here}/../../../../.." && pwd)"
dcr="${repo}/infra/lab-hybrid.tf"

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME COMMAND [DETAIL]: run COMMAND through eval and report it as ok or not ok.
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
# finish: remove the scratch directory, on every way out.
finish() { rm -rf "${work}"; }
trap finish EXIT

# render TEMPLATE OUT: as the template module does (trim_blocks), from
# defaults/main.yml plus ansible_managed, with the path filter the template
# uses (Ansible's dirname is os.path's). An undefined name fails the render.
render() {
  "${python}" - "${role}/templates/$1" "${defaults}" > "$2" <<'PY'
import posixpath, sys, jinja2, yaml
template, defaults = sys.argv[1], sys.argv[2]
values = yaml.safe_load(open(defaults, encoding="utf-8"))
values["ansible_managed"] = "Ansible managed"
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
env.filters["dirname"] = posixpath.dirname
sys.stdout.write(env.from_string(open(template, encoding="utf-8").read()).render(**values))
PY
}

script="${work}/hcw-playbook-drift"
render hcw-playbook-drift.sh.j2 "${script}"
render hcw-playbook-drift.service.j2 "${work}/service"
render hcw-playbook-drift.timer.j2 "${work}/timer"
chmod +x "${script}"
tag="$(sed -n 's/^hardening_drift_tag: //p' "${defaults}")"
path="$(sed -n 's/^hardening_drift_script_path: //p' "${defaults}")"
calendar="$(sed -n 's/^hardening_drift_on_calendar: "\(.*\)"$/\1/p' "${defaults}")"

# --- What the units and the role say agree with each other and with the DCR.
check "the rendered script parses as bash and holds no template syntax" \
  "bash -n '${script}' && ! grep -qE '\\{\\{|\\{%|raw %' '${script}'"
check "the script logs under the role's tag" "grep -qxF \"tag='${tag}'\" '${script}'"
check "the service runs the installed script" "grep -qxF 'ExecStart=${path}' '${work}/service'"
check "the service reports its own failure through the failure notifier" \
  "grep -qxF 'OnFailure=hcw-unit-failed@%n.service' '${work}/service'"
check "the service has a 15-minute start timeout" "grep -qxF 'TimeoutStartSec=900' '${work}/service'"
check "the timer is persistent and runs nightly at the role's calendar" \
  "grep -qxF 'Unit=hcw-playbook-drift.service' '${work}/timer' && grep -qxF 'Persistent=true' '${work}/timer' && grep -qxF 'OnCalendar=${calendar}' '${work}/timer'"
check "the role installs the script (0755), both units (0644), and enables the timer" \
  "grep -qF 'src: hcw-playbook-drift.sh.j2' '${tasks}' && grep -qF 'mode: \"0755\"' '${tasks}' && grep -qF 'src: \"hcw-playbook-drift.{{ item }}.j2\"' '${tasks}' && grep -qF 'dest: \"/etc/systemd/system/hcw-playbook-drift.{{ item }}\"' '${tasks}' && grep -qF 'name: hcw-playbook-drift.timer' '${tasks}'"
check "the role has a systemd reload handler for playbook drift detection" \
  "grep -qF 'Reload systemd for playbook drift detection' '${handlers}' && grep -qF 'Reload systemd for playbook drift detection' '${tasks}'"

if [ -f "${dcr}" ]; then
  check "the Arc data collection rule ships daemon at Warning, where drift and failure lines go" \
    "grep -qF 'facility_names = [\"daemon\", \"syslog\", \"kern\", \"cron\", \"user\"]' '${dcr}' && grep -qF 'log_levels     = [\"Warning\", \"Error\", \"Critical\", \"Alert\", \"Emergency\"]' '${dcr}'"
else
  echo "skip - infra/lab-hybrid.tf is not in this checkout, so the data collection rule is not compared"
fi

# --- Stubs and test environment setup.
stubs="${work}/bin"
mkdir -p "${stubs}"
fake_src="${work}/fake-src"
mkdir -p "${fake_src}/lab-host/ansible"
fake_applied="${work}/applied-commit.json"
echo '{"commit":"feedbeef1234567890abcdef1234567890abcdef"}' > "${fake_applied}"

# Point the rendered script to our test directories
sed -i "s#^src_dir=.*#src_dir='${fake_src}'#" "${script}"
sed -i "s#^applied_file=.*#applied_file='${fake_applied}'#" "${script}"

cat > "${stubs}/logger" <<EOF
#!/usr/bin/env bash
# logger -t TAG -p PRIORITY -- MESSAGE
printf '%s|%s|%s\n' "\$2" "\$4" "\$6" >> '${work}/log'
EOF

cat > "${stubs}/ansible-playbook" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >> '${work}/ansible-args'
cat '${work}/ansible-output'
exit \$(cat '${work}/ansible-rc')
EOF
chmod +x "${stubs}"/*

run() {
  : > "${work}/log"
  : > "${work}/ansible-args"
  PATH="${stubs}:${PATH}" "${script}"
}

# --- Case 1: Clean run (ok=45, changed=0, failed=0, unreachable=0).
cat > "${work}/ansible-output" <<EOF
PLAY [localhost] ***************************************************************
TASK [Gathering Facts] *********************************************************
ok: [localhost]
PLAY RECAP *********************************************************************
localhost                  : ok=45   changed=0    unreachable=0    failed=0    skipped=12   rescued=0    ignored=0
EOF
echo 0 > "${work}/ansible-rc"

check "a clean playbook run exits 0" "run"
check "a clean run logs notice to syslog saying no drift detected with commit" \
  "grep -qxF '${tag}|daemon.notice|playbook check: no drift detected on commit feedbeef1234567890abcdef1234567890abcdef' '${work}/log'" \
  "$(cat "${work}/log" 2>/dev/null || true)"
check "ansible-playbook was invoked with --check and --diff against localhost site.yml" \
  "grep -qF -- '--check' '${work}/ansible-args' && grep -qF -- '--diff' '${work}/ansible-args' && grep -qF 'site.yml' '${work}/ansible-args'"

# --- Case 2: Drift detected (changed=2).
cat > "${work}/ansible-output" <<EOF
PLAY [localhost] ***************************************************************
TASK [sshd : Configure sshd] ***************************************************
--- before: /etc/ssh/sshd_config
+++ after: /etc/ssh/sshd_config
changed: [localhost]
TASK [ufw : Configure ufw rules] ***********************************************
changed: [localhost]
PLAY RECAP *********************************************************************
localhost                  : ok=43   changed=2    unreachable=0    failed=0    skipped=12   rescued=0    ignored=0
EOF
echo 0 > "${work}/ansible-rc"

drift_status=0
run >/dev/null 2>&1 || drift_status=$?
check "drift detected exits non-zero (rc=2)" "[ '${drift_status}' -eq 2 ]"
check "drift detected logs warning to syslog with change count and commit" \
  "grep -qxF '${tag}|daemon.warning|playbook drift detected on commit feedbeef1234567890abcdef1234567890abcdef: 2 change(s) would be applied' '${work}/log'" \
  "$(cat "${work}/log" 2>/dev/null || true)"

# --- Case 3: Playbook task failure (failed=1, play_rc=2).
cat > "${work}/ansible-output" <<EOF
PLAY [localhost] ***************************************************************
TASK [docker : Check service] **************************************************
fatal: [localhost]: FAILED! => {"changed": false, "msg": "Docker daemon failed"}
PLAY RECAP *********************************************************************
localhost                  : ok=10   changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
EOF
echo 2 > "${work}/ansible-rc"

fail_status=0
run >/dev/null 2>&1 || fail_status=$?
check "playbook execution failure exits non-zero (rc=1)" "[ '${fail_status}' -eq 1 ]"
check "playbook execution failure logs warning to syslog with rc and failed count" \
  "grep -qxF '${tag}|daemon.warning|playbook check failed (rc=2, failed=1, unreachable=0) on commit feedbeef1234567890abcdef1234567890abcdef' '${work}/log'" \
  "$(cat "${work}/log" 2>/dev/null || true)"

# --- Case 4: Vault files passed when present.
fake_vault="${work}/fake-vault.yml"
fake_pass="${work}/fake-vault.pass"
touch "${fake_vault}" "${fake_pass}"
sed -i "s#^vault_file=.*#vault_file='${fake_vault}'#" "${script}"
sed -i "s#^vault_pass_file=.*#vault_pass_file='${fake_pass}'#" "${script}"

cat > "${work}/ansible-output" <<EOF
localhost                  : ok=45   changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
EOF
echo 0 > "${work}/ansible-rc"
run >/dev/null 2>&1
check "vault arguments are passed to ansible-playbook when vault files exist" \
  "grep -qxF -- '--vault-password-file' '${work}/ansible-args' && grep -qxF -- '${fake_pass}' '${work}/ansible-args' && grep -qxF -- '-e' '${work}/ansible-args' && grep -qxF -- \"@${fake_vault}\" '${work}/ansible-args'"

# --- Case 5: Missing ansible directory exits 1 with warning.
sed -i "s#^src_dir=.*#src_dir='${work}/nonexistent'#" "${script}"
missing_status=0
run >/dev/null 2>&1 || missing_status=$?
check "missing ansible directory exits 1 and logs warning" \
  "[ '${missing_status}' -eq 1 ] && grep -q 'daemon.warning|playbook drift check failed:' '${work}/log'"

if [ "${failed}" -ne 0 ]; then
  echo "hcw-playbook-drift.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "hcw-playbook-drift.test.sh: all ${passed} checks passed"
