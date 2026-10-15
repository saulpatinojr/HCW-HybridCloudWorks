#!/usr/bin/env bash
# Tests ../templates/hcw-held-upgradable.sh.j2, the daily held-package report
# this role renders to /usr/local/sbin/hcw-held-upgradable (LAB-3, #949), by
# rendering it and its service and timer with the role's own defaults and
# running the script against stub `apt-mark`, `apt` and `logger` on PATH.
# The stubs answer from files in a scratch directory and the logger stub
# records each line it is asked to send, with its tag and priority.
#
# No root and no Docker needed. CI runs it in the `ansible-lint (lab-host)`
# job with the job's Python, which has Jinja2 and PyYAML from ansible-core;
# lab-host/README.md ("Validating without a host") has the container line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
defaults="${role}/defaults/main.yml"
tasks="${role}/tasks/main.yml"
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
# defaults/main.yml plus ansible_managed. An undefined name fails the render.
render() {
  "${python}" - "${role}/templates/$1" "${defaults}" > "$2" <<'PY'
import sys, jinja2, yaml
template, defaults = sys.argv[1], sys.argv[2]
values = yaml.safe_load(open(defaults, encoding="utf-8"))
values["ansible_managed"] = "Ansible managed"
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
sys.stdout.write(env.from_string(open(template, encoding="utf-8").read()).render(**values))
PY
}
script="${work}/hcw-held-upgradable"
render hcw-held-upgradable.sh.j2 "${script}"
# The pending-reboot marker is read from a scratch path here, not from the
# machine running the test (an Ubuntu runner may well have one pending).
sed -i "s#^reboot_required='/var/run/reboot-required'\$#reboot_required='${work}/reboot-required'#" "${script}"
grep -q "^reboot_required='${work}/reboot-required'" "${script}" || { echo "the rendered script does not read the reboot marker from the role's path" >&2; exit 1; }
render hcw-held-upgradable.service.j2 "${work}/service"
render hcw-held-upgradable.timer.j2 "${work}/timer"
chmod +x "${script}"
tag="$(sed -n 's/^hardening_held_report_tag: //p' "${defaults}")"
path="$(sed -n 's/^hardening_held_report_script_path: //p' "${defaults}")"

# --- What the units and the role say agree with each other and with the DCR.
check "the rendered script parses as bash and holds no template syntax" \
  "bash -n '${script}' && ! grep -qE '\\{\\{|\\{%|raw %' '${script}'"
check "the script logs under the role's tag" "grep -qxF \"tag='${tag}'\" '${script}'"
check "the service runs the installed script" "grep -qxF 'ExecStart=${path}' '${work}/service'"
check "the service reports its own failure through the failure notifier" \
  "grep -qxF 'OnFailure=hcw-unit-failed@%n.service' '${work}/service'"
check "the service runs unprivileged and read-only" \
  "grep -qxF 'DynamicUser=true' '${work}/service' && grep -qxF 'ProtectSystem=strict' '${work}/service'"
check "the timer is daily, persistent, and starts the service" \
  "grep -qxF 'Unit=hcw-held-upgradable.service' '${work}/timer' && grep -qxF 'Persistent=true' '${work}/timer' && grep -qE '^OnCalendar=\\*-\\*-\\* [0-9]{2}:[0-9]{2}:00\$' '${work}/timer'"
check "the role installs the script, both units, and enables the timer" \
  "grep -qF 'src: hcw-held-upgradable.sh.j2' '${tasks}' && grep -qF 'dest: \"/etc/systemd/system/hcw-held-upgradable.{{ item }}\"' '${tasks}' && grep -qF 'name: hcw-held-upgradable.timer' '${tasks}'"
# infra/ is outside lab-host/, so the container line in lab-host/README.md
# (which mounts lab-host/ alone) cannot see it; CI's checkout can.
if [ -f "${dcr}" ]; then
  check "the Arc data collection rule ships daemon at Warning, where an upgradable line goes" \
    "grep -qF 'facility_names = [\"daemon\", \"syslog\", \"kern\", \"cron\", \"user\"]' '${dcr}' && grep -qF 'log_levels     = [\"Warning\", \"Error\", \"Critical\", \"Alert\", \"Emergency\"]' '${dcr}'"
else
  echo "skip - infra/lab-hybrid.tf is not in this checkout, so the data collection rule is not compared"
fi

# --- Stubs.
stubs="${work}/bin"
mkdir -p "${stubs}"
cat > "${stubs}/apt-mark" <<EOF
#!/usr/bin/env bash
[ "\$1" = showhold ] || exit 64
cat '${work}/held'
EOF
cat > "${stubs}/apt" <<EOF
#!/usr/bin/env bash
[ "\$1 \$2" = "list --upgradable" ] || exit 64
[ ! -e '${work}/apt-fails' ] || { echo 'E: Could not open lock file' >&2; exit 100; }
echo 'WARNING: apt does not have a stable CLI interface. Use with caution in scripts.' >&2
echo 'Listing...'
cat '${work}/upgradable'
EOF
cat > "${stubs}/logger" <<EOF
#!/usr/bin/env bash
# logger -t TAG -p PRIORITY -- MESSAGE
printf '%s|%s|%s\n' "\$2" "\$4" "\$6" >> '${work}/log'
EOF
chmod +x "${stubs}"/*

# run: run the script against the stubs with the syslog record emptied first; its exit status is the script's.
run() { : > "${work}/log"; PATH="${stubs}:${PATH}" "${script}"; }

# --- Two held packages, one of them upgradable, and an upgradable package that is not held.
printf '%s\n' containerd.io docker-ce > "${work}/held"
printf '%s\n' \
  'containerd.io/resolute 2.3.7-1~ubuntu.26.04~resolute amd64 [upgradable from: 2.3.6-1~ubuntu.26.04~resolute]' \
  'curl/resolute-updates 8.14.1-2ubuntu1.1 amd64 [upgradable from: 8.14.1-2ubuntu1]' > "${work}/upgradable"
check "a run with an upgradable held package succeeds" "run"
check "it logs exactly one line" "[ \"\$(wc -l < '${work}/log')\" -eq 1 ]" "$(cat "${work}/log")"
check "the line is the held package, at daemon.warning, under the tag, with both versions" \
  "grep -qxF '${tag}|daemon.warning|held package containerd.io is upgradable: installed 2.3.6-1~ubuntu.26.04~resolute, candidate 2.3.7-1~ubuntu.26.04~resolute. It moves only by a pin bump and a bootstrap.sh run (docs/runbooks/labs-host.md, Runtime advisories).' '${work}/log'" \
  "$(cat "${work}/log")"
check "an upgradable package that is not held is not reported" "! grep -q 'curl' '${work}/log'"

# --- Both upgradable: one line each.
printf '%s\n' \
  'containerd.io/resolute 2.3.7-1~ubuntu.26.04~resolute amd64 [upgradable from: 2.3.6-1~ubuntu.26.04~resolute]' \
  'docker-ce/resolute 5:29.8.2-1~ubuntu.26.04~resolute amd64 [upgradable from: 5:29.8.1-1~ubuntu.26.04~resolute]' > "${work}/upgradable"
run
check "two upgradable held packages are two warning lines" \
  "[ \"\$(grep -c '|daemon.warning|held package ' '${work}/log')\" -eq 2 ] && grep -q 'held package docker-ce is upgradable' '${work}/log'"

# --- Nothing upgradable: one notice line naming what is held.
: > "${work}/upgradable"
run
check "nothing upgradable is one notice line naming the held packages and the lists' age" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.notice\\|no held package is upgradable: 2 held \\(containerd\\.io docker-ce\\); package lists from ' '${work}/log'" \
  "$(cat "${work}/log")"

# --- Nothing held at all.
: > "${work}/held"
run
check "nothing held is the notice line with none" \
  "grep -qxF '${tag}|daemon.notice|no held package is upgradable: 0 held (none); package lists from unknown' '${work}/log' || grep -qE '0 held \\(none\\); package lists from [0-9]{4}-' '${work}/log'" \
  "$(cat "${work}/log")"

# --- A reboot pending for three days: one more line, at warning, with the date and the age.
printf '%s\n' docker-ce > "${work}/held"
: > "${work}/upgradable"
touch -d '3 days ago' "${work}/reboot-required"
run
reboot_time="$(sed -n 's/^hardening_unattended_reboot_time: "\(.*\)"$/\1/p' "${defaults}")"
check "a pending reboot adds one warning line with its age in days, naming the idle reboot and its hour" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 2 ] && grep -qE '^${tag}\\|daemon\\.warning\\|a reboot is pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \\(3 days\\): hcw-reboot-when-idle reboots at ${reboot_time} only with nobody logged in and no lab job running\\. Log out before then, or reboot at a time of your choosing \\(docs/runbooks/labs-host\\.md, Runtime advisories\\)\\.\$' '${work}/log'" \
  "$(cat "${work}/log")"
rm -f "${work}/reboot-required"
run
check "no pending reboot, no reboot line" "! grep -q 'a reboot is pending' '${work}/log'"

# --- apt fails: the run fails, so the unit fails and the notifier reports it.
printf '%s\n' docker-ce > "${work}/held"
touch "${work}/apt-fails"
check "a failing apt fails the run rather than reporting nothing upgradable" "! run 2> /dev/null && [ ! -s '${work}/log' ]"
rm -f "${work}/apt-fails"

if [ "${failed}" -ne 0 ]; then
  echo "hcw-held-upgradable.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "hcw-held-upgradable.test.sh: all ${passed} checks passed"
