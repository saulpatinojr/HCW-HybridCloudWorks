#!/usr/bin/env bash
# Tests ../templates/hcw-reboot-when-idle.sh.j2, the nightly idle reboot this
# role renders to /usr/local/sbin/hcw-reboot-when-idle (LAB-13, #959), by
# rendering it and its service and timer with the role's own defaults and
# running the script against stub `users`, `docker`, `systemctl` and `logger`
# on PATH, with the pending-reboot marker at a scratch path. The stubs answer
# from files in a scratch directory; the logger and systemctl stubs record
# what they are asked, so each case can say that exactly one reboot was
# requested, or none.
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
runner="${repo}/vps-agent/lib/docker-runner.js"

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
script="${work}/hcw-reboot-when-idle"
render hcw-reboot-when-idle.sh.j2 "${script}"
# The marker and systemctl are read from scratch paths here, not from the
# machine running the test: an Ubuntu runner may well have a reboot pending,
# and a real `systemctl reboot` would end the test the hard way.
sed -i "s#^reboot_required='/var/run/reboot-required'\$#reboot_required='${work}/reboot-required'#" "${script}"
grep -q "^reboot_required='${work}/reboot-required'" "${script}" || { echo "the rendered script does not read the reboot marker from the role's path" >&2; exit 1; }
sed -i "s#^systemctl='/usr/bin/systemctl'\$#systemctl='${work}/bin/systemctl'#" "${script}"
grep -q "^systemctl='${work}/bin/systemctl'" "${script}" || { echo "the rendered script does not reboot through /usr/bin/systemctl" >&2; exit 1; }
render hcw-reboot-when-idle.service.j2 "${work}/service"
render hcw-reboot-when-idle.timer.j2 "${work}/timer"
render 52hcw-unattended-upgrades.j2 "${work}/override"
chmod +x "${script}"
tag="$(sed -n 's/^hardening_reboot_when_idle_tag: //p' "${defaults}")"
path="$(sed -n 's/^hardening_reboot_when_idle_script_path: //p' "${defaults}")"
label="$(sed -n 's/^hardening_reboot_job_label: //p' "${defaults}")"
reboot_time="$(sed -n 's/^hardening_unattended_reboot_time: "\(.*\)"$/\1/p' "${defaults}")"

# --- What the units, the role and the agent say agree with each other.
check "the rendered script parses as bash and holds no template syntax" \
  "bash -n '${script}' && ! grep -qE '\\{\\{|\\{%|raw %' '${script}'"
check "the script logs under the role's tag" "grep -qxF \"tag='${tag}'\" '${script}'"
check "the script filters docker ps on the role's job label" "grep -qxF \"job_label='${label}'\" '${script}'"
# vps-agent/ is outside lab-host/, so the container line in lab-host/README.md
# (which mounts lab-host/ alone) cannot see it; CI's checkout can, and
# scripts/lab-job-limits.test.mjs holds the same pair.
if [ -f "${runner}" ]; then
  check "the role's job label is the one the agent writes on every job container" \
    "grep -qxF \"export const JOB_LABEL = '${label}';\" '${runner}'"
else
  echo "skip - vps-agent/lib/docker-runner.js is not in this checkout, so the job label is not compared"
fi
check "unattended-upgrades does not reboot on its own, which would skip both questions" \
  "grep -qxF 'Unattended-Upgrade::Automatic-Reboot \"false\";' '${work}/override'"
check "the service runs the installed script" "grep -qxF 'ExecStart=${path}' '${work}/service'"
check "the service reports its own failure through the failure notifier" \
  "grep -qxF 'OnFailure=hcw-unit-failed@%n.service' '${work}/service'"
check "the service is a root oneshot with the file system read-only to it and home hidden" \
  "grep -qxF 'Type=oneshot' '${work}/service' && grep -qxF 'ProtectSystem=strict' '${work}/service' && grep -qxF 'ProtectHome=true' '${work}/service' && grep -qxF 'NoNewPrivileges=true' '${work}/service' && ! grep -qE '^(DynamicUser|User)=' '${work}/service'"
check "the service cannot hang through the night on a docker that does not answer" \
  "grep -qE '^TimeoutStartSec=[0-9]+(min|s)?\$' '${work}/service'"
check "the timer fires at the role's reboot hour, is not persistent, has no jitter, and starts the service" \
  "grep -qxF 'OnCalendar=*-*-* ${reboot_time}:00' '${work}/timer' && grep -qxF 'Persistent=false' '${work}/timer' && ! grep -q '^RandomizedDelaySec=' '${work}/timer' && grep -qxF 'Unit=hcw-reboot-when-idle.service' '${work}/timer'"
check "the role installs the script, both units, and enables the timer" \
  "grep -qF 'src: hcw-reboot-when-idle.sh.j2' '${tasks}' && grep -qF 'dest: \"/etc/systemd/system/hcw-reboot-when-idle.{{ item }}\"' '${tasks}' && grep -qF 'name: hcw-reboot-when-idle.timer' '${tasks}'"
check "the role refuses a reboot hour that is not HH:MM" \
  "grep -qF \"hardening_unattended_reboot_time is match('^([01][0-9]|2[0-3]):[0-5][0-9]\$')\" '${tasks}'"

# --- Stubs.
stubs="${work}/bin"
mkdir -p "${stubs}"
cat > "${stubs}/users" <<EOF
#!/usr/bin/env bash
echo users >> '${work}/users.log'
[ ! -e '${work}/users-fails' ] || { echo 'users: cannot read the login records' >&2; exit 1; }
cat '${work}/users'
EOF
# docker-missing answers as bash does for a command it cannot find (127):
# the host's docker gone is the same failed check as a daemon that is down.
cat > "${stubs}/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >> '${work}/docker.log'
[ "\$*" = "ps -q --filter label=${label}" ] || { echo "unexpected docker argv: \$*" >&2; exit 64; }
[ ! -e '${work}/docker-fails' ] || { echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2; exit 1; }
[ ! -e '${work}/docker-missing' ] || { echo 'docker: command not found' >&2; exit 127; }
cat '${work}/containers'
EOF
cat > "${stubs}/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> '${work}/systemctl.log'
EOF
cat > "${stubs}/logger" <<EOF
#!/usr/bin/env bash
# logger -t TAG -p PRIORITY -- MESSAGE
printf '%s|%s|%s\n' "\$2" "\$4" "\$6" >> '${work}/log'
EOF
chmod +x "${stubs}"/*

run() { : > "${work}/log"; : > "${work}/users.log"; : > "${work}/docker.log"; : > "${work}/systemctl.log"; PATH="${stubs}:${PATH}" "${script}"; }
reboots() { grep -c '^reboot' "${work}/systemctl.log" || true; }
pending='a reboot has been pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \(3 days\)'

# --- No marker: nothing to do, one notice line, nobody asked, no reboot.
: > "${work}/users"
: > "${work}/containers"
rm -f "${work}/reboot-required"
check "no marker is a successful run" "run"
check "no marker is one notice line, and neither users nor docker is asked" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -qxF '${tag}|daemon.notice|no reboot is pending: ${work}/reboot-required does not exist' '${work}/log' && [ ! -s '${work}/users.log' ] && [ ! -s '${work}/docker.log' ]" \
  "$(cat "${work}/log")"
check "no marker requests no reboot" "[ \"\$(reboots)\" -eq 0 ]"

# --- A reboot pending for three days and a user logged in: deferred, docker not even asked.
touch -d '3 days ago' "${work}/reboot-required"
printf '%s\n' hcwadmin > "${work}/users"
check "a user logged in is a successful run" "run"
check "a user logged in is one warning line naming the user and the wait" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: a user is logged in \\(hcwadmin\\); ${pending}\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "docker is not asked while a user is logged in" "[ ! -s '${work}/docker.log' ]"
check "a user logged in requests no reboot" "[ \"\$(reboots)\" -eq 0 ]"

# --- users cannot answer: the run fails rather than taking silence for nobody; docker not asked, no reboot.
: > "${work}/users"
touch "${work}/users-fails"
check "a users that cannot answer fails the run rather than guessing" "! run 2> /dev/null"
check "a users that cannot answer is one err line, docker not asked, and no reboot" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: users could not say who is logged in' '${work}/log' && [ ! -s '${work}/docker.log' ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/users-fails"

# --- Nobody logged in, two job containers running: deferred, with the count.
: > "${work}/users"
printf '%s\n' 3f2a9c1d7e5b 8b1c0d2e4f6a > "${work}/containers"
check "running job containers are a successful run" "run"
check "running job containers are one warning line with their count and the wait" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 2 job container\\(s\\) running; ${pending}\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "docker was asked once, for containers with the agent's label only" \
  "[ \"\$(wc -l < '${work}/docker.log')\" -eq 1 ] && grep -qxF 'ps -q --filter label=${label}' '${work}/docker.log'" \
  "$(cat "${work}/docker.log")"
check "running job containers request no reboot" "[ \"\$(reboots)\" -eq 0 ]"

# --- docker cannot answer: the run fails (so the unit fails and the notifier reports it), no reboot.
: > "${work}/containers"
touch "${work}/docker-fails"
check "a docker that cannot answer fails the run rather than guessing" "! run 2> /dev/null"
check "a docker that cannot answer is one err line and no reboot" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: docker could not list the job containers' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/docker-fails"

# --- docker not found: the same failed check, not "no job container".
touch "${work}/docker-missing"
check "a docker the shell cannot find fails the run rather than reading as no job" "! run 2> /dev/null"
check "a docker the shell cannot find is one err line and no reboot" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: docker could not list the job containers' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/docker-missing"

# --- Idle: one warning line saying so and how long it waited, exactly one reboot.
check "an idle host is a successful run" "run"
check "an idle host is one warning line saying it reboots and how long it waited" \
  "[ \"\$(wc -l < '${work}/log')\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|rebooting; pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \\(3 days\\): nobody is logged in and no job container is running\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "an idle host requests exactly one reboot, through systemctl" \
  "[ \"\$(reboots)\" -eq 1 ] && grep -qxF 'reboot' '${work}/systemctl.log'" \
  "$(cat "${work}/systemctl.log")"

if [ "${failed}" -ne 0 ]; then
  echo "hcw-reboot-when-idle.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "hcw-reboot-when-idle.test.sh: all ${passed} checks passed"
