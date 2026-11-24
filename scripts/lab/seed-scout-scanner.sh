#!/usr/bin/env bash
# Fetch the Docker Scout scanner before the Docker Scout step runs, so that step does not have to download it.
#
#   GH_TOKEN=<this job's token> bash scripts/lab/seed-scout-scanner.sh [pins file]
#
# Used by .github/workflows/addon-image-scout.yml. Copied from the NetworkEyes App repository, where the same step
# was proved on a real build (https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/428); only the file names,
# this paragraph and the issue links differ.
#
# WHY. docker/scout-action is a small wrapper: when it starts it downloads its real scanner, a 187 MB file called
# docker-scout-action_linux_amd64, from its own GitHub release. It asks GitHub's API for that file WITHOUT a token
# (src/index.js at the pinned commit calls `tc.downloadTool(asset.url, binary, undefined, ...)`; the `undefined` is
# the sign-in). GitHub allows 60 such anonymous requests an hour per network address, and GitHub's runners share
# their addresses with everyone else's jobs, so the allowance is often already spent and the answer is
# "Unexpected HTTP response: 403". The job then fails before any image is scanned (first seen in
# https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/427; the action's own report is
# https://github.com/docker/scout-action/issues/116). A retry inside the same job does not help: it comes from the
# same address, against the same spent allowance.
#
# WHAT THIS DOES. The action looks for the scanner in its own `dist/` folder first and downloads only when it is
# not there ("If the binary already exists (e.g. bundled with the action), use it"). This script puts the same file
# there, fetched WITH this job's token (GH_TOKEN), which has its own, far larger allowance. If that fails it tries
# the release's public download link, which is not part of the API allowance, and it tries both up to three times.
#
# WHAT IT NEVER DOES. It does not scan and it does not decide anything about an image. The Docker Scout step that
# follows is unchanged and still fails the job when it cannot scan or when it finds a fixable critical or high
# vulnerability. So:
#   * the file arrived and matches its recorded sha256  -> it is installed, and the action uses it;
#   * the file could not be fetched at all              -> a warning, exit 0, and the action downloads it itself
#                                                          exactly as before (and fails the job if it cannot);
#   * the file arrived but its sha256 is wrong          -> exit 1. A scanner that is not the published one must
#                                                          not judge an image, so the job stops here.
#   * the pinned commit has no row in the pins file, or the action asks for a different release than the row says
#                                                       -> a warning, exit 0, nothing installed (the action
#                                                          downloads its own); a test keeps the rows in step.
#
# Which files are allowed, and their sha256 fingerprints: scripts/lab/scout-scanner-pins.txt.
# Environment: RUNNER_WORKSPACE (set by the runner; the actions live in the `_actions` folder beside it), GH_TOKEN
# (optional: without it only the public link is tried), RUNNER_TEMP (optional), SCOUT_SEED_PAUSE_SECONDS (optional,
# the pause before the second attempt, default 10; the third waits twice as long).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINS="${1:-$HERE/scout-scanner-pins.txt}"
ASSET="docker-scout-action_linux_amd64"
SOURCE_REPOSITORY="docker/scout-action"
PAUSE="${SCOUT_SEED_PAUSE_SECONDS:-10}"
ATTEMPTS=3

warn() { echo "::warning title=Docker Scout scanner not fetched ahead::$* The Docker Scout step will download the scanner itself, as it did before; if that download is refused, the job fails without scanning (https://github.com/docker/scout-action/issues/116)."; }

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  warn "This runner is $(uname -s) $(uname -m), and only ${ASSET} is recorded in ${PINS##*/}."
  exit 0
fi
if [ ! -r "$PINS" ]; then
  echo "::error::The pins file ${PINS} is missing, so no scanner file can be checked."
  exit 1
fi
if [ -z "${RUNNER_WORKSPACE:-}" ]; then
  warn "RUNNER_WORKSPACE is not set, so the folder the runner keeps its actions in is unknown."
  exit 0
fi
ACTION_ROOT="$(dirname "$RUNNER_WORKSPACE")/_actions/${SOURCE_REPOSITORY}"
if [ ! -d "$ACTION_ROOT" ]; then
  warn "The runner has no ${ACTION_ROOT} folder (its layout may have changed)."
  exit 0
fi

# Fetch release $1's scanner into file $2. Two routes per attempt: GitHub's API with this job's token, then the
# release's public download link. Returns 0 as soon as one of them wrote the file.
fetch() {
  local version="$1" out="$2" attempt
  for attempt in $(seq 1 "$ATTEMPTS"); do
    rm -f "$out"
    if [ -n "${GH_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
      if gh release download "$version" --repo "$SOURCE_REPOSITORY" --pattern "$ASSET" --output "$out"; then
        echo "Fetched ${ASSET} ${version} with this job's token (attempt ${attempt})."
        return 0
      fi
      echo "Attempt ${attempt}: the download with this job's token did not work."
      rm -f "$out"
    fi
    if curl --fail --silent --show-error --location --max-time 600 --output "$out" \
      "https://github.com/${SOURCE_REPOSITORY}/releases/download/${version}/${ASSET}"; then
      echo "Fetched ${ASSET} ${version} from the release's public download link (attempt ${attempt})."
      return 0
    fi
    echo "Attempt ${attempt}: the public download link did not work either."
    rm -f "$out"
    if [ "$attempt" -lt "$ATTEMPTS" ]; then
      sleep "$((PAUSE * attempt))"
    fi
  done
  return 1
}

found=0
for dir in "$ACTION_ROOT"/*/; do
  [ -d "$dir" ] || continue
  found=1
  dir="${dir%/}"
  ref="$(basename "$dir")"
  row="$(awk -v ref="$ref" '$1 == ref { print $2, $3; exit }' "$PINS")"
  if [ -z "$row" ]; then
    warn "${SOURCE_REPOSITORY}@${ref} has no row in ${PINS##*/}."
    continue
  fi
  read -r version sha256 <<<"$row"
  if ! [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "::error::The row for ${ref} in ${PINS##*/} is not '<commit> v<N.N.N> <64 hex sha256>'."
    exit 1
  fi
  # The action downloads the release its own code names, which need not be the release the commit is tagged as.
  if ! grep -qF "const version = \"${version}\"" "$dir/index.js" 2>/dev/null; then
    warn "${SOURCE_REPOSITORY}@${ref} does not ask for release ${version}, the one ${PINS##*/} records for it."
    continue
  fi
  dest="$dir/dist/$ASSET"
  if [ -e "$dest" ]; then
    actual="$(sha256sum "$dest" | cut -d' ' -f1)"
    if [ "$actual" != "$sha256" ]; then
      echo "::error::${dest} is already there with sha256 ${actual}, not the recorded ${sha256} for ${version}. The job stops: a scanner that is not the published file must not judge an image."
      exit 1
    fi
    echo "${ASSET} ${version} is already in place and matches its recorded sha256."
    continue
  fi
  work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/scout-scanner.XXXXXX")"
  if ! fetch "$version" "$work/$ASSET"; then
    rm -rf "$work"
    warn "${ASSET} ${version} could not be fetched in ${ATTEMPTS} attempts."
    continue
  fi
  actual="$(sha256sum "$work/$ASSET" | cut -d' ' -f1)"
  if [ "$actual" != "$sha256" ]; then
    rm -rf "$work"
    echo "::error::The downloaded ${ASSET} ${version} has sha256 ${actual}, not the recorded ${sha256} (${PINS##*/}). The job stops: a scanner that is not the published file must not judge an image. Re-run the job; if it repeats, compare the row with the release's Assets list at https://github.com/${SOURCE_REPOSITORY}/releases/tag/${version}."
    exit 1
  fi
  mkdir -p "$dir/dist"
  chmod 0755 "$work/$ASSET"
  mv "$work/$ASSET" "$dest"
  rm -rf "$work"
  echo "Installed ${ASSET} ${version} (sha256 ${sha256}) in ${dir}/dist. The Docker Scout step will say 'Using bundled binary' and will not download."
done

if [ "$found" -eq 0 ]; then
  warn "${ACTION_ROOT} holds no version of the action."
fi
