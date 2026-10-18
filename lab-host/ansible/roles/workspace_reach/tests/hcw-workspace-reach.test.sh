#!/usr/bin/env bash
# Tests ../files/hcw-workspace-reach, which the workspace_reach role installs
# as /usr/local/libexec/hcw-workspace-reach and runs at every bootstrap and
# every 15 minutes (#1267). It is run here against a stand-in for `docker`
# that records every call and answers as the sandbox daemon would, so the
# test holds:
#
#   - the container's shape: the workspace's uid, no capabilities, no
#     privilege gain, no nameserver of its own, nothing pulled;
#   - its creation in the provider's order (on the default bridge, then
#     disconnected and connected to its own network, then started), which is
#     what decides the nameservers it keeps. `docker run --network` resolved
#     on the very host where no workspace could;
#   - the URLs reaching the container as environment, never as script;
#   - each failure's message, the retries, and the clean-up.
#
# Needs no root and no Docker: bash, flock and mktemp. CI runs it in the
# `ansible-lint (lab-host)` job; on a workstation, bash:
#   bash lab-host/ansible/roles/workspace_reach/tests/hcw-workspace-reach.test.sh
#
# Each check's condition is single-quoted on purpose: check() evaluates it
# after the run it tests, so its variables are read there.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/../files/hcw-workspace-reach"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
bin="${work}/bin"
mkdir -p "${bin}"

HOST=unix:///run/hcw-coder-docker/docker.sock
IMAGE=docker.io/hybridcloudworks/hcw-lab@sha256:4efe1c369b151269e1782027556f233b20faed1f39e8ccdd54bab81c1ee5323a
CODER=https://coder.lab.hybridcloudworks.com
REPO=https://github.com/saulpatinojr/HCW-HybridCloudWorks.git

# The stand-in. Each call is one line of the log, its arguments separated by
# a tab and any newline in an argument written as \n. `start --attach` exits
# with the next status in FAKE_START_STATUSES, one per call (0 when the list
# runs out).
cat > "${bin}/docker" <<'EOF'
#!/usr/bin/env bash
args=()
for arg in "$@"; do args+=("${arg//$'\n'/\\n}"); done
(IFS=$'\t'; echo "${args[*]}") >> "${FAKE_DOCKER_LOG}"
[ "$1" = "-H" ] || { echo "no -H" >&2; exit 2; }
shift 2
case "$1 ${2:-}" in
  "version --format")
    if [ -n "${FAKE_DAEMON_DOWN:-}" ]; then echo "Cannot connect to the Docker daemon at unix:///run/hcw-coder-docker/docker.sock" >&2; exit 1; fi
    echo 29.9.1 ;;
  "image inspect") [ -z "${FAKE_IMAGE_MISSING:-}" ] ;;
  "rm -f") exit 0 ;;
  "network rm") exit 0 ;;
  "network create")
    if [ -n "${FAKE_NETWORK_CREATE_FAIL:-}" ]; then echo "Error response from daemon: all predefined address pools have been fully subnetted" >&2; exit 1; fi
    echo 4f1e2d3c4b5a ;;
  "network disconnect") exit 0 ;;
  "network connect") exit 0 ;;
  "create "*) echo 9e9e9e9e9e9e ;;
  "start --attach")
    n=$(cat "${FAKE_START_COUNT}" 2>/dev/null || echo 0); n=$((n + 1)); echo "${n}" > "${FAKE_START_COUNT}"
    read -r -a statuses <<< "${FAKE_START_STATUSES:-0}"
    exit "${statuses[$((n - 1))]:-0}" ;;
  *) echo "unexpected docker $*" >&2; exit 2 ;;
esac
EOF
chmod +x "${bin}/docker"

# One run of the script with a fresh log; its output in ${out}, exit in ${rc}.
run() {
  export FAKE_DOCKER_LOG="${work}/docker.log" FAKE_START_COUNT="${work}/starts"
  : > "${FAKE_DOCKER_LOG}"
  rm -f "${FAKE_START_COUNT}"
  set +e
  out=$(env PATH="${bin}:${PATH}" HCW_REACH_WAIT=0 "$@" bash "${script}" "${HOST}" "${IMAGE}" "${CODER}/" "${REPO}" 2>&1)
  rc=$?
  set -e
}
# How many calls began with the words $1 (after -H <host>).
calls() { cut -f3- "${FAKE_DOCKER_LOG}" | tr '\t' ' ' | grep -c "^$1" || true; }
# The log line, and the line number, of the first call that began with $1.
call() { awk -v want="$1" '{ line = $0; sub(/^[^\t]*\t[^\t]*\t/, "", line); gsub(/\t/, " ", line) } index(line, want) == 1 { print $0; exit }' "${FAKE_DOCKER_LOG}"; }
line_of() { awk -v want="$1" '{ line = $0; sub(/^[^\t]*\t[^\t]*\t/, "", line); gsub(/\t/, " ", line) } index(line, want) == 1 { print NR; exit }' "${FAKE_DOCKER_LOG}"; }
has_arg() { printf '%s\n' "$1" | tr '\t' '\n' | grep -qxF -- "$2"; }
# Whether the call in $1 passes the flag $2 with the value $3 straight after it.
has_pair() { printf '%s\n' "$1" | tr '\t' '\n' | awk -v flag="$2" -v value="$3" 'previous == flag && $0 == value { found = 1 } { previous = $0 } END { exit !found }'; }

# --- usage
set +e
out=$(bash "${script}" only two 2>&1); rc=$?
set -e
check "a wrong argument count exits 2 with the usage" '[ "${rc}" -eq 2 ] && [[ "${out}" == usage:* ]]' "${rc}: ${out}"

# --- success
run
check "success exits 0" '[ "${rc}" -eq 0 ]' "${rc}: ${out}"
check "success says OK, with the host, the agent URL and the repository" \
  '[[ "${out}" == *"workspace reach: OK: a container shaped like a workspace resolved coder.lab.hybridcloudworks.com, fetched the agent from https://coder.lab.hybridcloudworks.com/bin/coder-linux-amd64 and reached ${REPO} (attempt 1 of 3)"* ]]' "${out}"
check "every call names the sandbox daemon with -H" \
  '[ "$(awk -F"\t" "\$1 != \"-H\" || \$2 != \"${HOST}\"" "${FAKE_DOCKER_LOG}" | wc -l)" -eq 0 ]' "$(cat "${FAKE_DOCKER_LOG}")"

create_line=$(call "create --name")
for pair in "--network bridge" "--pull never" "--user 65534:65534" "--cap-drop ALL" \
  "--security-opt no-new-privileges:true" "--label hcw.workspace-reach=true" "--entrypoint sh" \
  "--env HCW_CODER_HOST=coder.lab.hybridcloudworks.com" "--env HCW_CODER_URL=${CODER}" "--env HCW_REPO_URL=${REPO}"; do
  check "the container is created with ${pair}" 'has_pair "${create_line}" ${pair}' "${create_line}"
done
check "the container runs the pinned image's sh -c" \
  'has_pair "${create_line}" sh "${IMAGE}" && has_pair "${create_line}" "${IMAGE}" -c' "${create_line}"
check "the container is given no nameserver of its own, no privilege, no mount and no published port" \
  '! printf "%s\n" "${create_line}" | tr "\t" "\n" | grep -qE "^--(dns|dns-option|privileged|volume|mount|publish|cap-add|network-alias)$|^-[vp]$"' "${create_line}"
check "the URLs reach the container as environment, not as script" \
  '! printf "%s\n" "${create_line}" | tr "\t" "\n" | sed -n "/^-c$/{n;p;}" | grep -qE "coder\.lab|github\.com"' "${create_line}"
check "the access URL reaches the container without the trailing slash it was given" \
  'has_arg "${create_line}" "HCW_CODER_URL=${CODER}" && ! has_arg "${create_line}" "HCW_CODER_URL=${CODER}/"' "${create_line}"

# The provider's order: network, create on bridge, disconnect bridge, connect
# its own, start; then everything removed.
n_network=$(line_of "network create")
n_create=$(line_of "create --name")
n_disconnect=$(line_of "network disconnect bridge hcw-workspace-reach")
n_connect=$(line_of "network connect hcw-workspace-reach hcw-workspace-reach")
n_start=$(line_of "start --attach hcw-workspace-reach")
check "it creates the network, creates on bridge, disconnects bridge, connects its own, then starts, in that order" \
  '[ -n "${n_network}" ] && [ -n "${n_start}" ] && [ "${n_network}" -lt "${n_create}" ] && [ "${n_create}" -lt "${n_disconnect}" ] && [ "${n_disconnect}" -lt "${n_connect}" ] && [ "${n_connect}" -lt "${n_start}" ]' \
  "network=${n_network} create=${n_create} disconnect=${n_disconnect} connect=${n_connect} start=${n_start}"
check "it removes the container and the network after the check" \
  '[ "$(tail -n 2 "${FAKE_DOCKER_LOG}" | cut -f3,4 | tr "\t\n" " ;")" = "rm -f;network rm;" ]' "$(tail -n 4 "${FAKE_DOCKER_LOG}")"
check "it never pulls" '[ "$(calls pull)" -eq 0 ]'

# --- the DNS failure, every attempt
run env FAKE_START_STATUSES="11 11 11"
check "a lookup that fails on every attempt exits 1" '[ "${rc}" -eq 1 ]' "${rc}: ${out}"
check "it tries three times" '[ "$(calls "start --attach")" -eq 3 ]' "$(calls "start --attach")"
check "it says each failed attempt" '[ "$(grep -c "did not come through (exit 11)" <<< "${out}")" -eq 2 ]' "${out}"
check "the DNS failure names the host, the learner's symptom, daemon.json and the firewall counters" \
  '[[ "${out}" == *"FAILED: a workspace cannot resolve coder.lab.hybridcloudworks.com"* && "${out}" == *"Agent is taking longer than expected to connect"* && "${out}" == *"/var/lib/hcw-coder-docker/.config/docker/daemon.json"* && "${out}" == *"hcw: the host resolver"* && "${out}" == *"Workspace reach"* ]]' "${out}"
check "it leaves nothing behind after a failure" '[ "$(tail -n 2 "${FAKE_DOCKER_LOG}" | cut -f3,4 | tr "\t\n" " ;")" = "rm -f;network rm;" ]'

# --- a passing second attempt is a pass
run env FAKE_START_STATUSES="11 0"
check "a check that passes on its second attempt exits 0 and says which attempt" \
  '[ "${rc}" -eq 0 ] && [[ "${out}" == *"(attempt 2 of 3)"* ]]' "${rc}: ${out}"

run env HCW_REACH_ATTEMPTS=1 FAKE_START_STATUSES="11"
check "HCW_REACH_ATTEMPTS=1 tries once" '[ "${rc}" -eq 1 ] && [ "$(calls "start --attach")" -eq 1 ]' "${rc}: ${out}"

# --- the agent and the repository
run env FAKE_START_STATUSES="12 12 12"
check "an agent download that fails names the agent URL, Caddy, Coder and the https-to-this-host rule" \
  '[ "${rc}" -eq 1 ] && [[ "${out}" == *"resolved coder.lab.hybridcloudworks.com but could not fetch https://coder.lab.hybridcloudworks.com/bin/coder-linux-amd64"* && "${out}" == *"caddy"* && "${out}" == *"hcw: https to this host"* ]]' "${out}"
run env FAKE_START_STATUSES="13 13 13"
check "a repository that cannot be reached names it and the web egress rule" \
  '[ "${rc}" -eq 1 ] && [[ "${out}" == *"reached Coder but not ${REPO}"* && "${out}" == *"hcw: web egress"* ]]' "${out}"

# --- the daemon, the image, the network
run env FAKE_DAEMON_DOWN=1
check "a daemon that does not answer exits 1, says so with its error, and creates nothing" \
  '[ "${rc}" -eq 1 ] && [[ "${out}" == *"the sandbox daemon does not answer on ${HOST}"* && "${out}" == *"Cannot connect to the Docker daemon"* ]] && [ "$(calls "create --name")" -eq 0 ]' "${out}"
run env FAKE_IMAGE_MISSING=1
check "a missing workspace image exits 1, names it and the lab_images run, and creates nothing" \
  '[ "${rc}" -eq 1 ] && [[ "${out}" == *"the workspace image ${IMAGE} is not on the sandbox daemon"* && "${out}" == *"--tags lab_images"* ]] && [ "$(calls "create --name")" -eq 0 ]' "${out}"
run env HCW_REACH_ATTEMPTS=1 FAKE_NETWORK_CREATE_FAIL=1
check "a network that cannot be created is reported with the daemon's words" \
  '[ "${rc}" -eq 1 ] && [[ "${out}" == *"did not run (exit 125)"* && "${out}" == *"address pools"* ]]' "${out}"

echo "1..${passed}"
if [ "${failed}" -gt 0 ]; then
  echo "${failed} check(s) failed" >&2
  exit 1
fi
