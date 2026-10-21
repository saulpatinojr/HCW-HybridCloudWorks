#!/usr/bin/env bash
# Tests that the portainer role restarts a Portainer container that started
# before the Docker daemon's current start (#1328).
#
# Portainer holds the daemon's socket as a bind-mounted FILE
# (/var/run/docker.sock:/var/run/docker.sock). A daemon restart, which a
# docker-ce upgrade causes, unlinks and recreates that file, and a Portainer
# that was already running keeps the old inode: it still answers, but its
# `local` environment (this host's Docker) reads down. The 2026-10-21 bootstrap
# (Docker 29.9.1 -> 29.9.2, #1324) left it so for three runs of the 15-minute
# check, until `sudo docker restart portainer`. The labs agent's socket proxy
# had the same fault (#1135) and the same cure: ask
# /usr/local/libexec/hcw-docker-proxy-stale whether the container predates the
# daemon, and restart it only then. This role installs that helper from the
# labs_agent role's files, so there is one copy to keep right.
#
# Two kinds of check, because neither alone is enough. The role's files are
# read for the wiring (the restart is tied to the answer, the answer is asked
# before the container task, the helper the role installs exists). The helper is
# run, with stand-ins for systemctl and docker and the real GNU date, against
# the container name this role actually uses, so "stale" is shown to follow from
# a Portainer older than the daemon.
#
# Needs no root, no Docker and no Ansible: bash, awk and GNU date. CI runs it in
# the `ansible-lint (lab-host)` job; on a workstation, bash:
#   bash lab-host/ansible/roles/portainer/tests/portainer-stale-socket.test.sh
#
# Each check is a single-quoted or escaped string that `check` evaluates, and
# the task blocks are read inside those strings, so shellcheck sees them as
# neither expanding (SC2016) nor used (SC2034). Both are by design.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
role="$(cd "${here}/.." && pwd)"
tasks="${role}/tasks/main.yml"
role_vars="${role}/vars/main.yml"
defaults="${role}/defaults/main.yml"
helper="${role}/../labs_agent/files/hcw-docker-proxy-stale"
labs_proxy_tasks="${role}/../labs_agent/tasks/docker_proxy.yml"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

# One top-level task of tasks/main.yml, from its `- name:` line to the next.
task_block() {
  awk -v name="$1" '$0 == "- name: " name { found = 1; print; next } found && /^- name: / { exit } found { print }' "${tasks}"
}
# The line a top-level task starts on, or 0 when there is no such task.
task_line() { grep -n -F -x -- "- name: $1" "${tasks}" | head -1 | cut -d: -f1 | grep . || echo 0; }

install_name="Install the container staleness check"
ask_name="Ask whether a running Portainer predates the daemon's current start"
record_name="Record whether Portainer must be restarted onto the daemon's new socket"
run_name="Run Portainer, published on the host's loopback only"
say_name="Say that Portainer was restarted onto the daemon's new socket"

# ---- the helper the role installs ---------------------------------------------------

check "the helper the role installs exists in the labs_agent role's files" \
  "[ -f '${helper}' ]"
check "the helper is valid bash" \
  "bash -n '${helper}'"
labs_dest="$(sed -n 's/^[[:space:]]*dest:[[:space:]]*\(\/usr\/local\/libexec\/hcw-docker-proxy-stale\)[[:space:]]*$/\1/p' "${labs_proxy_tasks}" | head -1)"
check "the role installs it where the labs_agent role does, so the two roles write one identical file" \
  "[ -n '${labs_dest}' ] && grep -qF 'portainer_stale_helper_dest: ${labs_dest}' '${role_vars}'"
check "vars name the labs_agent helper as the source, through role_path like the other roles that read a sibling's file" \
  "grep -qE '^portainer_stale_helper_source:[[:space:]]*\"\{\{ role_path \}\}/\.\./labs_agent/files/hcw-docker-proxy-stale\"' '${role_vars}'"

# ---- the wiring in tasks/main.yml ---------------------------------------------------

install_block="$(task_block "${install_name}")"
check "a task installs the helper from the source var, root-owned and executable" \
  "grep -qF 'src: \"{{ portainer_stale_helper_source }}\"' <<<\"\${install_block}\" && grep -qF 'dest: \"{{ portainer_stale_helper_dest }}\"' <<<\"\${install_block}\" && grep -qF 'mode: \"0755\"' <<<\"\${install_block}\" && grep -qF 'portainer_enabled | bool' <<<\"\${install_block}\""

ask_block="$(task_block "${ask_name}")"
check "a task asks the helper about the container this role runs, reads nothing it changes, and is skipped in check mode" \
  "grep -qF -- '- \"{{ portainer_stale_helper_dest }}\"' <<<\"\${ask_block}\" && grep -qF -- '- \"{{ portainer_container_name }}\"' <<<\"\${ask_block}\" && grep -qF 'changed_when: false' <<<\"\${ask_block}\" && grep -qF 'not ansible_check_mode' <<<\"\${ask_block}\""

record_block="$(task_block "${record_name}")"
check "the answer becomes portainer_stale only when the helper said exactly stale" \
  "grep -qF 'portainer_stale:' <<<\"\${record_block}\" && grep -qF \"== 'stale'\" <<<\"\${record_block}\" && grep -qF 'not ansible_check_mode' <<<\"\${record_block}\""

run_block="$(task_block "${run_name}")"
check "the container task restarts Portainer when, and only when, portainer_stale says so" \
  "grep -qF 'restart: \"{{ portainer_stale | bool }}\"' <<<\"\${run_block}\""
check "the container task still publishes on the loopback and keeps the socket mount (the restart is added, nothing else moved)" \
  "grep -qF 'published_ports:' <<<\"\${run_block}\" && grep -qF -- '- \"{{ portainer_published_port }}\"' <<<\"\${run_block}\" && grep -qF -- '- /var/run/docker.sock:/var/run/docker.sock' <<<\"\${run_block}\""

say_block="$(task_block "${say_name}")"
check "the run says so when it restarted Portainer, naming the cause" \
  "grep -qF 'portainer_stale | bool' <<<\"\${say_block}\" && grep -qi 'docker' <<<\"\${say_block}\" && grep -qF 'ansible.builtin.debug' <<<\"\${say_block}\""

install_at="$(task_line "${install_name}")"
ask_at="$(task_line "${ask_name}")"
record_at="$(task_line "${record_name}")"
run_at="$(task_line "${run_name}")"
say_at="$(task_line "${say_name}")"
check "the answer is asked and recorded before the container task decides, and the message follows it" \
  "[ ${install_at} -gt 0 ] && [ ${install_at} -lt ${ask_at} ] && [ ${ask_at} -lt ${record_at} ] && [ ${record_at} -lt ${run_at} ] && [ ${run_at} -lt ${say_at} ]" \
  "line numbers: install ${install_at}, ask ${ask_at}, record ${record_at}, run ${run_at}, say ${say_at}"

# ---- the helper, run against the name this role uses --------------------------------

container="$(sed -n 's/^portainer_container_name:[[:space:]]*\([A-Za-z0-9_.-]*\)[[:space:]]*$/\1/p' "${defaults}" | head -1)"
check "the role's default container name is read, so the checks below follow the role" \
  "[ -n '${container}' ]"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
bin="${work}/bin"
mkdir -p "${bin}"
cat > "${bin}/systemctl" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2 $3 $4 $5" = "show docker.service --property=ActiveEnterTimestamp --value --timestamp=utc" ] || { echo "unexpected systemctl $*" >&2; exit 2; }
echo "${FAKE_DAEMON_AT-Wed 2026-10-21 12:00:00 UTC}"
EOF
cat > "${bin}/docker" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "inspect --format" ] || { echo "unexpected docker $*" >&2; exit 2; }
[ -z "${FAKE_NO_CONTAINER:-}" ] || { echo "Error: No such object: $4" >&2; exit 1; }
echo "${FAKE_CONTAINER_STATE-true 2026-10-21T12:00:05.000000000Z}"
EOF
chmod 0755 "${bin}/systemctl" "${bin}/docker"
ask() { PATH="${bin}:${PATH}" bash "${helper}" "${container}"; }

check "a Portainer that started before Docker's current start is stale, which is what restarts it" \
  '[ "$(FAKE_CONTAINER_STATE="true 2026-10-20T08:00:00.000000000Z" ask)" = stale ]'
check "a Portainer that started after Docker's current start is fresh, so a normal run does not restart it" \
  '[ "$(ask)" = fresh ]'
check "a Portainer that is not running is absent, which the container task starts without a restart" \
  '[ "$(FAKE_CONTAINER_STATE="false 2026-10-20T08:00:00.000000000Z" ask)" = absent ]'
check "a host with no Portainer yet is absent" \
  '[ "$(FAKE_NO_CONTAINER=1 ask)" = absent ]'

echo
echo "${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
