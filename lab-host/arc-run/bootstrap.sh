#!/bin/sh
# lab-host-arc-run.yml, action "bootstrap" (#1590): the same full run the
# owner starts over SSH with `sudo /opt/hcw-src/lab-host/bootstrap.sh`. It
# brings the host to the current main commit (lab-host/README.md).
#
# Azure Arc Run Command hands back only the last 4 KB of output, and the
# workflow's log is public (this repository is public), so the run's whole
# log stays on the host, root-only, under /var/log/hcw-arc-run/, and this
# prints only the Ansible PLAY RECAP and the names of tasks that failed. The
# newest full log is read over SSH:
#   sudo tail -n 80 /var/log/hcw-arc-run/latest.log
# The exit status is bootstrap.sh's own, so a failed run fails the workflow.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
# The umask an SSH `sudo bootstrap.sh` runs with. It is set here, and the
# strict one below applies to the log file alone: on 2026-11-12 a global
# `umask 077` in this script made every file the run created or changed
# without an explicit mode root-only, among them the labs agent's checkout
# and node_modules, and the agent, which reads them as its own user, could
# no longer start a job (#1706).
umask 022

logdir=/var/log/hcw-arc-run
mkdir -p "$logdir"
chmod 0700 "$logdir"
log="$logdir/bootstrap-$(date -u +%Y%m%dT%H%M%SZ).log"
(umask 077 && : >"$log")
ln -sfn "$log" "$logdir/latest.log"

/opt/hcw-src/lab-host/bootstrap.sh </dev/null >"$log" 2>&1
rc=$?

echo "bootstrap.sh exit status: $rc"
echo "full log on the host: $log"
echo "== failed tasks"
# The TASK header above each fatal line names the task; the fatal line itself
# can carry a module's message, so only the header is printed.
awk '/^TASK \[/ { task = $0 } /^(fatal|failed):/ { print task }' "$log" | sort -u
echo "(end of list)"
echo "== PLAY RECAP"
sed -n '/^PLAY RECAP/,$p' "$log" | grep -E '^PLAY RECAP|ok=' | sed 's/^[^ ]* *: /host: /'
# The last line bootstrap.sh itself prints (its own log() lines have no
# secrets: they name steps and commits).
echo "== last bootstrap.sh line"
grep '^\[bootstrap\] ' "$log" | tail -n 1

# Keep the ten newest logs. The names carry a UTC timestamp, so the glob's
# order (by name) is oldest first.
set -- "$logdir"/bootstrap-*.log
n=$(($# - 10))
while [ "$n" -gt 0 ]; do
  rm -f -- "$1"
  shift
  n=$((n - 1))
done

exit "$rc"
