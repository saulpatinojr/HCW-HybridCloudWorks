#!/usr/bin/env bash
# Tests ../templates/hcw-reboot-when-idle.sh.j2, the nightly idle reboot this
# role renders to /usr/local/sbin/hcw-reboot-when-idle (LAB-13, #959), by
# rendering it and its service and timer with the role's own defaults and
# running the script against stub `apt-config`, `loginctl`, `docker`,
# `sleep`, `systemctl` and `logger` on PATH, with the pending-reboot marker,
# the maintenance hold, its first-seen record and the Coder sandbox socket at
# scratch paths. The stubs answer from files in a scratch directory; the
# loginctl stub answers from a session listing in the host's own format (the
# listing measured on the lab host on 2026-10-15 is the first fixture), the
# docker stub answers for two daemons (the host's, and the Coder sandbox's
# when `--host` names its socket) from container lists with a state on each
# line, filtering by `status=` the way docker does, and the logger and
# systemctl stubs record what they are asked, so each case can say that
# exactly one reboot was requested, or none.
#
# The `sleep` stub is the hold window (CodeRabbit on #1191). The script
# sleeps once, between writing the hold and its second look, so the stub
# records what the hold said at that moment and can change the host inside
# the window: a job container that a claim already in flight creates or
# starts, a workspace, a user who logs in, or a stop. Each of those must
# defer the reboot (or end the run) and remove the hold; only the reboot
# path keeps it.
#
# No root and no Docker needed. CI runs it in the `ansible-lint (lab-host)`
# job with the job's Python, which has Jinja2 and PyYAML from ansible-core;
# lab-host/README.md ("Validating without a host") has the container line.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
defaults="${role}/defaults/main.yml"
tasks="${role}/tasks/main.yml"
agent_defaults="$(cd "${role}/.." && pwd)/labs_agent/defaults/main.yml"
sandbox_vars="$(cd "${role}/.." && pwd)/coder_sandbox/vars/main.yml"
coder_templates="$(cd "${role}/../../.." && pwd)/coder/templates"
repo="$(cd "${here}/../../../../.." && pwd)"
runner="${repo}/vps-agent/lib/docker-runner.js"

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
# defaults/main.yml plus ansible_managed, with the two path filters the
# templates use (Ansible's dirname and basename are os.path's). An
# undefined name fails the render.
render() {
  "${python}" - "${role}/templates/$1" "${defaults}" > "$2" <<'PY'
import posixpath, sys, jinja2, yaml
template, defaults = sys.argv[1], sys.argv[2]
values = yaml.safe_load(open(defaults, encoding="utf-8"))
values["ansible_managed"] = "Ansible managed"
env = jinja2.Environment(undefined=jinja2.StrictUndefined, trim_blocks=True, keep_trailing_newline=True)
env.filters["dirname"] = posixpath.dirname
env.filters["basename"] = posixpath.basename
sys.stdout.write(env.from_string(open(template, encoding="utf-8").read()).render(**values))
PY
}
# default NAME: the role's default for NAME, without its quotes.
default() { sed -n "s/^$1: \"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "${defaults}"; }

tag="$(default hardening_reboot_when_idle_tag)"
path="$(default hardening_reboot_when_idle_script_path)"
label="$(default hardening_reboot_job_label)"
ws_host="$(default hardening_reboot_workspace_docker_host)"
ws_label="$(default hardening_reboot_workspace_label)"
reboot_time="$(default hardening_unattended_reboot_time)"
hold_path="$(default hardening_reboot_hold_path)"
settle="$(default hardening_reboot_hold_settle_seconds)"
hold_seconds="$(default hardening_reboot_hold_seconds)"
overdue="$(default hardening_reboot_overdue_days)"
agent_hold_path="$(sed -n 's/^labs_agent_maintenance_hold_path: \(\/.*\)$/\1/p' "${agent_defaults}")"
sandbox_dir="$(sed -n 's/^coder_sandbox_socket_dir: \(\/.*\)$/\1/p' "${sandbox_vars}")"

script="${work}/hcw-reboot-when-idle"
render hcw-reboot-when-idle.sh.j2 "${script}"
# The marker, the hold, the sandbox socket and systemctl are read from
# scratch paths here, not from the machine running the test: an Ubuntu
# runner may well have a reboot pending, /run is not the test's to write,
# and a real `systemctl reboot` would end the test the hard way. The
# first-seen record sits beside the hold, so it moves with it.
hold="${work}/run/hcw-maintenance/reboot-hold"
record="${work}/run/hcw-maintenance/reboot-pending-since"
ws_sock="${work}/coder-docker.sock"
sed -i "s#^reboot_required='/var/run/reboot-required'\$#reboot_required='${work}/reboot-required'#" "${script}"
grep -q "^reboot_required='${work}/reboot-required'" "${script}" || { echo "the rendered script does not read the reboot marker from the role's path" >&2; exit 1; }
sed -i "s#^systemctl='/usr/bin/systemctl'\$#systemctl='${work}/bin/systemctl'#" "${script}"
grep -q "^systemctl='${work}/bin/systemctl'" "${script}" || { echo "the rendered script does not reboot through /usr/bin/systemctl" >&2; exit 1; }
sed -i "s#^hold='${hold_path}'\$#hold='${hold}'#" "${script}"
grep -q "^hold='${hold}'" "${script}" || { echo "the rendered script does not write the hold at the role's hardening_reboot_hold_path" >&2; exit 1; }
sed -i "s#^workspace_docker_host='${ws_host}'\$#workspace_docker_host='unix://${ws_sock}'#" "${script}"
grep -q "^workspace_docker_host='unix://${ws_sock}'" "${script}" || { echo "the rendered script does not ask the role's hardening_reboot_workspace_docker_host" >&2; exit 1; }
render hcw-reboot-when-idle.service.j2 "${work}/service"
render hcw-reboot-when-idle.timer.j2 "${work}/timer"
render 52hcw-unattended-upgrades.j2 "${work}/override"
chmod +x "${script}"

# --- What the units, the role, the agent and Coder say agree with each other.
check "the rendered script parses as bash and holds no template syntax" \
  "bash -n '${script}' && ! grep -qE '\\{\\{|\\{%|raw %' '${script}'"
check "the script logs under the role's tag" "grep -qxF \"tag='${tag}'\" '${script}'"
check "the script filters docker ps on the role's job label" "grep -qxF \"job_label='${label}'\" '${script}'"
# rust-coreutils' users and who read utmp, which systemd no longer writes;
# on the lab host both printed nothing with an SSH session open (2026-10-15).
check "the script asks logind who is logged in, never users or who" \
  "grep -qF 'loginctl list-sessions --no-legend' '${script}' && ! grep -qE '^[^#]*(\\\$\\(|\\| *|^ *)(users|who)( |\\)|\$)' '${script}'"
# vps-agent/ is outside lab-host/, so the container line in lab-host/README.md
# (which mounts lab-host/ alone) cannot see it; CI's checkout can, and
# scripts/lab-job-limits.test.mjs holds the same pair.
if [ -f "${runner}" ]; then
  check "the role's job label is the one the agent writes on every job container" \
    "grep -qxF \"export const JOB_LABEL = '${label}';\" '${runner}'"
else
  echo "skip - vps-agent/lib/docker-runner.js is not in this checkout, so the job label is not compared"
fi
check "the hold is written where the labs agent reads it (labs_agent_maintenance_hold_path)" \
  "[ -n '${hold_path}' ] && [ '${hold_path}' = '${agent_hold_path}' ]"
# Coder's workspaces run on the sandbox daemon (review of #1191): the role
# asks the socket coder_sandbox makes, which ProtectHome= does not hide, for
# the label every workspace container in every template carries.
check "the workspace question goes to coder_sandbox's own socket, outside /run/user" \
  "[ -n '${sandbox_dir}' ] && [ '${ws_host}' = 'unix://${sandbox_dir}/docker.sock' ] && case '${ws_host}' in unix:///run/user/*) false ;; *) true ;; esac"
# workspace_blocks: every Coder template's workspace container block, one per template, on stdout.
workspace_blocks() { for tf in "${coder_templates}"/*/main.tf; do awk '/^resource "docker_container" "workspace"/,/^}/' "${tf}"; echo '--- end'; done; }
templates="$(find "${coder_templates}" -name main.tf | wc -l | tr -d ' ')"
labelled="$(workspace_blocks | grep -cF "label = \"${ws_label}\"" || true)"
check "every Coder template's workspace container carries the label the reboot asks for" \
  "[ '${templates}' -ge 1 ] && [ '${labelled}' -eq '${templates}' ]" "${labelled} of ${templates} templates"
check "unattended-upgrades does not reboot on its own, which would skip every question" \
  "grep -qxF 'Unattended-Upgrade::Automatic-Reboot \"false\";' '${work}/override'"
check "the service runs the installed script" "grep -qxF 'ExecStart=${path}' '${work}/service'"
check "the service reports its own failure through the failure notifier" \
  "grep -qxF 'OnFailure=hcw-unit-failed@%n.service' '${work}/service'"
# A stop exits 143 through the script's TERM trap: an owner's systemctl stop,
# or the reboot's own stop job. Without this the unit fails and pages.
check "a stop (exit 143) is a success to the unit, not a page" \
  "[ \"\$(grep -c '^SuccessExitStatus=' '${work}/service')\" -eq 1 ] && grep -qxF 'SuccessExitStatus=143' '${work}/service' && grep -qxF \"trap 'exit 143' TERM\" '${script}'"
check "the service is a root oneshot with the file system read-only to it and home hidden" \
  "grep -qxF 'Type=oneshot' '${work}/service' && grep -qxF 'ProtectSystem=strict' '${work}/service' && grep -qxF 'ProtectHome=true' '${work}/service' && grep -qxF 'NoNewPrivileges=true' '${work}/service' && ! grep -qE '^(DynamicUser|User)=' '${work}/service'"
check "the one place it may write is the hold's directory, under /run, kept when a run ends, readable by the agent" \
  "grep -qxF \"RuntimeDirectory=\$(basename \"\$(dirname '${hold_path}')\")\" '${work}/service' && [ \"\$(dirname \"\$(dirname '${hold_path}')\")\" = /run ] && grep -qxF 'RuntimeDirectoryPreserve=yes' '${work}/service' && grep -qxF 'RuntimeDirectoryMode=0755' '${work}/service' && ! grep -qE '^(ReadWritePaths|StateDirectory)=' '${work}/service'"
check "the first-seen record lives beside the hold, on the marker's own tmpfs" \
  "grep -qxF 'first_seen=\"\${hold%/*}/reboot-pending-since\"' '${script}'"
check "the service cannot hang through the night on a docker that does not answer" \
  "grep -qxF 'TimeoutStartSec=2min' '${work}/service'"
check "the 2 min leave the second look 30 s after the settle, and the hold outlasts them, within the agent's 10 min cap" \
  "[ '${settle}' -ge 35 ] && [ '${settle}' -le 90 ] && [ '${hold_seconds}' -gt 120 ] && [ '${hold_seconds}' -le 600 ]"
check "the timer fires at the role's reboot hour, is not persistent, has no jitter, and starts the service" \
  "grep -qxF 'OnCalendar=*-*-* ${reboot_time}:00' '${work}/timer' && grep -qxF 'Persistent=false' '${work}/timer' && ! grep -q '^RandomizedDelaySec=' '${work}/timer' && grep -qxF 'Unit=hcw-reboot-when-idle.service' '${work}/timer'"
check "the role installs the script, both units, and enables the timer" \
  "grep -qF 'src: hcw-reboot-when-idle.sh.j2' '${tasks}' && grep -qF 'dest: \"/etc/systemd/system/hcw-reboot-when-idle.{{ item }}\"' '${tasks}' && grep -qF 'name: hcw-reboot-when-idle.timer' '${tasks}'"
check "the role refuses a reboot hour that is not HH:MM" \
  "grep -qF \"hardening_unattended_reboot_time is match('^([01][0-9]|2[0-3]):[0-5][0-9]\$')\" '${tasks}'"
# The hand-over of reboot authority (CodeRabbit on #1191): a reboot
# unattended-upgrades already scheduled is dealt with first, the timer is
# installed, enabled and read back active, then unattended-upgrades' own
# reboot is turned off, and apt's effective setting is read back after that.
# at TEXT: the line number of TEXT's first occurrence in the role's tasks, or nothing, so a missing task fails its check rather than the run.
at() { grep -nF -- "$1" "${tasks}" | head -n 1 | cut -d: -f1 || true; }
preflight_at="$(at 'path: /run/systemd/shutdown/scheduled')"
script_at="$(at 'src: hcw-reboot-when-idle.sh.j2')"
enable_at="$(at '- name: Enable the nightly idle reboot')"
verify_at="$(at "- name: Refuse to turn unattended-upgrades' reboot off until the timer")"
override_at="$(at 'src: 52hcw-unattended-upgrades.j2')"
readback_at="$(at '- Unattended-Upgrade::Automatic-Reboot/b')"
refuse_at="$(at "hardening_automatic_reboot.stdout | trim != \"automatic_reboot='true'\"")"
check "the role looks for a scheduled shutdown, installs, enables, verifies, and only then turns unattended-upgrades' reboot off" \
  "[ -n '${preflight_at}' ] && [ -n '${script_at}' ] && [ -n '${enable_at}' ] && [ -n '${verify_at}' ] && [ -n '${override_at}' ] && [ '${preflight_at}' -lt '${script_at}' ] && [ '${script_at}' -lt '${enable_at}' ] && [ '${enable_at}' -lt '${verify_at}' ] && [ '${verify_at}' -lt '${override_at}' ]" \
  "scheduled ${preflight_at}, script ${script_at}, enable ${enable_at}, verify ${verify_at}, override ${override_at}"
# A later apt.conf.d file could set Automatic-Reboot back on (review of
# #1191): after the override, the role reads apt's own answer and refuses
# true, so "at most one reboot mechanism" is checked, not assumed.
check "after the override the role reads apt's effective Automatic-Reboot back and refuses true" \
  "[ -n '${readback_at}' ] && [ -n '${refuse_at}' ] && [ '${override_at}' -lt '${readback_at}' ] && [ '${readback_at}' -lt '${refuse_at}' ]" \
  "override ${override_at}, read-back ${readback_at}, refusal ${refuse_at}"
check "it cancels a scheduled reboot only when unattended-upgrades' log names it, and stops at one it does not" \
  "grep -qF 'hardening_scheduled_shutdown_logged.rc | default(1) == 0' '${tasks}' && grep -qF 'hardening_scheduled_shutdown_logged.rc | default(1) != 0' '${tasks}' && grep -qF -- '- /var/log/unattended-upgrades/unattended-upgrades.log' '${tasks}' && grep -qF 'Stop at a scheduled reboot nothing says unattended-upgrades scheduled' '${tasks}'"
# In check mode `command` registers skipped with rc 0 (ansible-core 2.21),
# so keying the cancel's read-back on `rc is defined` would read back, in a
# --check run, a reboot nothing cancelled, and fail it (review of #1191).
check "the cancel's read-back and its assertion run only when the cancel ran, check mode included" \
  "[ \"\$(grep -c 'when: hardening_scheduled_shutdown_cancel is not skipped' '${tasks}')\" -eq 2 ] && ! grep -qE 'hardening_scheduled_shutdown_cancel(\\.rc is defined| is changed)' '${tasks}'"

# --- Session listings, in the columns systemd 259 prints for
# `loginctl list-sessions --no-legend`: SESSION UID USER SEAT LEADER CLASS TTY
# IDLE SINCE. The first is the lab host's own, measured on 2026-10-15 with an
# SSH session open: hcwadmin's login (class user), hcwadmin's own service
# manager (manager) and the lingering manager that keeps hcw-coder-docker's
# rootless daemon up (manager-early).
measured="${work}/measured"
cat > "${measured}" <<'EOF'
 22  981 hcw-coder-docker - 331127  manager-early - no -
384 1000 hcwadmin         - 3923325 user          - no -
385 1000 hcwadmin         - 3923330 manager       - no -
EOF
# The same host with nobody logged in: the two service managers and a
# cron-like session, none of which is a person.
nobody="${work}/nobody"
cat > "${nobody}" <<'EOF'
 22  981 hcw-coder-docker - 331127  manager-early - no -
385 1000 hcwadmin         - 3923330 manager       - no -
391    0 root             - 3990001 background    - no -
EOF
# hcwadmin over SSH twice: named once.
twice="${work}/twice"
cat "${measured}" > "${twice}"
printf '%s\n' '386 1000 hcwadmin         - 3923400 user          - no -' >> "${twice}"
# Root at the provider's console and nobody else: class user-early, which
# systemd 256 and later give root's interactive logins.
console="${work}/console"
cat "${nobody}" > "${console}"
printf '%s\n' ' c1    0 root             seat0 4100  user-early    tty1 no -' >> "${console}"

# --- Stubs.
stubs="${work}/bin"
mkdir -p "${stubs}"
# apt-config answers the one question the script asks, as apt does: the
# key's boolean when it is set, nothing at all when nobody set it.
cat > "${stubs}/apt-config" <<EOF
#!/usr/bin/env bash
echo "\$*" >> '${work}/apt-config.log'
[ "\$*" = 'shell automatic_reboot Unattended-Upgrade::Automatic-Reboot/b' ] || { echo "unexpected apt-config argv: \$*" >&2; exit 64; }
[ ! -e '${work}/apt-config-fails' ] || { echo 'E: Syntax error /etc/apt/apt.conf.d/52hcw-unattended-upgrades:9: Extra junk at end of file' >&2; exit 100; }
[ ! -e '${work}/apt-reboot' ] || printf "automatic_reboot='%s'\n" "\$(cat '${work}/apt-reboot')"
EOF
# loginctl answers the two calls the script makes and refuses anything else.
# show-session prints Name before Class, the order logind's bus gives rather
# than the order of the -p flags, so the script cannot rely on an order.
cat > "${stubs}/loginctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> '${work}/loginctl.log'
[ ! -e '${work}/loginctl-fails' ] || { echo 'Failed to connect to system scope bus via local transport: No such file or directory' >&2; exit 1; }
if [ "\$*" = 'list-sessions --no-legend' ]; then
  cat '${work}/sessions'
  exit 0
fi
if [ "\$#" -eq 6 ] && [ "\$1" = show-session ] && [ "\$3 \$4 \$5 \$6" = '-p Class -p Name' ]; then
  [ ! -e '${work}/show-fails' ] || { echo "Failed to get session path: No session '\$2' known" >&2; exit 1; }
  awk -v id="\$2" '\$1 == id { print "Name=" \$3; print "Class=" \$6; found = 1 } END { exit !found }' '${work}/sessions'
  exit
fi
echo "unexpected loginctl argv: \$*" >&2
exit 64
EOF
# docker answers for two daemons: the host's (no --host), from `containers`,
# and the Coder sandbox's (--host and its socket), from `workspaces`. Each
# line of those is an id and a state. Like docker, a `status=` filter lists
# exactly the states it names, of every container; without one, only the
# containers that are up (running, restarting, paused), never one still in
# `created`. docker-missing answers as bash does for a command it cannot
# find (127), the same failed check as a daemon that is down;
# docker-fails-second lets the host daemon's first answer through and fails
# its second; workspaces-fail fails the sandbox daemon.
cat > "${stubs}/docker" <<EOF
#!/usr/bin/env bash
host=''
if [ "\${1:-}" = --host ]; then host="\$2"; shift 2; fi
echo "\${host:+--host \${host} }\$*" >> '${work}/docker.log'
if [ -n "\${host}" ]; then
  [ "\${host}" = 'unix://${ws_sock}' ] || { echo "unexpected docker host: \${host}" >&2; exit 64; }
  [ "\$1 \$2 \$3 \$4" = "ps -q --filter label=${ws_label}" ] || { echo "unexpected docker argv: \$*" >&2; exit 64; }
  [ ! -e '${work}/workspaces-fail' ] || { echo 'Cannot connect to the Docker daemon at unix:///run/hcw-coder-docker/docker.sock. Is the docker daemon running?' >&2; exit 1; }
  list='${work}/workspaces'
else
  [ "\$1 \$2 \$3 \$4" = "ps -q --filter label=${label}" ] || { echo "unexpected docker argv: \$*" >&2; exit 64; }
  [ ! -e '${work}/docker-fails' ] || { echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2; exit 1; }
  [ ! -e '${work}/docker-missing' ] || { echo 'docker: command not found' >&2; exit 127; }
  if [ -e '${work}/docker-fails-second' ] && [ "\$(grep -vc '^--host ' '${work}/docker.log')" -ge 2 ]; then
    echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2
    exit 1
  fi
  list='${work}/containers'
fi
shift 4
states=''
while [ "\$#" -gt 0 ]; do
  [ "\$1" = --filter ] || { echo "unexpected docker argv: \$1" >&2; exit 64; }
  case "\$2" in
    status=*) states="\${states} \${2#status=}" ;;
    *) echo "unexpected docker filter: \$2" >&2; exit 64 ;;
  esac
  shift 2
done
[ -n "\${states}" ] || states=' running restarting paused'
awk -v want="\${states} " 'index(want, " " \$2 " ") { print \$1 }' "\${list}"
EOF
# sleep is the hold window: it records how long it was asked to wait and
# what the hold said then, and does not wait. during-container is a job a
# claim already in flight creates or starts inside the window,
# during-workspace a workspace, during-session a login, during-term a stop
# of the unit (systemd's SIGTERM to the script).
cat > "${stubs}/sleep" <<EOF
#!/usr/bin/env bash
echo "\$*" >> '${work}/sleep.log'
if [ -e '${hold}' ]; then
  { cat '${hold}'; stat -c %a '${hold}'; } > '${work}/hold-during'
else
  echo absent > '${work}/hold-during'
fi
[ ! -e '${work}/during-container' ] || cat '${work}/during-container' >> '${work}/containers'
[ ! -e '${work}/during-workspace' ] || cat '${work}/during-workspace' >> '${work}/workspaces'
[ ! -e '${work}/during-session' ] || cat '${work}/during-session' >> '${work}/sessions'
[ ! -e '${work}/during-term' ] || kill -TERM "\${PPID}"
exit 0
EOF
cat > "${stubs}/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> '${work}/systemctl.log'
[ ! -e '${work}/systemctl-fails' ] || { echo 'Failed to start reboot.target: Transaction for reboot.target/start is destructive.' >&2; exit 1; }
EOF
cat > "${stubs}/logger" <<EOF
#!/usr/bin/env bash
# logger -t TAG -p PRIORITY -- MESSAGE
printf '%s|%s|%s\n' "\$2" "\$4" "\$6" >> '${work}/log'
EOF
chmod +x "${stubs}"/*

# run: run the script against the stubs with every record emptied first; its exit status is the script's.
run() {
  : > "${work}/log"
  : > "${work}/apt-config.log"
  : > "${work}/loginctl.log"
  : > "${work}/docker.log"
  : > "${work}/systemctl.log"
  rm -f "${work}/sleep.log" "${work}/hold-during"
  PATH="${stubs}:${PATH}" "${script}"
}
# reboots: how many reboots the last run asked systemctl for.
reboots() { grep -c '^reboot' "${work}/systemctl.log" || true; }
# lines: how many syslog lines the last run wrote.
lines() { wc -l < "${work}/log" | tr -d ' '; }
# slept: how many times the last run waited in the hold window.
slept() { if [ -e "${work}/sleep.log" ]; then wc -l < "${work}/sleep.log" | tr -d ' '; else echo 0; fi; }
# asked FILE: how many times the last run called the stub that records to FILE.
asked() { wc -l < "${work}/$1" | tr -d ' '; }
# host_asks: how many times the last run asked the host daemon.
host_asks() { grep -vc '^--host ' "${work}/docker.log" || true; }
# sandbox_asks: how many times the last run asked the Coder sandbox daemon.
sandbox_asks() { grep -c '^--host ' "${work}/docker.log" || true; }
# epoch DAYS: the epoch second DAYS days ago.
epoch() { echo $(( $(date -u +%s) - $1 * 86400 )); }
pending='a reboot has been pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \(3 days\)'
up_filters='--filter status=created --filter status=restarting --filter status=running --filter status=paused'
mkdir -p "$(dirname "${hold}")"
printf 'false\n' > "${work}/apt-reboot"
# The sandbox daemon as on the host: its socket there, no workspace up.
: > "${ws_sock}"
: > "${work}/workspaces"

# --- unattended-upgrades' own reboot on (a rollback): stand down, asking
# nothing else, writing no hold, rebooting nothing, every night saying so.
cp "${nobody}" "${work}/sessions"
: > "${work}/containers"
touch -d '3 days ago' "${work}/reboot-required"
printf 'true\n' > "${work}/apt-reboot"
check "apt's Automatic-Reboot on is a successful run" "run"
check "apt's Automatic-Reboot on is one warning line standing down, and nothing else is asked or held" \
  "[ \"\$(lines)\" -eq 1 ] && grep -qxF \"${tag}|daemon.warning|standing down: unattended-upgrades' own Automatic-Reboot is on, so it reboots this host and this timer does not; withdraw the timer, or run bootstrap.sh from a revision that turns Automatic-Reboot off (docs/runbooks/labs-host.md, Runtime advisories)\" '${work}/log' && [ \"\$(asked loginctl.log)\" -eq 0 ] && [ \"\$(asked docker.log)\" -eq 0 ] && [ \"\$(slept)\" -eq 0 ] && [ ! -e '${hold}' ] && [ ! -e '${record}' ]" \
  "$(cat "${work}/log")"
check "apt's Automatic-Reboot on requests no reboot from this timer" "[ \"\$(reboots)\" -eq 0 ]"

# --- apt-config cannot answer: the run fails, nothing else is asked.
touch "${work}/apt-config-fails"
check "an apt-config that cannot answer fails the run rather than guessing" "! run 2> /dev/null"
check "an apt-config that cannot answer is one err line, nothing else asked, and no reboot" \
  "[ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: apt-config could not say whether unattended-upgrades reboots on its own' '${work}/log' && [ \"\$(asked loginctl.log)\" -eq 0 ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/apt-config-fails"

# --- Automatic-Reboot set nowhere (apt prints nothing) is off, as
# unattended-upgrade reads it: the script goes on.
rm -f "${work}/apt-reboot"
check "an Automatic-Reboot nobody set is off: the idle host reboots" \
  "run && [ \"\$(reboots)\" -eq 1 ]" "$(cat "${work}/log")"
printf 'false\n' > "${work}/apt-reboot"
rm -f "${hold}"

# --- No marker: nothing to do, one notice line, nobody asked, no reboot,
# and the first-seen record of the reboot that was pending is gone.
cp "${measured}" "${work}/sessions"
rm -f "${work}/reboot-required"
check "no marker is a successful run" "run"
check "no marker is one notice line, and neither logind nor docker is asked" \
  "[ \"\$(lines)\" -eq 1 ] && grep -qxF '${tag}|daemon.notice|no reboot is pending: ${work}/reboot-required does not exist' '${work}/log' && [ ! -s '${work}/loginctl.log' ] && [ ! -s '${work}/docker.log' ] && [ \"\$(asked apt-config.log)\" -eq 1 ]" \
  "$(cat "${work}/log")"
check "no marker requests no reboot, writes no hold, and clears the first-seen record" \
  "[ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ] && [ ! -e '${record}' ]"

# --- A reboot pending for three days and the host as measured, hcwadmin
# logged in over SSH: deferred, naming hcwadmin once, docker not even asked.
touch -d '3 days ago' "${work}/reboot-required"
check "the measured host, hcwadmin logged in, is a successful run" "run"
check "a session of class user is one warning line naming its user once, and the wait" \
  "[ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: a user is logged in \\(hcwadmin\\); ${pending}\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "every listed session's class was read" \
  "[ \"\$(grep -c '^show-session ' '${work}/loginctl.log')\" -eq 3 ]" \
  "$(cat "${work}/loginctl.log")"
check "docker is not asked while a user is logged in" "[ ! -s '${work}/docker.log' ]"
check "a user logged in requests no reboot, writes no hold and does not wait" \
  "[ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ] && [ \"\$(slept)\" -eq 0 ]"
check "the first run that sees the marker records the marker's own time as when the reboot was first pending" \
  "[ \"\$(cat '${record}')\" = \"\$(stat -c %Y '${work}/reboot-required')\" ]" "record $(cat "${record}" 2> /dev/null || true)"

# --- The marker rewritten (another upgrade that wants a reboot): the
# reboot has still been pending since the first sight, not since today.
touch "${work}/reboot-required"
check "a marker rewritten today still reads three days pending, from the record" \
  "run && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: a user is logged in \\(hcwadmin\\); ${pending}\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "and the record keeps the first time, not the rewrite's" \
  "[ \"\$(cat '${record}')\" -lt \"\$(stat -c %Y '${work}/reboot-required')\" ]"
epoch "${overdue}" > "${record}"
check "a reboot first seen ${overdue} days ago is overdue even though the marker was rewritten today" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.err\\|deferred: a user is logged in \\(hcwadmin\\); a reboot has been pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \\(${overdue} days\\), overdue at ${overdue}: ' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
printf 'not-a-time\n' > "${record}"
touch -d '3 days ago' "${work}/reboot-required"
check "a record that is not a time is replaced by the marker's" \
  "run && grep -qE '${pending}\$' '${work}/log' && [ \"\$(cat '${record}')\" = \"\$(stat -c %Y '${work}/reboot-required')\" ]" \
  "$(cat "${work}/log")"

# --- Two SSH logins for the same user: one name in the line.
cp "${twice}" "${work}/sessions"
check "two logins for one user name that user once" \
  "run && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: a user is logged in \\(hcwadmin\\); ${pending}\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"

# --- Root at the console (class user-early) and nobody else: a person, deferred.
cp "${console}" "${work}/sessions"
check "root's console login (class user-early) defers the reboot" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: a user is logged in \\(root\\); ${pending}\$' '${work}/log' && [ ! -s '${work}/docker.log' ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"

# --- logind cannot answer: the run fails rather than taking silence for nobody.
cp "${measured}" "${work}/sessions"
touch "${work}/loginctl-fails"
check "a loginctl that cannot list the sessions fails the run rather than guessing" "! run 2> /dev/null"
check "a loginctl that cannot list the sessions is one err line, docker not asked, and no reboot" \
  "[ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: loginctl could not list the sessions' '${work}/log' && [ ! -s '${work}/docker.log' ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/loginctl-fails"
touch "${work}/show-fails"
check "a session loginctl cannot read fails the run rather than guessing" "! run 2> /dev/null"
check "a session loginctl cannot read is one err line naming it, docker not asked, and no reboot" \
  "[ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: loginctl could not read session 22,' '${work}/log' && [ ! -s '${work}/docker.log' ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/show-fails"

# --- Nobody logged in (only service managers and a background session),
# two job containers up and one that has exited: deferred, counting the two.
# Reaching docker at all is what says the managers did not count as people.
cp "${nobody}" "${work}/sessions"
printf '%s\n' '3f2a9c1d7e5b running' '8b1c0d2e4f6a paused' '1a2b3c4d5e6f exited' > "${work}/containers"
check "job containers up are a successful run" "run"
check "job containers up are one warning line with their count (an exited one not among them) and the wait" \
  "[ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 2 job container\\(s\\) up; ${pending}\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "the host daemon was asked once, for the agent's label in every state that is up or about to be" \
  "[ \"\$(asked docker.log)\" -eq 1 ] && grep -qxF 'ps -q --filter label=${label} ${up_filters}' '${work}/docker.log'" \
  "$(cat "${work}/docker.log")"
check "job containers up request no reboot, write no hold and do not wait" \
  "[ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ] && [ \"\$(slept)\" -eq 0 ]"

# --- A job container created and not started yet (review of #1191): plain
# `docker ps` would not list it; it is a job about to run, so it defers.
printf '%s\n' '9a8b7c6d5e4f created' > "${work}/containers"
check "a job container created and not yet started defers the reboot" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 1 job container\\(s\\) up; ${pending}\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
: > "${work}/containers"

# --- docker cannot answer: the run fails (so the unit fails and the notifier reports it), no reboot.
touch "${work}/docker-fails"
check "a docker that cannot answer fails the run rather than guessing" "! run 2> /dev/null"
check "a docker that cannot answer is one err line and no reboot" \
  "[ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: docker could not list the job containers' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/docker-fails"

# --- docker not found: the same failed check, not "no job container".
touch "${work}/docker-missing"
check "a docker the shell cannot find fails the run rather than reading as no job" "! run 2> /dev/null"
check "a docker the shell cannot find is one err line and no reboot" \
  "[ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: docker could not list the job containers' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/docker-missing"

# --- A Coder workspace up on the sandbox daemon (review of #1191): nobody
# has a logind session and no job runs, but a person may be working in it.
printf '%s\n' 'c0de1a2b3c4d running' 'c0de5e6f7a8b exited' > "${work}/workspaces"
check "a Coder workspace up defers the reboot, one warning line with the count (the exited one not among it)" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 1 Coder workspace\\(s\\) up; ${pending}\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ]" \
  "$(cat "${work}/log")"
check "the sandbox daemon was asked once, through its own socket, for the workspace label" \
  "[ \"\$(sandbox_asks)\" -eq 1 ] && grep -qxF -- '--host unix://${ws_sock} ps -q --filter label=${ws_label} ${up_filters}' '${work}/docker.log'" \
  "$(cat "${work}/docker.log")"
: > "${work}/workspaces"
touch "${work}/workspaces-fail"
check "a sandbox daemon that is there and cannot answer fails the run, with an err line and no reboot" \
  "! run 2> /dev/null && [ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: the Coder sandbox daemon could not list its workspaces' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rm -f "${work}/workspaces-fail"
rm -f "${ws_sock}"
check "with no sandbox socket (Coder off) the sandbox is not asked, and the idle host reboots" \
  "run && [ \"\$(sandbox_asks)\" -eq 0 ] && [ \"\$(reboots)\" -eq 1 ]" \
  "$(cat "${work}/log"); $(cat "${work}/docker.log")"
rm -f "${hold}"
: > "${ws_sock}"

# --- Idle, with the lingering managers and a background session still
# listed: the hold written, the settle waited, all three asked again, one
# warning line saying so and how long it waited, exactly one reboot, the
# hold kept.
before="$(date -u +%s)"
check "an idle host is a successful run" "run"
after="$(date -u +%s)"
check "an idle host is one warning line saying it reboots, how long it waited, and that it looked twice" \
  "[ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|rebooting; pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \\(3 days\\): nobody is logged in and no job container or Coder workspace is up, at two looks ${settle} s apart with new lab jobs held between\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "an idle host requests exactly one reboot, through systemctl" \
  "[ \"\$(reboots)\" -eq 1 ] && grep -qxF 'reboot' '${work}/systemctl.log'" \
  "$(cat "${work}/systemctl.log")"
check "it waited once, for the role's settle, between the two looks, and asked logind and both daemons at each" \
  "[ \"\$(slept)\" -eq 1 ] && grep -qxF '${settle}' '${work}/sleep.log' && [ \"\$(host_asks)\" -eq 2 ] && [ \"\$(sandbox_asks)\" -eq 2 ] && [ \"\$(grep -c '^list-sessions ' '${work}/loginctl.log')\" -eq 2 ]" \
  "slept $(cat "${work}/sleep.log" 2> /dev/null || true); docker $(cat "${work}/docker.log")"
held_until="$(sed -n 1p "${work}/hold-during" 2> /dev/null || true)"
held_mode="$(sed -n 2p "${work}/hold-during" 2> /dev/null || true)"
check "during the wait the hold held an expiry hardening_reboot_hold_seconds from its write" \
  "[ -n '${held_until}' ] && [ '${held_until}' != absent ] && [ '${held_until}' -ge \$(( before + hold_seconds )) ] && [ '${held_until}' -le \$(( after + hold_seconds )) ]" \
  "hold said '${held_until}', run between ${before} and ${after}, hold ${hold_seconds} s"
check "the hold is readable by the agent's user and written by root alone (0644)" "[ '${held_mode}' = 644 ]" "mode ${held_mode}"
check "on the reboot path the hold stays, so no claim lands before the manager stops the agent" \
  "[ -e '${hold}' ] && [ ! -e '${hold}.new' ]"
rm -f "${hold}"

# --- The interleaving (CodeRabbit on #1191): a job container that a claim
# already in flight starts while the hold is in force. The first look found
# nothing; the second sees it and defers.
printf '%s\n' '5c6d7e8f9a0b running' > "${work}/during-container"
check "a job container that appears during the hold is a successful run" "run"
check "a job container that appears during the hold defers the reboot, one warning line with its count" \
  "[ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 1 job container\\(s\\) started while new lab jobs were held; ${pending}\$' '${work}/log'" \
  "$(cat "${work}/log")"
check "a job container that appears during the hold requests no reboot" "[ \"\$(reboots)\" -eq 0 ]"
check "the hold was in force while the container appeared, and is removed once the night is deferred" \
  "[ \"\$(sed -n 1p '${work}/hold-during')\" != absent ] && [ ! -e '${hold}' ] && [ ! -e '${hold}.new' ]"
: > "${work}/containers"
# The same, with the container made and not started yet at the second look.
printf '%s\n' '5c6d7e8f9a0c created' > "${work}/during-container"
check "a job container created but not yet started at the second look defers the reboot" \
  "run && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 1 job container\\(s\\) started while new lab jobs were held; ${pending}\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ]" \
  "$(cat "${work}/log")"
rm -f "${work}/during-container"
: > "${work}/containers"

# --- A workspace started during the hold: the second look asks the sandbox again.
printf '%s\n' 'c0de9a8b7c6d running' > "${work}/during-workspace"
check "a Coder workspace that starts during the hold defers the reboot" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 1 Coder workspace\\(s\\) started while new lab jobs were held; ${pending}\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ]" \
  "$(cat "${work}/log")"
rm -f "${work}/during-workspace"
: > "${work}/workspaces"

# --- A user who logs in during the hold: the second look sees the session.
printf '%s\n' '402 1000 hcwadmin         - 3924100 user          - no -' > "${work}/during-session"
check "a login during the hold defers the reboot, naming the user" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: a user logged in while new lab jobs were held \\(hcwadmin\\); ${pending}\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ]" \
  "$(cat "${work}/log")"
check "neither daemon is asked again once the login has deferred the night" \
  "[ \"\$(host_asks)\" -eq 1 ] && [ \"\$(sandbox_asks)\" -eq 1 ]"
rm -f "${work}/during-session"
cp "${nobody}" "${work}/sessions"

# --- docker cannot answer at the second look: a failed run, the hold removed.
touch "${work}/docker-fails-second"
check "a docker that fails at the second look fails the run, with the hold removed and no reboot" \
  "! run 2> /dev/null && [ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: docker could not list the job containers' '${work}/log' && [ \"\$(reboots)\" -eq 0 ] && [ ! -e '${hold}' ]" \
  "$(cat "${work}/log")"
rm -f "${work}/docker-fails-second"

# --- A stop during the hold (TimeoutStartSec, systemctl stop, or the
# reboot's stop job): the run ends with 143, which the unit counts as a
# success, the hold goes with it, nothing reboots.
touch "${work}/during-term"
status=0
run 2> /dev/null || status=$?
check "a stop during the hold exits 143, removes the hold, and reboots nothing" \
  "[ '${status}' -eq 143 ] && [ ! -e '${hold}' ] && [ \"\$(reboots)\" -eq 0 ] && [ \"\$(grep -c '^list-sessions ' '${work}/loginctl.log')\" -eq 1 ]" \
  "exit ${status}; $(cat "${work}/log")"
rm -f "${work}/during-term"

# --- The hold cannot be written (something is in the way of its temporary
# file): no second look could be trusted, so the run fails before it waits.
mkdir -p "${hold}.new"
check "a hold that cannot be written fails the run before it waits, and reboots nothing" \
  "! run 2> /dev/null && [ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: the hold that keeps new lab jobs from starting could not be written' '${work}/log' && [ \"\$(slept)\" -eq 0 ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
rmdir "${hold}.new"

# --- The record cannot be written (its directory is gone): how long the
# reboot has waited cannot be told, so the run fails before it asks
# anything. rm -r, not rmdir, so a script that left a hold behind still
# reaches this case.
rm -rf "$(dirname "${hold}")"
check "a first-seen record that cannot be written fails the run before any question, and reboots nothing" \
  "! run 2> /dev/null && [ \"\$(lines)\" -eq 1 ] && grep -q '^${tag}|daemon.err|not rebooting: the record of when this reboot was first seen could not be written' '${work}/log' && [ ! -s '${work}/loginctl.log' ] && [ \"\$(slept)\" -eq 0 ] && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
mkdir -p "$(dirname "${hold}")"

# --- The manager refuses the reboot: a failed run, and the hold released,
# since nothing is coming to stop the agent.
touch "${work}/systemctl-fails"
check "a reboot the manager refuses fails the run and releases the hold" \
  "! run 2> /dev/null && [ \"\$(reboots)\" -eq 1 ] && [ ! -e '${hold}' ]" \
  "$(cat "${work}/log")"
rm -f "${work}/systemctl-fails"

# --- Overdue: a reboot pending hardening_reboot_overdue_days or more is
# deferred at err, with what to do; one day less is still a warning. Only
# the line changes: nothing reboots over a person, a job or a workspace.
# Each case is a fresh pending reboot, so the record goes with the marker.
cp "${measured}" "${work}/sessions"
rm -f "${record}"
touch -d "${overdue} days ago" "${work}/reboot-required"
check "a reboot pending ${overdue} days, deferred for a login, is one err line saying it is overdue and what to do" \
  "run && [ \"\$(lines)\" -eq 1 ] && grep -qE '^${tag}\\|daemon\\.err\\|deferred: a user is logged in \\(hcwadmin\\); a reboot has been pending since [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z \\(${overdue} days\\), overdue at ${overdue}: log out before ${reboot_time}, or reboot at a time of your choosing \\(docs/runbooks/labs-host\\.md, Runtime advisories\\)\$' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
cp "${nobody}" "${work}/sessions"
printf '%s\n' '3f2a9c1d7e5b running' > "${work}/containers"
check "an overdue reboot deferred for a job is an err line too, and still no reboot" \
  "run && grep -qE '^${tag}\\|daemon\\.err\\|deferred: 1 job container\\(s\\) up; .*overdue at ${overdue}' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
: > "${work}/containers"
printf '%s\n' 'c0de1a2b3c4d running' > "${work}/workspaces"
check "an overdue reboot deferred for a workspace left running is an err line, and still no reboot" \
  "run && grep -qE '^${tag}\\|daemon\\.err\\|deferred: 1 Coder workspace\\(s\\) up; .*overdue at ${overdue}' '${work}/log' && [ \"\$(reboots)\" -eq 0 ]" \
  "$(cat "${work}/log")"
: > "${work}/workspaces"
printf '%s\n' '3f2a9c1d7e5b running' > "${work}/containers"
rm -f "${record}"
touch -d "$(( overdue - 1 )) days ago" "${work}/reboot-required"
check "a day short of overdue, the same deferral is still a warning" \
  "run && grep -qE '^${tag}\\|daemon\\.warning\\|deferred: 1 job container\\(s\\) up; a reboot has been pending since .* \\($(( overdue - 1 )) days\\)\$' '${work}/log'" \
  "$(cat "${work}/log")"
: > "${work}/containers"
rm -f "${record}"
touch -d '3 days ago' "${work}/reboot-required"

# --- No sessions at all is idle too.
: > "${work}/sessions"
check "a host with no sessions at all reboots, once" \
  "run && [ \"\$(reboots)\" -eq 1 ] && grep -q '|daemon.warning|rebooting; pending since ' '${work}/log'" \
  "$(cat "${work}/log")"

if [ "${failed}" -ne 0 ]; then
  echo "hcw-reboot-when-idle.test.sh: ${failed} of $((passed + failed)) checks failed" >&2
  exit 1
fi
echo "hcw-reboot-when-idle.test.sh: all ${passed} checks passed"
