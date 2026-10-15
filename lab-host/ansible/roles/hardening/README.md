# hardening

The first role `site.yml` runs. It replaces the "Harden the Hostinger VPS" step
the admin Labs page's Setup tab used to ask the owner to do by hand.

## What it does

1. Installs the packages it configures, `sudo` included: a minimal image may
   not ship it, and both the administrative user's access and the play's own
   `become` depend on it (`bootstrap.sh` installs it too, before Ansible
   ever runs, for the same reason). Creates `hcwadmin` with passwordless
   sudo (`/etc/sudoers.d/90-hcw-admin`, validated with `visudo`) and
   installs its public keys. With
   `hardening_admin_authorized_keys` empty the keys are copied from
   `/root/.ssh/authorized_keys`, which is where the Hostinger provisioner
   puts the key Terraform passes it. The role **refuses to continue** if no
   key is found from either source, because the next step would lock the
   host.
2. Writes `/etc/ssh/sshd_config.d/00-hcw-hardening.conf` with
   `PasswordAuthentication no`, `PermitRootLogin no` and
   `KbdInteractiveAuthentication no`, validated with `sshd -t`. The `00-`
   prefix matters: sshd keeps the first value it reads and Ubuntu's cloud
   image ships `50-cloud-init.conf` with `PasswordAuthentication yes`.
3. ufw: default deny inbound, allow outbound, allow TCP 22, 80, 443.
   Docker's iptables rules for a published port come before ufw's, so ufw
   cannot close a port Docker publishes. That is why every publish on this
   host names the loopback: Coder's `127.0.0.1:7080` in its Compose file and
   Portainer's `127.0.0.1:9443`, which the `portainer` role refuses to move.
   Jobs run with `--network none`, and Caddy binds 80 and 443 directly.
4. `unattended-upgrades` with the allowed origins rendered from
   `hardening_unattended_allowed_origins` rather than inherited, and its own
   reboot off (LAB-13, #959): the reboot is item 8's, which asks at the hour
   whether anyone is logged in or any lab job is running. The override is
   the last thing the role writes, once item 8's timer is enabled and read
   back active, so a run that stops part way leaves unattended-upgrades
   rebooting as it did rather than nothing rebooting at all (item 8, "Reboot
   authority").
5. A fail2ban `sshd` jail on the systemd backend, which reads sshd's
   journal directly, so the jail works on 26.04 and 24.04 whether or not
   rsyslog is installed to write `/var/log/auth.log`.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `hardening_admin_user` | `hcwadmin` | The key-only administrative login |
| `hardening_admin_authorized_keys` | `[]` | Public keys; empty copies root's |
| `hardening_ufw_allowed_tcp_ports` | `[22, 80, 443]` | Inbound TCP allowlist |
| `hardening_ufw_logging` | `low` | ufw logging level |
| `hardening_unattended_reboot_time` | `04:30` | The hour (HH:MM, host time) `hcw-reboot-when-idle.timer` asks whether the host may reboot |
| `hardening_unattended_allowed_origins` | Ubuntu's four (`release`, `-security`, ESM apps, ESM infra) | The origins unattended-upgrades may move packages from; rendered into the override, the whole list |
| `hardening_fail2ban_maxretry` | `5` | Failures before a ban |
| `hardening_fail2ban_findtime` | `10m` | Counting window |
| `hardening_fail2ban_bantime` | `1h` | Ban length |
| `hardening_held_report_tag` | `hcw-held-upgradable` | Syslog tag of the held-package report |
| `hardening_reboot_required_path` | `/var/run/reboot-required` | The pending-reboot marker the daily report ages |
| `hardening_held_report_script_path` | `/usr/local/sbin/hcw-held-upgradable` | Where the report script is installed |
| `hardening_held_report_on_calendar` | `*-*-* 07:15:00` | When the report runs (systemd `OnCalendar`) |
| `hardening_reboot_when_idle_script_path` | `/usr/local/sbin/hcw-reboot-when-idle` | Where the idle-reboot script is installed |
| `hardening_reboot_when_idle_tag` | `hcw-reboot-when-idle` | Syslog tag of the idle reboot's one line per outcome |
| `hardening_reboot_job_label` | `hcw.lab-job` | The Docker label every lab job container carries (`JOB_LABEL` in `vps-agent/lib/docker-runner.js`); the reboot waits while any container has it |
| `hardening_reboot_hold_path` | `/run/hcw-maintenance/reboot-hold` | The maintenance hold the script writes before its second look; the labs agent claims no new job while it holds. `/run/<directory>/<file>`, the same path as `labs_agent_maintenance_hold_path` |
| `hardening_reboot_hold_settle_seconds` | `45` | The wait between writing the hold and the second look: 35 to 90, at least a claim already sent plus its container's start |
| `hardening_reboot_hold_seconds` | `300` | How long a hold lasts if nothing removes it: over 120 (the run's timeout), at most 600 (the agent's cap) |
| `hardening_reboot_overdue_days` | `7` | From this many days pending, a deferral is logged at `err` instead of `warning` |

`meta/argument_specs.yml` is the contract; the table is a summary of it.

6. `hcw-unit-failed@.service`, a template unit the other roles name in
   `OnFailure=` on the units that matter (the Coder backup, the labs agent,
   Caddy, Vault). When one of them enters the failed state it logs one line
   at `daemon.err`, which the Arc data collection rule ships and
   `alert-lab-unit-failed` pages on (LAB-2, 2026-10-06).
7. `hcw-held-upgradable`, a daily timer (LAB-3, #949). The docker,
   labs_agent and arc roles hold their packages so that unattended-upgrades
   cannot move them, which also means nothing on the host said when a fix
   for one was waiting. Once a day, after the idle-reboot window, the
   script reads `apt-mark showhold` and `apt list --upgradable` and logs,
   under the tag `hcw-held-upgradable`:

   - one line at `daemon.warning` while `/var/run/reboot-required` exists,
     with the date it appeared and its age in days (LAB-13, #959):
     `hcw-reboot-when-idle` (item 8) reboots only on a night with nobody
     logged in and no lab job running, and this is the line that says it
     has waited;
   - one line per held package apt could upgrade, at `daemon.warning`,
     which the Arc data collection rule ships to Log Analytics:
     `held package containerd.io is upgradable: installed <version>,
     candidate <version>. ...`;
   - otherwise one line at `daemon.notice`, which stays on the host:
     `no held package is upgradable: 5 held (...); package lists from
     <time>`.

   It reads the lists `apt-daily.timer` refreshes and changes nothing, so it
   never takes apt's locks; it runs as a dynamic user. A failed run is a
   line from the failure notifier above (`OnFailure=`). On the host, bash:
   `journalctl -t hcw-held-upgradable --since -2d` shows the last two days,
   and `sudo systemctl start hcw-held-upgradable.service` runs it now. What
   to do about a warning line is `docs/runbooks/labs-host.md`, "Runtime
   advisories".
8. `hcw-reboot-when-idle`, a nightly timer at `hardening_unattended_reboot_time`
   (LAB-13, #959). unattended-upgrades used to reboot: it asked `users` when
   the upgrade ran, about twenty-two hours before the hour, then scheduled
   `shutdown -r` for the hour with no further question, and it never asked
   whether a visitor's lab job container was running; a job killed at 04:30
   is the issue's evidence. The override now sets `Automatic-Reboot` to
   false and the timer runs the script at the hour itself, which decides in
   this order and logs one line under the tag `hcw-reboot-when-idle`:

   | The host at the hour | Line | Level | Exit |
   | --- | --- | --- | --- |
   | `apt-config` says `Unattended-Upgrade::Automatic-Reboot` is on (a rollback) | `standing down: unattended-upgrades' own Automatic-Reboot is on, ...` | `warning`, shipped | 0 |
   | `apt-config` cannot answer | `not rebooting: apt-config could not say whether ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | `/var/run/reboot-required` absent | `no reboot is pending: ...` | `notice`, stays on the host | 0 |
   | `loginctl list-sessions` has a session of class `user` (or `user-` and a suffix) | `deferred: a user is logged in (<names>); a reboot has been pending since <date> (<n> days)` | `warning`, shipped | 0 |
   | `loginctl` cannot list the sessions, or read one | `not rebooting: loginctl could not list the sessions, ...` or `... could not read session <id>, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | `docker ps -q --filter label=hcw.lab-job` lists anything | `deferred: <n> job container(s) running; a reboot has been pending since ...` | `warning`, shipped | 0 |
   | `docker ps` fails, or there is no `docker` to run | `not rebooting: docker could not list the job containers, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | idle: the hold cannot be written | `not rebooting: the hold that keeps new lab jobs from starting could not be written, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | idle, then, after the settle, a session of class `user` | `deferred: a user logged in while new lab jobs were held (<names>); ...` | `warning`, shipped | 0 |
   | idle, then, after the settle, a job container | `deferred: <n> job container(s) started while new lab jobs were held; ...` | `warning`, shipped | 0 |
   | idle at both looks | `rebooting; pending since <date> (<n> days): nobody is logged in and no job container is running, at two looks 45 s apart with new lab jobs held between` | `warning`, shipped | 0, then `systemctl reboot` |

   A deferred night tries again the next night; the held report above says
   how long the wait has been. **Once the reboot has been pending
   `hardening_reboot_overdue_days` (7) days or more, each deferral line goes
   to `err` instead**, with what to do (`..., overdue at 7: log out before
   04:30, or reboot at a time of your choosing ...`), so a security fix that
   has waited a week stands out from the nightly warnings in Log Analytics.
   Only the line changes: the script never reboots over a logged-in user or
   a running job. No alert rule matches these rows yet (the lab's one Syslog
   alert, `alert-lab-unit-failed`, matches the failure notifier's tag); the
   err row is there for the query or the alert PLAT-4 adds.

   **The second look, and the maintenance hold** (CodeRabbit on #1191). One
   look left a gap: a job the agent claimed after `docker ps` came back empty,
   and before the reboot request, started a container the reboot then
   killed. So when the first look finds the host idle, the script writes
   `hardening_reboot_hold_path` (`/run/hcw-maintenance/reboot-hold`, root's,
   0644) holding the epoch second the hold lapses, 300 s on. The labs agent
   reads it before every claim and claims nothing while it holds
   (`vps-agent/lib/maintenance-hold.js`, `LABS_AGENT_MAINTENANCE_HOLD_PATH`
   from the `labs_agent` role, the same path). The script then waits
   `hardening_reboot_hold_settle_seconds` (45 s), longer than a claim
   already sent can take to come back and start its container (the API
   client's 20 s request timeout plus the runner's 15 s start grace), and
   asks both questions again. A claim in flight is not recalled: its job
   runs, the second look sees its container, and the night is deferred. The
   hold is removed on every way out except the reboot: on that path it
   stays, so no claim lands between the request and the manager stopping
   the agent, and the reboot clears `/run`. The directory is the service's
   `RuntimeDirectory=` (kept between runs), the one place it may write. A
   run that dies without removing the hold cannot keep the agent idle past
   its expiry, and the agent caps any hold at ten minutes from its write, an
   unreadable one included; it says each change in the hold, once, in its
   journal, and an unreadable or expired hold at `warn`.

   **Reboot authority.** Exactly one mechanism reboots the host at a time.
   The role checks first (the hour, the hold's bounds, a reboot
   unattended-upgrades already scheduled), installs the script and units,
   enables the timer, reads it back active and enabled, and only then writes
   the override that turns unattended-upgrades' own reboot off. A run that
   stops before that leaves unattended-upgrades rebooting as before. The
   script **stands down** whenever apt's effective configuration has
   `Automatic-Reboot` on (`apt-config shell automatic_reboot
   Unattended-Upgrade::Automatic-Reboot/b`, read the way unattended-upgrade
   reads it), so a timer installed beside unattended-upgrades' reboot, after
   a partial run or a rollback to a revision before this one, logs the
   stand-down each night and reboots nothing. Withdrawing the timer is in
   `docs/runbooks/labs-host.md`, "Runtime advisories".

   **A reboot unattended-upgrades already scheduled.** Turning its
   `Automatic-Reboot` off stops it scheduling another, but one it scheduled
   before the run is logind's (`/run/systemd/shutdown/scheduled`) and fires
   at its hour without either question. That record cannot tell
   unattended-upgrades from root: it runs `/sbin/shutdown -r <hour>` as root
   with no message of its own, the same record as root's own `shutdown -r`
   for that minute. Its log can: it writes systemd's answer to
   `/var/log/unattended-upgrades/unattended-upgrades.log` (`Shutdown msg:
   ... Reboot scheduled for <time>, use 'shutdown -c' to cancel.`), and
   `shutdown --show` prints the scheduled one in the same words. A reboot
   whose time that log names is cancelled (`shutdown -c`) and read back
   gone. A reboot it does not name stops the run before the timer or the
   override is written, with what to do, because it may be the owner's; a
   poweroff, a halt or a kexec is never unattended-upgrades' and is left
   alone.

   The timer is `OnCalendar=*-*-* 04:30:00`
   with `Persistent=false` and no jitter: a run missed while the host was
   off must not reboot it the moment it is back, and the hour is what the
   Coder dump (03:30), the Vault snapshot (03:45) and the held report
   (07:15) are placed around. The service runs as root (the docker socket,
   the reboot) with the file system read-only to it but for the hold's
   directory and home hidden, `TimeoutStartSec=2min` so a docker that hangs
   is a failed run rather than a night lost (the settle and both looks fit
   inside it), and the failure notifier in `OnFailure=`. The label is the
   agent's `JOB_LABEL` and the hold's path the agent's;
   `scripts/lab-job-limits.test.mjs` and the test below hold each pair
   together.

   **Who is logged in comes from logind, not `users` or `who`.** On Ubuntu
   26.04 those two are rust-coreutils, which reads utmp, and systemd no
   longer writes it: measured on the host on 2026-10-15 with an SSH session
   open, both printed nothing. unattended-upgrade's own WithUsers check read
   `users`, so it never saw anyone either. The script lists the sessions
   with `loginctl list-sessions --no-legend` and reads each one's class with
   `loginctl show-session <id> -p Class -p Name`. A person's login is class
   `user`, or `user-` and a suffix: `user-early` is root's interactive login
   (the provider's console) since systemd 256, `user-incomplete` a login
   whose home is not ready yet, and the `-light` classes the same logins
   without a user service manager. `manager` and `manager-early` (the
   per-user service managers lingering keeps up, hcw-coder-docker's rootless
   daemon among them) and `background` (cron and the like) are not people
   and never defer. As measured with one SSH login open, the host lists:

   ```text
    22  981 hcw-coder-docker - 331127  manager-early - no -
   384 1000 hcwadmin         - 3923325 user          - no -
   385 1000 hcwadmin         - 3923330 manager       - no -
   ```

   Session 384, class `user`, is the login that defers the reboot; 385 is
   hcwadmin's service manager and 22 is the lingering daemon's, and neither
   would. On the host, bash: `loginctl list-sessions` shows the same columns
   with a header, and `journalctl -t hcw-reboot-when-idle --since -7d`
   shows the last week's decisions. `sudo systemctl start
   hcw-reboot-when-idle.service` runs the decision now, and **reboots the
   host now** when it is idle with a reboot pending. Run it only while a
   `user` session (yours) is listed, and the result is the deferred line.

## Handlers

`Restart ssh`, `Restart unattended-upgrades`, `Restart fail2ban`, `Reload
systemd for the failure notifier`, `Reload systemd for the held-package
report`, `Reload systemd for the idle reboot`.

## Tests

`tests/unattended-upgrades.test.sh` renders `52hcw-unattended-upgrades.j2`
with the role's defaults and asserts the override clears and names the
allowed origins itself and leaves the reboot to `hcw-reboot-when-idle.timer`
(`Automatic-Reboot` off, neither setting read only while it is on) (LAB-13,
#959). Same job, same requirements as the tests below.

`tests/hcw-held-upgradable.test.sh` renders the report script and its two
units with the role's defaults and runs the script against stub `apt-mark`,
`apt` and `logger`: one warning line per held package with an upgrade and
none for a package that is not held, the notice line when nothing is
upgradable, and a non-zero exit when apt fails. It needs neither root nor
Docker; CI runs it in the `ansible-lint (lab-host)` job, and
`lab-host/README.md` ("Validating without a host") has the container line.

`tests/hcw-reboot-when-idle.test.sh` renders the idle-reboot script and its
two units the same way and runs the script against stub `apt-config`,
`loginctl`, `docker`, `sleep`, `systemctl` and `logger`, with the marker
and the hold at scratch paths. The `loginctl` stub answers from session
listings in the host's columns, the first of them the one measured on the
host above. `Automatic-Reboot` on is the stand-down line and nothing else
asked; an `apt-config` that cannot answer is an `err` line and a failed
run. No marker is the notice line and no reboot; that listing (one `user`
session for hcwadmin) is the deferred line naming hcwadmin once, and so is
a second SSH login for the same user; root at the console (`user-early`)
defers too; only `manager`, `manager-early` and `background` sessions do
not, so docker is asked (docker is not even asked while a user is logged
in). A job container running is the deferred line, with no hold written;
a `loginctl` that cannot list or read a session, a docker that cannot
answer and a docker the shell cannot find are each one `err` line, a
non-zero exit and no reboot. The `sleep` stub is the hold window: it
records the hold as it stood (an expiry 300 s on, mode 0644) and can
change the host inside it. A job container or a login that appears there
defers the night and removes the hold; a docker that fails at the second
look, a stop (SIGTERM) during the wait, and a refused reboot each fail the
run and remove it; a hold that cannot be written fails the run before the
wait. An idle host, with the lingering managers still listed or with no
sessions at all, is the rebooting line, one wait of the role's settle, two
looks and exactly one `systemctl reboot`, with the hold left in place. A
reboot pending 7 days is deferred at `err`, 6 days at `warning`. It also
checks that the script never calls `users` or `who`, that the role deals
with a scheduled shutdown before it installs the timer and writes the
override only after reading the timer back, and holds the timer to the
role's hour, the hold's path to the `labs_agent` role's and the job label
to the agent's `JOB_LABEL` when `vps-agent/` is in the checkout. Same job,
same requirements.

## Check mode

Safe. Every task is a module with check-mode support; `sshd -t` and `visudo -cf`
run against the rendered temporary file, not the live one. The two reads
about a scheduled shutdown (`shutdown --show`, and a `grep` of
unattended-upgrades' log) run in check mode too, because they change
nothing; `shutdown -c` does not, and neither does the read-back of the
timer, which a host that has never had it cannot answer before the run that
installs it.
