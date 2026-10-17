# hardening

The first role `site.yml` runs. It replaces the "Harden the Hostinger VPS" step
the admin Labs page's Setup tab used to ask the owner to do by hand.

## What it does

1. Installs the packages it configures, `sudo` included: a minimal image may
   not ship it, and both the administrative user's access and the play's own
   `become` depend on it (`bootstrap.sh` installs it too, before Ansible
   ever runs, for the same reason). Creates `hcwadmin` with passwordless
   sudo (`/etc/sudoers.d/90-hcw-admin`, validated with `visudo`; an
   accepted risk, below) and writes its `authorized_keys` from
   `hardening_admin_authorized_keys` and nothing else (`exclusive`, #953).
   That list is in `group_vars/all.yml`: the owner's workstation key,
   pinned. There is no fallback to root's keys any more. Before it writes
   anything, the role **stops** (`tasks/admin_keys.yml`):
   - when the list is empty, or an entry is not one public key line, or
     `ssh-keygen` cannot read one;
   - when the list does not hold the key the operator logs in with (the
     **lockout guard**). That is the key of the most recent SSH login as
     `hcwadmin` or root in the journal of the last 14 days: sshd logs every
     accepted login at INFO as `Accepted publickey for <user> from <address>
     port <n> ssh2: <type> SHA256:<fingerprint>`, and the guard reads it
     with `journalctl -u ssh.service -o cat`. A list that keeps some other
     key on file but drops the one in use is refused. Only when the journal
     has no login at all, a fresh host, does the guard fall back to the
     files: the list must then share a key, compared by key blob, with
     `hcwadmin`'s `authorized_keys`, or with root's while `hcwadmin` has
     none. A journal that cannot be read stops the run rather than fall
     back. The refusal prints SHA256 fingerprints, and a run that means to
     replace the key in use passes `-e hardening_admin_keys_replace_all=true`.
2. Writes `/etc/ssh/sshd_config.d/00-hcw-hardening.conf`: `AllowUsers`
   from `hardening_sshd_allow_users` (`hcwadmin` alone),
   `AuthenticationMethods publickey`, `PubkeyAuthentication yes`,
   `AuthorizedKeysFile .ssh/authorized_keys` (no `authorized_keys2`),
   `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
   `PermitRootLogin no`, `MaxAuthTries 4`, `LoginGraceTime 30`,
   `AllowAgentForwarding no`, `AllowTcpForwarding local` (VS Code
   Remote-SSH and the Portainer `-L` tunnel need local forwards),
   `AllowStreamLocalForwarding no` (nothing forwards Unix sockets),
   `PermitTunnel no`, `X11Forwarding no`,
   `PerSourcePenaltyExemptList 127.0.0.1,::1` (every Arc SSH session will
   arrive from the loopback, and OpenSSH's per-source penalties would
   otherwise hold a few failures there against all of them),
   `ListenAddress 127.0.0.1` and `ListenAddress ::1` (#1257: sshd listens on
   the loopback alone for defense in depth; Ubuntu's `sshd-socket-generator`
   derives `ssh.socket`'s `ListenStream=` lines from these at `daemon-reload`,
   and `ssh.socket` is restarted once) and
   `LogLevel VERBOSE`. INFO already logs the fingerprint of the key each
   accepted login used (`Accepted publickey for …`); VERBOSE adds the
   fingerprints of keys offered and refused. The `00-` prefix matters: sshd keeps the first value it reads and
   Ubuntu's cloud image ships `50-cloud-init.conf` with
   `PasswordAuthentication yes`. Before sshd reads it the role proves it:
   `sshd -t -f` on the drop-in alone (the template's `validate`), `sshd -t`
   on the whole configuration, and `sshd -T -C user=…,host=hcw-lab,addr=192.0.2.10`
   for `hcwadmin` and for root, held to `allowusers hcwadmin`,
   `authenticationmethods publickey`, `permitrootlogin no`,
   `listenaddress 127.0.0.1:22`, `listenaddress [::1]:22`,
   `allowagentforwarding no` and the rest of the file, and to root not
   being allowed. A failure puts the previous drop-in back and removes its
   backup before the run stops, so the reload `force_handlers` still runs
   keeps today's settings.
   Then sshd is **reloaded, never restarted**: `ssh.socket` hands each
   connection to `ssh.service`'s listening `sshd`, which hands it to an
   `sshd-session` process of its own, so only the listener has to re-read
   its settings. The unit's `ExecReload` runs `sshd -t` and sends it `HUP`;
   open sessions, the operator's included, stay up. Before a drop-in that
   is about to change is written, the role writes a marker,
   `/var/lib/hcw-hardening/sshd-reload-pending`, and only the reload
   handler removes it. A run interrupted between the write and the reload
   leaves the marker, and the next run, finding it, reloads sshd although
   the drop-in is unchanged. Last, once sshd has reloaded, root's
   `authorized_keys` is written empty and both users' `authorized_keys2`
   are removed, so root's keys are never taken while the running sshd may
   still let root in. These tasks are `tasks/sshd.yml`.
3. ufw (`tasks/ufw.yml`): default deny inbound, allow outbound, allow
   `hardening_ufw_allowed_tcp_ports` (on the lab host TCP 80 and 443), and
   delete the allow of each port in `hardening_ufw_closed_tcp_ports` (on
   the lab host 22, #953 stage 3), for IPv4 and IPv6. The run then reads
   `ufw status` and fails if any ALLOW or LIMIT rule still names a closed
   port (alone or in a port list, on any interface or destination address,
   either family), or Ubuntu's `OpenSSH` profile for 22. The delete matches
   only the plain `<port>/tcp` pair. A port range and an allow of
   everything from one source are not read. The lists are compared as
   integers. With `hardening_ssh_arc_gate` on, as on the lab host, 22
   closes only while Azure Arc SSH is ready to replace it: the Arc agent
   Connected with incoming connections on for port 22. While the agent
   reads Disconnected, which a network drop and an agent reset with
   `azcmagent disconnect` both do, 22 is left as ufw has it, and the run
   says so in a line beginning `Port 22 is left as ufw has it on this run`.
   Otherwise (no agent on a rebuilt host before `Register-LabArc.ps1
   -Connect`, Expired, unreadable, or Arc SSH off) 22 stays allowed, in a
   line beginning `Port 22 stays open to the internet on this run`. Docker's iptables rules for a published port come before ufw's, so ufw
   cannot close a port Docker publishes. That is why every publish on this
   host names the loopback: Coder's `127.0.0.1:7080` in its Compose file and
   Portainer's `127.0.0.1:9443`, which the `portainer` role refuses to move.
   Jobs run with `--network none`, and Caddy binds 80 and 443 directly.
4. `unattended-upgrades` with the allowed origins rendered from
   `hardening_unattended_allowed_origins` rather than inherited, and its own
   reboot off (LAB-13, #959): the reboot is item 8's, which asks at the hour
   whether anyone is logged in, any lab job is running or any Coder
   workspace is up. The override is the last thing the role writes, once
   item 8's timer is enabled and read back active, and apt's effective
   setting is read back after it. A run that stops before the override
   leaves unattended-upgrades' own setting as it was; only a run that
   cancelled a reboot unattended-upgrades had scheduled and then stopped can
   leave one night with no reboot at all (item 8, "Reboot authority").
5. A fail2ban `sshd` jail on the systemd backend, which reads sshd's
   journal directly, so the jail works on 26.04 and 24.04 whether or not
   rsyslog is installed to write `/var/log/auth.log`.

## Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `hardening_admin_user` | `hcwadmin` | The key-only administrative login |
| `hardening_admin_authorized_keys` | `[]` (group_vars pins the owner's workstation key) | The only keys that may log in as `hcwadmin`; empty stops the run |
| `hardening_admin_keys_replace_all` | `false` | Lets one run (`-e`) through the lockout guard |
| `hardening_sshd_allow_users` | `[hardening_admin_user]` | sshd's `AllowUsers`; must hold the administrative user and not root |
| `hardening_ufw_allowed_tcp_ports` | `[22, 80, 443]` | Inbound TCP allowlist (the lab host's `group_vars`: `[80, 443]`) |
| `hardening_ufw_closed_tcp_ports` | `[]` | Inbound TCP ports whose ufw allow is deleted; the run fails if ufw still admits one (the lab host's `group_vars`: `[22]`, #953) |
| `hardening_ssh_arc_gate` | `false` | Close 22 only while the Arc agent is Connected with incoming connections on for 22; leave it as it is while Disconnected; keep it allowed otherwise (the lab host's `group_vars`: `true`) |
| `hardening_arc_azcmagent_path` | `/opt/azcmagent/bin/azcmagent` | The Arc agent's CLI, read for that gate; the `arc` role's `arc_azcmagent_path` |
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
| `hardening_reboot_workspace_docker_host` | `unix:///run/hcw-coder-docker/docker.sock` | The Coder sandbox daemon (`coder_sandbox_docker_host`); the reboot waits while it has a workspace up. No socket, nothing asked |
| `hardening_reboot_workspace_label` | `coder.workspace_id` | The label every Coder workspace container carries (`lab-host/coder/templates`) |
| `hardening_reboot_hold_path` | `/run/hcw-maintenance/reboot-hold` | The maintenance hold the script writes before its second look; the labs agent claims no new job while it holds. `/run/<directory>/<file>`, the same path as `labs_agent_maintenance_hold_path` |
| `hardening_reboot_hold_settle_seconds` | `45` | The longest wait for the agent's acknowledgement before the night is deferred: 35 to 90, at least a claim already sent plus one poll tick |
| `hardening_reboot_ack_path` | `/run/hcw-labs-agent/maintenance-ack` | Where the labs agent acknowledges the hold (`labs_agent_maintenance_ack_path`, the same path) |
| `hardening_reboot_agent_service` | `hcw-labs-agent` | The agent's unit (`labs_agent_service_name`); inactive or failed, no acknowledgement is waited for |
| `hardening_reboot_hold_seconds` | `300` | How long a hold lasts if nothing removes it: over 120 (the run's timeout), at most 600 (the agent's cap) |
| `hardening_reboot_overdue_days` | `7` | From this many days pending, a deferral is logged at `err` instead of `warning` |
| `hardening_drift_tag` | `hcw-playbook-drift` | Syslog tag of the playbook drift detection |
| `hardening_drift_script_path` | `/usr/local/sbin/hcw-playbook-drift` | Where the drift detection script is installed |
| `hardening_drift_src_dir` | `/opt/hcw-src` | Where the HCW source checkout lives |
| `hardening_drift_on_calendar` | `*-*-* 03:00:00` | When drift detection runs (systemd `OnCalendar`) |
| `hardening_drift_ansible_playbook` | `/usr/local/bin/ansible-playbook` | The ansible-playbook executable to run |
| `hardening_drift_vault_file` | `/etc/hcw/vault.yml` | Vault file to include if present |
| `hardening_drift_vault_password_file` | `/etc/hcw/vault.pass` | Vault password file if present |

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
     with the date the pending reboot was first seen and its age in days
     (LAB-13, #959), from item 8's first-seen record when there is one and
     the marker's own time otherwise: `hcw-reboot-when-idle` (item 8)
     reboots only on a night with nobody logged in and no lab job or Coder
     workspace up, and this is the line that says it has waited;
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
   | `docker ps -q --filter label=hcw.lab-job` with `status=created`, `restarting`, `running` and `paused` lists anything | `deferred: <n> job container(s) up; a reboot has been pending since ...` | `warning`, shipped | 0 |
   | `docker ps` fails, or there is no `docker` to run | `not rebooting: docker could not list the job containers, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | the same question, with `--label coder.workspace_id`, to the Coder sandbox daemon (when its socket is there) lists anything | `deferred: <n> Coder workspace(s) up; ...` | `warning`, shipped | 0 |
   | the sandbox daemon is there and cannot answer | `not rebooting: the Coder sandbox daemon could not list its workspaces, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | the first-seen record cannot be written | `not rebooting: the record of when this reboot was first seen could not be written, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | idle: the hold cannot be written | `not rebooting: the hold that keeps new lab jobs from starting could not be written, ...` | `err`, shipped | 1, so the unit fails and the failure notifier pages |
   | idle, the agent running, and no acknowledgement naming this hold within 45 s | `deferred: the lab agent did not confirm it was idle within 45 s; ...` | `warning`, shipped | 0 |
   | idle, then, at the second look, a session of class `user` | `deferred: a user logged in while new lab jobs were held (<names>); ...` | `warning`, shipped | 0 |
   | idle, then, at the second look, a job container | `deferred: <n> job container(s) started while new lab jobs were held; ...` | `warning`, shipped | 0 |
   | idle, then, at the second look, a Coder workspace | `deferred: <n> Coder workspace(s) started while new lab jobs were held; ...` | `warning`, shipped | 0 |
   | idle at both looks | `rebooting; pending since <date> (<n> days): nobody is logged in and no job container or Coder workspace is up, at both looks, with new lab jobs held between and the lab agent confirmed it was idle` (or `... was not running`) | `warning`, shipped | 0, then `systemctl reboot` |

   A container counts while it is up or about to be: `created` (made by
   `docker run` and not started yet) as well as running, paused or
   restarting. A `status=` filter makes `docker ps` look at every container,
   so the created one is listed; plain `docker ps` would miss it.

   A deferred night tries again the next night; the held report above says
   how long the wait has been. **Once the reboot has been pending
   `hardening_reboot_overdue_days` (7) days or more, each deferral line goes
   to `err` instead**, with what to do (`..., overdue at 7: log out before
   04:30, or reboot at a time of your choosing ...`), so a security fix that
   has waited a week stands out from the nightly warnings in Log Analytics.
   Only the line changes: the script never reboots over a logged-in user, a
   running job or a workspace. No alert rule matches these rows yet (the
   lab's one Syslog alert, `alert-lab-unit-failed`, matches the failure
   notifier's tag); the err row is there for the query or the alert PLAT-4
   adds.

   **How long it has been pending** is counted from the first night a run
   saw `/var/run/reboot-required`, not from the marker's own time, which
   every upgrade that wants a reboot rewrites (a fortnight of kernel updates
   would otherwise always read a day old). The script keeps that first time,
   taken from the marker as it found it, in
   `/run/hcw-maintenance/reboot-pending-since`, beside the hold, and removes
   it the first night the marker is gone. It lives on `/run`, the marker's
   own tmpfs, so a reboot clears the two together: a record under
   `/var/lib` (a `StateDirectory=`) would outlive the reboot it counted
   towards and date the next boot's marker from the last boot's. The held
   report (item 7) ages the marker from the same record when there is one.

   **Coder workspaces.** They run on the rootless sandbox daemon
   (`roles/coder_sandbox`, `/run/hcw-coder-docker/docker.sock`), which the
   host daemon does not see, and a person working in one has no logind
   session on the host, so neither of the other questions would see them.
   The script asks that daemon, as root (the Ansible roles already query it
   the same way; the socket is outside `/run/user`, so `ProtectHome=` does
   not hide it), for containers labelled `coder.workspace_id`, which every
   template's workspace container carries. With no socket there (Coder off,
   or the daemon down, when no workspace runs either) nothing is asked. A
   workspace left running defers every night, and the overdue line says so
   from the seventh.

   **The second look, and the maintenance hold** (CodeRabbit on #1191). One
   look left a gap: a job the agent claimed after `docker ps` came back empty,
   and before the reboot request, started a container the reboot then
   killed. So when the first look finds the host idle, the script writes
   `hardening_reboot_hold_path` (`/run/hcw-maintenance/reboot-hold`, root's,
   0644) holding the epoch second the hold lapses, 300 s on. The labs agent
   reads it before every claim and claims nothing while it holds
   (`vps-agent/lib/maintenance-hold.js`, `LABS_AGENT_MAINTENANCE_HOLD_PATH`
   from the `labs_agent` role, the same path). The script then waits for
   the agent to **acknowledge** the hold (CodeRabbit's second round on
   #1191). The agent reads the hold on every poll tick; on a tick with no
   claim in flight and no job running, it writes the hold's expiry, exactly
   as read, to `hardening_reboot_ack_path`
   (`/run/hcw-labs-agent/maintenance-ack`, in the agent unit's own runtime
   directory, which goes when the agent stops), and withdraws it on any
   tick where that stops being true or the hold lifts. An acknowledgement
   naming this hold's expiry is the agent's word that nothing is running
   and, with new claims refused, that nothing can start, so the second look
   follows at once, with no further wait. The script asks systemd first:
   an agent that is `inactive` or `failed` cannot have a claim in flight,
   so it looks again without waiting; in any other state, a systemctl that
   cannot reach the manager included, it waits, checking once a second, for
   at most `hardening_reboot_hold_settle_seconds` (45 s, at least the
   agent's `ACK_WITHIN_MS`: a claim already sent, 20 s, then one 15 s poll
   tick). No matching acknowledgement in that time (a claim that brought a
   job still running, a stuck agent, or one too old to acknowledge) defers
   the night, and the overdue line reports a run of such nights. The second
   look then asks all three questions again; an acknowledgement does not
   excuse a container or a login it can see. The
   hold is removed on every way out except the reboot: on that path it
   stays, so no claim lands between the request and the manager stopping
   the agent, and the reboot clears `/run`. The directory is the service's
   `RuntimeDirectory=` (kept between runs), the one place it may write. A
   run that dies without removing the hold cannot keep the agent idle past
   its expiry, and the agent caps any hold at ten minutes from its write, an
   unreadable one included; it says each change in the hold, once, in its
   journal, and an unreadable or expired hold at `warn`.

   **Reboot authority.** At most one mechanism reboots the host at a time.
   The role checks first (the hour, the hold's bounds, a reboot
   unattended-upgrades already scheduled), installs the script and units,
   enables the timer, reads it back active and enabled, and only then writes
   the override that turns unattended-upgrades' own reboot off. Then it
   reads back the setting apt itself ends up with, and stops the run if a
   later file in `/etc/apt/apt.conf.d` turns it back on, with a one-line
   command that finds the file. A run that stops before the override
   leaves unattended-upgrades' own setting as it was. One case leaves
   neither for a night: a run that cancelled a reboot unattended-upgrades
   had scheduled and then stopped before the override. Its next daily run
   schedules the reboot again, since `Automatic-Reboot` is still on, and a
   re-run of `bootstrap.sh` completes the hand-over. The script **stands
   down** whenever apt's effective configuration has
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
   (07:15) are placed around. The service runs as root (the two docker
   sockets, the reboot) with the file system read-only to it but for the
   hold's directory and home hidden, `TimeoutStartSec=2min` so a docker that
   hangs is a failed run rather than a night lost (the wait for the
   acknowledgement and both looks fit inside it), and the failure notifier
   in `OnFailure=`. A stop is not a
   failure: the script's TERM trap exits 143, which `SuccessExitStatus=143`
   counts as success, so neither an owner's `systemctl stop` nor the
   reboot's own stop job reaching the unit pages; a `TimeoutStartSec` kill
   still does, as a timeout. The label is the agent's `JOB_LABEL`, the hold's
   and the acknowledgement's paths the agent's, the agent unit the
   `labs_agent` role's, the sandbox socket `coder_sandbox`'s and the
   workspace label the templates'; `scripts/lab-job-limits.test.mjs`,
   `scripts/lab-host-docker-proxy.test.mjs` and the test below hold each
   pair together.

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
9. `hcw-playbook-drift`, a nightly timer at 03:00 (LAB-4, #950). Runs
   `ansible-playbook -i inventory/localhost.yml site.yml --check --diff` from
   the applied checkout (`/opt/hcw-src/lab-host/ansible`), before the Coder
   dump (03:30) and the idle reboot (04:30).
   - If changes would be applied, logs `playbook drift detected ...: <n> change(s) would be applied`
     at `daemon.warning` under the tag `hcw-playbook-drift`, exiting 2.
   - If the playbook execution fails, logs `playbook check failed (rc=..., failed=...)`
     at `daemon.warning`, exiting 1.
   - Non-zero exits mark the unit as failed, triggering `OnFailure=hcw-unit-failed@%n.service`
     which pages `alert-lab-unit-failed`.
   - On a clean run with no drift, logs `playbook check: no drift detected ...`
     at `daemon.notice` and exits 0.

## Break-glass

Root has no key (its `authorized_keys` is kept empty) and sshd lets in
`hcwadmin` alone, by key. When SSH is not working, the intended way in is
hPanel's **Web Console** (https://hpanel.hostinger.com/vps, **Manage** on
the server, then **Web Console**), signed in as root with root's password.

**Unverified:** whether that console goes through sshd. Hostinger's page
says it "functions exactly like a standard SSH connection"; if it is an SSH
login as root, this role's settings refuse it and the break-glass is gone.
Root login over SSH has been off since 2026-09-26, the journal shows no SSH
login as root and no console login since, and a getty runs on `tty1` and
`ttyS0`, which a VNC or serial console would use, but none of that settles
it. So the owner signs in to the Web Console before and after the first run
with #953, keeping an SSH session open through the run
(`docs/runbooks/labs-host.md`, "The first `bootstrap.sh` run with #953").

## Accepted risk: passwordless sudo

`hcwadmin` keeps `NOPASSWD:ALL` (owner decision 2026-10-16, #953). Whoever
holds a session as `hcwadmin` is root on the host with no second factor.
The owner accepts that risk, and the controls in front of that session
carry it:

- **The pinned key.** `hcwadmin`'s `authorized_keys` holds exactly the keys
  in `group_vars/all.yml`, rewritten on every run; the owner's workstation
  key is the only one.
- **`AllowUsers hcwadmin`** with `AuthenticationMethods publickey`: no other
  account, and no password, logs in over SSH.
- **Azure Arc SSH** (#953): SSH through the Arc agent's relay, which hands
  each session to sshd on the loopback. Port 22 is closed to the internet
  at ufw since #953 stage 3, so a session needs the pinned key and an Azure
  sign-in with access to the Arc machine. sshd itself still listens on
  every address until #1257 binds it to the loopback.
- **The login alert** (`alert-lab-ssh-login`, #953): pages on every
  accepted SSH login that is not `hcwadmin` by public key with the pinned
  key, or that did not arrive from the loopback. It is keyed on the INFO
  line `Accepted publickey for …`, which names the key's fingerprint at any
  log level. It ignores VERBOSE's `Accepted key` and `Accepted certificate`
  lines, so each login counts once.

Revisit if a second person gets a key, or if either of those controls is
dropped.

## Rolling back

A rollback must keep `hardening_admin_authorized_keys` pinned in
`group_vars/all.yml`. Once this role has run, root's `authorized_keys` is
empty, so there is nothing left to copy from:

- with the list set back to `[]`, this revision stops every
  `bootstrap.sh` run at its empty-list check;
- the revision before #953 copied root's keys into `hcwadmin`'s when the
  list was empty, so with `[]` it finds none and stops every run at its own
  "No public key" check.

So revert the code if you need to, but leave the list as it is: every
revision writes `hcwadmin`'s keys from a non-empty list. Rolling sshd's
settings back is the same: revert the template and run `bootstrap.sh`; the
reload keeps open sessions.

## Handlers

`Reload ssh`, `Restart unattended-upgrades`, `Restart fail2ban`, `Reload
systemd for the failure notifier`, `Reload systemd for the held-package
report`, `Reload systemd for the idle reboot`, `Reload systemd for playbook
drift detection`.

## Tests

`tests/admin-keys.test.sh` runs `tasks/admin_keys.yml` with ansible-core
against a journal fixture and scratch copies of the two `authorized_keys`
files: an empty list, a malformed entry and one `ssh-keygen` cannot read
stop the run with nothing written. With logins in the journal, a list
without the key of the most recent login as the user or root stops it,
though it keeps another key on file, and a list with that key passes;
another user's login, a refused key and VERBOSE's `Accepted key` line do
not count. With an empty journal it falls back to the files: a list that
shares no key with `hcwadmin`'s file, or with root's while `hcwadmin`'s has
none, stops it with both sides' fingerprints. A journal that cannot be
read stops it too. The override lets a refused list through, a list that
passes writes `hcwadmin`'s file to exactly the list, and a second run
changes nothing. No root needed: the administrative user is the account
running the test, so it owns what the test writes. CI runs it in the
`ansible-lint (lab-host)` job.
`tests/sshd-apply.test.sh` runs `tasks/sshd.yml` against a stub `sshd`
and scratch paths, with the role's handlers as written except that the
reload of `ssh.service` becomes a log line recording the size of root's
`authorized_keys` at that moment. A fresh write marks the reload pending
before the drop-in is written, reloads, clears the marker and only then
empties root's keys, and a second run changes nothing; a marker an
interrupted run left makes the next run reload before root's keys are
emptied; a drop-in that `sshd -T` does not confirm is put back with its
backup removed, root's keys untouched, and the forced reload clears the
marker; check mode with a marker left reports it and changes nothing. As
root, because the tasks make root the owner of what they write; CI runs it
with `sudo` in the `ansible-lint (lab-host)` job.
`tests/ufw-closed-ports.test.sh` runs `tasks/ufw.yml` with the lab host's
`group_vars` against the real ufw, in a network and mount namespace of its
own so the machine's firewall is untouched, with a stub `azcmagent`.
Seeded as the host was before #953 stage 3 (22, 80 and 443 open) with Arc
SSH ready, a run deletes 22's pair and keeps the rest, and a second run
and check mode change nothing. Check mode reports a re-added allow as
drift. A bare `22`, `limit 22/tcp`, an interface rule, a port list, a
destination address and the `OpenSSH` profile each fail the run at the
read-back; 2222 and 220 do not. A Disconnected agent leaves 22 as it is:
closed stays closed, and one reopened for re-onboarding stays open. 22 is
allowed, with the line saying why, for a missing, Expired or unreadable
agent or one without incoming port 22, and the next run with Arc ready
closes it. A port written as a string goes through the gate the same way. A
port in both lists stops the run before any rule changes. As root, for the
namespaces; CI runs it with `sudo` in the `ansible-lint (lab-host)` job,
after installing ufw.
`scripts/lab-host-ssh-hardening.test.mjs` (vitest) holds the drop-in's
directives, the pinned key and its fingerprint, the order of the checks
before the reload, the pending-reload marker, and root's empty file.

`tests/hcw-playbook-drift.test.sh` renders the drift detection script and its
two units with the role's defaults and runs the script against stub
`ansible-playbook` and `logger`: a notice line on a clean check run (ok,
changed=0), a warning line and exit 2 on detected drift (changed>0), a warning
line and exit 1 on playbook execution failure, and `--vault-password-file` and
`-e` passed when vault files exist. Needs neither root nor Docker; CI runs it in
the `ansible-lint (lab-host)` job.

`tests/unattended-upgrades.test.sh` renders `52hcw-unattended-upgrades.j2`
with the role's defaults and asserts the override clears and names the
allowed origins itself and leaves the reboot to `hcw-reboot-when-idle.timer`
(`Automatic-Reboot` off, neither setting read only while it is on) (LAB-13,
#959). Same job, same requirements as the tests below.

`tests/hcw-held-upgradable.test.sh` renders the report script and its two
units with the role's defaults and runs the script against stub `apt-mark`,
`apt` and `logger`: one warning line per held package with an upgrade and
none for a package that is not held, the notice line when nothing is
upgradable, the pending-reboot line aged from item 8's first-seen record
when the marker has been rewritten, and a non-zero exit when apt fails. It
needs neither root nor
Docker; CI runs it in the `ansible-lint (lab-host)` job, and
`lab-host/README.md` ("Validating without a host") has the container line.

`tests/hcw-reboot-when-idle.test.sh` renders the idle-reboot script and its
two units the same way and runs the script against stub `apt-config`,
`loginctl`, `docker`, `sleep`, `systemctl` and `logger`, with the marker,
the hold, its first-seen record and the sandbox socket at scratch paths.
The `loginctl` stub answers from session listings in the host's columns,
the first of them the one measured on the host above; the `docker` stub
answers for the host daemon and the sandbox daemon from container lists
with a state on each line, filtering on `status=` as docker does.
`Automatic-Reboot` on is the stand-down line and nothing else asked; an
`apt-config` that cannot answer is an `err` line and a failed run. No
marker is the notice line, no reboot and no record; that listing (one
`user` session for hcwadmin) is the deferred line naming hcwadmin once, and
so is a second SSH login for the same user; root at the console
(`user-early`) defers too; only `manager`, `manager-early` and
`background` sessions do not, so docker is asked (docker is not even asked
while a user is logged in). A marker rewritten after the first sight still
reads its first age, and a record seven days old is overdue whatever the
marker's time. Job containers up (running or paused) are the deferred
line with their count, an exited one not counted, and so is one created
and not yet started; a workspace up on the sandbox daemon is the workspace
deferral, the sandbox is not asked when its socket is absent, and a sandbox
that cannot answer is an `err` line. A `loginctl` that cannot list or read
a session, a docker that cannot answer and a docker the shell cannot find
are each one `err` line, a non-zero exit and no reboot. The `systemctl`
stub answers `is-active` for the agent's unit from a state file, and the
`sleep` stub, one call per second the script waits, plays the agent: on the
call the test chooses it writes the hold's expiry to the acknowledgement
(or another hold's). An agent systemd calls inactive or failed means no
wait and a reboot; activating, deactivating, or a systemctl that cannot
reach the manager, means a wait; no acknowledgement in 45 s, or one naming
another hold, defers the night with no second look; one already there
means no wait at all, and one that comes on the thirtieth second still
lets the host reboot. On its first call the `sleep` stub also records the
hold as it stood (an expiry 300 s on, mode 0644) and can change the host:
a job container (running, or created and not started), a workspace or a
login that appears then defers the night at the second look and removes
the hold; a docker that fails at the second look and a refused reboot each
fail the run and remove it; a stop (SIGTERM) during the wait exits 143 and
removes it; a hold or a record that cannot be written fails the run before
the wait. An idle host, with the lingering managers still listed or with no
sessions at all, is the rebooting line, one second's wait for the
acknowledgement, two looks at logind and both daemons, and exactly one
`systemctl reboot`, with the hold left in place. A reboot pending 7 days is
deferred at `err` (for a login, a job, a workspace, or an agent that never
confirms), 6 days at `warning`. It also checks that the script never calls
`users` or `who`, that its only sleep is the one-second wait for the
acknowledgement, that it reads the acknowledgement where the `labs_agent`
role tells the agent to write it and asks about that role's unit, that the
unit counts exit 143 as success, that the role deals with a
scheduled shutdown before it installs the timer, keys the cancel's
read-back on the cancel having run (not on `rc`, which check mode also
sets), writes the override only after reading the timer back and reads
apt's effective `Automatic-Reboot` back after it, and holds the timer to
the role's hour, the hold's path to the `labs_agent` role's, the sandbox
socket to `coder_sandbox`'s, the workspace label to every Coder template's
workspace container and the job label to the agent's `JOB_LABEL` when
`vps-agent/` is in the checkout. Same job, same requirements.

## Check mode

Safe. Every task is a module with check-mode support; `sshd -t` and `visudo -cf`
run against the rendered temporary file, not the live one. Three reads run
in check mode too, because they change nothing: `shutdown --show`, a `grep`
of unattended-upgrades' log, and `apt-config`'s answer for
`Automatic-Reboot`. `shutdown -c` does not run in check mode. Its read-back
and assertion are keyed on `hardening_scheduled_shutdown_cancel is not
skipped`, because a `command` that check mode skips still registers `rc` 0
(measured on ansible-core 2.21.4), so a key on `rc is defined` would read
back, in `bootstrap.sh --check --diff`, a reboot nothing cancelled, and fail.
The assertions on the timer's read-back and on apt's `Automatic-Reboot` are
skipped in check mode: on a host that has never had the timer, or still
has the old override, check mode installs and writes nothing for them to
read.
