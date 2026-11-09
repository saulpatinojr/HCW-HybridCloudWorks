#!/bin/sh
# lab-host-arc-run.yml, action "status": what the lab host looks like right
# now, read-only (#1590). Azure Arc Run Command runs this on the host as root
# and hands back the last 4 KB of what it prints.
#
# The workflow's log is public (this repository is public), so this prints
# counts, names and states, never file contents, environment values or
# addresses. It changes nothing on the host.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

echo "== host"
echo "time (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
uptime

echo "== memory (MiB)"
free -m

echo "== disk"
df -h / /var/lib/docker 2>/dev/null

echo "== last completed bootstrap run"
# bootstrap.sh records the commit and time of its last full, real run here.
grep '^completed_' /etc/hcw/bootstrap-host-accepted 2>/dev/null || echo "no completed run recorded"

echo "== checkout at /opt/hcw-src"
git -C /opt/hcw-src log -1 --format='%h %cI %s' 2>/dev/null || echo "no checkout"

echo "== containers"
docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null || echo "docker did not answer"

echo "== failed systemd units"
systemctl --failed --no-legend --plain 2>/dev/null | awk '{print $1}'
echo "(end of list)"

exit 0
