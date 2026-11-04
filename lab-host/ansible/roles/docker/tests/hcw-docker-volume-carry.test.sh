#!/usr/bin/env bash
# Tests ../files/hcw-docker-volume-carry.py, which the docker role installs as
# /usr/local/libexec/hcw-docker-volume-carry and runs once per named volume on
# the run that turns userns-remap on (LAB-5). It is the one step that copies
# Coder's PostgreSQL cluster, so it is run here as it ships against a scratch
# tree shaped like one: a 0700 data directory owned by uid 999, a symlink, a
# setgid directory, hard links.
#
# Run as root, because the helper chowns. CI runs it in the
# `lab-host role tests` job with sudo; on a workstation, bash, with Docker:
#   docker run --rm -v "$PWD/lab-host/ansible/roles/docker:/r:ro" python:3.14-slim bash /r/tests/hcw-docker-volume-carry.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${here}/../files/hcw-docker-volume-carry.py"

if [ "$(id -u)" -ne 0 ]; then
  echo "hcw-docker-volume-carry.test.sh: run as root (the helper chowns)" >&2
  exit 1
fi

passed=0
failed=0
ok() { passed=$((passed + 1)); echo "ok ${passed} - $1"; }
not_ok() { failed=$((failed + 1)); echo "not ok - $1" >&2; [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2; }
check() { if eval "$2"; then ok "$1"; else not_ok "$1" "${3:-}"; fi; }
owner() { stat -c '%u:%g' "$1"; }
mode() { stat -c '%a' "$1"; }

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# A source shaped like PostgreSQL 18's volume: /var/lib/postgresql/18/docker.
make_source() {
  local src="$1"
  mkdir -p "${src}/18/docker/base/1" "${src}/18/docker/shared"
  printf 'pg data\n' > "${src}/18/docker/base/1/1259"
  printf '18\n' > "${src}/18/docker/PG_VERSION"
  ln "${src}/18/docker/PG_VERSION" "${src}/18/docker/PG_VERSION.link"
  ln -s ../PG_VERSION "${src}/18/docker/base/version-symlink"
  chown -R 999:999 "${src}"
  chown 0:0 "${src}/18/docker/shared"
  chmod 0700 "${src}/18/docker"
  chmod 2770 "${src}/18/docker/shared"
}

# --- A remapped volume: every inode moves up by the range's base.
src="${work}/legacy/_data"
dst="${work}/remapped/_data"
make_source "${src}"
mkdir -p "${dst}"
before="$(cd "${src}" && find . -printf '%p %u:%g %m %y\n' | sort)"

out="$(python3 "${helper}" --from "${src}" --to "${dst}" --uid-shift 231072 --gid-shift 231072)"
check "the carry succeeds and says what it did" "[[ '${out}' == carried* ]]" "${out}"
check "a file owned by 999 is owned by 231072+999" "[ \"\$(owner '${dst}/18/docker/base/1/1259')\" = '232071:232071' ]" "$(owner "${dst}/18/docker/base/1/1259")"
check "a directory owned by root is owned by the remapped root" "[ \"\$(owner '${dst}/18/docker/shared')\" = '231072:231072' ]"
check "the volume's own directory is shifted too" "[ \"\$(owner '${dst}')\" = '232071:232071' ]" "$(owner "${dst}")"
check "PostgreSQL's 0700 data directory keeps its mode" "[ \"\$(mode '${dst}/18/docker')\" = '700' ]" "$(mode "${dst}/18/docker")"
check "a setgid directory keeps its setgid bit after the chown" "[ \"\$(mode '${dst}/18/docker/shared')\" = '2770' ]" "$(mode "${dst}/18/docker/shared")"
check "a symlink stays a symlink, re-owned itself" "[ -L '${dst}/18/docker/base/version-symlink' ] && [ \"\$(stat -c '%u' '${dst}/18/docker/base/version-symlink')\" = '232071' ]"
check "hard links stay hard links" "[ \"\$(stat -c '%i' '${dst}/18/docker/PG_VERSION')\" = \"\$(stat -c '%i' '${dst}/18/docker/PG_VERSION.link')\" ]"
check "file contents are copied" "grep -qx 'pg data' '${dst}/18/docker/base/1/1259'"
after="$(cd "${src}" && find . -printf '%p %u:%g %m %y\n' | sort)"
check "the source is untouched" "[ \"\${before}\" = \"\${after}\" ]"
check "no staging directory is left behind" "[ ! -e '${dst}.hcw-carry' ]"

# --- A destination that already holds data is refused, and kept as it is.
printf 'started\n' > "${dst}/marker-from-a-container"
set +e
refusal="$(python3 "${helper}" --from "${src}" --to "${dst}" --uid-shift 231072 --gid-shift 231072 2>&1)"
rc=$?
set -e
check "a non-empty destination is refused" "[ ${rc} -ne 0 ]"
check "the refusal says nothing was changed" "[[ \"\${refusal}\" == *'Nothing was changed'* ]]" "${refusal}"
check "and the destination is left as it was" "[ -f '${dst}/marker-from-a-container' ] && [ -d '${dst}/18' ]"

# --- A --userns=host volume is copied with its owners as they are.
src2="${work}/legacy2/_data"
dst2="${work}/remapped2/_data"
make_source "${src2}"
mkdir -p "${dst2}"
python3 "${helper}" --from "${src2}" --to "${dst2}" --uid-shift 0 --gid-shift 0 > /dev/null
check "with shifts of 0 the owners are copied unchanged" "[ \"\$(owner '${dst2}/18/docker/base/1/1259')\" = '999:999' ]"

# --- An owner outside the 65536 ids a remapped container can use is refused.
src3="${work}/legacy3/_data"
dst3="${work}/remapped3/_data"
mkdir -p "${src3}" "${dst3}"
printf 'x\n' > "${src3}/high"
chown 70000:70000 "${src3}/high"
set +e
python3 "${helper}" --from "${src3}" --to "${dst3}" --uid-shift 231072 --gid-shift 231072 > /dev/null 2>&1
rc=$?
set -e
check "an owner outside the remapped range is refused" "[ ${rc} -ne 0 ]"
check "and the refused carry leaves the destination empty" "[ -z \"\$(ls -A '${dst3}')\" ]"
check "and no half-shifted staging copy" "[ ! -e '${dst3}.hcw-carry' ]"

echo "hcw-docker-volume-carry.test.sh: ${passed} passed, ${failed} failed"
[ "${failed}" -eq 0 ]
