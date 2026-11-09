#!/bin/sh
# lab-host-arc-run.yml, action "memory-check" (#1590): the five-run sandbox
# memory check the owner ran by hand over SSH for the 768m lab job limit
# (#1590). It starts the pinned lab runner image five times through
# lab-image/sandbox-check.mjs, prints only its `limits` and `sandbox-check:`
# lines, then the last three OOM-killer lines from the kernel log.
#
# Read-only apart from the five short-lived sandbox containers the check
# starts and removes. Not `set -e`: a run that prints no matching line is a
# result to read, not a reason to stop before the other four.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root

cd /opt/hcw-src || { echo "no checkout at /opt/hcw-src"; exit 1; }
img=$(grep -o 'docker.io/hybridcloudworks/hcw-lab-runner:[0-9a-f]*@sha256:[0-9a-f]*' vps-agent/lib/capabilities.js | head -n 1)
if [ -z "$img" ]; then
  echo "could not read the pinned lab runner image from vps-agent/lib/capabilities.js"
  exit 1
fi
echo "image: $img"
free -m
for n in 1 2 3 4 5; do
  echo "== run $n"
  node lab-image/sandbox-check.mjs "$img" 2>&1 | grep -E '^limits|^sandbox-check:'
done
echo "== OOM lines in the kernel log (last 3)"
dmesg -T | grep -i oom | tail -n 3
exit 0
