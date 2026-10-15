#!/usr/bin/env bash
# Tests ../files/hcw-labjob-sweep, which the labs_agent role installs as
# /usr/local/libexec/hcw-labjob-sweep and hcw-labs-agent.service runs as root
# before the agent starts and after it exits, so a lab job container the
# agent did not finish removing is never left running beside the next job
# (CodeRabbit on #1188). Run against a stand-in for docker that records each
# call.
#
# What it holds: only containers with the agent's job label are listed, the
# label is the one vps-agent/lib/docker-runner.js stamps, the daemon's own
# socket is used rather than the agent's proxy, nothing is removed when
# nothing is labelled, every labelled container is removed in one call, and
# a listing or removal Docker refuses fails the run.
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

# The stand-in logs each call with the DOCKER_HOST it saw. `ps` answers only
# the exact label filter, so a sweep that listed every container, or none,
# fails here. FAKE_IDS is the listing; FAKE_PS_FAIL and FAKE_RM_FAIL make
# that call fail the way the CLI does when the daemon refuses.
cat > "${bin}/docker" <<'EOF'
#!/usr/bin/env bash
echo "DOCKER_HOST=${DOCKER_HOST:-} $*" >> "${FAKE_LOG}"
case "$1" in
  ps)
    [ "$*" = "ps --all --quiet --filter label=hcw.lab-job" ] || { echo "unexpected docker $*" >&2; exit 2; }
    [ -z "${FAKE_PS_FAIL:-}" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    [ -z "${FAKE_IDS:-}" ] || printf '%s\n' ${FAKE_IDS}
    ;;
  rm)
    [ -z "${FAKE_RM_FAIL:-}" ] || { echo "Error response from daemon" >&2; exit 1; }
    ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
EOF
chmod +x "${bin}/docker"

# run [ENV=VALUE...]: the sweep with the stand-in first on PATH and the
# unit's proxy DOCKER_HOST set, as systemd sets it; output in ${out},
# exit code in ${code}, the stand-in's calls in ${log}.
run() {
  log="${work}/calls.$((passed + failed))"
  : > "${log}"
  set +e
  out="$(env PATH="${bin}:${PATH}" FAKE_LOG="${log}" DOCKER_HOST=unix:///run/hcw-labs-agent/docker.sock "$@" bash "${sweep}" 2>&1)"
  code=$?
  set -e
}

check "the sweep filters on the label the runner stamps on every job container" \
  "grep -qF \"export const JOB_LABEL = 'hcw.lab-job';\" '${runner}' && grep -qxF 'label=hcw.lab-job' '${sweep}'"

run
check "nothing labelled: exits 0, prints nothing" "[ ${code} -eq 0 ] && [ -z '${out}' ]" "exit ${code}, output: ${out}"
check "nothing labelled: no removal is asked for" "! grep -q ' rm ' '${log}'" "$(cat "${log}")"
check "the daemon's own socket is used, not the agent's proxy" \
  "grep -qxF 'DOCKER_HOST=unix:///var/run/docker.sock ps --all --quiet --filter label=hcw.lab-job' '${log}'" "$(cat "${log}")"

run FAKE_IDS="3f2a9c1b7d4e 9e8d7c6b5a41"
check "two orphans: exits 0" "[ ${code} -eq 0 ]" "exit ${code}, output: ${out}"
check "two orphans: both are removed in one forced call" \
  "grep -qxF 'DOCKER_HOST=unix:///var/run/docker.sock rm --force 3f2a9c1b7d4e 9e8d7c6b5a41' '${log}'" "$(cat "${log}")"
check "two orphans: the journal line is a count, with no ids" \
  "[ '${out}' = 'removed 2 lab job container(s) that no agent owned' ]" "output: ${out}"

run FAKE_PS_FAIL=1
check "a listing Docker refuses fails the run" "[ ${code} -ne 0 ]" "exit ${code}"
check "a listing Docker refuses removes nothing" "! grep -q ' rm ' '${log}'" "$(cat "${log}")"

run FAKE_IDS="3f2a9c1b7d4e" FAKE_RM_FAIL=1
check "a removal Docker refuses fails the run" "[ ${code} -ne 0 ]" "exit ${code}, output: ${out}"

echo "# ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
