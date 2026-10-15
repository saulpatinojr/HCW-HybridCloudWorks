#!/usr/bin/env bash
# Tests ../files/hcw-labjob-sweep, which the labs_agent role installs as
# /usr/local/libexec/hcw-labjob-sweep and hcw-labs-agent.service runs as root
# before the agent starts and after it exits, so a lab job container the
# agent did not finish removing is never left running beside the next job
# (CodeRabbit on #1188). Run against a stand-in for docker that keeps its
# containers in a state file and records each call.
#
# What it holds: only containers with the agent's job label are listed, the
# label is the one vps-agent/lib/docker-runner.js stamps, the daemon's own
# socket is used rather than the agent's proxy, nothing is removed when
# nothing is labelled, every labelled container is removed in one call, a
# removal Docker answers with "already in progress" is not a failure once
# the container is gone, a container still running at the deadline fails
# the run, a stopped one Docker cannot remove only warns, a listing Docker
# refuses fails the run, and no journal line carries an id.
#
# Needs no root and no Docker: bash only. CI runs it in the
# `ansible-lint (lab-host)` job; on a workstation, bash:
#   bash lab-host/ansible/roles/labs_agent/tests/hcw-labjob-sweep.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sweep="${here}/../files/hcw-labjob-sweep"
runner="$(cd "${here}/../../../../.." && pwd)/vps-agent/lib/docker-runner.js"

passed=0
failed=0
# ok NAME: count and print a passing check, TAP style.
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
# not_ok NAME [DETAIL]: count and print a failing check, with its detail indented.
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
# check NAME COMMAND [DETAIL]: run COMMAND through eval and report it as ok or not ok.
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
bin="${work}/bin"
mkdir -p "${bin}"

# The stand-in's containers are lines of `<id> <status>` in FAKE_STATE, all
# carrying the job label. It logs each call with the DOCKER_HOST it saw and
# answers only the exact filters the sweep may use, so a sweep that listed
# every container fails here. FAKE_RM decides what a removal does:
#   ok        the containers go, exit 0
#   conflict  exit 1 with Docker's "already in progress", and they go anyway,
#             as when another remover finishes
#   stuck     exit 1, nothing goes
# FAKE_PS_FAIL makes the listing fail as the CLI does when the daemon refuses.
cat > "${bin}/docker" <<'EOF'
#!/usr/bin/env bash
echo "DOCKER_HOST=${DOCKER_HOST:-} $*" >> "${FAKE_LOG}"
case "$*" in
  "ps --all --quiet --filter label=hcw.lab-job")
    [ -z "${FAKE_PS_FAIL:-}" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    cut -d' ' -f1 "${FAKE_STATE}"
    ;;
  "ps --quiet --filter label=hcw.lab-job --filter status=running --filter status=restarting --filter status=paused")
    grep -E ' (running|restarting|paused)$' "${FAKE_STATE}" | cut -d' ' -f1 || true
    ;;
  "rm --force "*)
    shift 2
    case "${FAKE_RM:-ok}" in
      ok|conflict)
        for id in "$@"; do grep -v "^${id} " "${FAKE_STATE}" > "${FAKE_STATE}.next" || true; mv "${FAKE_STATE}.next" "${FAKE_STATE}"; done
        [ "${FAKE_RM:-ok}" = ok ] || { echo "Error response from daemon: removal of container $1 is already in progress" >&2; exit 1; }
        ;;
      stuck) echo "Error response from daemon: cannot remove container: device or resource busy" >&2; exit 1 ;;
    esac
    ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
EOF
chmod +x "${bin}/docker"

# run CONTAINERS [ENV=VALUE...]: the sweep against a stand-in holding
# CONTAINERS (`id status` pairs, comma-separated), with the unit's proxy
# DOCKER_HOST set as systemd sets it and a 2 s deadline. Leaves stdout in
# ${out}, stderr in ${err}, the exit code in ${code}, the stand-in's calls
# in ${log} and its final containers in ${state}.
run() {
  local n=$((passed + failed))
  log="${work}/calls.${n}"
  state="${work}/state.${n}"
  : > "${log}"
  printf '%s' "$1" | tr ',' '\n' | sed '/^$/d' > "${state}"
  shift
  set +e
  out="$(env PATH="${bin}:${PATH}" FAKE_LOG="${log}" FAKE_STATE="${state}" HCW_LABJOB_SWEEP_DEADLINE_S=2 \
    DOCKER_HOST=unix:///run/hcw-labs-agent/docker.sock "$@" bash "${sweep}" 2> "${work}/err")"
  code=$?
  set -e
  err="$(cat "${work}/err")"
}

check "the sweep filters on the label the runner stamps on every job container" \
  "grep -qF \"export const JOB_LABEL = 'hcw.lab-job';\" '${runner}' && grep -qxF 'label=hcw.lab-job' '${sweep}'"

run ''
check "nothing labelled: exits 0, prints nothing" "[ ${code} -eq 0 ] && [ -z \"\${out}\${err}\" ]" "exit ${code}, out: ${out}, err: ${err}"
check "nothing labelled: no removal is asked for" "! grep -q ' rm ' '${log}'" "$(cat "${log}")"
check "the daemon's own socket is used, not the agent's proxy" \
  "grep -qxF 'DOCKER_HOST=unix:///var/run/docker.sock ps --all --quiet --filter label=hcw.lab-job' '${log}'" "$(cat "${log}")"

run '3f2a9c1b7d4e running,9e8d7c6b5a41 exited'
check "two orphans: exits 0 with both gone" "[ ${code} -eq 0 ] && [ ! -s '${state}' ]" "exit ${code}, err: ${err}"
check "two orphans: both are removed in one forced call on the daemon's socket" \
  "grep -qxF 'DOCKER_HOST=unix:///var/run/docker.sock rm --force 3f2a9c1b7d4e 9e8d7c6b5a41' '${log}'" "$(cat "${log}")"
check "two orphans: the journal line is a count, with no ids" \
  "[ \"\${out}\" = 'removed 2 lab job container(s) that no agent owned' ]" "out: ${out}"

run '3f2a9c1b7d4e running' FAKE_RM=conflict
check "a removal already in progress elsewhere is not a failure once the container is gone" \
  "[ ${code} -eq 0 ] && [ \"\${out}\" = 'removed 1 lab job container(s) that no agent owned' ]" "exit ${code}, out: ${out}, err: ${err}"

run '3f2a9c1b7d4e running' FAKE_RM=stuck
check "a container still running at the deadline fails the run" "[ ${code} -ne 0 ]" "exit ${code}, err: ${err}"
check "and says how many, with no id" \
  "[ \"\${err}\" = '1 lab job container(s) still running after the sweep; the next lab job may run beside them' ]" "err: ${err}"
check "and asked Docker again before the deadline rather than once" \
  "[ \"\$(grep -c ' rm --force ' '${log}')\" -ge 2 ]" "$(cat "${log}")"

run '3f2a9c1b7d4e dead' FAKE_RM=stuck
check "a stopped container Docker cannot remove only warns" "[ ${code} -eq 0 ]" "exit ${code}, err: ${err}"
check "and the warning is a count, with no id" \
  "[ \"\${err}\" = 'removed lab job containers that no agent owned; 1 stopped one(s) could not be removed and hold no CPU or memory' ]" "err: ${err}"

run '3f2a9c1b7d4e running' FAKE_PS_FAIL=1
check "a listing Docker refuses fails the run" "[ ${code} -ne 0 ]" "exit ${code}"
check "a listing Docker refuses removes nothing" "! grep -q ' rm ' '${log}'" "$(cat "${log}")"

echo "# ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
