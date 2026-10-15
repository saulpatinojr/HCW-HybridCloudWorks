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
   whether anyone is logged in or any lab job is running.
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
   | `/var/run/reboot-required` absent | `no reboot is pending: ...` | `notice`, stays on the host | 0 |
   | `users` prints anyone | `deferred: a user is logged in (<names>); a reboot has been pending since <date> (<n> days)` | `warning`, shipped | 0 |
   | `docker ps -q --filter label=hcw.lab-job` lists anything | `deferred: <n> job container(s) running; a reboot has been pending since ...` | `warning`, shipped | 0 |
   | `users` fails | `not rebooting: users could not say who is logged in, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | `docker ps` fails, or there is no `docker` to run | `not rebooting: docker could not list the job containers, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | otherwise | `rebooting; pending since <date> (<n> days): nobody is logged in and no job container is running` | `warning`, shipped | 0, then `systemctl reboot` |

   A deferred night tries again the next night; the held report above says
   how long the wait has been. The timer is `OnCalendar=*-*-* 04:30:00`
   with `Persistent=false` and no jitter: a run missed while the host was
   off must not reboot it the moment it is back, and the hour is what the
   Coder dump (03:30), the Vault snapshot (03:45) and the held report
   (07:15) are placed around. The service runs as root (the docker socket,
   the reboot) with the file system read-only to it and home hidden,
   `TimeoutStartSec=2min` so a docker that hangs is a failed run rather
   than a night lost, and the failure notifier in `OnFailure=`. The label
   is the agent's `JOB_LABEL`; `scripts/lab-job-limits.test.mjs` and the
   test below hold the two together.

   `users` reads the host's login records, as unattended-upgrade's own
   check did, and an empty answer is read as nobody. On Ubuntu 26.04,
   rust-coreutils' `who` printed nothing for open sessions until a fixed
   package (Launchpad bug 2152801), so check once that `users` prints your
   login while you are logged in over SSH; an empty line there means the
   first question cannot defer anything. On the host, bash: `users` is that
   check, and `journalctl -t hcw-reboot-when-idle --since -7d` shows the
   last week's decisions. `sudo systemctl start hcw-reboot-when-idle.service`
   runs the decision now, and **reboots the host now** when it is idle with
   a reboot pending, so run `users` first.

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
two units the same way and runs the script against stub `users`, `docker`,
`systemctl` and `logger`, with the marker at a scratch path: no marker is
the notice line and no reboot; a user logged in, or a job container
running, is the deferred line and no reboot (docker is not even asked while
a user is logged in); a `users` that fails, a docker that cannot answer and
a docker the shell cannot find are each one `err` line, a non-zero exit and
no reboot; an idle host is the rebooting line and exactly one `systemctl
reboot`. It also holds the timer to the role's hour and the job label to the
agent's `JOB_LABEL` when `vps-agent/` is in the checkout. Same job, same
requirements.

## Check mode

Safe. Every task is a module with check-mode support; `sshd -t` and `visudo -cf`
run against the rendered temporary file, not the live one.
