#!/usr/bin/env bash
# Tests ../files/hcw-docker-proxy-stale, which the labs_agent role installs as
# /usr/local/libexec/hcw-docker-proxy-stale and asks on every bootstrap before
# deciding whether to restart the agent's Docker socket proxy: a proxy that
# started before the daemon's current start holds the daemon's old socket
# inode and answers every forwarded call with HAProxy's 503 (the 2026-10-14
# bootstrap, Docker 29.8.1 → 29.9.0). Run against stand-ins for systemctl and
# docker, with the real GNU date, which is what parses both timestamps.
#
# Needs no root and no Docker: bash and GNU date. CI runs it in the
# `ansible-lint (lab-host)` job; on a workstation, bash:
#   bash lab-host/ansible/roles/labs_agent/tests/hcw-docker-proxy-stale.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${here}/../files/hcw-docker-proxy-stale"

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
bin="${work}/bin"
mkdir -p "${bin}"

# systemctl prints the daemon's start the way `systemctl show --value` does:
# a weekday, a local date and time, a zone. FAKE_DAEMON_AT replaces it.
cat > "${bin}/systemctl" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2 $3 $4" = "show docker.service --property=ActiveEnterTimestamp --value" ] || { echo "unexpected systemctl $*" >&2; exit 2; }
echo "${FAKE_DAEMON_AT-Tue 2026-10-14 00:20:29 UTC}"
EOF
# docker inspect prints `<Running> <StartedAt>` for the one container the
# role names, StartedAt with Docker's nanoseconds; FAKE_CONTAINER_STATE
# replaces it, and FAKE_NO_CONTAINER makes the container unknown.
cat > "${bin}/docker" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "inspect --format" ] || { echo "unexpected docker $*" >&2; exit 2; }
[ -z "${FAKE_NO_CONTAINER:-}" ] || { echo "Error: No such object: $4" >&2; exit 1; }
echo "${FAKE_CONTAINER_STATE-true 2026-10-14T00:20:31.123456789Z}"
EOF
chmod 0755 "${bin}/systemctl" "${bin}/docker"
run() { PATH="${bin}:${PATH}" bash "${helper}" "$@"; }

check "a proxy started after the daemon's current start is fresh" \
  '[ "$(run hcw-labs-agent-docker-proxy)" = fresh ]'

check "a proxy started before the daemon's current start is stale" \
  '[ "$(FAKE_CONTAINER_STATE="true 2026-10-13T22:00:00.000000000Z" run hcw-labs-agent-docker-proxy)" = stale ]'

check "the daemon time is read in its own zone, so a proxy started one second before a daemon in UTC+2 is stale" \
  '[ "$(FAKE_DAEMON_AT="Tue 2026-10-14 02:20:29 +0200" FAKE_CONTAINER_STATE="true 2026-10-14T00:20:28.000000000Z" run x)" = stale ]'

check "a proxy that exists but is not running is absent (the role starts it)" \
  '[ "$(FAKE_CONTAINER_STATE="false 2026-10-13T22:00:00.000000000Z" run x)" = absent ]'

check "a never-started container, StartedAt at year 1, is absent rather than stale" \
  '[ "$(FAKE_CONTAINER_STATE="false 0001-01-01T00:00:00Z" run x)" = absent ]'

check "no such container is absent" \
  '[ "$(FAKE_NO_CONTAINER=1 run x)" = absent ]'

check "a daemon without a start time is a refusal (exit 2), never a verdict" \
  '! FAKE_DAEMON_AT="n/a" run x > /dev/null 2>&1 && { FAKE_DAEMON_AT="n/a" run x > /dev/null 2>&1; [ $? -eq 2 ]; }'

check "a missing container name is usage, not a verdict" \
  '! run > /dev/null 2>&1'

check "the installed copy is the file the role ships, mode-independent (the role sets 0755)" \
  'head -1 "${helper}" | grep -q "^#!/usr/bin/env bash$"'

echo "# ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
