#!/bin/sh
# lab-host-arc-run.yml, action "memory-check" (#1590): the five-run sandbox
# memory check the owner ran by hand over SSH for the 768m lab job limit
# (#1590). It starts the pinned lab runner image five times through
# lab-image/sandbox-check.mjs, prints only its `limits` and `sandbox-check:`
# lines, then the last three OOM-killer lines from the kernel log.
#
# Read-only apart from the five short-lived sandbox containers the check
# starts and removes. Not `set -e`: a run that fails is counted and the other
# four still run. A run whose output has no matching line is a result to
# read, not a failure; a run whose `node` exits non-zero (the check crashed,
# or Docker did not answer) is a failure, and the script then exits 1 so the
# workflow does not report success.
#
# The two HCW_ARC_RUN_* values exist for scripts/lab-host-arc-run-workflow.test.mjs,
# which runs this with a stand-in node, dmesg and checkout; Run Command sets
# neither, so on the host they are the defaults.
export PATH="${HCW_ARC_RUN_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export HOME=/root
src="${HCW_ARC_RUN_SRC:-/opt/hcw-src}"

cd "$src" || { echo "no checkout at $src"; exit 1; }
img=$(grep -o 'docker.io/hybridcloudworks/hcw-lab-runner:[0-9a-f]*@sha256:[0-9a-f]*' vps-agent/lib/capabilities.js | head -n 1)
if [ -z "$img" ]; then
  echo "could not read the pinned lab runner image from vps-agent/lib/capabilities.js"
  exit 1
fi
echo "image: $img"
free -m

out=$(mktemp) || { echo "could not create a temporary file"; exit 1; }
trap 'rm -f "$out"' EXIT
failed=0
for n in 1 2 3 4 5; do
  echo "== run $n"
  # The output goes to a file first, so node's own exit status is kept; a
  # pipe into grep would report grep's.
  node lab-image/sandbox-check.mjs "$img" >"$out" 2>&1
  status=$?
  grep -E '^limits|^sandbox-check:' "$out"
  if [ "$status" -ne 0 ]; then
    echo "run $n: sandbox-check.mjs exited $status"
    failed=$((failed + 1))
  fi
done
echo "== OOM lines in the kernel log (last 3)"
dmesg -T | grep -i oom | tail -n 3
if [ "$failed" -ne 0 ]; then
  echo "$failed of 5 runs failed"
  exit 1
fi
exit 0
