# Labs host — desktop access and Azure Arc onboarding

How to reach the Hostinger lab host from a desktop over SSH and VS Code (the
first section); how to reinstall it, and what the first `bootstrap.sh` run
checks before it changes anything; how the lab agent goes live, which is one
PowerShell line; the order of the run after a merge (the playbook, then the
Coder template, at once); how the owner adds a learner to Coder and removes
one ("Coder sign-in", #954); how the host renews the site's Coder status token
and publishes the template on its own once the owner seeds one credential
("Automatic renewal"); how to check, after the run that turns it on, that the
container runtime is privilege-separated and how to take that back (LAB-5);
how the owner reaches Portainer and
initialises and unseals HashiCorp Vault on it (owner decision 2026-09-26),
and moves that Vault to auto-unseal through the Arc identity (#726);
how to reload Caddy by hand now that its admin API is a Unix socket (#958);
how the owner turns on a tool add-on, the first being the migration
assessment the site frames at `/tools/migration` ("Tool add-ons", ADR 0035);
how fast a runc, containerd or Docker Engine advisory is fixed on the host,
and who does what ("Runtime advisories", #949);
how the site counts the lab sessions it starts for visitors, what that count
does and does not cover, and where an admin reads it ("Counting lab starts");
and how the host becomes an Azure Arc-enabled server in
`rg-lab-hybrid-prod-cus`, sends heartbeat and `auth`/`authpriv` syslog to the
Management workspace, and is audited against the Linux security baseline,
which is two runs of one PowerShell script with one `hcw-azure` run between
them (ADR 0032 decision 3, #663; the rest of the page). The shape of the host is
[Labs host](../architecture/labs-host.md); the decisions are
[ADR 0032](../decisions/0032-learner-labs-platform.md).

## Connect from a desktop

`scripts/lab/Connect-Lab.ps1` sets up any desktop to reach the host by the
name `hcw-lab`. It creates a per-machine key, `$HOME\.ssh\hcw-lab_ed25519`,
if there is none; writes one `Host hcw-lab` block into `$HOME\.ssh\config`
after a timestamped backup, leaving every other line alone; loads the key
into `ssh-agent`; and prints the public key with the step that authorizes it.
It never reads or sends the private key, and a second run changes nothing
and says so. It needs PowerShell 7 (`pwsh`, installed by the `winget` line
below) and the OpenSSH client, which Windows 10 and 11 include; on macOS and
Linux it runs under `pwsh` with the same paths under `$HOME`.

VS Code needs the **Remote - SSH** extension, `ms-vscode-remote.remote-ssh`.
PowerShell:

```powershell
code --install-extension ms-vscode-remote.remote-ssh
```

Success prints that the extension was successfully installed, or that it is
already installed. If `pwsh` is not on the machine, PowerShell:

```powershell
winget install --id Microsoft.PowerShell --source winget
```

### Optional: one host name for every desktop

The script points `hcw-lab` at the repository variable `LAB_SSH_HOST` when
`gh` is installed and signed in, and at `lab.hybridcloudworks.com`
otherwise. That record does not exist until the `hcw-lab` apply
(`infra-lab/README.md`, step 5), so until then the variable holds the
server's IPv4 address. This site carries no addresses
([Labs host](../architecture/labs-host.md)), so the command reads it from the
clipboard: copy it from the server's page in hPanel
(https://hpanel.hostinger.com/vps, then **Manage**), then, PowerShell:

```powershell
gh variable set LAB_SSH_HOST -R saulpatinojr/HCW-HybridCloudWorks -b (Get-Clipboard -Raw).Trim()
```

Once the record exists, switch the variable to the name, PowerShell:

```powershell
gh variable set LAB_SSH_HOST -R saulpatinojr/HCW-HybridCloudWorks -b lab.hybridcloudworks.com
```

Success for either is this printing the value; run the script again on each
desktop afterwards so its block picks the value up:

```powershell
gh variable get LAB_SSH_HOST -R saulpatinojr/HCW-HybridCloudWorks
```

### Run it on a machine with the repository

PowerShell, from the repository root on `main` once this change has merged
(`Test-Path scripts/lab/Connect-Lab.ps1` prints `True` when the working tree
has the script):

```powershell
pwsh -NoProfile -File scripts/lab/Connect-Lab.ps1
```

Until the first `bootstrap.sh` run, the host accepts `root` only. For that
window add `-User root`, and run the line above again once bootstrap has
finished and turned root login off:

```powershell
pwsh -NoProfile -File scripts/lab/Connect-Lab.ps1 -User root
```

### Run it on a machine without the repository

PowerShell. This saves a copy of the script from `main` to Downloads, then
runs that copy:

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/scripts/lab/Connect-Lab.ps1 -OutFile $HOME\Downloads\Connect-Lab.ps1; pwsh -NoProfile -File $HOME\Downloads\Connect-Lab.ps1
```

It is saved rather than piped to `iex` so that what runs is a file you can
open and read first, run as a script with its parameters, where `iex` would
run whatever the URL returned at that moment, unread, inside your current
session. For the root window, run the saved copy again with `-User root`:

```powershell
pwsh -NoProfile -File $HOME\Downloads\Connect-Lab.ps1 -User root
```

### What success looks like

The run that sets a machine up ends with the public key, the line that pins
it, and `Changed:` naming what it did. Every later run ends with
`No changes: this machine was already set up for hcw-lab.`

**The pinned key (#953, owner decision 2026-10-16).** The keys that may log
in are one list, `hardening_admin_authorized_keys` in
`lab-host/ansible/group_vars/all.yml`. Every `bootstrap.sh` run writes
`hcwadmin`'s `authorized_keys` from that list and nothing else, keeps
root's empty, and lets `hcwadmin` alone in over SSH, by key only
(`AllowUsers hcwadmin`, `AuthenticationMethods publickey`). The list holds
one key, the owner's workstation key `hcw-lab_ed25519.pub`,
`SHA256:VTyaLLQLfYwi38RP1mHDD6Vtu0eSQsa4EPsNJTrdgG8`. Before it writes, the
run stops if the list is empty, or if it does not hold the key of the most
recent SSH login in the journal (the lockout guard; on a host with no login
in the journal, if it shares no key with the keys on file), and says which
keys it compared.

- **A second key (another desktop):** the script prints the line to add,
  `  - ssh-ed25519 AAAA…`, which is the key's type and key with the comment
  stripped. Put it under `hardening_admin_authorized_keys` in
  `lab-host/ansible/group_vars/all.yml` on a branch and merge it. Then, from
  the machine that already connects, PowerShell:

  ```powershell
  ssh hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"
  ```

  Success is a play recap with `failed=0`, after which the new desktop's
  `ssh hcw-lab hostname` prints the host name. To use the new desktop before
  the merge, run the other line the script printed on the machine that
  already connects: it adds the key to `hcwadmin`'s file at once, until the
  next `bootstrap.sh` run removes it, and the nightly drift check reports
  that file as drift until the key is in the list.
- **The first key for a reinstalled server:** paste the public key in hPanel
  at https://hpanel.hostinger.com/vps, **Manage** on the server,
  **Settings**, **SSH keys**, **Add SSH key**. hPanel installs it for root,
  and the first `bootstrap.sh` run, made as root, writes `hcwadmin`'s file
  from the list and empties root's. The most recent login the guard finds
  in the journal is that root login, so the run goes ahead only if the key
  hPanel installed is in the list; the pinned workstation key is
  (`infra-lab/README.md`, steps 6 and 7).
- **Replacing every key** (a lost or rebuilt workstation): put the new key
  in the list instead of the old one and merge. The guard then stops the
  run, because the key of the most recent login is no longer in the list.
  Run it once with the override from hPanel's Web Console (below), bash, on
  the host:

  ```bash
  sudo /opt/hcw-src/lab-host/bootstrap.sh -e hardening_admin_keys_replace_all=true
  ```

Then this prints the server's host name, PowerShell:

```powershell
ssh hcw-lab hostname
```

The first connection asks you to accept the host key. Its fingerprint can be
read from the host itself in the Web Console (below), bash, on the host; the
`SHA256:` value must match the one `ssh` shows:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

To open the repository checkout on the host in VS Code (it exists after the
first `bootstrap.sh` run), PowerShell; the script's `-Code` switch does the
same after setup, and `-Connect` opens a shell:

```powershell
code --remote ssh-remote+hcw-lab /opt/hcw-src
```

Windows ships the `ssh-agent` service disabled, and the script says so
rather than changing it. Without the agent everything still works, and each
connection asks for the key's passphrase. To turn it on, run this once in
PowerShell opened with **Run as administrator**, then run the script again:

```powershell
Set-Service -Name ssh-agent -StartupType Automatic; Start-Service -Name ssh-agent
```

An OS reinstall gives the host a new host key, and `ssh` then refuses with
`REMOTE HOST IDENTIFICATION HAS CHANGED`. This removes the old entry for
whatever `hcw-lab` points at, PowerShell:

```powershell
ssh-keygen -R (ssh -G hcw-lab | Select-String -Pattern '^hostname (.+)$').Matches[0].Groups[1].Value
```

The site itself never tunnels into the host: under ADR 0032 the host
accepts inbound 80 and 443 only (22 too until Azure Arc SSH is ready, #953
stage 3), and the site's one view of it is the read-only
status proxy in the Function App ([Labs host, Exposure](../architecture/labs-host.md#exposure)).
SSH from a desktop, through Azure Arc ("Connect through Azure Arc", below),
is the only shell. When SSH is not working, hPanel's
**Web Console** is the break-glass: https://hpanel.hostinger.com/vps,
**Manage** on the server, then **Web Console** on its overview. It usually
signs in by itself; when it asks, Hostinger's instructions are `root` and
the root password.

**The Web Console does not go through sshd** (#953, verified 2026-10-17).
Hostinger's own page says the session "functions exactly like a standard
SSH connection"
([How to use the Hostinger VPS Web Console](https://www.hostinger.com/support/how-to-use-the-web-console-in-hostinger/)),
but on this host it is a console login. It shows the getty's
`srv939861 login:` prompt, and it opened a shell on 2026-10-17 while sshd
refused every root login (`PermitRootLogin no` since 2026-09-26,
`AllowUsers hcwadmin`, publickey only, root's `authorized_keys` empty). A
getty runs on `tty1` and on the serial port `ttyS0`, which a VNC or serial
console uses. It needs neither sshd, Arc nor port 22, which is what makes
it the break-glass with port 22 closed.

### The first `bootstrap.sh` run with #953

1. **Before the run**, sign in to the Web Console:
   https://hpanel.hostinger.com/vps, **Manage** on the server, then
   **Web Console**. Success is a `root@` prompt. If it does not get there,
   stop and say so on #953 before running anything: SSH would then be the
   only way in, and this change should not be applied until the
   break-glass is settled.
2. Open an SSH session and keep it open until step 4, PowerShell:

   ```powershell
   ssh hcw-lab
   ```

3. In that session, run the playbook, bash, on the host. Success is a play
   recap with `failed=0`; leave the session open afterwards:

   ```bash
   sudo /opt/hcw-src/lab-host/bootstrap.sh
   ```

4. From a second PowerShell window, check that a new SSH login still works.
   Success prints the server's host name:

   ```powershell
   ssh hcw-lab hostname
   ```

   If it fails, the open session from step 2 is still root through `sudo`,
   and `sudo journalctl -u ssh.service -n 20` there says why.
5. Sign in to the Web Console again. Success is the same `root@` prompt. If
   it stopped working after the run, it was going through sshd: SSH still
   works (step 4), so nothing is locked out, but say so on #953, because
   with port 22 closed the console is the only way in when Arc SSH is down.
   (Done on 2026-10-17: it is a console login, above.)

Then this shows what sshd now applies. PowerShell:

```powershell
ssh hcw-lab 'sudo -n sshd -T | grep -e ^allowusers -e ^authenticationmethods'
```

Success is exactly these two lines:

```text
allowusers hcwadmin
authenticationmethods publickey
```

### Connect through Azure Arc

Owner decision 2026-10-16 (#953; [ADR 0032](../decisions/0032-learner-labs-platform.md),
amendment of that date): the owner reaches the host through **Azure Arc
SSH**, and port 22 is closed to the internet (#953 stage 3). Arc SSH
carries the session through a relay the host's Arc agent dials out to, so
sshd needs no open port; sshd still asks for the same pinned key. The
direct block works only where 22 is open: on a rebuilt host before Arc
onboards it ("Re-onboarding a rebuilt host"), or after "When Arc SSH is
down", below. Running the script without `-Arc` puts it back.

`Connect-Lab.ps1 -Arc` writes the same `Host hcw-lab` block with a
`ProxyCommand`. That runs `$HOME\.ssh\hcw-lab-arc-proxy.ps1` (written by the
script, run by Windows PowerShell 5.1), which asks `az ssh config` for fresh
relay credentials on **every** connection, since they last an hour at most,
and hands the connection to the az ssh extension's proxy. So `ssh hcw-lab`,
piped commands, `ssh -t`, `ssh -L` and VS Code Remote-SSH work as they do
directly, from PowerShell and Git Bash alike, and nothing expires an hour
after setup. The credentials are written by az into a folder only you can
read, under `$env:LOCALAPPDATA\hcw-lab-arc`; the helper reads them and
deletes the folder **before** the connection starts, and the proxy gets
them in its environment, so they are not on disk while you are connected,
nor after: Windows OpenSSH ends a connection by killing the helper, so no
cleanup at the end could be relied on. A folder is left only if the helper
is killed in the few seconds az is writing it, and the next connection, or
any run of `Connect-Lab.ps1`, deletes it once it is an hour old and the
credentials in it have expired. Each connection takes a few seconds
longer while az fetches the credentials. The host key is checked under the
name a direct connection used (`HostKeyAlias`), so the key already accepted
is the one Arc must present. After an OS reinstall, the old key is removed
under that name, PowerShell:

```powershell
ssh-keygen -R (ssh -G hcw-lab | Select-String -Pattern '^hostkeyalias (.+)$').Matches[0].Groups[1].Value
```

Once, in this order:

1. **The `hcw-azure` run** that creates the Arc machine's connectivity
   endpoint and its SSH service configuration on port 22
   (`infra/lab-hybrid.tf`): two creates,
   `azapi_resource.lab_hybrid_arc_connectivity_endpoint[0]` and
   `azapi_resource.lab_hybrid_arc_ssh_service_configuration[0]`, beside the
   permanent diff, confirmed in the HCP Terraform UI. Run it before anything
   below: the az ssh extension creates a missing endpoint itself, and this
   run would then fail on one that already exists. The script refuses to
   continue until it has run.
2. **The playbook run** that turns on the agent's incoming connections for
   port 22 alone (the `arc` role, `arc_incoming_ssh_enabled`), PowerShell:

   ```powershell
   ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"
   ```

   Success is a recap with `failed=0`, after the line `Arc agent: extension
   allowlist Microsoft.Azure.Monitor/AzureMonitorLinuxAgent; incoming
   connections on, port 22 only (Arc SSH).` The run stops instead if the
   allowlist reads anything else.
3. **The az ssh extension** on this desktop, PowerShell:

   ```powershell
   az extension add --name ssh
   ```

   Success is this printing a version, 2.0.4 or later:

   ```powershell
   az extension show --name ssh --query version -o tsv
   ```

4. **The script**, from the repository root on `main` once this change has
   merged, signed in with `az login`. The script exists on `main` already,
   so check for its `-Arc` switch instead; this prints `True` once the
   working tree has it, PowerShell:

   ```powershell
   Select-String -Path scripts/lab/Connect-Lab.ps1 -Pattern '\[switch\] \$Arc' -Quiet
   ```

   Then, PowerShell:

   ```powershell
   pwsh -NoProfile -File scripts/lab/Connect-Lab.ps1 -Arc
   ```

   It reads first and changes nothing until each check passes: az, the
   extension, the sign-in, and the service configuration from step 1. Then
   it writes the helper, asks Azure once for relay credentials through it
   (which also downloads the extension's proxy), and only then replaces the
   block. Success ends with `Changed:` naming the helper and the block, after
   the line `hcw-lab (Arc): relay credentials issued for
   arcs-lab-hybrid-prod-cus-01; proxy …`. A refusal names the step to run
   and leaves the direct block in place.
5. **The test**, PowerShell:

   ```powershell
   ssh hcw-lab hostname
   ```

   Success prints the host's name, after a few seconds. That it came
   through Arc is this, whose first field is `127.0.0.1` or `::1`, the
   host's own loopback, where the relay hands connections to sshd:

   ```powershell
   ssh hcw-lab 'echo $SSH_CONNECTION'
   ```

   A failure prints lines starting `hcw-lab (Arc):` that say why. VS Code
   opens the repository the same way as before; if Remote-SSH gives up
   connecting, raise its **Remote.SSH: Connect Timeout** setting to 60.
6. **The break-glass path**: the Web Console checks of "The first
   `bootstrap.sh` run with #953" above (its steps 1 and 5). It needs
   neither Arc, the relay nor port 22, so it is the way in when nothing
   else works.

Port 22 closed after step 5 here and those console checks had both
succeeded (2026-10-17; #953 stage 3). Two things close it, and both follow
one decision (the Arc gate, `roles/hardening/tasks/arc_gate.yml`):
- **ufw:** the hardening role deletes ufw's allow for 22, and fails a run in
  which any ALLOW or LIMIT rule still names it, or Ubuntu's `OpenSSH`
  profile does.
- **sshd's bind:** sshd listens on the loopback alone (#1257).

The gate decides from the Arc agent:
- **Connected,** with incoming connections on for port 22: SSH is closed to
  the internet.
- **`Disconnected`** (a network drop, or an agent reset to be onboarded
  again): the run leaves ufw's 22 rule and sshd's bind as they are, and
  prints a line beginning `Port 22 is left as ufw has it on this run`.
- **Anything else** (no agent, as on a rebuilt host before onboarding, or
  `Expired`): 22 stays open, sshd listens on every address, and the run
  prints `Port 22 stays open to the internet on this run`. The listener
  check admits 22 only then.

The SSH login alert
(`alert-lab-ssh-login`, `lab_ssh_loopback_only`) pages on any accepted
login that did not come through Arc, so a login over a reopened 22 pages
too, once the agent's syslog reaches the workspace. Before onboarding no
syslog leaves the host, so nothing pages.

### Closing port 22: the first run

Once the `hcw-azure` run that turns `lab_ssh_loopback_only` on has applied
(the change's own steps say which run), one `bootstrap.sh` run closes the
port. Bash, on the host, through Arc (`ssh hcw-lab` from a desktop set up
with `-Arc`):

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh
```

Success is a recap with `failed=0` and no line beginning `Port 22 stays
open` or `Port 22 is left`. Then, from the same session, bash on the host,
this prints nothing:

```bash
sudo ufw status | grep -E '(^|[ ,])22([,/ ]|$)|OpenSSH'
```

And this prints only `127.0.0.1:22` and `[::1]:22` in its fourth column,
sshd on the loopback alone:

```bash
ss -Hltn 'sport = :22'
```

And from the desktop, PowerShell, this still prints the host's name,
through Arc:

```powershell
ssh hcw-lab hostname
```

### When Arc SSH is down

With port 22 closed, a broken Arc path (the agent, the relay, the az ssh
extension or the Azure sign-in) leaves hPanel's Web Console as the way in:
https://hpanel.hostinger.com/vps, **Manage** on the server, then **Web
Console**, signed in as `root`.

1. **Read the agent**, bash, in the Web Console. Success is `Agent Status
   : Connected`:

   ```bash
   /opt/azcmagent/bin/azcmagent show
   ```

   `Disconnected` usually clears by itself once the host reaches Azure
   again. `Expired` means onboarding again: reset the agent ("Disconnecting",
   step 3), reopen SSH (step 2 here), then "Re-onboarding a rebuilt host".
   A reset agent reads `Disconnected`, and the hardening role leaves ufw's
   22 rule and sshd's bind as they are while the agent does. So the reopened
   SSH stays open through `Register-LabArc.ps1 -Connect`, and the first run
   with the agent `Connected` again closes it.
2. **Reopen SSH for the repair**, bash, in the Web Console. Both halves are
   needed: ufw admits 22, and sshd listens beyond the loopback (#1257).

   ```bash
   ufw allow 22/tcp && sed -i '/^ListenAddress /d' /etc/ssh/sshd_config.d/00-hcw-hardening.conf && systemctl daemon-reload && systemctl restart ssh.socket
   ```

   Success is `Rule added` and `Rule added (v6)`, and then this lists
   `0.0.0.0:22` and `[::]:22` in its fourth column:

   ```bash
   ss -Hltn 'sport = :22'
   ```

   With no agent, or an `Expired` one, a `bootstrap.sh` run from the Web
   Console does both itself, since the gate keeps SSH open then.

   Then point the desktop at the direct block, PowerShell, from the
   repository root:

   ```powershell
   pwsh -NoProfile -File scripts/lab/Connect-Lab.ps1
   ```

   While it is open, every login over 22 pages `alert-lab-ssh-login`
   (severity 1) once the agent's syslog reaches the workspace, late if the
   agent is cut off. That is the alert working, not a second problem.
3. **Close it again** once Arc SSH answers (`ssh hcw-lab hostname` after
   `Connect-Lab.ps1 -Arc`): run `bootstrap.sh` as in "Closing port 22: the
   first run". It deletes the rule and binds sshd to the loopback again, and
   fails rather than leave the rule if it cannot.

## The first-run host check

`lab-host/bootstrap.sh` configures only a host that was prepared for it. On
2026-09-26 its first run met a VPS that had never been reinstalled: two
self-hosted GitHub Actions runners, Portainer, an nginx site on port 80,
k3s, Vault and an old install of the agent. Before failing, that run
upgraded and restarted Docker, which killed a running Dependabot job,
enabled ufw and rewrote sshd's settings. So on a host it has never
accepted, the script now looks for other workloads before it changes
anything, and stops if it finds one:

- any Docker container, running or stopped;
- an installed `actions.runner.*` systemd unit (a self-hosted runner);
- Kubernetes: a `k3s`, `k0s`, `rke2`, `kubelet` or `microk8s` unit, or
  `/usr/local/bin/k3s`, `/etc/rancher`, `/var/lib/rancher`,
  `/etc/kubernetes`, `/var/lib/kubelet`;
- `/opt/hcw-src` or `/opt/hcw-labs-agent` holding anything but a checkout of
  this repository;
- anything else under `/opt`;
- a TCP listener other than sshd on 22 and systemd-resolved on
  `127.0.0.53:53` and `127.0.0.54:53`.

A refusal ends with exit code 3 and changes nothing. On a copy of the
2026-09-26 host (Docker from Docker's repository, and stand-ins for each
workload, in an Ubuntu 26.04 test container) the step-7 line printed:

```text
[bootstrap] host check: this host has not run bootstrap.sh before; looking for other workloads first
[bootstrap] refusing to configure this host: it shows signs of other workloads, and bootstrap.sh has never run here (no /etc/hcw/bootstrap-host-accepted).
[bootstrap] found:
[bootstrap]   - Docker container old-nginx (busybox:1.37, Up 15 seconds)
[bootstrap]   - Docker container old-portainer (busybox:1.37, Up 16 seconds)
[bootstrap]   - systemd unit actions.runner.example-org-example-repo.runner-1.service (enabled): a GitHub Actions self-hosted runner
[bootstrap]   - systemd unit actions.runner.example-org-example-repo.runner-2.service (enabled): a GitHub Actions self-hosted runner
[bootstrap]   - systemd unit k3s.service (enabled): Kubernetes
[bootstrap]   - /etc/rancher exists: Kubernetes
[bootstrap]   - /opt/hcw-labs-agent exists and is not a checkout of https://github.com/saulpatinojr/HCW-HybridCloudWorks.git
[bootstrap]   - /opt/actions-runner: not created by this repository
[bootstrap]   - /opt/containerd: not created by this repository
[bootstrap]   - TCP listener on 127.0.0.1:8200 (python3)
[bootstrap]   - TCP listener on 0.0.0.0:80 (docker-proxy)
[bootstrap]   - TCP listener on [::]:80 (docker-proxy)
[bootstrap] nothing has been changed. A run would move Docker to its pinned version and restart it, enable ufw with only TCP 22, 80 and 443 open, and replace sshd's login settings, whatever the workloads above need.
[bootstrap] either reinstall the server with Ubuntu 26.04 LTS and run this again (docs/runbooks/labs-host.md, "Reinstalling the host"),
[bootstrap] or, only if every item above is meant to stay and may be disrupted, accept the host knowingly:
[bootstrap]   HCW_ADOPT_NONEMPTY_HOST=1 /opt/hcw-src/lab-host/bootstrap.sh
```

The way on is the reinstall below. The other, for a host whose workloads
are meant to stay, is the last line of the refusal, bash, on the host, as
root:

```bash
HCW_ADOPT_NONEMPTY_HOST=1 /opt/hcw-src/lab-host/bootstrap.sh
```

The first run that passes writes `/etc/hcw/bootstrap-host-accepted` before
its first change, and every run that finishes adds its commit and time.
While the file exists, later runs print `host check: skipped` and do not
look again, so a first run that fails half-way can simply be re-run.
Success on a clean host is these three lines at the top of the first run:

```text
[bootstrap] host check: this host has not run bootstrap.sh before; looking for other workloads first
[bootstrap] host check: no other workloads found
[bootstrap] host check: recorded in /etc/hcw/bootstrap-host-accepted
```

## Reinstalling the host

Owner decision 2026-09-26: the VPS is reinstalled clean, and nothing on it
is exported, because nothing on it was production. The same procedure
applies whenever the host check refuses or the host is compromised or broken:
ADR 0032 rebuilds the host rather than repairing it.

1. **Before wiping.** If the host is Connected to Azure Arc, delete its
   machine resource first ("Re-onboarding a rebuilt host", below). If the
   old host ran self-hosted GitHub Actions runners, remove their
   registrations where they were registered, or GitHub keeps them as
   offline runners. This repository's list is
   `https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/actions/runners`
   and the organisation's is
   `https://github.com/organizations/HybridCloudWorks/settings/actions/runners`;
   both were empty on 2026-09-26.
2. **Reinstall.** At https://hpanel.hostinger.com/vps, **Manage** on the
   server, then **OS & Panel**, **Operating System**: choose plain **Ubuntu
   26.04**, not a template that adds Docker, a control panel or an
   application, because the host check refuses anything those leave in
   `/opt` or running.
   Give root your SSH key there (the key `scripts/lab/Connect-Lab.ps1`
   printed; `infra-lab/README.md`, step 6). The same two steps exist in
   Hostinger's API, which is how the 2026-10-18 rehearsal ran them: `POST
   /api/vps/v1/virtual-machines/939861/recreate` with `template_id` `1214`
   (plain Ubuntu 26.04 LTS, the id the server already ran, so step 3 had
   nothing to set), then `POST /api/vps/v1/virtual-machines/939861/ssh-keys`
   with the public key; port 22 answered 45 seconds after the recreate was
   accepted. Reinstalling wipes the disk: the Ansible vault on the host,
   Portainer's data, Vault's data and the Coder automation's rotation
   credential go with it (step 7 brings each back).
3. **The workspace variable.** If the `hcw-lab` workspace exists, its
   `hostinger_template_id` must match the new install, or its next plan stops
   at the postcondition. Read the new value with the line in
   `infra-lab/README.md`, step 1, and set it at
   `https://app.terraform.io/app/hcw/workspaces/hcw-lab/variables`.
4. **Forget the old host key**, on every desktop that connected before. A
   reinstall gives the host new SSH host keys, and `ssh` refuses the new ones
   with `REMOTE HOST IDENTIFICATION HAS CHANGED` until the old entries are
   gone. PowerShell, by name:

   ```powershell
   ssh-keygen -R lab.hybridcloudworks.com
   ```

   And whatever `hcw-lab` points at, which is the server's address while
   `LAB_SSH_HOST` holds it (this page carries no addresses), PowerShell:

   ```powershell
   ssh-keygen -R (ssh -G hcw-lab | Select-String -Pattern '^hostname (.+)$').Matches[0].Groups[1].Value
   ```

   Success for each is `found` and `updated` for a name that was known, or
   `not found` for one that was not; both are fine.
5. **Connect as root**, PowerShell, from the repository root:

   ```powershell
   pwsh -NoProfile -File scripts/lab/Connect-Lab.ps1 -User root
   ```

   ```powershell
   ssh hcw-lab hostname
   ```

   Accept the new host key after comparing its fingerprint with the one the
   Web Console shows ("Connect from a desktop", above). Success is the
   server's host name. A session with no terminal to answer the prompt
   pins the key it compared, so the connection cannot be answered by a
   different one: it scans the key once, shows that scan's fingerprint for
   the owner to compare with the Web Console's, and appends that same scan
   to `known_hosts` under the alias's name before connecting with the
   default strict checking, which refuses any other key. PowerShell:

   ```powershell
   $k = ssh-keyscan -t ed25519 lab.hybridcloudworks.com 2>$null; $k | ssh-keygen -lf -
   ```

   Only when the fingerprint matches the Web Console's:

   ```powershell
   Add-Content -Path $HOME\.ssh\known_hosts -Value $k; ssh hcw-lab hostname
   ```

   Never `StrictHostKeyChecking=accept-new` here: it records whichever key
   the connection meets, which need not be the one that was compared. On
   2026-10-18 the session did exactly that and recorded the fingerprint
   (`SHA256:RgkOkM9UDA8TtHeLrDjOXymTrzanqCZ39z0iDuzW4yg`) without a
   comparison; that is written on #955 as a divergence, and this paragraph
   is the correction.
6. **First run**: `infra-lab/README.md`, step 7. Success is `host check: no
   other workloads found` near the top (above), and, because there is no
   vault yet and Coder is on (since 2026-09-28), a `PLAY RECAP` for
   `localhost` with `failed=1` at `coder : Refuse to enable Coder without
   its three vault secrets`. Every role before it has run, so root login is
   off and `hcw-vault-set` is installed; the re-run in step 7 finishes the
   rest. Run `Connect-Lab.ps1` again without `-User root`.
7. **Everything the disk held, again, in this order.** The 2026-10-18
   rehearsal found that the order matters more than the earlier text said:
   every role after `coder` is installed only once the play gets past
   Coder, and the play gets past Coder only once its database is back.
   1. **The Ansible vault.** Create its password and set every key the host
      cannot make itself (`lab-host/README.md`, "The vault"), rotating the
      values marked "rotate on every host rebuild" in
      [Required inputs §4.7](../standards/required-inputs.md#47-vps-agent-hostinger-env-never-committed).
      Eight keys by hand: `vault_cloudflare_api_token` (**Roll** the Caddy
      token at https://dash.cloudflare.com/profile/api-tokens, which keeps
      its name, scope, filter and end date, and check the client-IP filter
      holds **both** of the host's
      addresses, IPv4 and the IPv6 `/128`: a reinstalled Ubuntu reaches the
      Cloudflare API over IPv6, and every issuance failed with `Cannot use
      the access token from location` until the second address was added),
      `vault_coder_oauth2_github_client_id` and
      `vault_coder_oauth2_github_client_secret` (the `HCW Labs` app at
      https://github.com/organizations/HybridCloudWorks/settings/applications:
      **Edit**, read the Client ID, **Generate a new client secret**), the
      four add-on Turnstile secrets `vault_addon_migration_turnstile_secret`,
      `vault_addon_network_assessment_turnstile_secret`,
      `vault_addon_cloud_assessment_turnstile_secret` and
      `vault_addon_cloud_crawler_turnstile_secret` (each widget's
      **Secret key** under **Settings** at
      https://dash.cloudflare.com/?to=/:account/turnstile, widgets
      `hcw-addon-migration`, `HCW-NetworkEyes_AddOn`, `HCW-CloudAssessor_AddOn`
      and `HCW-CloudCrawler_AddOn`; the play names a missing one), and
      `vault_coder_postgres_password`, generated on the host. Each goes in
      with the `hcw-vault-set` clipboard line in "The vault". The four
      `vault_arc_*` and four `vault_labs_agent_*` keys are the scripts'
      below, so the vault holds sixteen keys when step 7 is done.
   2. **Arc, both runs** ("Re-onboarding a rebuilt host", below):
      `Register-LabArc.ps1`, then `Register-LabArc.ps1 -Connect`. The
      `-Connect` run's `bootstrap.sh` stops at `coder : Coder has no account
      yet`, because the restored database is not there yet; Arc still
      connects, the credential is still removed and the monitoring agent
      still installed, and the run says `Arc onboarding does not depend on
      it`. **Before any further `bootstrap.sh`, run `Connect-Lab.ps1
      -Arc`:** the next run closes port 22 (the hardening keeps sshd on the
      loopback once Arc is Connected), and the agent has already created the
      connectivity endpoint and the SSH service configuration, so Arc SSH
      works at once. A session that ran the next step first was locked out
      until it switched.
   3. **The `hcw-azure` run**, started by hand at
      https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs (**+ New
      run**, Plan and apply): the two role assignments on the machine
      identity (`lab_hybrid_vault_seal`, `lab_hybrid_backups_writer`) are
      replaced, because the identity is new. Both restores below read the
      container as that identity, so they wait on this apply.
   4. **Everything after Coder, without Coder.** Bash, on the host:

      ```bash
      sudo /opt/hcw-src/lab-host/bootstrap.sh --skip-tags coder
      ```

      The roles after `coder` (agent, images, add-ons, Portainer, Vault,
      backups) are installed; the run ends `failed=1` at the workspace-reach
      post-task, which cannot pass while Coder is unpublished, and here that
      is expected. Do not make Coder's first account by hand: the
      `--first-user` line in "A Coder with no account yet" answers `Password
      authentication is disabled.` (the Compose file sets
      `CODER_DISABLE_PASSWORD_AUTH`), and the restore brings the accounts
      back anyway.
   5. **Coder, from the container** ("Off-host backups", below, has what
      each line does). Bash, on the host:

      ```bash
      sudo /usr/local/sbin/hcw-backup-restore list
      ```

      ```bash
      sudo /usr/local/sbin/hcw-backup-restore coder --yes
      ```

      Success is `restored coder/coder-<UTC stamp>.sql.gz into coder-postgres`
      and the `buildinfo` line under "Enabling" in `lab-host/README.md`
      answering within a minute; signed-in learners and the templates are
      back. **Note the time: Coder is back.**
   6. **The seal, before Vault holds anything**, because the snapshot was
      taken under the Azure Key Vault seal and only a Vault under the same
      seal can open it: steps 4 and 5 of "HashiCorp Vault: moving to
      auto-unseal" (the seal fact, then `bootstrap.sh --tags
      vault_seal_check`, whose result is the `The Arc identity reads …`
      line; that run too ends at the workspace-reach post-task).
   7. **The lab agent's go-live** (below): `Register-LabAgent.ps1` appends
      the new certificate, writes the four keys back and runs the full
      `bootstrap.sh`, which now publishes Coder on its restored accounts,
      renders the seal into Vault's configuration, starts the agent and
      passes the workspace-reach check: `failed=0`. The agent id is pinned
      (`labs_agent_id`), so the registry document already binds it and
      there is nothing to register; its "Press Enter" takes Enter, or a
      newline on standard input.
   8. **Vault.** `vault status` now says `Seal Type azurekeyvault` and
      `Initialized false`. Initialise under the seal and restore in one
      command on the host: the fresh initialisation's root token goes from a
      root-only file into the restore helper's standard input and the file
      is shredded, because after the restore those credentials open
      nothing, so they never need to reach a screen or a password manager.
      Bash, on the host:

      ```bash
      sudo -i bash -c 'umask 077; vault operator init -recovery-shares=5 -recovery-threshold=3 -format=json > /root/vault-init.json && python3 -c "import json; print(json.load(open(\"/root/vault-init.json\"))[\"root_token\"])" | /usr/local/sbin/hcw-backup-restore vault --yes; rc=$?; shred -u /root/vault-init.json; exit $rc'
      ```

      The helper refuses a Vault whose seal is not `azurekeyvault`, naming
      step 6. Success is `Vault accepted vault/vault-<UTC stamp>.snap for
      restore and now reports Initialized true, Sealed false`. That is
      acceptance, not completion: Vault replaces its data in the background,
      so before relying on it, bash, on the host:

      ```bash
      sudo journalctl -u vault -n 30 --no-pager && vault status
      ```

      Good is `post-unseal setup complete` in the log, `Sealed false`, and
      `vault status` with no error. If it reports `Sealed true`, `sudo
      systemctl restart vault` unseals it with the same key. **Clock stops
      here.** The snapshot's own root token was revoked when the snapshot
      was taken, so seed the snapshot token file again with a root token
      from `generate-root`, using three of the *old* recovery keys ("The
      root token", below, has the Vault 2.x switch it needs; "Off-host
      backups" has the seed line), then take the first snapshot on the
      rebuilt host, `sudo systemctl start hcw-vault-backup.service`, and
      read its `uploaded vault/…` journal line.
   9. **The Coder automation's rotation credential**, which was on the
      disk: `hcw-coder-automation.service` skips on
      `ConditionPathExists=/etc/hcw/coder/automation/rotation-token` until
      `hcw-coder-automation-seed` runs again ("Automatic renewal", below).
   10. **Portainer**: a new administrator and its licence key (below).
       Portainer creates the `local` environment itself during setup
       and then opens an Edge Agent wizard; close it.
   **Keep the old Vault recovery keys.** The Vault snapshot restored in step
   8 carries its own recovery authority, and after the restore those five
   keys, the ones already in the password manager, are the restored
   Vault's; `generate-root` needs three of them. Nothing from the old Vault
   is deleted, and the fresh initialisation's keys and root token never
   left the host.
   **Last rehearsed / elapsed:** 2026-10-18, on the live host (VPS 939861;
   there is no spare): **66 min 42 s** from the reinstall click (22:36:58Z)
   to Vault unsealed on the snapshot's data (23:43:40Z); Coder back on the
   restored database at 23:35:00Z. #955 has the record; the order above is
   what that rehearsal corrected.
8. **Retire the old agent record.** If the go-live registered the rebuilt
   host under a new agent id, the old id's card stays on
   https://hybridcloudworks.com/admin/labs?tab=agents, Offline, until it is
   removed: the 2026-09-26 reinstall left `srv939861` beside
   `vps-hostinger-01`. **Deactivate** it if it is still active, then
   **Remove** and confirm. Success is the old card gone and the new agent
   still Online. The API refuses an active agent, and one still holding a
   job claimed in the last 15 minutes; the removal is audited as
   `lab_agent_removed`. If the host came back under the same agent id, there
   is nothing to retire: the go-live re-bound that record.

## The lab agent's go-live

The agent (`vps-agent`, the `labs_agent` role) is installed by the first
`bootstrap.sh` run and stays stopped until it has an identity: an Entra app
registration holding its certificate and the `LabAgent` app role, a
`lab_agents` registry document binding it to that identity, and four values
in the host's Ansible vault. `scripts/lab/Register-LabAgent.ps1` does all of
it in one run, as the owner, on the workstation, with one paste in the
browser for the registry document (step 4). The owner-created Entra objects
are deliberate: this repository has no `azuread` Terraform provider
(`infra/oidc.tf`, `infra/lab-hybrid.tf`).

**Before you start.** The host has run `bootstrap.sh` at least once, so
`/etc/hcw/labs-agent.crt` exists; this desktop reaches it
(`ssh hcw-lab hostname` prints its name, "Connect from a desktop", above);
`/etc/hcw/ansible/vault-password` exists on the host (`lab-host/README.md`,
"The vault"; `vault.yml` itself may or may not exist yet); you can
create app registrations and assign app roles in the tenant (Application
Administrator, Cloud Application Administrator or Global Administrator);
and you can sign in to https://hybridcloudworks.com/admin as an editor or
above, for step 4. Sign in to `az`, PowerShell; a browser opens:

```powershell
az login --tenant saulpatinojrhotmail.onmicrosoft.com
```

Then, PowerShell, from the repository root on `main` once this change has
merged (`Test-Path scripts/lab/Register-LabAgent.ps1` prints `True` when the
working tree has the script):

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabAgent.ps1
```

Adding `-WhatIf` to that line shows what it would change and changes
nothing: step 4 prints what it would ask for without waiting, the vault
merge runs in check mode on the host, and `bootstrap.sh` does not run.

**What it does**, printing one line per step:

1. Checks `az` is signed in to `saulpatinojrhotmail.onmicrosoft.com`, and
   stops with the `az login` line above when it is not.
2. Reads `/etc/hcw/labs-agent.crt` over `ssh hcw-lab` into a temporary file
   on the desktop, deleted after step 3. It is the public certificate; the
   host checks it against the private key in `labs-agent.pem` and reports
   only whether they match, so the key never leaves the host. The
   certificate's CN is the agent id, `vps-hostinger-01`.
3. Finds or creates the single-tenant app registration and service
   principal `sp-labs-agent-lab-hybrid-prod-cus-01`. Appends the
   certificate to it with `az ad app credential reset --cert --append`,
   ending one second before the certificate does, unless a credential with
   its thumbprint is already there; every other credential is left alone.
   Assigns the service principal the `LabAgent` app role on the HCWSite API
   (the script's `-ApiAppId`, whose default is the same client id
   `scripts/cutover/01-entra-api.ps1` names), which is gate 1 of the agent
   guard (`functions/src/lib/auth/require-agent.js`) and, for an
   application permission, the admin consent. Nothing else is granted: no
   Azure role, no Microsoft Graph permission, no client secret.
4. Has you register the agent on the site, which writes the
   `lab_agents/vps-hostinger-01` document gate 2 reads (below). It prints
   https://hybridcloudworks.com/admin/labs?tab=agents and the two values to
   paste into **Register agent** there, the agent id `vps-hostinger-01` and
   the service principal's object id from step 3, and waits for Enter. Leave
   every job type ticked and press **Register agent**; success is a toast
   reading `Agent registered` and a `vps-hostinger-01` card on that page.
   Then press Enter in PowerShell. When the agent is already heartbeating
   and step 3 did not create its service principal, the document is already
   there and binds it, so the step says so and does not wait.
5. Writes `vault_labs_agent_api_base`, `vault_labs_agent_tenant_id`,
   `vault_labs_agent_client_id` and `vault_labs_agent_api_scope` into
   `/etc/hcw/ansible/vault.yml`, as root on the host: decrypted into a
   root-only temporary directory, only those four keys replaced, every
   other key checked to be exactly as it was, re-encrypted with the
   existing password file, decrypted again and compared, then moved into
   place; the temporary files are shredded. When `vault.yml` does not exist
   it is created with only those four keys, so add the rest afterwards with
   `ansible-vault edit`, not `create`. When the four are already right the
   file is not rewritten at all. It prints key names, never a value read
   from the vault. Before the merge, the host sends one request without a
   token to `https://api-azure.hybridcloudworks.com/api/agent/heartbeat`
   (the probe, below).
6. Runs `sudo /opt/hcw-src/lab-host/bootstrap.sh` when the vault changed or
   the agent is not running (`-ForceBootstrap` runs it regardless), or
   restarts the agent when only Entra or the registration changed: a
   running agent keeps a token issued before the grant for up to an hour,
   and a heartbeat that starts working after a registration logs nothing,
   so without a restart the journal would still end on the refusal. Then
   it reads `systemctl is-active hcw-labs-agent` and the last journal
   lines, and says what they mean.

**What success looks like.** Near the end of the run:

```text
Agent: hcw-labs-agent is active and has logged no failure since it started: it is heartbeating.
```

The run exits 0, and https://hybridcloudworks.com/admin/labs?tab=agents
lists `vps-hostinger-01` as Online within 30 seconds. A heartbeat that works
logs nothing, which is why "no failure since it started" is the signal. A
second run ends with `No changes: the identity, the vault and the agent were
already set up.` A step that cannot finish stops there with its reason and
exits 1, having changed nothing after it. When everything ran but the agent
is not heartbeating at the end, the run exits 2 and says which of these it
is:

| The run says | What it means | What to do |
| --- | --- | --- |
| `Agent access required` | The token is accepted and the agent guard refuses it. Step 3 made the grant, so it is gate 2: the registry document is missing, deactivated, or bound to another object id | On https://hybridcloudworks.com/admin/labs?tab=agents: no `vps-hostinger-01` card, register it (step 4, the values the run prints); a card marked Deactivated, press Activate; a card showing another object id, register it again with the one the run prints, which rebinds it. Then run `ssh hcw-lab sudo systemctl restart hcw-labs-agent`. If step 3 assigned the role in this same run, wait two minutes before the restart |
| `Authentication required` | The API rejected the token itself: its audience or tenant is not what `ENTRA_API_AUDIENCE` and `ENTRA_TENANT_ID` expect | The scope must be `api://<API client id>/.default` and the API must issue v2 tokens; step 3 checks both and stops if either is not so |
| `HTTP 403 with no API error in the body` | Cloudflare answered, not the API. The probe line says the same thing before the merge | The probe, below |
| `Entra refused the agent's certificate sign-in (AADSTS…)` | Usually a registration or certificate this run created that Entra has not replicated yet | Wait two minutes, run `ssh hcw-lab sudo systemctl restart hcw-labs-agent`, and run the script again |
| `hcw-labs-agent is inactive` | `bootstrap.sh` starts it only when all four vault keys exist | The play's `Say why the agent is not running yet` task, in the output above, names what is missing |

**The API base, and the probe.** The agent calls
`https://api-azure.hybridcloudworks.com/api`, the Cloudflare hostname, and
not the Function App's `azurewebsites.net` host: the origin lock
(`functions_origin_lock_enabled`, on since 2026-08-20, `infra/functionapp.tf`)
denies every address outside Cloudflare's ranges, and the lab host is
outside them. The Cloudflare path has its own gate. Bot Fight Mode answers
many clients on hosting networks with a 403 challenge page (it is why the
availability probe is a Cloudflare Worker, [ADR 0024](../decisions/0024-edge-availability-probe.md)),
and the lab host is on one. So the script asks first: without a token the
API answers 401 with its own JSON, and the script says `the host reaches
agent/heartbeat through Cloudflare`. A `403` with an HTML page, or a
`cf-mitigated: challenge` header, means Cloudflare is refusing the host, and
the agent will log `HTTP 403` on every heartbeat. Admitting it is an owner
decision, not something this script changes: either admit the host's
address at the origin (an `ip_restriction` allow rule in
`infra/functionapp.tf`, and the Function App's own host name as
`LABS_AGENT_API_BASE`, passed to this script with `-ApiBase`), or relax
Bot Fight Mode for the zone. Each narrows a control, and a WAF skip rule
does not work: Bot Fight Mode does not run on the Ruleset Engine
([Alerting and support](alerting-and-support.md)).

**The registry document, and why it is a paste.** Gate 2 of the agent guard
reads `lab_agents/{agentId}` and requires its `oid` to be the agent's
service principal object id (the `oid` claim of an app-only token) and
`active` to be `true`; `capabilities` are the job types it may claim. The
only writer is the API (#740): **Register agent** on the Agents tab calls
`POST /api/cms/labs/agents` with `{ agentId, oid, jobTypes }`, and each
agent's card has **Deactivate** or **Activate**, which call
`PATCH /api/cms/labs/agents/{agentId}` with `{ active }`; a deactivated card
also has **Remove**, which calls `DELETE` on the same address and deletes the
record (step 8 of "Reinstalling the host", above). All three need an
editor or above and write an audit row, and the record holds only
identifiers: `id` and
`agentId` both `vps-hostinger-01`, `oid` lower-cased (the claim is lower
case and the guard compares exactly), `active`, and `capabilities`, by
default the five job types (`shell-echo`, `terraform-validate`,
`ansible-check`, `helm-template`, `kubeconform`) that
`scripts/lab-job-types.test.mjs` keeps in step with the server and agent
allowlists. Registering again with the same values changes nothing; with a
new object id it rebinds the agent. It never reactivates a deactivated
agent: that is the card's Activate, so undoing a revocation is always its
own act. A deactivation takes effect on the agent's next call, because the
guard does not cache the registry. The script cannot make the call itself,
because the route needs an admin's delegated token and no owner script
acquires one; and nothing can write the container directly, because the
Cosmos DB firewall admits only the Function App's subnet and no operator
holds a data-plane role. So step 4 prints the values and waits.

**Certificate rotation** uses the same script with `-NextCertificate`
(`lab-host/README.md`, "Rotating the agent certificate"): it appends
`/etc/hcw/labs-agent.next.crt`, leaves the old one, touches neither the
vault nor `bootstrap.sh`, and prints the swap as one PowerShell line. After
the swap, a plain run finds the agent heartbeating on the new certificate
and prints the `az ad app credential delete` line for the old one.

**When the agent stops with a job running** (LAB-13, #959). The agent
stops the same way on `systemctl stop` or `restart`, on a run that restarts
Docker (the unit `Requires=docker.service`), and on the 04:30
unattended-upgrades reboot. systemd sends SIGTERM to the agent alone
(`KillMode=mixed`), never to the `docker` CLI it runs. The agent then
interrupts every job it holds:

1. It starts removing the job's container through its Docker proxy.
2. Without waiting for that removal, it reports the job `failed`, exit `-1`, with the sentence the visitor
   sees: *The lab host was restarting and this job was interrupted. Submit
   it again.*
3. It sends `stopping` and waits up to `LABS_AGENT_SHUTDOWN_TIMEOUT_MS` for
   those reports (5000, the role's `labs_agent_shutdown_timeout_ms`).
4. It sends `offline` and exits, inside the unit's `TimeoutStopSec=30`.
5. systemd then runs `/usr/local/libexec/hcw-labjob-sweep` as root, which
   removes any container still labelled `hcw.lab-job`. It runs again before
   the agent next starts. A removal can outlast the agent's 5 s window, and
   a crash removes nothing, so the sweep removes what the agent left. When
   it removed one, the journal says `removed 1 lab job container(s) that no
   agent owned`. If a labelled container is still running after 20 s, the
   sweep fails with `1 lab job container(s) still running after the sweep`,
   and the unit's failure alert fires. A stopped container Docker cannot
   remove is only a warning, because it holds no CPU or memory.

A claim already sent when the signal lands is waited for in the same
budget, and its job is reported the same way without being started. This
replaces #1178's drain of up to 210 s. That drain then exited with the
container still running, and left the job `claimed` until its 15-minute
lease ran out. It applies on the host from the first `bootstrap.sh` run
that includes it ([Labs host, Applied state](../architecture/labs-host.md#applied-state)).

Bash, on the host (PowerShell `ssh hcw-lab` from the workstation gets
there), after a restart with a job running:

```bash
sudo journalctl -u hcw-labs-agent -n 20 --no-pager
```

Good is `SIGTERM received; interrupting 1 active job(s), 5000 ms to report
them`, then `job <id> -> failed (exit -1); interrupted by shutdown`, then
systemd's stop, all within a few seconds. On
<https://hybridcloudworks.com/admin/labs?tab=jobs> the job reads failed with
the sentence above, and `sudo docker ps --filter label=hcw.lab-job` lists no
container. If the journal shows `shutdown budget of 5000 ms exceeded`, a
report did not land in time. That line is an error, so it reaches Log
Analytics, and its job is recovered by the lease 15 minutes later, as
before.

## Opening "Validate on the lab" to the public

The Landing Zone Builder's **Validate on the lab** sends the build's files to
this host as a `terraform-validate` job. Since the owner revised
[ADR 0032](../decisions/0032-learner-labs-platform.md) decision 6 on
2026-09-28 it is open to anyone, but only from the builder's pane on the
site: the API takes a job only with the site's `Origin` and a Cloudflare
Turnstile token, and within decision 6's bounds (64 KB, 2 an hour per
visitor, 50 a day, no more than 20 queued). It needs the agent above to be
heartbeating, and three owner values, which this section sets once.

The order is not a preference. `deploy-functions.yml` will not start while an
`hcw-azure` run is unfinished, and fails a deploy whose live settings lack a
reference Terraform declares, so the Terraform run goes first. The API-keys
page offers only the secrets the deployed code lists, so the secret goes after
the functions deploy. In between, `TURNSTILE_SECRET_KEY` is unresolved and
the path answers `TURNSTILE_NOT_CONFIGURED`. It was on the
`EXPECTED_UNRESOLVED` allowlist for that window the first time and came off
it once seeded on 2026-09-28, so on a rebuild `monitor-unresolved-secrets.yml`
reports it until step 4 is done.

**1. Confirm the Terraform run.** Open the run the merge queued at
https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs. Success is
`Plan: 3 to add, 1 to change, 3 to destroy`, the permanent diff, where the
one change, `azurerm_function_app_flex_consumption.hcw`, also adds
`LABS_PUBLIC_SUBMISSION_ENABLED = "true"` and `TURNSTILE_SECRET_KEY`, a
`@Microsoft.KeyVault(...)` reference. Anything else is a finding. The machine
check, PowerShell:

```powershell
gh workflow run tfc-plan-check.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
```

Its summary reads expected, with two `DECLARED` lines for those two settings.
Then confirm and apply the run in the UI.

**2. Create the Turnstile widget and set the site-key variable.** Terraform
does not create it: `cloudflare_turnstile_widget` would hold its secret key in
state (`infra/frontend.tf`). At https://dash.cloudflare.com/?to=/:account/turnstile
choose **Add widget** and set:

| Field | Value |
| --- | --- |
| Widget name | `hcw-lab-validate` |
| Hostname management | `hybridcloudworks.com` (a hostname covers its subdomains, so www too) |
| Widget mode | Managed |
| Pre-clearance | No |

Create it, and copy the **Site Key** it shows (it starts with `0x4`). With the
site key on the clipboard, PowerShell:

```powershell
gh variable set VITE_TURNSTILE_SITE_KEY --repo saulpatinojr/HCW-HybridCloudWorks --body (Get-Clipboard)
```

```powershell
gh variable get VITE_TURNSTILE_SITE_KEY --repo saulpatinojr/HCW-HybridCloudWorks
```

Success is the second line printing the same `0x4…` value. Keep the widget's
page open: step 4 needs its **Secret Key**.

**3. Deploy the functions and the site.** Both are dispatch-only, from
`main`, PowerShell. The functions deploy refuses while step 1's run is
unfinished, so run it after the apply:

```powershell
gh workflow run deploy-functions.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
```

```powershell
gh workflow run deploy-azure-frontend.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
```

Success is both runs green at
https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions. The site
build reads the variable from step 2, so a site deployed before it has no site
key, and its button says the lab isn't available while the status read says
open (the table below).

**4. Seed the Turnstile secret.** At
https://hybridcloudworks.com/admin/integrations?tab=keys, in the Hybrid Lab
section, paste the widget's **Secret Key** into **Cloudflare Turnstile — secret
key** and save. Success is the row's light turning green.

**What success looks like.** A minute after step 4 (the status read is cached
for one), the status read answers open, PowerShell:

```powershell
Invoke-RestMethod https://api-azure.hybridcloudworks.com/api/public/labs/submit | Select-Object open, code, reason, queued
```

Success is `open` `True` with `code` and `reason` empty. `False` names the
missing piece in `code`: `TURNSTILE_NOT_CONFIGURED` is step 4,
`LAB_AGENT_OFFLINE` is the agent ("The lab agent's go-live", above), and
`PUBLIC_SUBMISSION_CLOSED` is `labs_public_submission_enabled` set `false` in
the workspace. The lock refuses a caller that is not the site, PowerShell:

```powershell
try { Invoke-RestMethod -Method Post -Uri https://api-azure.hybridcloudworks.com/api/public/labs/submit -ContentType 'application/json' -Body '{}' } catch { $_.ErrorDetails.Message }
```

Success is a body with `"code":"ORIGIN_NOT_ALLOWED"`, since PowerShell sends
no `Origin`. Then the real thing: at
https://hybridcloudworks.com/tools/landing-zone, open the files and press
**Validate on the lab**. The line beside it goes from *Queued on the lab…* to
*Running on the lab…*, and the report under it reads *The configuration is
valid: Terraform found no errors.*, then **Modules used** (the default build
lists four, such as `avm-ptn-alz@0.21.0`) and **Providers** (six, such as
`hashicorp/azurerm v4.81.0`). The visitor never sees the job log: no image
pull, no `/opt/avm` path, no `(unauthenticated)`. The log itself is on the
job at https://hybridcloudworks.com/admin/labs?tab=jobs, claimed by
`vps-hostinger-01`. The first run on 2026-09-28 got that far, and
`TURNSTILE_SECRET_KEY` came off `EXPECTED_UNRESOLVED` in
`scripts/check-unresolved-secrets.mjs` in the same change that replaced the
log with the report.

**When the button will not take a job.** The line beside the button speaks
to visitors only (#755): it names no setting and no vendor, and every closed
door reads the same sentence, so the sentence alone does not say which door
is closed. The `code` does. In the browser's developer tools, **Network**
tab, it is in the JSON answer of `GET
https://api-azure.hybridcloudworks.com/api/public/labs/submit`, the status
read the page makes when it loads (the same `code` the PowerShell line above
prints), or, after a press, of the `POST` to the same address; a job's
progress is `GET /api/public/labs/job?jobId=`. In the **Elements** tab, the
line beside the button carries `data-door` (`open`, `busy`, `closed`,
`checking` or `unreadable`) and the browser check's box carries
`data-check` (`idle`, `loading`, `interactive`, `ready`, `spent` or
`error`), which tell the rows without a code apart. The sentences are
`frontend/src/pages/tools/landingZone/labValidateRules.js`; the codes are
`functions/src/lib/labs/public-bounds.js`, `public-lock.js`,
`public-submit.js` and `public-job.js`.

| `code` | Where it shows | The visitor reads | What it means | What to do |
| --- | --- | --- | --- | --- |
| `PUBLIC_SUBMISSION_CLOSED` | Status read (`open` false, `data-door="closed"`); POST 503; job read 503 | *Validation on the lab isn't available right now. You can still download the files and validate locally.* | `LABS_PUBLIC_SUBMISSION_ENABLED` is not exactly `true`: `labs_public_submission_enabled` is `false` in the workspace | Delete the workspace variable (the default is `true`) or set it `true`, and apply |
| `TURNSTILE_NOT_CONFIGURED` | Status read (`data-door="closed"`); POST 503 | The same sentence | `TURNSTILE-SECRET-KEY` is not seeded, or its Key Vault reference did not resolve | Step 4 |
| `LAB_AGENT_OFFLINE` | Status read (`data-door="closed"`); POST 503 | The same sentence | No agent registered for `terraform-validate` has heartbeated in the last 90 seconds (`vps-hostinger-01`) | "The lab agent's go-live", above |
| `LAB_STATUS_UNAVAILABLE` | Status read (`data-door="closed"`); POST 503 | The same sentence | The Function App could not read the agents or the queued count from Cosmos DB, and logs `labs public submit: readiness read failed:` | The Function App's log for that line |
| `LAB_QUEUE_FULL` | Status read (`data-door="busy"`); POST 503 with `Retry-After: 300` | *The lab is busy right now. Try again in a few minutes, or download the files and validate locally.* | More than 20 jobs are queued | Nothing if it clears. If it stays, the agent is not claiming: the jobs at https://hybridcloudworks.com/admin/labs?tab=jobs |
| `ORIGIN_NOT_ALLOWED` | POST 403 | *Validate on the lab works only from the Landing Zone Builder on hybridcloudworks.com.* | The request's `Origin` is not exactly `https://hybridcloudworks.com` or `https://www.hybridcloudworks.com` | Nothing, from the site. It is the expected answer to the PowerShell check above |
| `TURNSTILE_REQUIRED` | POST 403 | *The browser check didn't finish, so the lab didn't take the job. Reload the page and try again.* | The POST carried no browser-check token | Reload. If it repeats, read `data-check` (the rows at the end) |
| `TURNSTILE_RATE_LIMITED` | POST 429 with `Retry-After: 600` | *Too many attempts from this browser in the last few minutes. Try again in about ten minutes.* | One client asked for more than ten checks in ten minutes on one Function App instance | Wait ten minutes |
| `TURNSTILE_FAILED` | POST 403 | *The browser check didn't pass, so the lab didn't take the job. Try again.* | Siteverify refused the token, or the token's hostname is not the site's or its action is not `lab-validate`. The log line `labs public submit refused by the Turnstile check:` has Cloudflare's error codes | Press again: the widget fetches a new token. If it repeats, check the widget's hostname is `hybridcloudworks.com` |
| `TURNSTILE_UNAVAILABLE` | POST 503 with `Retry-After: 60` | *The browser check couldn't be completed just now. Try again in a minute.* | Siteverify was out of reach, slower than five seconds, answered something other than JSON, or refused the request itself. The same log line says which | If it lasts, read the log line. `invalid-input-secret` means the seeded secret is not this widget's: step 4 again with its **Secret Key** |
| `LAB_RATE_LIMITED` | POST 429 with `Retry-After: 3600` | *You've reached the limit for validation on the lab for now (two an hour). Try again in about an hour.* | This client has submitted twice in its current hour | Nothing: the window resets an hour after the client's first submission |
| `LAB_PAUSED_FOR_TODAY` | POST 503 | *Validation on the lab has reached today's limit. Try again tomorrow, or download the files and validate locally.* | Fifty public jobs today, UTC | Nothing until 00:00 UTC |
| `PAYLOAD_TOO_LARGE` | POST 413, or the page before it sends | *This build is too large for the lab. Remove some components, or download the files and validate locally.* When the page measured it before sending, the size comes after *for the lab*, as in *(70,112 bytes; the limit is 65,536)* | The encoded files are over 64 KB | Nothing on the server: the build is too big for the public path |
| `INVALID_BODY` | POST 400 | *Something went wrong. Please try again.* | The body failed the server's checks, which the site's own page never sends | The site and the functions are from different commits: both deploys in step 3, from `main` |
| `FORBIDDEN` | POST 403 | *Something went wrong. Please try again.* | The request reached the Function App without Cloudflare's origin secret, and it logs `labs public submit rejected: unverified origin` | Check `CF_ORIGIN_SECRET` resolves on the Function App and Cloudflare still adds the origin-secret header |
| `JOB_NOT_FOUND` | Job read 404 | *The lab no longer has this job. Its result is kept for a day.* | The job is past its day, or never existed | Nothing |
| None | Status read `open` true; `data-door="open"`, `data-check="idle"` | *Validation on the lab isn't available right now. You can still download the files and validate locally.* | This build of the site has no `VITE_TURNSTILE_SITE_KEY` | Step 2, then the site deploy in step 3 |
| None | The status read failed; `data-door="unreadable"` | The same sentence | The status read did not answer: the network, or a 500 the Function App logs as `publicLabsSubmit status failed:` | The Function App's log |
| None | `data-check="error"` | *The browser check couldn't run here, so Validate on the lab is unavailable. Reload the page to try again.* | The check's script did not load, or the widget failed, in that browser: an extension or network blocking `challenges.cloudflare.com`, or a host the widget does not list | Reload, or another browser. If every browser shows it, check the widget's hostname list |
| None | `data-check="interactive"` | *Please complete the check below, then validate.* | The widget wants an interaction, which Managed mode asks for now and then | The visitor completes it |
| None | POST 500 | *Something went wrong. Please try again.* | The submission failed inside the Function App, which logs `publicLabsSubmit failed:` | The Function App's log |

**Closing it again** is one workspace edit: set the Terraform variable
`labs_public_submission_enabled` to `false` (HCL off) at
https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables and apply.
Every public lab route then answers `PUBLIC_SUBMISSION_CLOSED` before reading
anything, and the line beside the button reads *Validation on the lab isn't
available right now. You can still download the files and validate
locally.*

## Visitor lab sessions (#1016)

Visitors outside the `HybridCloudWorks` GitHub organization can start ephemeral 60-minute Coder lab sessions directly from the site without creating a Coder account.

### Why Brokered
Coder Community edition lacks per-user quotas, forced dormancy, and auto-stop enforcement. Opening GitHub sign-in to everyone would permit a visitor to consume the host's 5 workspace slots. To preserve team learner availability while offering interactive labs to visitors, the Function App brokers ephemeral Coder users and workspaces on demand.

### Architecture & Broker Lifecycle
1. **Request:** A visitor presses **Start visitor session** on a lab pane. The request sends the site's `Origin` and a Cloudflare Turnstile token (`action: visitor-session`) to `POST /api/public/labs/visitor-session`.
2. **Provisioning:** The Function App broker (`functions/src/lib/labs/visitor-session.js`) first writes a `provisioning` record (see the table below), then uses `CODER_BROKER_TOKEN` to provision an ephemeral Coder user (`v-<hex>`) and workspace (`lab-lzb`, `lab-tfv`, etc.) from template `hcw-lab`, and saves the session over that record once both exist.
3. **Access:** The workspace's code-server access URL is returned and embedded in the browser lab pane.
4. **Limits Enforced:**
   - Maximum concurrent visitor sessions: `LABS_VISITOR_MAX_CONCURRENT` (default: 2, leaving remaining slots for team members). A start under way, and a session that is over but whose workspace Coder has not confirmed as deleted, count against it too ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 5): until Coder confirms, the lab may still be using one of the host's slots.
   - Daily limit: 2 new labs per visitor client key per UTC day. Only a start that is really going to make a new lab uses one ([#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400), item 1). Pressing start again while your session runs hands the same session back for free, a start refused because the lab is full costs nothing, and a start that fails in Coder gives its start back.
   - How often one visitor may ask ([#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400), item 2), counted per Function App instance (each running copy of the app keeps its own count) in a ten-minute window: at most 10 starts that reach the human verification check (`429 TURNSTILE_RATE_LIMITED`, the lab submission's own limit), and at most 60 status reads and stops together (`429 VISITOR_READS_RATE_LIMITED`). Both answers carry `Retry-After: 600`. The pane reads the status once when it opens, so a person never meets either.
   - Session duration: 60 minutes (`VISITOR_SESSION_DURATION_MS`).
   - Hard auto-reap: expired sessions are reaped on status/start checks and, once the owner arms the `sweepVisitorSessions` timer, every two minutes whether or not anyone visits ("The sweep timer" below), and users can end their session via `DELETE /public/labs/visitor-session?sessionId=...`. A session counts as over only once Coder has confirmed that its workspace and user are deleted; one it has not confirmed is retried (see "When Coder does not confirm the clean-up" below).
5. **Emergency Switch:** Set `LABS_VISITOR_SESSIONS_ENABLED="false"` in app settings to instantly close visitor sessions.

### Who counts as one visitor (#1387)
The three routes (`GET`, `POST` and `DELETE` on `/api/public/labs/visitor-session`) know a caller the way the other anonymous routes do: by a hash (a scrambled, one-way fingerprint) of the address Cloudflare reports. `functions/src/lib/auth/client-identity.js` only trusts that address on a request that carries the origin secret (`CF_ORIGIN_SECRET`, a password Cloudflare adds to every request it passes to the API, so a request sent straight to the Function App cannot pretend to be someone else).

- **Each visitor has their own daily limit and their own session.** The status route describes only the caller's own session, and the stop route ends a session only for the caller it belongs to. Any other caller, even one who holds the session's id, is told `404 Session not found`, the same answer as for an id that never existed.
- **People behind one shared network address count as one visitor** (an office, a school, a mobile carrier's shared address). They share the daily limit and the session, as they share every other anonymous limit on the site, and each of them can see the running lab's address and end it.
- **A visitor whose address changes during a session** (Wi-Fi to mobile data, or a VPN switched on) is a different visitor from then on. They can no longer see or end the old session, which keeps running until its hour is up and counts against the concurrent limit; starting again spends another of their two sessions for the day.
- **A request is refused** with `403 FORBIDDEN`, before anything is read, written or sent to Turnstile (Cloudflare's bot check) or Coder, when it does not come through our Cloudflare (no origin secret) or when it carries the secret but no usable client address (`CF-Connecting-IP`). This holds whatever `NODE_ENV` says ([#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400), item 5). The shared identity helper lets an unproved request through when `NODE_ENV` is not `production`, which suits the other anonymous routes on a developer's machine; these three routes refuse it anyway, so a Function App or slot that lost `NODE_ENV`, or never got `CF_ORIGIN_SECRET`, files nothing under an address the caller chose. To try the routes on your own machine, set `CF_ORIGIN_SECRET` there and send the `x-hcw-origin-secret` and `CF-Connecting-IP` headers. The log says only `visitor-session: refused a request whose caller could not be verified`. If visitors who should get through are being refused, check that `CF_ORIGIN_SECRET` resolves on the Function App and that Cloudflare still adds the origin-secret header and the client address, as for the `FORBIDDEN` row in the lab submission table above.
- **When the human verification check says no**, the visitor gets a plain sentence (the same words the lab submission uses) and the reason goes only to the log, as `visitor-session: refused a start by the human verification check: <why>` ([#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400), item 3). The reason can carry Cloudflare's error codes, such as `missing-input-secret`, which would tell an anonymous caller how the site is set up.
- **A session saved before this change** (if the switch was ever on) was filed under the text `unidentified`. Nobody can read or end one of those now; each is expired by the sweep (the clean-up that runs every two minutes once the timer is armed, and whenever a visitor asks for the status or starts a session while the switch is on) once its hour is up.

### When Coder does not confirm the clean-up (#1388)
Ending a visitor session means asking Coder to delete two things: the visitor's workspace (the running lab) and the temporary Coder user the broker made for them. Coder deletes a workspace with a job that finishes a little later, and it refuses to delete a user who still has a workspace (it answers HTTP 417). So the request to delete the user, made straight after the workspace one is accepted, is refused for most sessions. That is expected, not a fault.

The broker therefore marks a session `ended` (the visitor pressed **End session**) or `expired` (its hour ran out) only once Coder has confirmed both deletes: it accepted them, or answered 404 or 410 because the thing was already gone. Until then the session record says where it is:

| `status` | What it means | What happens next |
| --- | --- | --- |
| `provisioning` | A start is under way: the broker wrote this before its first call to Coder, with the user name it chose (`coderUsername`) and the workspace name, so whatever Coder makes has a record ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 2). | Becomes `active` when both Coder calls work, or `cleanup_pending` (`startFailed`) at once when one fails. If the Function App dies in between, the sweep takes it up after 5 minutes (`PROVISION_LEASE_MS`) and cleans up whatever Coder made. |
| `active` | The lab is running. | The visitor ends it, or its hour runs out. |
| `ending` | One request is cleaning it up right now (it has "claimed" the record: only one request can, so two never call Coder for the same session). | If that request dies, its claim runs out after 5 minutes and the sweep takes over. |
| `cleanup_pending` | Coder has not confirmed yet. The record keeps which half is done (`workspaceGone`, `userGone`) so the workspace delete is not asked for twice. A start that failed is kept this way too (`startFailed`). | Tried again after 2 minutes, then 4, 6 and 8, by the sweep or by the visitor pressing **End session** again once the time has come. After three refusals of the user delete in a row (`userRefusals`), the next try asks for the workspace delete again, because the delete job Coder accepted may have failed ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 3). |
| `ended`, `expired` | Done: Coder confirmed both. | The record ages out two hours later. |
| `cleanup_failed` | Five tries in a round, and Coder still has not confirmed. | Another round of five tries starts an hour later (its `retryAt`), up to 24 more rounds (`cleanupRounds` counts them), in case Coder was simply down for longer than a round lasts. After the last round there is no `retryAt` and nothing retries it; the record keeps its Coder ids for 7 days so a person can finish the job (below). |

The sweep is the clean-up that ends sessions past their hour and retries the waiting ones. Two things run it, and each run ends at most 10 sessions. **A timer, `sweepVisitorSessions`, runs it every two minutes** once the owner arms it ("The sweep timer", below), whether or not anyone visits and whatever `LABS_VISITOR_SESSIONS_ENABLED` says. **A visitor** reading the lab's status, or starting a session, also runs it, at most once a minute per Function App worker. While the timer is off, only the visitors do, so with no visitors, or while `LABS_VISITOR_SESSIONS_ENABLED` is off, a waiting session waits; a waiting record is kept for 7 days for that reason.

**A start that failed.** When a visitor presses start, the broker writes the `provisioning` record, makes a Coder user and then asks Coder for a workspace. If either call gets no answer within 30 seconds (or Coder refuses it), or the session cannot be saved after both worked, the visitor is told the lab is unreachable and gets their daily start back, but Coder may still have made the user or the workspace. The broker therefore turns the record into a note before it answers: a `cleanup_pending` record with `startFailed`, the user's name (`coderUsername`), its id when Coder gave one (`coderUserId`), the workspace's name (`workspaceName`) and its id only when Coder gave one (a start that failed at the user never asked for a workspace, so that half is saved as done and the note does not count against the concurrent limit), whose first try comes 2 minutes later so that a create Coder is still finishing can finish. The note has no `clientHash` and was never shown to a visitor, so no visitor can read or end it; only the sweep handles it.

For a record with a user name and no user id, the sweep first asks Coder for the user by that name ([`GET /api/v2/users/{user}`](https://coder.com/docs/reference/api/users), which takes "User ID, username, or me", read 2026-10-31). It sends only a name of the broker's own shape (`v-` and twelve hexadecimal characters), never `me` or anyone else's. If Coder has no such user, nothing was made at all (the workspace is asked for only after the user exists), and the record is over. For a record with no workspace id the sweep then asks Coder for the workspace by its owner and name ([`GET /api/v2/users/{user}/workspace/{workspacename}`](https://coder.com/docs/reference/api/workspaces), read 2026-10-26) and deletes what it finds only when the name is the expected one and the owner is that user. If Coder has no such workspace, that counts as gone for that try only; the user delete, which Coder refuses while the user still has a workspace, is the confirmation, and a workspace that turns up later is found by the next try.

**What confirmed each half.** A finished record says how each delete was confirmed, in `workspaceConfirmedBy` and `userConfirmedBy` ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 4): `ok` (Coder accepted the delete), `gone` (Coder answered 404 or 410), `not found` (a lookup by name found nothing) or `no user` (there was no user, so no workspace). A 404 is also what Coder may answer a token that is not allowed to see the thing, so the broker logs `visitor-session: a session's Coder clean-up was taken as done on a 404 or 410` whenever a half was confirmed that way. If those lines are common while the broker token's permissions are in doubt, check in Coder that the users and workspaces are really gone.

The visitor sees no difference: **End session** answers success (also when Coder has not confirmed yet), with a `cleanup` field that says `done`, `pending` or `failed` for anyone who looks ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 7; the pane ignores it). A waiting session is no longer shown to them. Its lab address (`accessUrl`) is dropped from the record as soon as it stops being `active` ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 6), since only a running session needs it. The lab itself may still exist in Coder, and use one of the host's 5 workspace slots, until Coder confirms the delete, so a waiting record whose `workspaceGone` is not true still counts against the concurrent limit.

**Finding sessions Coder has not cleaned up.** Open the list of Azure Cosmos DB accounts in the Azure portal, <https://portal.azure.com/#blade/HubsExtension/BrowseResource/resourceType/Microsoft.DocumentDB%2FdatabaseAccounts>, and click the site's account (`cosmos-site-prod-cus` in production, named in [the cold rebuild runbook](cold-rebuild.md)). Then choose **Data Explorer**, the database `hcw` (the Function App's `COSMOS_DATABASE` setting names it), the container `lab_jobs` and **New SQL Query** ([Microsoft's steps](https://learn.microsoft.com/azure/cosmos-db/quickstart-portal#add-and-query-sample-data)), and run:

```sql
SELECT c.id, c.status, c.endStatus, c.startFailed, c.endedAt, c.retryAt, c.cleanupAttempts, c.cleanupRounds, c.userRefusals, c.workspaceGone, c.userGone, c.workspaceId, c.coderUsername, c.workspaceName FROM c WHERE c.type = 'visitor-session' AND c.status IN ('provisioning', 'ending', 'cleanup_pending', 'cleanup_failed')
```

This query is the dependable way to find them. The broker also logs a line when it gives up on a session (`visitor-session: a session's Coder clean-up was given up`, with Coder's answer for each half, for example `user HTTP 417`, and no session id), but only when the try is made by the timer, a stop request or a session start; a try made by the status read's background sweep cannot write to the log, so do not rely on the log alone.

**What needs a person.** A `cleanup_pending` row is normal while its `retryAt` is still ahead or only a few minutes behind, and so is a `provisioning` row whose `retryAt` is ahead. A `cleanup_failed` row with no `retryAt` (its last round is used), or any of these rows whose `retryAt` is more than half an hour past, means Coder is not letting go of it, or no sweep has run since (the timer is off and nobody has visited). With the timer armed, check it first ("The sweep timer", below). Without it, run the tries yourself by opening a lab's page in a private browser window (so that it is not signed in to Coder), for example <https://hybridcloudworks.com/education/labs/terraform-validate-walkthrough>, once: the page asks for the visitors' status (`GET /api/public/labs/visitor-session`), and that runs the sweep (it does nothing while `LABS_VISITOR_SESSIONS_ENABLED` is off). The page asks only when Coder is reachable. For a `cleanup_failed` one with no `retryAt`, finish the clean-up by hand:

1. Put the leftover user's name (the query's `coderUsername`, which starts `v-`) and its workspace's name (`workspaceName`, for example `lab-lzb`) into variables. Paste each line, then type the value at the prompt:

   ```powershell
   $visitor = Read-Host 'Leftover visitor username (starts with v-)'
   ```

   ```powershell
   $workspace = Read-Host 'Its workspace name from the query (for example lab-lzb)'
   ```

2. Delete the workspace. This needs a Coder token of the owner's in `$t`, made as "Adding a learner" below explains. Success is Coder saying the workspace is deleted; a message that it was not found means it is already gone, so go on:

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder delete $visitor/$workspace --yes; }'"
   ```

3. Delete the user, once step 2 has finished. If Coder says the user still has workspaces, the workspace is still being deleted, so wait a minute and run this line again:

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; echo yes | coder users delete $visitor; }'"
   ```

The flags were read from Coder's reference pages for [`coder delete`](https://coder.com/docs/reference/cli/delete) and [`coder users delete`](https://coder.com/docs/reference/cli/users_delete) on 2026-10-26, and the lines follow the ones in "Adding a learner" below. They have not been run on the live host. Coder's own Users page does not cover deleting a user or the 417 answer, so there is no page to link for that. A record that is still `cleanup_pending` when you delete the user finishes on its own at its next try (Coder answers 404, which counts as done).

**What the numbers are.** `MAX_CLEANUP_ATTEMPTS` (5 tries a round), `CLEANUP_REARM_MS` (an hour between rounds), `MAX_CLEANUP_ROUNDS` (24 rounds after the first), `USER_REFUSALS_BEFORE_WORKSPACE_RETRY` (3), `PROVISION_LEASE_MS` (5 minutes), `CLEANUP_RETRY_BASE_MS` (2 minutes), `CLEANUP_LEASE_MS` (5 minutes), `RETRY_SWEEP_EVERY_MS` (1 minute), `MAX_SWEEP_SESSIONS` (10), `VISITOR_PENDING_DOC_TTL_SECONDS` (7 days), `CODER_CALL_TIMEOUT_MS` (10 seconds for a delete) and `CODER_PROVISION_TIMEOUT_MS` (30 seconds for creating a user or a workspace) are at the top of the clean-up section of `functions/src/lib/labs/visitor-session.js`. Every Coder call has a timeout, so a Coder that hangs cannot hold a request open.

**Rollback.** Revert the pull request that closed [#1388](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1388). Code from before it only looks at `active` sessions and would never retry a waiting one, so run the query above first and clean up what it lists by hand. The same goes for reverting the follow-up for [#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400) and [#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403): code from before it does not know `provisioning` records or a second round for `cleanup_failed` ones, so those would wait for a person.

### The sweep timer (#1403)

`sweepVisitorSessions` runs the sweep on its own every two minutes. Each scheduled run is called a *tick* below. Its schedule is `0 */2 * * * *`, six fields (seconds, minutes, hours, day, month, weekday) in UTC; with no hour in it, the schedule does not depend on the Function App's clock. Before the timer, the sweep ran only when a visitor read the lab's status or started a session, so a session waiting for its clean-up, and the Coder user and host workspace slot it held, waited for the next visitor. The code is `functions/src/functions/visitor-session-sweep.js` (the registration and the on/off check) and `functions/src/lib/timers/visitor-session-sweep.js` (what one run does).

**What one run does.** It does what the sweep above does and nothing else: it ends the sessions past their hour, retries the waiting clean-ups, and takes over a claim whose holder died, at most 10 sessions a run, with a 10-second limit on each Coder call. A run with nothing to do is two queries on the `lab_jobs` container (sessions past their hour; then, in one query, every record whose next try is due: waiting ones, claims and starts that ran out, and given-up ones due another round) and no call to Coder.

**What it never does.**

- **It never creates a session or a Coder user.** It is given the three database operations the sweep uses (read, query, and a save that is refused if someone else changed the record meanwhile) and none that creates a document. A test watches every operation that would create or overwrite one, and checks that the only thing it ever asks Coder to build is a workspace delete.
- **It does not wait for `LABS_VISITOR_SESSIONS_ENABLED`.** That switch closes the door to new visitors. If it is turned off while sessions exist, their Coder users and workspaces still have to be removed, so the timer keeps running with it off.
- **It does nothing when Coder is not set up**, not even a query. "Set up" means `CODER_URL` and `CODER_BROKER_TOKEN` both have a value. The read-only status token (`CODER_STATUS_TOKEN`) does not count, and the broker no longer falls back to it: it cannot delete anything, so every try with it would be refused and used up. A sweep with no usable Coder settings would still spend one of a waiting session's five tries on every tick, and five tries end a round as `cleanup_failed`. The timer logs one Warning, `Coder is not set up (CODER_URL and CODER_BROKER_TOKEN): nothing swept, and no clean-up try spent`, the first time after each restart (and again after Coder was set up and then lost again), then an Information line each tick.
- **It never fails a run.** A problem is one Warning line with the kind of error, never a session, a Coder id or text from Coder or the database, and the next tick tries again. The other side of that: a sweep that cannot run (the database is down, say) is a *successful* run to `alert-timer-overdue`, which only checks that the timer ran. So look for the Warning lines `the sweep could not run` and `could not be listed`, not for a failed run.

**The trade-off the timer makes.** Before it, a clean-up try was spent only when a visitor arrived, so a quiet site waited out a Coder outage without using up tries. Now tries are spent on the clock: a session Coder refuses is tried at about 0, 2, 6, 12 and 20 minutes (the wait is 2 minutes times the try number; a run that starts late in its tick can push a retry one tick later, so the last try can come as late as about 28 minutes), then marked `cleanup_failed` for the round. A Coder or token outage longer than about twenty to thirty minutes therefore leaves the sessions that were waiting as `cleanup_failed` instead of `cleanup_pending`. They are not lost: each is taken up again an hour later for another round, up to 24 more rounds (about a day), and only after the last does it need a person (steps in "What needs a person" above). No alert reads these lines yet.

**Log levels.** A Warning line is kept in Application Insights (the Azure service that stores the Function App's logs); an Information line is not, because `host.json` keeps the Function App's own lines at Warning. So a run that did something, or went wrong, leaves a Warning; a run that found nothing to do leaves only the row that Azure writes for every run.

**Why two minutes.** The numbers it has to fit: a refused clean-up is tried again after 2, 4, 6 and 8 minutes, a dead claim is taken over after 5, and a session lasts 60. Two minutes is the retry step, so each of those happens within one tick of being due. Five minutes would turn the 2-minute retry into a 5-minute one. One minute would double the runs for nothing, because a visitor's own request already runs the sweep at most once a minute. At 720 runs a day, an idle timer is about 1,440 queries a day. That count follows from the code; what each query costs in request units (Cosmos DB's measure of the work a request does, which sets the bill) was not measured against the live account.

**Two runs at once.** The Functions host runs one copy of a timer across all its instances and does not start it again while a run is still going ([Microsoft Learn, timer trigger, Scale-out](https://learn.microsoft.com/azure/azure-functions/functions-bindings-timer#usage)). That is not relied on. The sweep first "claims" a session with a conditional write (a save that is refused if the record changed since it was read), so of two runs that reach the same session, one wins and one is refused before it calls Coder. Tests run two timer runs, and a timer run with a visitor's sweep, at the same moment and count the Coder calls. One limit: a claim lasts 5 minutes from the start of the sweep, and a sweep of 10 sessions whose Coder calls all run to their 10-second limit can use all of it. A claim taken over then can lead to a second delete of the same thing. That is harmless (Coder answers 404 or 410 for what is already gone, and the code counts that as done), but it spends one try; the margin is an open item in [#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403). The visitor-triggered sweep stays, with its once-a-minute limit: it frees a session the moment a visitor is about, and it is the only sweep while the timer is off.

**What happens when this change is merged.** Merging deploys nothing and applies nothing. HCP Terraform queues a run in the `hcw-azure` workspace that waits for the owner to confirm it (the workspace is connected to this repository and does not apply by itself). Its plan adds the setting `FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = "false"` to the Function App and one row, for this timer, to the query of the `alert-timer-overdue` alert; the plan check ([tfc-plan-check.yml](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/tfc-plan-check.yml), **Run workflow** on `main`) reads both as `DECLARED`. The functions are deployed separately, by the owner (step 4 below). After both, the timer fires every two minutes and does nothing, because its flag is `false`.

**Arming it.** The timer is off until the owner arms it. Do these in order:

1. Check that the Function App has the broker's Coder settings, and that the token behind the second one is really there. Two parts.

   **1a. The settings exist.** Paste this into PowerShell (it needs `az login`); it prints names only, never values:

   ```powershell
   az functionapp config appsettings list -g rg-web-site-prod-cus -n func-site-prod-cus-01 -o json | ConvertFrom-Json | Where-Object name -in 'CODER_URL','CODER_BROKER_TOKEN' | Select-Object name
   ```

   You should see two rows, `CODER_URL` and `CODER_BROKER_TOKEN`. `infra/` has declared `CODER_BROKER_TOKEN` (a Key Vault reference, [#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403)) since [pull request #1422](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1422), and the setting appears once the `hcw-azure` run that pull request queued has been confirmed and has finished: <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>. **If `CODER_BROKER_TOKEN` is missing, confirm that run first, and do not set it by hand.** Terraform removes any setting that `infra/` does not declare, and step 5 is a Terraform apply.

   **1b. The token has been seeded.** A listed name is not enough: until its secret exists, the setting holds the unresolved reference, and the code treats that as no token. Open the Keys page, <https://hybridcloudworks.com/admin/integrations?tab=keys> (it needs the admin sign-in), and find **Coder broker token** in the Labs group. By the page's code a green light means the reference resolves; grey means it was never seeded or does not resolve; amber means it was seeded after the copy of the app answering you started, so that copy may still hold the old value (it can stay amber until the app restarts, and the apply in step 5 restarts it). If it is not green, do "Seeding the broker token" below first. Green is not proof that Coder accepts the token: nothing in the app tries it, so before you arm, check that seeding step 2 (deciding and measuring what the token may do) was done, because a token Coder refuses makes every tick spend clean-up tries. Armed without the token, the timer is safe but pointless: it logs one Warning after each restart, sweeps nothing and spends no clean-up try. One more thing to know before you count on it: `infra/` does not declare `LABS_VISITOR_SESSIONS_ENABLED` yet, so until it does, nothing in Terraform can switch visitor sessions on (a copy set by hand would be removed by the next apply), and the timer only has records left from earlier sessions to end. Arming it now is a safety net ahead of that, not a change anyone will see.
2. In the `hcw-azure` variables, <https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables>, check that `schedulers_master_enabled` is `true`. If it is `false`, stop and ask the owner: setting it to `true` lets every timer that is in `enabled_timers` run, which is a separate decision.
3. Edit `enabled_timers` (HCL) in the same place to add `"SWEEP_VISITOR_SESSIONS"` to the list, and save.
4. Make sure the functions with the timer are deployed: <https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-functions.yml> (**Run workflow** on `main`; the `production` environment asks for approval, and either of its two required reviewers can give it). The deploy refuses to start while a Terraform run is going or is waiting for confirmation, because a deploy and an apply that overlap can overwrite each other's app settings ([#454](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/454)). After a merge HCP Terraform queues a run by itself, so there usually is one waiting. The order this repository uses is **apply, then deploy**: confirm that run, wait for it to finish, then deploy. The cost: `alert-timer-overdue` watches a timer the host is not running yet, so it pages until the deploy lands, then clears by itself. The other order (discard the waiting run, deploy, then start a new run, step 5) avoids the page, but only when that waiting plan holds nothing else the new code needs: if the deploy's closing check, `scripts/assert-live-app-settings.mjs`, finds a setting the code reads missing, it fails after the package is live, and the fix is to apply `infra/` and deploy again.
5. Start a run at <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs> if none is waiting, read the plan, and confirm it. What the plan shows for this timer depends on what has applied: if the catalogue run from the merge has applied, the flag changes from `false` to `true`; if not (you discarded it, or it is this run), the flag appears as `true` from nothing and the alert's query gains the timer's row. Each of these is `DECLARED` in the plan check. Other changes that were merged earlier and have not applied yet can be in the same plan, each declared too; anything the plan check calls UNEXPECTED needs reading before you confirm.

**Seeding the broker token (#1403).** `CODER-BROKER-TOKEN` is the Key Vault secret behind the app setting `CODER_BROKER_TOKEN`, the token the broker and this timer act in Coder with. `infra/` declares only the reference; a person makes the token and seeds its value, the way `docs/standards/variables-and-secrets.md` describes for every secret. The value is never written in the repository, a pull request, an issue or a chat. While the secret is missing nothing breaks: the broker is "not configured", a visitor session cannot start, and the timer logs its one Warning and calls nothing. One thing to expect after the merge: `scripts/assert-live-app-settings.mjs`, the closing check of a functions deploy, now requires the `CODER_BROKER_TOKEN` setting to exist on the live app, so a functions deploy fails its closing check (after the package is live) until the `hcw-azure` run that adds the setting has been confirmed and has finished, and the deploy refuses to start while that run waits. Confirm the run first, as arming step 4 says. Do these in order:

1. Make sure the reference is applied and the functions that know the new key are deployed. The Keys page offers only the secrets in the deployed code, so before the deploy the **Coder broker token** row is not there. Open <https://hybridcloudworks.com/admin/integrations?tab=keys>; the row should be in the Labs group. If it is not, do arming step 4 (the deploy), after the `hcw-azure` run has been confirmed and has finished.
2. Make the token in Coder. **This step has no written procedure yet, on purpose.** Which Coder user and which permissions the broker should have is the owner's decision ([#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403), item 4), and nobody has measured the smallest set that works on the lab host's Coder, as "The status token for the site" in `lab-host/README.md` did for the status token. What the code needs the token to be able to do (read from `functions/src/lib/labs/visitor-session.js`, not run against a live Coder): create a user, list templates and organizations, create a workspace for that user, start a delete build for a workspace, delete a user, and look a workspace up by its owner and name. A read-only token such as the status token is refused for all of that. Do not reuse the status token or your own Coder sign-in token. Decide the user and permissions first, measure them, and write the result into that README.
3. Paste the value on the Keys page, in the **Coder broker token** row of the Labs group, and save. Paste it only there (or run `scripts/cutover/06-seed-secret.ps1 -Name CODER-BROKER-TOKEN`, which asks for the value at a hidden prompt and never prints it, if the site itself is what is broken). Success: the page says either "Stored. New workers pick it up immediately; this one keeps the old value until it recycles." or "Stored. It goes live within 24 hours or at the next deploy (…)", and the light goes amber, then green once the copy of the app answering you has the new value. If it stays amber, the app has to restart: the apply in arming step 5 does that, or restart the Function App in the Azure portal.
4. Take the placeholder allowance away. Open a pull request that deletes the `CODER_BROKER_TOKEN` entry from `EXPECTED_UNRESOLVED` in `scripts/check-unresolved-secrets.mjs` and lowers the cap in `scripts/check-unresolved-secrets.test.mjs` from 6 to 5. Then run <https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/monitor-unresolved-secrets.yml> (**Run workflow** on `main`). Success: the run is green and does not name `CODER_BROKER_TOKEN`. From then on an unresolved broker token is a real finding.
5. Arm the timer: steps 2 to 5 of "Arming it" above.

**Taking the broker token away again.** What actually stops the token working is deleting it in Coder; everything else only makes the app stop using it. Do these in order:

1. If visitor sessions may be running, let them finish first, and leave the timer armed until the query under "Finding sessions Coder has not cleaned up" lists no `active`, `ending` or `cleanup_pending` row. Once the app has no token, nothing can delete a session's Coder user and workspace.
2. To stop the timer, remove `"SWEEP_VISITOR_SESSIONS"` from `enabled_timers` and apply (the flag goes from `true` to `false`; the plan check does not declare that direction, so it shows as UNEXPECTED, which is the prompt to read it).
3. Delete the token in Coder, as whoever made it (see seeding step 2).
4. Optional, and only if you want the secret gone too: two things to know first. The vault's firewall admits only the Function App's subnet, and the seeding script's window covers writes only, so a delete needs a window opened by hand and a data-plane role. And purge protection is on, so a deleted secret keeps its name until it is recovered: a later seed on the Keys page is refused until someone with the role runs `az keyvault secret recover`. If you only want the broker off, step 3 is enough and the secret can stay. To delete it anyway, from a place the firewall admits, paste this into PowerShell:

   ```powershell
   az keyvault secret delete --vault-name kv-site-prod-cus-01 --name CODER-BROKER-TOKEN
   ```

   Success prints the deleted secret's JSON, with a `recoveryId`; `az keyvault secret recover --vault-name kv-site-prod-cus-01 --name CODER-BROKER-TOKEN` undoes it. The app keeps the value it already holds until it restarts or its references refresh (up to 24 hours), and only then reads the broker as "not configured".

**Checking that it runs.**

1. Check the setting. This prints the flag's name and value (not a secret): `true` means armed, `false` or no row means off.

   ```powershell
   az functionapp config appsettings list -g rg-web-site-prod-cus -n func-site-prod-cus-01 -o json | ConvertFrom-Json | Where-Object name -eq 'FEATURE_FLAG_SWEEP_VISITOR_SESSIONS' | Select-Object name, value
   ```

2. Check the runs. In the Azure portal, open the list of Application Insights components, <https://portal.azure.com/#blade/HubsExtension/BrowseResource/resourceType/microsoft.insights%2Fcomponents>, click `appi-site-prod-cus-01`, then **Logs**, and run:

   ```kusto
   requests | where name == "Functions.sweepVisitorSessions" | where timestamp > ago(30m) | project timestamp, success, duration | order by timestamp desc
   ```

   Success is a row about every two minutes with `success` true. That alone does not tell armed from off, because a disarmed timer also runs and succeeds; step 1 does. A disarmed timer writes a Warning, `[sweepVisitorSessions] disabled — skipping (first skip since this process started ...)`, once after each restart and Information after that, so it is easy to miss.
3. Look for what the runs said. In the same **Logs** page run the line below. A run that did something leaves `[sweepVisitorSessions] reaped=<n> finished=<n> pending=<n> failed=<n>` (counts and nothing else); `Coder is not set up` means a setting is missing (step 1 of arming); `the sweep could not run` or `could not be listed` means the database or something else failed, which the alert does not see.

   ```kusto
   traces | where timestamp > ago(1h) | where message has "sweepVisitorSessions" | project timestamp, severityLevel, message | order by timestamp desc
   ```

4. Run the Cosmos query above ("Finding sessions Coder has not cleaned up"): nothing should stay `cleanup_pending` past its `retryAt` by more than a couple of minutes.

**If the alert pages.** `alert-timer-overdue` watches this timer from the first Terraform apply after the merge. If that apply runs before the functions are deployed, the host is not running the timer yet, so the alert pages until the deploy lands, then clears by itself (arming step 4). A disarmed timer, a timer with no Coder settings, and a run that fails inside the sweep all count as successful runs to this alert, so it stays quiet for them: use "Checking that it runs" for those.

**Turning it off, or rolling it back.**

- *Off.* Remove `"SWEEP_VISITOR_SESSIONS"` from `enabled_timers` the same way and apply: the next tick logs the skip and does nothing, and a run already under way finishes. The plan check lists that one flag line (`true` to `false`) as UNEXPECTED, because only arming is declared in `scripts/assert-expected-plan.mjs`; for a disarm that is expected, so read the plan, and if that line is the only change beyond the permanent diff, confirm it. Setting `schedulers_master_enabled` to `false` also holds this timer off, but it holds every timer off, and its plan line is `FEATURE_FLAG_SCHEDULERS`, not this flag. Nothing the timer did needs undoing, since all it does is finish clean-ups.
- *Out completely.* Revert the pull request that added it. Apply the Terraform run first, then deploy the functions; the other way round leaves the alert watching a timer that no longer exists, and it pages. The plan check will list the removal of the flag and of the alert's row as UNEXPECTED (they are declared only as additions); read them, and confirm. A full revert also removes the id and name checks added to the sweep code in the same change, which the in-request sweep uses too; to keep them, remove only the registration, the inventory entry, the catalogue entry, the allowlist entry and the alert row. The in-request sweep keeps working throughout.

### Counting lab starts

The site counts every lab session it starts for a visitor, so that anyone quoting
a number in a report or letter can quote a real, checkable one. This section says
exactly what the count is, so that it is not overclaimed.

**What is counted.** One count each time the visitor session broker (the code
above that creates the visitor's workspace) makes a new session: the moment the
session record is saved (`startSession` in
`functions/src/lib/labs/visitor-session.js`). It counts sessions the site
*created*, whether or not the visitor then did anything in them, and it includes
any session the owner or a tester starts with the public Start button. Not
counted: a repeat request that returns the session already running, a page view,
a refused request (closed door, lab full, daily limit, failed check) and a start
the Coder host could not create. Also not counted, because the site's server
never sees them: a signed-in member starting a workspace inside the lab pane, and
the public *Validate on the lab* runs (a Terraform check, not a lab session).

**Sessions, not people.** The counting documents hold nothing that identifies a
person, so someone who starts two sessions counts twice. A letter should say "lab sessions", never
"learners" or "users". The "last 7 days" and "last 30 days" figures include
today, which is only part of a day so far.

**What is stored.** Plain numbers in the `system` container (a container is a
table-like collection in the Cosmos database; this one is small, never expires
and is copied by the weekly export): one document per UTC day,
`lab-starts:YYYY-MM-DD`, holding `{ day, total, byLab }` where `byLab` maps a lab
id (for example `terraform-validate-walkthrough`) to a count, and one marker
document, `lab-starts:meta`, holding the day counting began. The counting
documents store no IP address, client key, session id, user id, token, query
string or time of day. (The visitor session records, which the broker keeps for
about two hours, are separate and do hold a hashed client key and a session id;
the counter never copies them. Cosmos also adds its own last-modified stamp to
every document it stores; that is the database's, not a field the counter writes.)
`functions/src/lib/labs/lab-starts.test.js` fails if a stored document gains any
other key. The code is `functions/src/lib/labs/lab-starts.js`. It follows the
pattern of the legacy-blogs read counter
(`functions/src/lib/legacy-blogs-telemetry.js`): a plain tally in the `system`
container, kept as numbers only.

**Counting since.** There is no history to count from: a visitor session's record
is deleted about two hours after it was last updated (`VISITOR_DOC_TTL_SECONDS`),
so nothing older than the day this shipped can be added up. The count begins on
the day the first start is recorded or the card below is first opened, whichever
comes first, and the card says that day. Do not backfill or estimate earlier
sessions.

**Read it.** You need to be signed in as an admin account at editor level or
above.

1. Open [the Labs hub Dashboard](https://hybridcloudworks.com/admin/labs?tab=dashboard).
   You should see the Labs hub with the **Dashboard** tab selected and, under
   three small boxes (agents online, jobs queued, jobs in flight), a card titled
   **Lab sessions started through the website**. If you are signed out you are
   sent to the sign-in page first; if your account is below editor level the card
   says it could not be read (see step 4).
2. Read the four boxes (Today, Last 7 days, Last 30 days, Total), the table with
   one row per lab that has been started, and the line *Counting since* with a
   date. A 0 in every box is normal until the first visitor starts a lab. If the
   card is not there at all, the functions and the site have not been deployed
   with it yet (the
   [changelog](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/CHANGELOG.md)
   entry says when it shipped).
3. Press **Copy as text for a letter**. You should see a tick on the button and
   the word *Copied.* beside it. The sentence shown above the button is what was
   copied: it gives the date range, the real numbers, the day counting began, and
   says the count is of sessions, not people. It names no vendor. If the clipboard
   is blocked, the card says *The clipboard is not available here*; select the
   sentence with the mouse and copy it by hand.
4. If the card says *The lab session counts could not be read*, press **Try
   again** and wait a few seconds. If it still fails, read the message under the
   title. *Forbidden* means your account is not an editor or above, so ask the
   owner to check your role. Any other failure means the site could not read its
   store: open the list of Function Apps in the Azure portal at
   <https://portal.azure.com/#blade/HubsExtension/BrowseResource/resourceType/Microsoft.Web%2Fsites/kind/functionapp>
   (that address is the Learn-documented way to reach the list; this page does
   not use a link straight to the app because a link to one resource contains
   the subscription id, and `scripts/docs/check_redaction.py` keeps real ids out
   of the docs), click **func-site-prod-cus-01** (resource group
   `rg-web-site-prod-cus`), open **Application Insights** from the Overview page,
   choose **Logs**, and run `traces | where message startswith "cmsLabsStarts failed" | order by timestamp desc`.
   You should see one row per failure, each ending in a number in brackets. That
   number is the only detail the line keeps, and it never holds personal data. If
   there are no rows, the failure was not on the site's side (check the sign-in
   and the role again). The built-in *Log stream* is not offered for a Flex
   Consumption app like this one, so the logs are read from Application Insights
   (see [Enable streaming execution logs in Azure Functions](https://learn.microsoft.com/azure/azure-functions/streaming-logs)).

UTC is the world reference clock, and every day here is a UTC day: *Last 7 days*
is today and the six days before it, *Last 30 days* is today and the
twenty-nine before it. A UTC day runs from 18:00 to 18:00 US Central time while
winter time applies, and from 19:00 to 19:00 while summer time applies.

**If a start is missing from the count.** The counter never blocks a visitor.
If the store cannot be written, the session is still handed out and the Function
App logs `visitor-session: lab start not counted (<code>)`, where the code is the
store's error number. If five attempts in a row lose a race (two starts try to
update the same day's number at the same moment and one has to try again), the
start is left out and the log line ends `(contention)` instead. With at most two
visitor sessions running at once this should be vanishingly rare. In the same
Application Insights **Logs** page, run
`traces | where message startswith "visitor-session: lab start not counted" | order by timestamp desc`
to see whether either has happened. Either way the count is too low, never too high.

**Roll it back.** The counter is two small reads and a write added to the
broker, plus a read-only route and a card. Revert the pull request that added it
(the
[changelog](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/CHANGELOG.md)
entry under *Unreleased*, *Features* names it). The stored documents are inert
and can stay or be deleted (the documents whose id starts `lab-starts:` in the
`system` container).

## After a merge: the playbook, then the template, at once

Nothing applies a merged change to the host on its own (#950), so the host
is behind `main` until the owner runs it
([Labs host, Applied state](../architecture/labs-host.md#applied-state)).
The rule for that run:

> **Run `bootstrap.sh`. That is the whole step.** Its `coder` role
> publishes every Coder template whose files changed, with the host's own
> rotation credential, before `lab_images` removes the images the old
> template versions name. No token, and nothing to paste after it.

Why. The lab images moved from GHCR to Docker Hub on 2026-10-08 (#1002,
#1003). The `lab_images` role keeps the images the checked-out commit names
and removes the others from both daemons once no container uses them. So
the first run after that merge removes the GHCR `hcw-lab` image from the
sandbox daemon, while Coder's active template version still names that GHCR
digest until the push publishes the version that names Docker Hub. A
workspace started between the two finds its image gone and has to pull it
back from a registry this repository no longer publishes to. The run
publishes the templates itself, before `lab_images` removes anything, so
the gap never opens. That has needed no token since the rotation credential
was seeded on 2026-10-10 ("Automatic renewal", below), and it covers every
template under `lab-host/coder/templates` since 2026-10-12. Before then it
published `hcw-lab` alone, so a change to `amo-guided-lab` or
`na-guided-lab` still needed the owner's token.

1. Bash, on the host (PowerShell `ssh hcw-lab` from the workstation gets
   there):

   ```bash
   sudo /opt/hcw-src/lab-host/bootstrap.sh
   ```

   Good is a `PLAY RECAP` line for `localhost` with `failed=0`. On the first
   run since #1009, a checkout cloned from the old organisation also logs
   `repointing origin of /opt/hcw-src from` the old address `to
   https://github.com/saulpatinojr/HCW-HybridCloudWorks.git`, once, and
   every run logs `fetching` with the address it really fetches from.

   The run's last task, **Record the commit this host converged from, for
   the agent's heartbeat**, is `changed` on every successful run. Within a
   minute the agent's card on
   <https://hybridcloudworks.com/admin/labs?tab=agents> reads `commit
   <first 8 of the sha the run logged> · converged <now>`, and the line
   under it begins `vps-hostinger-01 converged from` and ends `nothing under
   lab-host/ or vps-agent/ has merged to main since.` Two other endings are
   about the site's read of `main`, not the host:

   - `main has not been read yet.` `checkAgentHealth` has not run since the
     Functions deploy that brought the check. It reads `main` on its first
     run, so this clears within five minutes.
   - `main could not be read (<code>: <reason>).` The read was attempted and
     failed, and the code says why: `RATE_LIMITED` (GitHub's unauthenticated
     limit for the Function App's outbound address is used up; the reason
     says when it resets), `TIMEOUT` or `FETCH_FAILED` (GitHub did not
     answer), `UPSTREAM_STATUS` (GitHub answered with an error). It is tried
     again every hour and clears only after a read succeeds. If it is still
     there a day later, the host's lag is unknown and the **Lab host runs
     main** card says so.
   - Any verdict followed by `The latest read of main failed (<code>:
     <reason>); this is from the read <n> h ago.` The newest hourly read
     failed, for the reasons above, and the verdict comes from the last good
     one. It stands while that read is under six hours old; after that a
     healthy verdict turns unknown, and a host already behind stays critical.

2. Nothing to paste. In the same run's output, the `coder` role's
   **Publish the Coder templates with the rotation credential when they
   changed** is `changed` when it published anything. It prints one line
   per template it published, `hcw-coder-automation: published <name> with
   the rotation credential; active version <version>`, and `<name> is
   unchanged since <date> (version <version>); nothing was published` for
   each of the rest of `hcw-lab`, `amo-guided-lab` and `na-guided-lab`.
   A template that fails to publish fails the task, names itself, and is
   tried again by the next run; the others still publish.

   Only when the task prints that there is no rotation credential, or that
   Coder refused it (a rebuilt host, or a leak contained as "Automatic
   renewal" describes), does anything need the owner: seed it again as that
   section says, and the next run publishes. A template can be published by
   hand in the meantime, which is the fallback under "Publishing the
   template" in `lab-host/README.md`.

## Coder sign-in: adding and removing a learner

Since 2026-10-16 (owner decision, #954) Coder signs in only members of the
GitHub team `HybridCloudWorks/lab-learners`, and sign-ups are off: a
GitHub sign-in that matches no Coder account is refused with `Signups are
disabled` and nothing is created. So a learner needs two things, team
membership and an account the owner made. Why, and what happens to
accounts that already exist (they keep working; the team is checked at
each GitHub sign-in), is in `lab-host/README.md`, "Who signs in".

Every line below is PowerShell, run on the workstation, and needs a Coder
token of the owner's in `$t`: `lab-host/README.md`, "The status token for
the site", step 1, makes one (`hcw-setup`, shortest expiry) and holds it.

### Adding a learner

1. **The learner's GitHub login and primary email**, into variables. The
   address must be the one GitHub marks **Primary** and verified on the
   learner's https://github.com/settings/emails page: Coder matches a first
   sign-in to an account by that address and no other. Paste each line,
   then type the value at the prompt:

   ```powershell
   $login = Read-Host 'Learner GitHub login'
   ```

   ```powershell
   $email = Read-Host 'Learner primary GitHub email'
   ```

2. **The team.** In the browser, on
   https://github.com/orgs/HybridCloudWorks/teams/lab-learners/members,
   choose **Add a member** and add `$login`'s account. Someone outside the
   organisation is invited to it as well, and is refused at sign-in with
   `You aren't a member of the authorized Github organizations!` until they
   accept that invitation. Success is the login in the team's member list
   without `Pending`.

3. **The account.**

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder users create --username $login --email $email --login-type github && coder users show $login; }'"
   ```

   Success is `A new user has been created!` with `Login is authenticated
   through GitHub.`, then the user's table with `Username` the login and
   `Status` `dormant` (no sign-in yet). `already exists` means an account
   with that name or address is already there: `coder users show` in the
   same line, without the create, shows which.

4. **The learner signs in** with the **Sign in with GitHub** button on any
   lab's page on https://hybridcloudworks.com/education/labs. Success is
   the lab opening in the pane, and the account's `Status` reading
   `active` in the line above.

What a refused sign-in says in the learner's tab, and what it means:

| The learner's tab says | Meaning | Fix |
| --- | --- | --- |
| `Signups are disabled` | No account matched: step 3 has not run, or its address is not the learner's primary verified one on GitHub | Run step 3, or delete the account (`coder users delete $login` in step 3's line) and create it with the right address |
| `You aren't a member of an authorized team in the [HybridCloudWorks] Github organization(s)!` | Not in `lab-learners` | Step 2 |
| `You aren't a member of the authorized Github organizations!` | Not an active member of `HybridCloudWorks`, or the invitation is not accepted | Step 2, then the learner accepts the invitation |

### Removing a learner

Both steps, in this order. Removing the learner from the team stops their
next GitHub sign-in, but Coder does not check the team for a session that
is already open, and an open session is extended while it is used. The
suspension is what ends it now.

1. **The team.** In the browser, on
   https://github.com/orgs/HybridCloudWorks/teams/lab-learners/members,
   select the learner and choose **Remove from team**.

2. **The account, suspended**, with the learner's login in `$login`
   (step 1 above):

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; echo yes | coder users suspend $login; coder users show $login; }'"
   ```

   Success is `User <login> has been suspended!` and `Status`
   `suspended` in the table. A suspended account cannot sign in or use any
   session or token it holds. Its running workspaces are stopped on Coder's
   next autobuild check, within about a minute (v2.38.0 stops a started
   workspace whose owner is suspended: `coderd/autobuild/lifecycle_executor.go`,
   `isEligibleForAutostop`, polled every `CODER_AUTOBUILD_POLL_INTERVAL`,
   one minute by default); they are kept, stopped, with their files.
   `coder users activate` in the same line undoes the suspension.

### A Coder with no account yet

Only after a fresh install, or a restore that left Coder's database empty.
The live host has accounts, so this does not apply to it, and neither does
it apply to a rebuild that restores last night's dump: step 7 of
"Reinstalling the host" runs the play with `--skip-tags coder`, restores the
database and publishes Coder on the next full run. Tried on the 2026-10-18
rebuild, the line in step 2 below answered `Password authentication is
disabled.`: the Compose file sets `CODER_DISABLE_PASSWORD_AUTH`, so the
break-glass account cannot be made that way on this build. For a genuinely
empty database, `coder server create-admin-user` at the end of this section
is the way in.

**Why.** Coder v2.38.0 lets whoever reaches a deployment with no account
make the first one, and that account is the Owner. Its `/setup` page makes a
password account. A GitHub sign-in is let through as well, even with sign-ups
off (`coderd/userauth.go`: `userCount == 0 || params.AllowSignups`). So
`bootstrap.sh` never publishes such a Coder. Before Coder starts, the coder
role counts the accounts in its database; with none, it takes Coder's Caddy
route down and reloads Caddy, then and there. Once Coder is up, it asks
`/api/v2/users/first` too, and on a 404 it fails with `Coder has no account
yet`. Coder keeps running on the host's loopback only. Everything below was
measured against v2.38.0 on 2026-10-17.

Your GitHub account, `saulpatinojr`, must be a member of
`HybridCloudWorks/lab-learners`, or step 4's sign-in is refused like any
other outside the team. It has been since 2026-10-16. Success is
`saulpatinojr` in the list at
https://github.com/orgs/HybridCloudWorks/teams/lab-learners/members; if it
is not there, add it with **Add a member** before step 4.

1. **Your primary GitHub email**, into a variable: the address
   https://github.com/settings/emails marks **Primary** and verified, which
   is how Coder will match your first GitHub sign-in. PowerShell; paste the
   line, then type the address at the prompt:

   ```powershell
   $email = Read-Host 'Your primary GitHub email'
   ```

2. **A break-glass Owner, and your GitHub account as Owner**, in one line on
   the host's loopback. PowerShell:

   ```powershell
   ssh -t hcw-lab "sudo docker exec -it -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'coder login http://127.0.0.1:7080 --first-user-username hcw-breakglass --first-user-email breakglass@lab.hybridcloudworks.com --first-user-full-name Break-glass --first-user-trial=false && coder users create --username saulpatinojr --email $email --login-type github && coder users edit-roles saulpatinojr --roles owner -y; coder logout -y'"
   ```

   It asks for the break-glass account's password; keep it in your password
   manager. Success is `A new user has been created!` with `Login is
   authenticated through GitHub.`, then `You are no longer logged in.`
   Any `Encountered an error` line names the step that failed.

3. **Publish Coder.** PowerShell. Success is a play recap with `failed=0`:

   ```powershell
   ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"
   ```

4. **Sign in with GitHub** at https://coder.lab.hybridcloudworks.com.
   Success is Coder's dashboard, signed in as `saulpatinojr`.

5. **Retire the break-glass account**, with a token of yours in `$t` (step 1
   of "The status token for the site", in `lab-host/README.md`). Coder will
   not suspend an Owner, so its role is lowered first. PowerShell:

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder users edit-roles hcw-breakglass --roles auditor -y && echo yes | coder users suspend hcw-breakglass; }'"
   ```

   Success is `User hcw-breakglass has been suspended!`. A suspended account
   cannot sign in, and `/api/v2/users/first` keeps answering 200, so later
   runs publish Coder as usual. Should every Owner ever be lost, a new one
   is made on the host straight in the database, without signing in, bash
   on the host:

   ```bash
   sudo docker exec -it coder coder server create-admin-user
   ```

## The lab canary and the status-token check

Two Health Hub probes watch what #1009 found broken with nothing saying so,
beside **Lab host runs main** and **Coder template published** (above). All
four are on the **Checks** tab,
<https://hybridcloudworks.com/admin/health?tab=checks>, under Enhanced, with
**Portainer** beside them since 2026-10-19 (#1282; "Portainer through an SSH
tunnel", below), and the health pulse records each every five minutes.

- **Lab job canary.** Once an hour, at 20 past, `labCanary` enqueues one
  `shell-echo` job whose payload is `hcw-canary <job id>`, waits up to 150
  seconds for the agent to claim it, run it and report the payload back, and
  deletes the job. It enqueues nothing when no active agent registered for
  `shell-echo` is online. Healthy reads `A shell-echo job ran end to end <n>
  min ago: claimed after <n> s, done <n> s later.` Offline means nothing ran
  it (no agent online, or nobody claimed it); critical means it ran and
  failed, echoed something else, or the agent's registration lacks
  `shell-echo` (re-register it on the Labs **Agents** tab with that job type
  ticked). A job still running at the deadline is left to finish and
  deleted by the next run, and no second one is enqueued meanwhile. One run
  holds the canary's record at a time: a second run that starts while the
  first is under way leaves everything alone and ends with `overlap`.
- **Coder status token.** Every read of Coder with `CODER-STATUS-TOKEN`
  records Coder's answer, kept apart for the two things the token does: the
  labs status read (a visitor's read that misses the one-minute cache, and
  `checkAgentHealth`'s hourly check, which asks Coder directly and never
  through that cache) and the Integrations card's read of the token's own
  record.
  Critical from the first 401 or 403 on either until that same read
  succeeds again, naming which read and since when; so opening Integrations
  never clears a status read's 403. Unknown when nothing has read Coder for
  a day, which with the hourly check means the check itself has stopped. A
  401 also writes a warning line starting `coder-status:
  Coder refused CODER_STATUS_TOKEN (401)` (no alert rule pages on it yet;
  "What these still do not cover" in `alerting-and-support.md` has the
  query). The fix is the automatic renewal below, run now with
  `--rotate-now`.

**Arming the canary.** It is a real job on the host every hour, so it is off
until the owner arms it. In the browser, open
<https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables>, edit
`enabled_timers` (HCL) to add `"LAB_CANARY"` to the list, save, and start a
run from <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>. The
plan's one change beyond the usual three replacements is
`FEATURE_FLAG_LAB_CANARY` from `false` to `true` on the Function App, which
the plan check reads as `DECLARED`. Confirm it. Within the hour, at 20
past, the **Lab job canary** card turns healthy; until its first run it
reads `The lab canary has not run`.

**Disarming it, or rolling it back, and a job in flight.** Remove
`"LAB_CANARY"` from `enabled_timers` the same way, or revert the change and
redeploy. Either stops new runs at once; a run already under way finishes
and cleans up after itself as usual. What can be left is the one job a run
was still waiting on at its 150-second deadline, which it leaves to the
agent and names in `admin_config/lab_canary` as `pendingJobId` for the next
run to settle. With no next run:

- A job the agent claimed finishes as normal and stays in the Labs **Jobs**
  list, a `shell-echo` job requested by `lab-canary`. Nothing claims it
  again, and nothing runs on the host because of it.
- A job still queued is rare: a run cancels and deletes a job nobody
  claimed by its deadline, so one is left queued only when the run died
  after creating it. The agent claims and runs it as soon as it is online,
  and until then it counts as one of the 20 queued jobs the public door
  allows. The admin console offers no cancel for a job it did not submit,
  so the way to remove it at once is to re-arm the canary for one run.
- Either way, the job's document goes when the `lab_jobs` container's
  30-day time-to-live (`default_ttl` 2592000 in
  `infra/cosmos-containers.json`) removes it. Re-arming the canary settles it
  sooner: the first run deletes a finished one, and withdraws one claimed
  more than twenty minutes earlier, before it enqueues anything.

No job outlives the time-to-live, so nothing else is needed.

## Automatic renewal

Owner approval 2026-10-08. The lab host renews the site's Coder status
token (`CODER-STATUS-TOKEN`) and publishes the `hcw-lab` template on its
own, with one credential the owner seeds once: the **rotation credential**,
an unscoped Coder token of `hcw-status`, which is a Template Admin and never
an Owner, kept root-only at `/etc/hcw/coder/automation/rotation-token`.
Unscoped on purpose: measured on 2026-10-19 (#1037, the second table under
"The status token for the site" in `lab-host/README.md`), a token that can
renew the status token can mint any scope on Coder 2.38.0, so a narrower
credential would contain nothing; containment is the account, below.
After the seed:

- `hcw-coder-automation.timer` runs `hcw-coder-automation.service` daily at
  05:45 UTC (up to 30 minutes later). It renews the site's status token when
  the one the site holds expires within 30 days or is more than 60 days
  old: a new token with the three read scopes and `user:read` for 90 days, checked
  against Coder, then handed to the site through the lab agent's CLI, which
  stores it in Key Vault. It deletes `hcw-status`'s older status tokens,
  keeping the newest two and any younger than 48 hours. It renews the
  rotation credential itself when it has under 60 days left. And every run
  reports to the site when it checked, when each token expires, when the
  template was last published and the last error, if any.
- Every `bootstrap.sh` run publishes the template with the rotation
  credential when its files changed.

The design, and why the credential is a root-only file rather than a vault
secret, is in `lab-host/ansible/roles/coder/README.md`, "Coder automation".
The status token was renewed by hand before this ("The status token for
the site" in `lab-host/README.md`); that still works, and is the fallback.

**Before you start.** The `bootstrap.sh` run that installs it has run
(it installs `/usr/local/sbin/hcw-coder-automation-seed`); `hcw-status`
exists with the Template Admin role (step 2 of "The status token for the
site"); and the lab agent is configured and runs a commit that has
`vps-agent/bin/report-coder-automation.js`, the site's CLI this uses.

**1. Seed the rotation credential, once.** Make the short-lived `hcw-setup`
token in a pane as step 1 of "The status token for the site" in
`lab-host/README.md` shows, then hold it in PowerShell: paste this line,
then paste the token at the masked prompt.

```powershell
$t = [Net.NetworkCredential]::new('', (Read-Host 'hcw-setup token' -AsSecureString)).Password
```

Then seed, PowerShell:

```powershell
$t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-coder-automation-seed"
```

`sudo -n` works as it does for `hcw-coder-template-push`: `hcwadmin` has
passwordless sudo (`/etc/sudoers.d/90-hcw-admin`, the `hardening` role), so
neither helper needs a sudoers entry of its own. Success is one line:

```text
hcw-coder-automation-seed: stored the rotation credential hcw-status-rotation-<today> for hcw-status; it expires on <a year from today>.
```

A second run prints `a working rotation credential for hcw-status is already
stored (it expires on …); nothing was changed. --force replaces it`. Then
clear the variable, PowerShell, and delete `hcw-setup` in the pane (step 5
of "The status token for the site"):

```powershell
Remove-Variable t
```

| Message | Means |
| --- | --- |
| `pipe the owner's Coder token in on stdin` | The line ran without `$t` piped into it, or `$t` is empty |
| `the first line on stdin is not a Coder token` | `$t` holds something else; repeat the `Read-Host` line. What it held is not shown |
| `Coder refused the token on stdin (HTTP 401)` | The `hcw-setup` token expired or was deleted; make another |
| `Coder has no user hcw-status` | Step 2 of "The status token for the site" has not run |
| `hcw-status holds the Owner role` / `is not a Template Admin` | Its role is wrong; step 2 of the same section sets Template Admin, and Owner must be removed in Coder's **Users** page. A stored credential is not kept while either is wrong, so the seed says this even when one is already stored |
| `deleting the new rotation credential … failed too` | Coder made the new credential but it failed before it was stored, and Coder did not delete it. The stored one is unchanged; the next run deletes the new one |

**2. Run it once now, and read what it did.** PowerShell:

```powershell
ssh hcw-lab "sudo -n systemctl start hcw-coder-automation.service; sudo -n journalctl -u hcw-coder-automation.service -n 20 --no-pager -o cat"
```

Success is a last line starting `hcw-coder-automation: checked:` and ending
`reported to the site`. While the site still holds the token made by hand
and it is younger than 60 days, that line says `the site still holds a
status token made by hand`, and the timer takes over when it turns 60 days
old. To hand over now, rotate by hand (below). A `Job for
hcw-coder-automation.service failed` line means the run failed; the
journal's lines above it say why (the table below).

**Checking it afterwards.** The timer, PowerShell:

```powershell
ssh hcw-lab "systemctl list-timers hcw-coder-automation.timer --no-pager"
```

Success is one row with a `NEXT` time on the next day and a `LAST` time once
it has run. The last runs, PowerShell:

```powershell
ssh hcw-lab "sudo -n systemctl status hcw-coder-automation.service --no-pager; sudo -n journalctl -u hcw-coder-automation.service -n 30 --no-pager -o cat"
```

Success is `Active: inactive (dead)` with `status=0/SUCCESS` (a oneshot
that finished; `failed` is a failed run), and each day's run ending with the
`checked: … reported to the site` line. On a day it renewed, two lines come
before it: `renewing the site's status token: …` and `the site stored the
new status token hcw-status-site-<that day>; it expires on …`. What it last
recorded, content-free (token names and dates, never a token), PowerShell:

```powershell
ssh hcw-lab "sudo -n cat /var/lib/hcw-coder-automation/state.json"
```

A failed run is also an Azure alert: the unit's `OnFailure=` logs `unit
hcw-coder-automation.service entered the failed state`, which
`alert-lab-unit-failed` pages on, and the site's report carries the same
`lastError`.

| Journal line | Means | Do |
| --- | --- | --- |
| `Coder refused the rotation credential (HTTP 401)` | It expired or was deleted | Seed again with `--force` (below) |
| `Coder did not answer at http://127.0.0.1:7080` | Coder is down | `sudo docker compose --project-directory /etc/hcw/coder ps`, bash, on the host |
| `the lab agent is not configured` | `/etc/hcw/labs-agent.env` is missing | "The lab agent's go-live", above |
| `site CLI: …` then `the site's CLI exited with 1` | The site's CLI failed, and its one line names the class: `HTTP <status>` (the site answered that), `MISSING_CONFIG` (the agent's environment lacks a value), `INVALID_INPUT`, `INPUT_TOO_LARGE` or `UNEXPECTED_ANSWER` | `HTTP` and `MISSING_CONFIG` are the site's or the agent's side; the other three are a fault in this helper or the CLI. A new token was kept, and the next run tries again |
| `the site answered that it did not store the new status token` | The site declined it; the new token was deleted | The site side |
| `hcw-status holds the Owner role` | Someone granted it Owner; nothing ran | Remove Owner from `hcw-status` |
| `hcw-status is not a Template Admin` | Someone removed the role; nothing ran | Give `hcw-status` Template Admin again (`lab-host/README.md`, "The status token for the site", step 2) |
| `deleting the new rotation credential … failed too` | A renewed credential failed before it was stored and Coder did not delete it; the stored one is unchanged and its id is in the state | Nothing: every run deletes it until it is gone |
| `Coder did not delete the previous one; the next run deletes it` | A renewal stored the new credential, and Coder did not delete the one it replaced; its id is on the state's deletion list | Nothing: every run deletes it until it is gone |
| `Coder did not delete 1 rotation credential(s) an earlier run replaced or never stored` | That deletion failed again | Nothing while it clears within a day or two; if it repeats, Coder is failing deletes generally, and `coder tokens list --all` (`lab-host/README.md`, "The status token for the site") shows the stray `hcw-status-rotation-` token |

**Rotating by hand.** The site's status token, now, PowerShell:

```powershell
ssh hcw-lab "sudo -n /usr/local/libexec/hcw-coder-automation run --rotate-now"
```

Success is `the site stored the new status token hcw-status-site-<today>;
it expires on <90 days on>` and then the `checked:` line. The site picks up
the new Key Vault version within 24 hours, and the old token is kept
meanwhile. The rotation credential, renewed with itself, PowerShell:

```powershell
ssh hcw-lab "sudo -n /usr/local/libexec/hcw-coder-automation run --rotate-credential"
```

Success is `stored a new rotation credential, hcw-status-rotation-<today>;
it expires on <a year on>`. When Coder refuses the credential (it lapsed or
was deleted), seed it again: step 1 with this line in place of the seed
line, PowerShell:

```powershell
$t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-coder-automation-seed --force"
```

Publishing the template now, without waiting for a change, PowerShell:

```powershell
ssh hcw-lab "sudo -n /usr/local/libexec/hcw-coder-automation push-template --force"
```

Success ends `hcw-coder-automation: published hcw-lab with the rotation
credential; active version <name>`.

**Stopping it.** Revoke the credential, PowerShell:

```powershell
ssh hcw-lab "sudo -n /usr/local/libexec/hcw-coder-automation revoke"
```

Success is one line, `hcw-coder-automation: revoked the rotation credential
in Coder and removed it; …`. It deletes the credential in Coder first, along
with any on the state's deletion list, and removes the file only once Coder
confirms, so no unscoped token outlives the automation. Deleting the file
alone would leave that token valid in Coder for up to a year. A line ending
`run this again` means Coder did not confirm a deletion; nothing that
could finish the job was removed, so run the same line again. Afterwards
the daily run is skipped, not failed (`systemctl status` shows a
`Condition:` line naming `ConditionPathExists`), `bootstrap.sh` stops
publishing and says how to seed again, and the site keeps the last status
token it was given until that token expires; renew it by hand as before
("The status token for the site" in `lab-host/README.md`). Seeding again
turns it all back on.

**Before reverting the automation's code,** run the line above first. The
revert removes the helper that knows how to revoke the credential, and the
file it leaves behind would still be a valid unscoped token.

**If the rotation credential may have leaked** (someone else may have read
`/etc/hcw/coder/automation/rotation-token`, or a backup or copy of the host
holding it went astray), contain it on the account, not the token. Its year
is that one token's lifetime, not a bound on access: whoever holds it can
mint more unscoped, year-long tokens of `hcw-status`, which are neither the
stored credential nor status tokens, so neither `revoke` nor the daily
clean-up would touch them. Deleting the user removes every API key it has
at once, copies and successors alike: Coder v2.38's schema deletes a
deleted user's `api_keys` in the `delete_deleted_user_resources` trigger.
`hcw-status` owns no workspaces, which Coder requires before deleting a
user, and its username can be created again at once (Coder's unique index
on usernames skips deleted users) (review of #1035).

1. Make the `hcw-setup` token and hold it in `$t`, as step 1 of "The status
   token for the site" in `lab-host/README.md` shows. Then delete the user,
   PowerShell:

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder users delete hcw-status; }'"
   ```

   Success is `Successfully deleted hcw-status.` From here the Hybrid Lab
   card stops listing templates and counting workspaces until step 3,
   because the site's status token went with the user.
2. Clear the host's copy, PowerShell:

   ```powershell
   ssh hcw-lab "sudo -n /usr/local/libexec/hcw-coder-automation revoke"
   ```

   Success starts `hcw-coder-automation: Coder no longer accepts the
   rotation credential (HTTP 401), so there was nothing to delete in Coder;
   removed it`.
3. Make the user again with step 2 of "The status token for the site" (the
   same `$t`), then seed (step 1 of this section) and run once (step 2). The
   run finds that the token the site was given is no longer in Coder and
   gives the site a new one at once: success is `the site stored the new
   status token hcw-status-site-<today>` above the `checked:` line. Then
   `Remove-Variable t`, and delete `hcw-setup` in the pane (step 5 of "The
   status token for the site").

## Off-host backups

Owner decision 2026-10-14 (ADR 0032, amendment of that date; estate review
LAB-9, [#955](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/955)):
the nightly Coder dump and a nightly Vault raft snapshot are uploaded to the
`host-backups` container of `stlabhybridprodcus01`, as the Arc machine's
identity, by the `backups` role (`lab-host/ansible/roles/backups/README.md`).
The container is immutable for 35 days, so the host can add a copy and cannot
remove one. The Coder dump needs nothing from the owner: it uploads after
every dump while the host is Connected to Arc. The Vault snapshot needs one
token, seeded once; after that `hcw-vault-backup.service` renews it every
night, and the owner does nothing more.

**Before you start.** The `bootstrap.sh` run that installs the role has run
with `failed=0`. Its task `backups : Say how the off-host backups stand`
prints `Off-host backups are on` and `The Vault snapshot token is not
seeded`. Vault is unsealed (`vault status` over `ssh hcw-lab` says `Sealed
false`).

**1. Seed the snapshot token, once.** It takes the Vault root token from the
password manager (creating an orphan periodic token needs it). Hold it in
PowerShell: paste this line, then paste the token at the masked prompt.

```powershell
$t = [Net.NetworkCredential]::new('', (Read-Host 'Vault root token' -AsSecureString)).Password
```

Then seed, take the first snapshot and read the upload's line, PowerShell:

```powershell
$t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-backup-seed && sudo -n systemctl start hcw-vault-backup.service && sudo -n journalctl -t hcw-backup-upload -n 1 --no-pager"
```

`sudo -n` works as it does for `hcw-coder-automation-seed`: `hcwadmin` has
passwordless sudo. Success is two lines: one starting
`hcw-vault-backup-seed: stored the snapshot token for policy
hcw-raft-snapshot in /etc/hcw/backups/vault-token`, and a journal line ending
`uploaded vault/vault-<UTC stamp>.snap (<bytes> bytes) to
stlabhybridprodcus01/host-backups`. Then drop the token from the session,
PowerShell:

```powershell
$t = $null
```

A second run prints `a working snapshot token is already stored in
/etc/hcw/backups/vault-token; nothing was changed (--force replaces it)`.
The seed never prints a token, and the root token is used for the policy
and the token and kept nowhere.

**2. The Coder dump uploads on its own.** The next 03:30 dump ends with an
`uploaded coder/coder-<UTC stamp>.sql.gz` line. To see one now rather than
tomorrow, bash, on the host:

```bash
sudo /usr/local/sbin/coder-postgres-backup && sudo journalctl -t hcw-backup-upload -n 1 --no-pager
```

**What to check later.** Every upload is one journal line, bash, on the host:

```bash
sudo journalctl -t hcw-backup-upload --since -3d --no-pager
```

Good is one `uploaded coder/...` and one `uploaded vault/...` line per night.
A night without one raises `alert-lab-backup-missing-coder` or
`alert-lab-backup-missing-vault` after two nights
([alerting-and-support.md](alerting-and-support.md)); the same journal says
which step failed. `sudo /usr/local/sbin/hcw-backup-upload --check` proves
the grant without uploading anything. A snapshot token that has expired or
been revoked (`could not be renewed` in the journal) is replaced by step 1 as
it stands: a plain run of the seed replaces a stored token that no longer
works, and revokes a working one only when `--force` is added.

**The way back.** `hcw-backup-restore`, installed by the same role, lists
the container as the Arc identity, fetches the newest (or a named) blob to
`/var/backups/restore/`, and with `--yes` restores a dump into
`coder-postgres` or a snapshot into Vault
(`lab-host/ansible/roles/backups/README.md`, "Restore"). The rebuild that
uses it is "Reinstalling the host", step 7, above, which carries the **Last
rehearsed / elapsed** line. To see what is there without changing anything,
bash, on the host:

```bash
sudo /usr/local/sbin/hcw-backup-restore list
```

Good is one line per blob, name, bytes and date, newest last under each of
`coder/` and `vault/`.

## Container-runtime privilege separation (LAB-5)

Estate review 2026-10-06, finding LAB-5; ADR 0032, amendment of 2026-10-07.
Merged on 2026-10-07 (#987), and **not yet on the host** at the 2026-10-08
review (#1009): the host last converged before the merge
([Labs host, Applied state](../architecture/labs-host.md#applied-state)).
This section describes the host from the first `bootstrap.sh` run after the
merge, which this run's checks prove. From that run the lab host runs two
Docker daemons and nobody but root reaches either directly:

- the **host daemon** remaps user namespaces (`userns-remap: default`), so a
  job container's root, and Coder's server's and PostgreSQL's, is an
  unprivileged uid on the host;
- **`hcw-labs-agent` is in no docker group**: the agent reaches the host
  daemon through `hcw-labs-agent-docker-proxy`, which passes the calls a job
  makes and refuses any container that asks for privilege, a host
  namespace, a device, a mount, or a bind beyond the job's own directory;
- **Coder's workspaces run on a rootless daemon** owned by the unprivileged
  user `hcw-coder-docker`, and Coder's proxy reaches that daemon and never
  the host's.

The run of `lab-host/bootstrap.sh` that first applies this checks all of it
at its end (the `privilege_checks` role) and fails with what to do. The
commands below are the owner's own look afterwards, and what the estate
review's next pass will check.

### What the first run changes, and costs

The run that turns user-namespace remapping on:

1. **Stops every running container**, then restarts Docker. A lab job in
   flight fails and is reported failed; a workspace in use stops.
2. **Copies two volumes** into the daemon's new data root: Coder's
   PostgreSQL cluster (sign-ins, the template, workspace records) and
   Portainer's database (its administrator and licence). The originals are
   only read and stay in `/var/lib/docker/volumes/`.
3. **Pulls every image again**: the host daemon's store starts empty, and
   the workspace image (about 484 MB) goes into the sandbox daemon's. The
   run takes several minutes longer than usual, once.
4. **Starts workspaces on the sandbox daemon.** A learner's workspace
   starts again from an empty home volume, because its old volume belongs to
   the host daemon's old data root, where it stays on disk
   (`/var/lib/docker/volumes/coder-<workspace id>-home`) but no daemon
   serves it. Coder Community has members of one GitHub organisation only,
   so this is expected to be the owner's own workspaces.

`lab-host/coder/templates/hcw-lab/main.tf` changed in comments only, so
publishing the template again is not needed for this change.

### Before the run

An extra PostgreSQL dump of Coder, beside the nightly one, costs nothing.
Bash, on the host (PowerShell `ssh hcw-lab` from the workstation gets there):

```bash
sudo /usr/local/sbin/coder-postgres-backup
```

Good is exit status 0 and a new file under `/var/backups/coder/`; with
off-host backups on ("Off-host backups", above), also an
`hcw-backup-upload: uploaded coder/...` line.

### The run

Bash, on the host, after the pull request is merged:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh
```

Good is a `PLAY RECAP` line for `localhost` with `failed=0`, and before it
the task **Say what the agent proxy check saw** printing one sentence: the
job printed its payload, `docker ps` was refused by the allowlist, a
privileged run was refused by the container rules. (The two refusals reach
the Docker CLI as `Error response from daemon: … refused …`; that is the
proxy's refusal, not a fault, and the sentence says so rather than quoting
it. The raw answers are printed only when the check fails.)

A run that moves Docker Engine restarts the daemon, which recreates
`/var/run/docker.sock`; the agent's proxy holds that socket as a bind-mounted
file, so a proxy already running would keep the old inode and answer every
forwarded call with `503 Service Unavailable` while its own refusals still
answer (the 2026-10-14 run, 29.8.1 → 29.9.0, ended at the privilege check
with exactly that). The labs_agent role now restarts a proxy that started
before the daemon's current start (**Ask whether a running proxy predates
the daemon's current start**, then **Run the agent's Docker socket proxy**
reporting `changed`) and refuses to go on until `GET /_ping` through the
proxy answers 200. After a pin set merges, the run can be narrowed to the
roles that own it (`lab-host/README.md`, "Running part of the play"); a
narrowed run is not recorded as a convergence. The docker role reports `changed`
on the stop and the carry tasks on the run that switches (they run once), and
on **Delete the bridges the running daemon no longer owns** when that run left
the old root's bridges behind. Compose no longer warns that
`coder-postgres-data` "was not created by Docker Compose": the volume is
external and the coder role creates it (2026-10-08).

This is also the run that takes the lab images to Docker Hub (#1002,
#1003), and it publishes the templates that name them itself:
[After a merge: the playbook, then the template, at once](#after-a-merge-the-playbook-then-the-template-at-once).

### Checking it afterwards

Each command is bash, on the host, one line.

The agent user's groups:

```bash
id hcw-labs-agent
```

Good is `groups=` naming `hcw-labs-agent` alone. `docker` anywhere in the
line is the finding.

The host daemon's security options:

```bash
sudo docker info --format '{{json .SecurityOptions}} {{.DockerRootDir}} {{.Driver}}'
```

Good is a list containing `"name=userns"`, then a data root of the form
`/var/lib/docker/231072.231072` (two equal numbers, the remapped range's
first id) and `overlay2`.

A job, as the agent user, through its proxy, and the two things the proxy
must refuse:

```bash
sudo runuser -u hcw-labs-agent -- env DOCKER_HOST=unix:///run/hcw-labs-agent-docker/docker.sock TMPDIR=/var/lib/hcw-labs-agent/tmp /usr/bin/node /usr/local/libexec/hcw-labs-agent-proxy-check.mjs /opt/hcw-labs-agent/vps-agent 64m 0.5 32
```

Good is one line of JSON in which `job`, `listing` and `privileged` each
carry `"ok":true`: the job printed `hcw-labs-agent proxy check` and exited 0,
and the other two were answered `hcw-labs-agent-docker-proxy refused this
call` and `refused this container`.

The agent user cannot use the daemon's own socket:

```bash
sudo runuser -u hcw-labs-agent -- docker -H unix:///var/run/docker.sock ps
```

Good is `permission denied while trying to connect to the docker API`.

Coder's proxy and the allowlist it runs with:

```bash
sudo docker inspect coder-docker-proxy --format '{{range .Config.Env}}{{println .}}{{end}}{{range .Mounts}}mount {{.Source}}{{println}}{{end}}'
```

Good is every `KEY="0"` or `KEY="1"` line of the `coder-docker-proxy`
service in `lab-host/coder/docker-compose.yml` (on `main`) appearing as
`KEY=0` or `KEY=1`, `SOCKET_PATH=/run/hcw-coder-docker/docker.sock`, and
one mount line, `mount /run/hcw-coder-docker`. A `mount
/var/run/docker.sock` line is the finding.

The daemon Coder's workspaces run on:

```bash
sudo docker -H unix:///run/hcw-coder-docker/docker.sock info --format '{{json .SecurityOptions}} cgroup v{{.CgroupVersion}} {{.CgroupDriver}}'
```

Good is a list containing `"name=rootless"`, then `cgroup v2 systemd`.

Then open a lab from https://hybridcloudworks.com/education/labs and, once
the editor shows, look for its container on each daemon:

```bash
sudo docker -H unix:///run/hcw-coder-docker/docker.sock ps --format '{{.Names}} {{.Labels}}'
```

Good is one `coder-...` line per running workspace with
`com.coder.resource=true` in its labels, and

```bash
sudo docker ps --format '{{.Names}}'
```

listing `coder`, `coder-postgres`, `coder-docker-proxy`,
`hcw-labs-agent-docker-proxy`, `portainer`, and no `coder-...` workspace.

### If a check fails

The run's own message names what to do. Its log is the first place to read:
for the host daemon, `sudo journalctl -u docker -n 50 --no-pager`; for the
agent's proxy, `sudo docker logs --tail 50 hcw-labs-agent-docker-proxy`
(each refused request is a line with `403`); for the sandbox daemon,
`sudo journalctl _UID=$(id -u hcw-coder-docker) -n 80 --no-pager`.

### Taking it back

Nothing on the host was deleted to make this change, so the remap is
undone with a flag rather than a repair. Bash, on the host:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh -e docker_userns_remap=false
```

The docker role stops the running containers, puts the daemon back on its
original data root with the containerd image store it was installed with,
and the Coder database and Portainer come back as they were at the moment
of the switch. Good is `failed=0` in the `PLAY RECAP` and, near the end, the
message `This run was given docker_userns_remap=false` from the checks,
which warn rather than fail on it. The agent stays out of the docker group
and the workspaces stay on the sandbox daemon: the flag undoes the remap
only. Do not take it back by reverting the pull request: the older docker
role neither stops the containers before switching nor restarts the daemon
before the roles after it, and leaves the remapped containers running
beside the original ones.

Anything Coder recorded after the switch (a new sign-in, a template
version) is in the remapped root's copy only, so take a dump with
`sudo /usr/local/sbin/coder-postgres-backup` first if it matters. The next
plain run turns the remap on again and stops at the carry: it finds the
pre-remap data newer than the copy it made the first time, refuses to use
that older copy, and prints the three steps that carry the data again.

### Listeners beyond the loopback

Every service the roles run listens on the loopback: Coder on 7080,
Portainer on 9443, Vault on 8200 and 8201, node_exporter on 9100, the Arc
agent on 40341 to 40344, each tool add-on on its own port, and sshd (TCP 22,
#1257). In addition, ufw refuses 22 from outside while Arc SSH is ready
(#953 stage 3). Only Caddy (TCP 80 and 443) listens beyond the loopback. The
last check of every run (`roles/privilege_checks`, `tasks/listeners.yml`; #958,
LAB-12) reads every TCP and UDP listener with `ss`, including the ports the
rootless sandbox forwards for a workspace. It fails the run if anything else
listens beyond the loopback, naming each one: `These listen beyond the loopback,
and only TCP 80, 443 may: …`.

When it fails, this names the process behind each one, bash on the host:

```bash
sudo ss -ltnup
```

Bind that service to `127.0.0.1` (for a container, publish
`127.0.0.1:<port>:<port>`), or stop it, then run `bootstrap.sh` again. Good
is a recap with `failed=0`. Port 22 has left `privilege_checks_public_tcp_ports`
now that sshd binds to the loopback alone (#1257).

The same check also reads the host daemon's published ports from the rules
that carry them: every `DNAT` rule in the `nat` table's `DOCKER` chain, IPv4
and IPv6, must name a loopback destination (`-d 127.0.0.1/32` or
`-d ::1/128`). That holds even with Docker's userland proxy off, when a
published port has no listener for `ss` to see. A failure says `The host
daemon publishes these beyond the loopback:` and quotes each rule. This
lists them, bash on the host:

```bash
sudo iptables -w -t nat -S DOCKER; sudo ip6tables -w -t nat -S DOCKER
```

Publish the container's port as `127.0.0.1:<port>:<port>`, or remove the
container, then run `bootstrap.sh` again.

### Host firewall for the sandbox and bridges

The `host_firewall` role (#954, #958; owner decision 2026-10-16) limits
workspace egress to what the labs need, refuses host-local and private
destinations, lets containers on the host daemon's bridges open only HTTP
and HTTPS to the host, and refuses the host's own new connections to Coder's
internal network. It is on the host from the first `bootstrap.sh` run after
its pull request merges. Four chains of the host's own, each jumped to first,
above ufw's:

- **`HCW-SANDBOX-OUT`**, for everything the sandbox user `hcw-coder-docker`
  sends (the sandbox daemon and its workspaces): DNS to systemd-resolved's
  stub `127.0.0.53`, TCP 443 to the host's own non-loopback addresses
  (Caddy: Coder and the guided labs), then the rest of the host and every
  private, link-local, multicast and reserved range refused, then replies,
  TCP 80 and 443 to public addresses, and everything else (mail, SSH, other
  UDP) refused. The refusals come before replies, so a flow to a refused
  destination that was open when the rules first loaded is cut.
- **`HCW-BRIDGE-IN`**, for what containers on `docker0` and `br-*` send to
  the host: replies to the host's own connections and TCP 80 and 443;
  everything else refused.
- **`HCW-CONTROL-OUT`**, for what the host itself sends to Coder's internal
  network (`coder-control`): the host's own new connections there are
  refused, and its answers to connections opened from there go. Coder
  reaches that network across its own bridge. The subnet is read from
  Docker and from the Compose file at every run.
- **`HCW-REFUSE`**, which the others use to refuse: a TCP reset or an ICMP
  port-unreachable, so a refused TCP connection fails at once rather than
  timing out.

`hcw-host-firewall.service` loads them at every boot, after ufw and before
Docker, and the sandbox user's manager requires it, so the sandbox daemon
does not start without them; a failed load is reported through
`hcw-unit-failed@` (`alert-lab-unit-failed`). ufw's reload and Docker's
restart leave them in place; the add-ons' `DOCKER-USER` rules are separate
and untouched.

**Reading it.** Each command is bash, on the host, one line. Whether the
live chains and jumps match the files the role rendered:

```bash
sudo /usr/local/libexec/hcw-host-firewall verify; echo "exit=$?"
```

Good is `exit=0` and nothing before it. A difference prints one line per
chain or jump that differs, under `v4:` or `v6:`. The rules as loaded:

```bash
sudo iptables -S HCW-SANDBOX-OUT
```

Good is the rules in the order above, each with an `hcw:` comment, the
`https to this host` line reading `! -d 127.0.0.0/8 -p tcp -m tcp --dport 443
-m addrtype --dst-type LOCAL`, and the last line
`-A HCW-SANDBOX-OUT -m comment --comment "hcw: refused" -j HCW-REFUSE`. The
jumps:

```bash
sudo iptables -S OUTPUT | sed -n 2,3p; sudo iptables -S INPUT | sed -n 2,3p
```

Good is four lines: `-A OUTPUT -m owner --uid-owner` followed by the
number `id -u hcw-coder-docker` prints and `-j HCW-SANDBOX-OUT`, then
`-A OUTPUT -j HCW-CONTROL-OUT`, `-A INPUT -i docker0 -j HCW-BRIDGE-IN` and
`-A INPUT -i br-+ -j HCW-BRIDGE-IN`. `ip6tables` in place of `iptables`
gives the IPv6 side, which reads the same with IPv6 ranges. The internal
network's rules:

```bash
sudo iptables -S HCW-CONTROL-OUT
```

Good is two lines per subnet of `coder-control` (the subnet
`sudo docker network inspect coder-control --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`
prints): one ending `"hcw: replies on the internal network" -j RETURN`, one
ending `"hcw: internal network, refused" -j HCW-REFUSE`. The boot unit:

```bash
systemctl is-active hcw-host-firewall; systemctl show "user@$(id -u hcw-coder-docker).service" -p Requires
```

Good is `active`, then a `Requires=` line that names
`hcw-host-firewall.service`.

**When a lab cannot reach something.** From the workspace's terminal, a
refused TCP destination fails at once with `Connection refused`. UDP (DNS to
a public resolver, QUIC) may instead simply time out, and so does a
destination that is down, so a timeout alone says nothing either way: read
the counters. Read them, make the lab try again, and read them again; the
line whose packet count grew is the verdict:

```bash
sudo iptables -L HCW-SANDBOX-OUT -v -n --line-numbers
```

`hcw: private or reserved, refused` and `hcw: host-local, refused` mean the
lab tried a private or host address; `hcw: refused` means a port or protocol
other than TCP 80 and 443 (`git` over SSH, a mail port, DNS to a public
resolver, QUIC). Labs use HTTPS for all of these. A lab that genuinely needs
more is a change to `lab-host/ansible/roles/host_firewall/vars/main.yml` in
a reviewed pull request (owner decision), not an edit on the host. The same
command with `HCW-BRIDGE-IN` reads what the host's own containers were
refused.

**Putting it back.** If `verify` reports a difference (something rewrote
the filter table), re-apply from the files:

```bash
sudo systemctl reload hcw-host-firewall; sudo /usr/local/libexec/hcw-host-firewall verify; echo "exit=$?"
```

Good is `exit=0`. Do not `restart` or `stop` the unit: it refuses, because
stopping it would stop the sandbox user's manager and every workspace with
it, and would not remove a rule. Re-running the role alone also works:
`sudo /opt/hcw-src/lab-host/bootstrap.sh --tags host_firewall`.

If the unit failed at boot (the `alert-lab-unit-failed` mail names
`hcw-host-firewall.service`, and workspaces do not start, because the
sandbox user's manager requires it), read why with
`sudo journalctl -u hcw-host-firewall -b --no-pager`, put right what it
names, then start the unit and the manager that waited for it:

```bash
sudo systemctl start hcw-host-firewall && sudo systemctl start "user@$(id -u hcw-coder-docker).service"
```

Then:

```bash
systemctl is-active hcw-host-firewall "user@$(id -u hcw-coder-docker).service"
```

Good is two lines, `active` and `active`.

The same two commands recover a `bootstrap.sh` run that stopped the
sandbox: when the role cannot load the firewall and the live rules do not
exactly equal the last policy it verified (`/etc/hcw/firewall/verified`), it
stops the sandbox user's manager and fails the run, and its message says so. Put right what the message names, then
run the role on its own first, because a plain run starts that manager in
`coder_sandbox`, before this role, and the manager waits for the firewall:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags host_firewall
```

Good is `failed=0`. Then the two commands above, with the same good result.
A run that fails while the live rules still equal that verified policy
stops nothing: its message says so.

**Taking it out.** The role removes everything it put on the host when run
with `host_firewall_state=absent`: the drop-in first, so the sandbox user's
manager stops requiring the unit, then the unit, then the jumps and the
chains, then the helper and its files. Nothing restarts the user's manager or
Docker. The sandbox and the bridges are then as unrestricted as before the
role existed, until the next plain run, which puts it all back. Bash, on the
host:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags host_firewall -e host_firewall_state=absent
```

Good is `failed=0` in the `PLAY RECAP`, and then:

```bash
sudo iptables -S | grep -c HCW-; sudo ip6tables -S | grep -c HCW-; systemctl is-active hcw-host-firewall
```

Good is `0`, `0`, then `inactive`.

## Workspace reach

**The symptom:** a lab's Coder page says **"Agent is taking longer than
expected to connect"** and the CPU, Memory and Home disk gauges stay empty.
The workspace's container is running, but the agent inside it never
started, because the container could not download it from Coder. That
happened to every lab on 2026-10-17 (#1267). The sandbox firewall refused
the workspaces' DNS: the Terraform docker provider creates each workspace on
the default bridge, which gave it systemd-resolved's upstream servers
instead of the stub, and the firewall lets the sandbox reach the stub only
(`lab-host/ansible/roles/coder_sandbox/README.md`, "Workspace DNS").

The `workspace_reach` role checks this before a learner can. At the end of
every `bootstrap.sh` run, whatever the tags, and every 15 minutes from
`hcw-workspace-reach.timer`, it creates one throwaway container the way the
provider creates a workspace, on the sandbox daemon, as its user. The container resolves
Coder's name, fetches the start of the agent and runs `git ls-remote` on the
lab repository. A failure fails the run, and from the timer it raises
`alert-lab-unit-failed` through `hcw-unit-failed@`.

**Run it now.** Bash, on the host (`ssh hcw-lab`):

```bash
sudo systemctl start hcw-workspace-reach.service; systemctl show -p Result --value hcw-workspace-reach.service; sudo journalctl -t hcw-workspace-reach -n 3 --no-pager --output=cat
```

Good is `success`, then a line beginning `workspace reach: OK:`. Anything else
ends in a line beginning `workspace reach: FAILED:`, which names the step:

- **`cannot resolve coder.lab.hybridcloudworks.com`:** the workspace's DNS.
  Read the sandbox daemon's nameserver for workspaces, and what rootlesskit
  runs. Bash, on the host:

  ```bash
  sudo grep -A2 '"dns"' /var/lib/hcw-coder-docker/.config/docker/daemon.json; sudo curl -s --unix-socket "/run/user/$(id -u hcw-coder-docker)/dockerd-rootless/api.sock" http://rootlesskit/v1/info; echo; grep '^nameserver' /etc/resolv.conf
  ```

  Good is `"10.0.2.3"` under `"dns"`, JSON with `"dns":["10.0.2.3"]`, and
  `nameserver 127.0.0.53` alone. A missing `"dns"` means the `coder_sandbox`
  role has not run since #1267 merged. Run
  `sudo /opt/hcw-src/lab-host/bootstrap.sh --tags coder_sandbox` (bash, on
  the host; the check runs at its end), then start each stuck workspace
  again (below). The firewall's counters show where lookups go. Bash, on the
  host:

  ```bash
  sudo iptables -L HCW-SANDBOX-OUT -v -n -x | grep -E 'host resolver|hcw: refused \*/'
  ```

  Good is the `the host resolver` rule's first column rising when a
  workspace starts, while the `refused` line's stays put.
- **`resolved … but could not fetch …/bin/coder-linux-amd64`:** Caddy,
  Coder, or the firewall's `hcw: https to this host` rule. Start with
  `systemctl status caddy --no-pager` and `sudo docker logs --tail 50 coder`.
- **`reached Coder but not https://github.com/…`:** the firewall's
  `hcw: web egress` rule, or the repository is no longer public. Labs then
  start with empty folders.
- **`the sandbox daemon does not answer`**, **`no hybridcloudworks/hcw-lab
  image is on the sandbox daemon`**, or **`the check's container did not
  run`:** the `coder_sandbox` or `lab_images` role. The message gives the
  command.

Applying the fix restarts the sandbox daemon, which stops every workspace's
container, so a workspace that was stuck stays down until it is started
again: from Coder (stop, then start), or from the lab's page on the site.
Docker gives the new container its nameservers when it starts, now from
the daemon's `dns`.

## Coder workspaces: one running per learner, sign-ins in memory (#954)

Owner decision 2026-10-16. Every template under `lab-host/coder/templates`
carries both, and they reach Coder when the run after the merge publishes
the templates ("After a merge", above). The launcher's half reaches the
host in the same run.

- **One running workspace per learner.** A start is refused while another
  workspace of the same learner may have its container up: its latest build
  is a start that is queued, under way, done or being cancelled, or a stop
  that failed. Stopped workspaces do not count, so a learner keeps one per
  lab, and neither does a start that failed, so a refused start never holds
  the limit itself. The refusal is a precondition on the workspace
  container, checked at plan, so a refused start creates nothing. Coder's
  build log carries `Stop your other lab first: <name>.` In a pane on the
  site, the lab launcher reads that line, says `Only one of your lab
  workspaces runs at a time, and <name> is running. Stop it on the page
  below, and this lab starts.`, the site's toolbar says `Stop your other lab
  to continue`, and Coder's page for that workspace, where Stop is, is in
  the frame. The pane waits for as long as that lab runs (its own autostop
  ends it within the hour), and once it has stopped the launcher starts the
  refused one by itself. The check reads
  `http://127.0.0.1:7080/api/v2/workspaces?q=owner:me` from inside the
  `coder` container, where the provisioner runs Terraform, with the
  learner's own session token, which Coder makes for each start build. It
  runs on a start only, never on a stop, a delete or a template import, and
  it fails closed: when Coder does not answer 200, the start fails with
  `Your lab workspace could not check your other lab workspaces (answer
  <code>). Try again in a minute.`
- **Sign-ins in memory.** The Azure, AWS and Google Cloud CLIs keep their
  sign-ins on a 64 MiB tmpfs at `/tmp/cloud-creds` (uid and gid 65534, mode
  0700, `noexec`, `nosuid`, `nodev`): `AZURE_CONFIG_DIR`, `AWS_CONFIG_FILE`,
  `AWS_SHARED_CREDENTIALS_FILE` and `CLOUDSDK_CONFIG` point there, never at
  the workspace's home volume. The AWS CLI's SSO and assumed-role caches
  have no setting, so every start makes all of `~/.aws` a link into the
  tmpfs. A sign-in ends when the workspace stops, and nothing of it is left
  on disk. On 2026-10-16 neither workspace volume
  on the sandbox daemon held a `.azure`, `.aws` or `.config/gcloud`
  directory, so there is nothing older to clear. One thing still lands on
  the volume, by design: anything a learner writes outside `~/.aws` and
  `/tmp/cloud-creds` by hand.

**Both bind the builds of a template version published with them, and no
other.** A build runs the template version it is given, and Coder Community
gives a start the workspace's own version: the build API without a version
(`coderd/wsbuilder/wsbuilder.go`, `getTemplateVersionID`, "default is prior
version"), and the dashboard's Start and Restart, which send the workspace's
current version (`site/src/api/queries/workspaces.ts`, `startWorkspace`).
The template's "require active version" setting, which would force every
start onto the new version, is Premium, and a workspace's "automatic
updates" setting changes only autostart and the CLI's `coder start`, not
those buttons (`lab-host/coder/README.md`, "Community edition caps"). The
lab launcher does start an outdated workspace on the active version (#911),
so a workspace opened through the site picks both up on its next open. One
that is still on a version from before #954 and is started any other way
(Coder's own Start in the pane's frame) runs without them until that
happens. So once, after the run that publishes the templates:

1. List the workspaces and which are outdated, PowerShell, with a token of
   yours in `$t` (`lab-host/README.md`, "The status token for the site",
   step 1):

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder list --all --column workspace,template,status,outdated; }'"
   ```

   Good is a table with one row per workspace, each `<owner>/<name>`, and an
   `OUTDATED` column. On 2026-10-16 there were two, both the owner's,
   `lab-mde-wsl` and `lab-wslc` on `hcw-lab`.

2. For each row whose `OUTDATED` is `true`: open its lab through the site
   once, which starts it on the active version, then stop it from the
   workspace's own menu in the pane (the lab page's **Your workspace** panel
   says where); or, if its files are not wanted, delete it there. For
   the owner's two those are
   https://hybridcloudworks.com/education/labs/defender-wsl-plugin-walkthrough
   (`lab-mde-wsl`) and
   https://hybridcloudworks.com/education/labs/wsl-containers-walkthrough
   (`lab-wslc`), one at a time. Another learner's outdated workspace
   updates the same way on their next open through the site. Good is the
   same line in step 1 listing no `true` under `OUTDATED` for the owner.
   Template versions published from here on all carry both, so this is
   needed once.

### Checking them

After the run that publishes the templates. Each check is in a browser
signed in to the site; the commands are bash, in the workspace's own
terminal (**Terminal** > **New Terminal** in the editor).

1. **Sign-ins in memory.** Open
   https://hybridcloudworks.com/education/labs/terraform-validate-walkthrough
   and wait for the editor. In its terminal:

   ```bash
   az login --use-device-code
   ```

   Finish the sign-in at the address, and with the code, that it prints.
   Then:

   ```bash
   ls -la /tmp/home/.azure; ls -la /tmp/cloud-creds/azure; grep ' /tmp/cloud-creds ' /proc/mounts
   ```

   Good is `ls: cannot access '/tmp/home/.azure': No such file or
   directory`, then a listing of `/tmp/cloud-creds/azure` that includes
   `azureProfile.json`, then one `tmpfs /tmp/cloud-creds tmpfs
   rw,nosuid,nodev,noexec,relatime,size=65536k,mode=700,uid=65534,gid=65534`
   line. After the workspace stops and starts again, `az account show`
   says to run `az login`.

2. **One running workspace.** With that lab still open and running, open
   https://hybridcloudworks.com/education/labs/ansible-syntax-check-walkthrough
   in another tab, and confirm Coder's dialog if its workspace is new. Good
   is the pane saying `Only one of your lab workspaces runs at a time, and
   lab-tfv is running. Stop it on the page below, and this lab starts.`
   above Coder's page for `lab-tfv`, and the toolbar above the pane saying
   `Stop your other lab to continue`. Press **Stop** there: within a minute
   the pane says `Getting your lab workspace ready.` and then opens the
   editor for the second lab, with no click.

A start that fails with `Your lab workspace could not check your other lab
workspaces (answer <code>)` means Coder answered the read with a client
error: `401` is a session token Coder refused, `403` or `404` a token that
may not list the learner's workspaces. A `5xx`, and a connection nothing
answered, never show that line: the provider tries twice more and then
fails the start with its own `Error making request: GET
http://127.0.0.1:7080/api/v2/workspaces?q=owner:me giving up after 3
attempt(s)` (measured 2026-10-16 with `terraform plan` against a stand-in
answering 500, and with nothing listening). Either way, Coder's page for
the workspace shows the failed build's log with the whole error.

## Portainer through an SSH tunnel

Portainer Business Edition runs for the owner only (owner decision
2026-09-26). It holds the Docker socket, which is root on the host, so it is
published on the host's `127.0.0.1:9443` and nowhere else, with no Caddy
route, and the way to it is an SSH tunnel. Whoever can open the tunnel
already has an SSH login, which carries `sudo`.

It is off until a pull request sets `portainer_enabled: true` in
`lab-host/ansible/group_vars/all.yml` and `bootstrap.sh` runs after the
merge. Success for that run is a `PLAY RECAP` with `failed=0` and the task
`portainer : Say how to reach Portainer` printing `Portainer <version> answers
on https://127.0.0.1:9443 on this host and nowhere else` (the version is
`portainer_image_tag` in `group_vars`).

**The first sign-in.** Two guards stand in front of a fresh Portainer, and
both were measured on the then-pinned 2.45.1 on 2026-09-26 and seen again
on 2.45.2 at the 2026-10-18 rebuild. Until an
administrator exists it stops serving five minutes after it starts: the
container stays up and every request answers `Administrator initialization
timeout`. And creating the administrator needs a one-time **setup token**
that Portainer prints in its log at every start; without it the setup
screen is refused. So open the tunnel first, then restart Portainer and read
the token from inside it. PowerShell, on the desktop; this opens a shell on
the host and the tunnel together, and the tunnel lasts as long as that
shell:

```powershell
ssh -L 9443:127.0.0.1:9443 hcw-lab
```

Bash, in that shell on the host; this opens a new five minutes:

```bash
sudo docker restart portainer
```

Bash, in the same shell; this prints the token of the start that line just
made, as one `setup_token=` line:

```bash
sudo docker logs portainer 2>&1 | grep setup_token | tail -n 1
```

Then open https://localhost:9443 on the desktop. The browser warns about the
certificate, which Portainer generated for itself; for this address that
warning is expected. Paste the value after `setup_token=` where the setup
screen asks for it. The token is good for this one start and is not kept
anywhere. Create the administrator with a password from the password manager,
at least 12 characters (an 11-character one was refused), and keep it there
only. Business Edition then asks for its licence key: the 3 Nodes Free key
Portainer issued. Until a key is entered it reports the licence as not
valid. The key from the pre-reinstall server may be reused, because that
server no longer runs it, and https://www.portainer.io/take-3 issues a new
one. The key goes into this page only, never into the repository or the
Ansible vault. Portainer then offers its environment wizard, where **Get
Started** adds this host's Docker, through the socket, as the environment
`local`; no environment exists before that.

**Since 2026-10-19 the host watches Portainer itself (#1282).** The
`portainer` role's `hcw-portainer-check` reads it on the loopback every 15
minutes with the owner's access token, `GET` only, and reports counts and
states to the Health Hub's **Portainer** card on the **Checks** tab,
<https://hybridcloudworks.com/admin/health?tab=checks>, under Enhanced:
healthy with the version, edition, running count and licence end; degraded
on an unhealthy or restarting container, a running image with an update or
a licence within 30 days of its end; critical when Portainer or its `local`
environment is down, the check itself failed, or no report has arrived for
45 minutes. The card's detail names what the check saw. What the check said
on the host, bash, in the tunnel shell:

```bash
sudo journalctl -t hcw-portainer-check -n 3 --no-pager --output=cat
```

Good ends with a line beginning `hcw-portainer-check: checked:`. The token
and the paste line that seeds it are in `lab-host/README.md`, "The Portainer
check"; until it is seeded the card reads `Portainer has not reported`.

**A Docker upgrade used to leave the card critical (#1328).** Portainer holds
the daemon's socket as a bind-mounted file, so when Docker restarts a
Portainer that was already running keeps the old socket: it answers, but its
`local` environment reads down, the check says `environment local down or not
found`, and the lab alert fires. The 2026-10-21 bootstrap (Docker 29.9.1 to
29.9.2) did exactly that, three runs of the check in a row, until the
container was restarted. The `portainer` role now restarts a Portainer that
started before the daemon's current start, and the run says `Portainer was
restarted onto the daemon's new socket`. If a card still reads critical with
that message after a Docker move, the by-hand cure is, bash, on the host:

```bash
sudo docker restart portainer
sudo systemctl start hcw-portainer-check.service
sudo journalctl -t hcw-portainer-check -n 3 --no-pager --output=cat
```

Good ends with `hcw-portainer-check: checked:` and `environment local up`.

Success is Portainer's **Home** page listing `local`, **Docker Standalone**,
**Up**, whose containers include `portainer`. If the page says the instance
timed out, the five minutes passed first: run the restart line and the token
line again, in the same shell, and use the new token. Once the administrator
exists there is no timeout and no token, and later visits need only the
tunnel line.

## HashiCorp Vault: initialising and unsealing

HashiCorp Vault runs host-native on `127.0.0.1:8200` (owner decision
2026-09-26). **It holds lab-host secrets only.** This host runs learner
workloads, and an escape from a workspace or a job container is root on the
host, which can read an unsealed Vault's memory. So no production
HybridCloudWorks secret is ever put in it: those stay in Azure Key Vault
`kv-site-prod-cus-01`. Nor anything that exists nowhere else, because the
host holds no data of record; every value in it must be one its issuer can
issue again.

It is off until a pull request sets `vault_enabled: true` in
`lab-host/ansible/group_vars/all.yml` and `bootstrap.sh` runs after the
merge. Success for that run is `failed=0` and the task `vault : Say what
state Vault is in` printing `It is not initialised`. The role never
initialises or unseals Vault. Both are the steps below, and the keys they
produce go to the owner's password manager, never to the repository, a
log, an issue, a chat or the Ansible vault.

**Initialise, once.** PowerShell, on the desktop; an interactive login,
because the login shell is what sets `VAULT_ADDR` and `VAULT_CACERT`:

```powershell
ssh hcw-lab
```

Bash, on the host:

```bash
vault status
```

Success is `Initialized false` and `Sealed true`, with exit code 2, which is
what a sealed Vault returns. Then:

```bash
vault operator init -key-shares=5 -key-threshold=3
```

It prints `Unseal Key 1:` to `Unseal Key 5:` and `Initial Root Token:`
once, and Vault keeps no copy: without three of the five keys it stays
sealed for good. Copy each of the six values into the password manager as
it is printed. Success is the line `Vault initialized with 5 key shares and
a key threshold of 3.` Then clear the screen and the terminal's scrollback,
bash, on the host:

```bash
clear && printf '\033[3J'
```

**Unseal, after initialising and after every restart or reboot, under
Shamir keys only.** Which seal the host is on decides this step. Under
Shamir keys (`vault status` shows `Seal Type shamir`), a restart seals
Vault, and so does every reboot, including the nightly idle reboot at 04:30
(`hcw-reboot-when-idle.timer`); until three keys are entered it serves
nothing. Under auto-unseal (`Seal Type azurekeyvault` and `Recovery Seal
Type shamir`), which this host has run since 2026-09-29, a restart or a
reboot, the idle one included, comes back unsealed by itself, and the five
keys are recovery keys that cannot unseal it ("HashiCorp Vault: moving to
auto-unseal", below), so there is nothing to type. Under Shamir keys, bash, on the
host, three times, pasting a different key at each `Unseal Key (will be
hidden):` prompt:

```bash
vault operator unseal
```

It takes no argument on purpose, so no key reaches the shell's history.
Success is `Unseal Progress 1/3`, then `2/3`, then `Sealed false`; `vault
status` then shows `Initialized true`, `Sealed false` and `HA Mode active`.
Rehearsed on 2026-09-26 in a test container with Vault 2.1.1: exactly that
sequence, raft's cluster port opening on `127.0.0.1:8201` only after the
unseal, and `Sealed true` again after `systemctl restart vault`. Auto-unseal
through Azure Key Vault and the Arc machine's identity removes this step
once the owner moves the host to it
([#726](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/726);
the next section).

**The root token.** `vault login` prompts for it, hidden, and writes it to
`~/.vault-token`. Use it for what the host needs, then remove that file with
`rm ~/.vault-token`. Once another way in exists, revoke the root token with
`vault token revoke -self`; a new one takes three unseal (or recovery) keys
and `vault operator generate-root`.

Since Vault 2.0 that endpoint also needs a token (CVE-2026-5807), so with no
token left it answers `403 permission denied`. The way through, done
2026-10-14 for the backup seed, is the configuration switch Vault documents
for it, on for the minutes this takes and reloaded without a reseal. The
same line schedules the switch's removal twenty minutes later, as a transient
systemd timer, so a dropped session cannot leave it on. Bash, on the host,
in an interactive `ssh hcw-lab` shell:

```bash
echo 'enable_unauthenticated_access = ["generate-root"]' | sudo tee -a /etc/vault.d/vault.hcl >/dev/null && sudo systemctl reload vault && sudo systemd-run --quiet --on-active=20min --unit=hcw-generate-root-switch-off --collect /bin/sh -c 'sed -i "/^enable_unauthenticated_access = \[\"generate-root\"\]$/d" /etc/vault.d/vault.hcl && systemctl reload vault' && vault operator generate-root -cancel 2>/dev/null; vault status | grep Sealed
```

```bash
init=$(vault operator generate-root -init -format=json); nonce=$(printf '%s' "$init" | sed -n 's/.*"nonce": *"\([^"]*\)".*/\1/p'); otp=$(printf '%s' "$init" | sed -n 's/.*"otp": *"\([^"]*\)".*/\1/p'); echo "nonce ${nonce:0:8}… otp ${#otp} chars"
```

Then three times, a different recovery key at each hidden prompt, each run
plainly (inside `$( )` the prompt has no terminal and sends an empty key):

```bash
vault operator generate-root -nonce="$nonce"
```

The third prints `Complete true` and an `Encoded Token`, which is useless
without the one-time pad in `$otp`. The attempt is cleared the moment it
completes and `-status` no longer has it, so the next line asks for that
encoded value at a prompt, then decodes it into a variable rather than onto
the screen:

```bash
read -rp 'Encoded Token: ' enc && root=$(vault operator generate-root -decode="$enc" -otp="$otp"); echo "root token ${#root} chars"
```

Use `$root` for what was needed and revoke it in the same line, so no
interruption can fall between the two (the seed, say):

```bash
printf '%s\n' "$root" | sudo /usr/local/sbin/hcw-vault-backup-seed; VAULT_TOKEN="$root" vault token revoke -self; unset root enc
```

Success is the seed's `stored the snapshot token` line and `Success! Revoked
token (if it existed)`. Then switch the endpoint back off, which also stops
the twenty-minute timer, and clear the shell:

```bash
sudo systemctl stop hcw-generate-root-switch-off.timer 2>/dev/null; sudo sed -i '/^enable_unauthenticated_access = \["generate-root"\]$/d' /etc/vault.d/vault.hcl && sudo systemctl reload vault && sudo grep -c enable_unauthenticated_access /etc/vault.d/vault.hcl; unset otp nonce init
```

Success is `0`. The file is back to what the `vault` role renders, so the
next `bootstrap.sh` run reports it unchanged. If the shell is lost partway
(a dropped connection): the switch comes off by itself when the timer fires,
or now with the line above from a new shell, and a `bootstrap.sh` run
renders the file without it too. An attempt left half done is cleared by
`vault operator generate-root -cancel` before a new `-init`. A root token
decoded but neither used nor revoked before the drop is unheld: the next
`generate-root` can find it with `vault list auth/token/accessors` and
`vault token lookup -accessor` (display name `root`, created at that
minute) and revoke it with `vault token revoke -accessor`, before that new
root token is itself revoked.

## HashiCorp Vault: moving to auto-unseal

With auto-unseal, Vault unseals itself at every start with the key
`vault-seal` in the lab-only Key Vault `kv-labhybrid-prod-cus-01`, signing in
as the Arc machine's identity; nothing is stored on the host for it (#726).
**Moving to it is the owner's decision to accept**, because of the trade
recorded in
[ADR 0032, amendment of 2026-09-29](../decisions/0032-learner-labs-platform.md#amendment-2026-09-29-vault-auto-unseal-through-the-arc-identity):
afterwards, root on the host together with the Arc identity can unseal
Vault, which the Shamir keys alone never allowed. The five keys in the
password manager become **recovery keys**. Keep them: they still authorise
`generate-root`, a rekey, and the migration back. They can no longer unseal
Vault, so if Key Vault or the key is unreachable, Vault stays down until it
is back.

Every step below was rehearsed on 2026-09-29 against Vault 2.1.1, the pinned
role and ansible-core, in an Ubuntu 26.04 container with a stand-in for the
Arc agent's challenge flow and for Key Vault. Each prints what is quoted as
its success.

**1. The `hcw-azure` run.** The merge of #726 queues a run that stops at
**planned** at https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs.
Expected: **`Plan: 7 to add, 1 to change, 3 to destroy`**. That is the
permanent `RUNTIME_CONFIG_WRITER` change and three `azapi_*` replacements
(`infra/functionapp.tf`) plus four new resources:
`azurerm_key_vault.lab_hybrid`, `azapi_resource.lab_hybrid_vault_seal_key`,
`azurerm_role_assignment.lab_hybrid_vault_seal[0]` and
`azurerm_monitor_diagnostic_setting.lab_hybrid_key_vault`. Anything else is
not this change; stop and read the plan. Confirm and apply.

**2. Read the grant back.** PowerShell, on the workstation. The first line
finds the application subscription's id and the Arc machine's identity; the
second lists the assignments on the key and says whether each is that
identity:

```powershell
$sub = (az account show --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json).id; $arc = (az resource show --ids "/subscriptions/$sub/resourceGroups/rg-lab-hybrid-prod-cus/providers/Microsoft.HybridCompute/machines/arcs-lab-hybrid-prod-cus-01" -o json | ConvertFrom-Json).identity.principalId
```

```powershell
az role assignment list --scope "/subscriptions/$sub/resourceGroups/rg-lab-hybrid-prod-cus/providers/Microsoft.KeyVault/vaults/kv-labhybrid-prod-cus-01/keys/vault-seal" -o json | ConvertFrom-Json | Select-Object roleDefinitionName, principalType, @{n='isArcMachine'; e={$_.principalId -eq $arc}}
```

Success is exactly one row: `Key Vault Crypto Service Encryption User`,
`ServicePrincipal`, `True`. No row means the apply has not run, or the Arc
machine did not exist when it planned; run it again from the runs page.

**3. On the host.** PowerShell, on the workstation:

```powershell
ssh hcw-lab
```

Every line from here is bash, on the host, one at a time. Vault as it is
now:

```bash
vault status
```

Success is `Seal Type shamir`, `Initialized true` and `Sealed false`.

**4. Turn the switch on for this host.**

```bash
sudo install -d -m 0755 /etc/ansible/facts.d && echo '{"enabled": true}' | sudo tee /etc/ansible/facts.d/hcw_vault_seal.fact
```

Success prints `{"enabled": true}`.

**5. Read the key as the Arc identity, before touching Vault.** Only the
role's seal checks run:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags vault_seal_check
```

Success is `failed=0` and, under `vault : Refuse the seal until the Arc
identity can read a wrap and unwrap key`, the line `The Arc identity reads
kv-labhybrid-prod-cus-01/keys/vault-seal (RSA, wrapKey, unwrapKey).` Vault is
untouched. A refusal names its reason and changes nothing: `Key Vault refuses
the Arc identity` is the grant (wait a few minutes after the apply and run
the line again), `has no key named` is the apply. To stop here for the day
instead, `sudo rm /etc/ansible/facts.d/hcw_vault_seal.fact` puts the host
back as it was.

**6. A cold copy of Vault's data.** Vault stops here and stays stopped until
step 7 starts it:

```bash
sudo systemctl stop vault && sudo tar -C /var/lib -czf /root/vault-before-726.tgz vault && sudo ls -l /root/vault-before-726.tgz
```

Success is one line listing `/root/vault-before-726.tgz`, owned by root. It
is Vault's encrypted storage from before the migration, which the current
keys unseal; keep it until the host has come back unsealed from a reboot.

**7. Write the seal and start Vault on it.**

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh
```

Success is `failed=0` and the task `vault : Say what state Vault is in`
printing `It is sealed for a seal migration`. `vault status` now shows
`Seal Type azurekeyvault`, `Recovery Seal Type shamir`, `Sealed true` and
`Seal Migration in Progress true`.

**8. Migrate, with three of the five keys.** Three times, entering a
different key at each `Unseal Key (will be hidden):` prompt. The command
takes no argument, so no key reaches the shell's history, and the prompt
reads only from a terminal:

```bash
vault operator unseal -migrate
```

Success is `Unseal Progress 1/3`, then `2/3`, then `Sealed false` with
`Seal Migration in Progress true` still shown at that instant.

**9. Wait for the migration to finish.**

```bash
vault status
```

Success is `Seal Type azurekeyvault`, `Recovery Seal Type shamir`,
`Sealed false`, and **no** `Seal Migration in Progress` line. Vault writes
`core: seal migration complete` to its log a moment after the third key.
While the line is still there, run `vault status` again after a second. Do
not restart before it goes: in the rehearsal, a restart 8 milliseconds after
the third key brought Vault back sealed and still migrating, and entering
the three keys again at step 8 finished it.

**10. The test: a restart comes back unsealed by itself.**

```bash
sudo systemctl restart vault && sleep 5 && vault status
```

Success is `Seal Type azurekeyvault`, `Recovery Seal Type shamir`,
`Initialized true` and `Sealed false`, with exit code 0. A later
`bootstrap.sh` run prints `It is initialised and unsealed, and unseals itself
through Azure Key Vault after every restart.`

**If it goes wrong.** Two ways back, both rehearsed:

- **At any point from step 6 on: restore the cold copy**, which the keys
  from before the migration unseal. Bash, on the host, one line at a time,
  then unseal it three times as in the section above:

  ```bash
  sudo rm /etc/ansible/facts.d/hcw_vault_seal.fact
  ```

  ```bash
  sudo systemctl stop vault && sudo find /var/lib/vault -mindepth 1 -delete && sudo tar -C /var/lib -xzf /root/vault-before-726.tgz
  ```

  ```bash
  sudo /opt/hcw-src/lab-host/bootstrap.sh
  ```

  Success is `failed=0`, `It is initialised and sealed`, and after the three
  unseals `Seal Type shamir` and `Sealed false`. Anything written to Vault
  after step 6 is not in the copy.

- **After step 10, with the key still in Key Vault: migrate back to Shamir
  keys.** Bash, on the host. Mark the seal disabled, run step 7's line, and
  run step 8's line three times with three of the same keys (now recovery
  keys, and unseal keys again after this). When `vault status` shows
  `Seal Type shamir` with no migration line, delete the fact with
  `sudo rm /etc/ansible/facts.d/hcw_vault_seal.fact` and run step 7's line
  once more to drop the stanza; that restart seals Vault, so unseal it as in
  the section above:

  ```bash
  echo '{"enabled": true, "disabled": true}' | sudo tee /etc/ansible/facts.d/hcw_vault_seal.fact
  ```

**Afterwards.** Once the seal is on, never run `bootstrap.sh` with
`HCW_REPO_REF` at a commit older than #726: that role knows nothing of the
seal and would write a configuration without it. The role refuses to drop
the stanza itself while Vault's data is under it. Every unwrap is in the
Management workspace as an `AzureDiagnostics` row with the caller's IP
address, from the vault's AuditEvent diagnostic setting. When the owner has
seen the host come back unsealed from a reboot, the cold copy can go:
`sudo rm /root/vault-before-726.tgz`.

## Caddy: reloading by hand

Since #958 Caddy's admin API, which every reload goes through, listens on
the Unix socket `/run/caddy/admin.sock` instead of TCP `127.0.0.1:2019`, and
HTTP/3 is off. Only the `caddy` user and root can open the socket. The
playbook reloads Caddy itself whenever the Caddyfile or a route changes, so
a reload by hand is only for a file edited on the host, which the next
`bootstrap.sh` run puts back. Bash, on the host:

```bash
sudo systemctl reload caddy
```

Success prints nothing and exits 0, and the journal
(`sudo journalctl -u caddy -n 5`) ends with `Reloaded caddy.service - Caddy.`
The unit's reload is this line, run as the `caddy` user, which is the same
thing by hand. Bash, on the host:

```bash
sudo -u caddy /usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
```

A reload that fails with `connect: no such file or directory` on
`/run/caddy/admin.sock` means the Caddy running now was started before the
unit gained its runtime directory, so it is still on TCP 2019. The playbook
restarts it in that case; by hand, bash, on the host (a restart closes open
connections for a few seconds, and panes reconnect):

```bash
sudo systemctl restart caddy
```

After the first `bootstrap.sh` run with #958, these show the move took.
Bash, on the host; the first two print `0` (nothing on TCP 2019, nothing on
UDP 443) and the third a line beginning `s-w-------` owned by `caddy caddy`:

```bash
sudo ss -Hltn 'sport = :2019' | wc -l
sudo ss -Hlun 'sport = :443' | wc -l
sudo ls -l /run/caddy/admin.sock
```

## Tool add-ons

**[ADR 0035](../decisions/0035-addon-pane-model.md), 2026-10-09.** The tool
add-ons are independently built tools the site shows in a pane at
`/tools/<id>`; the lab host runs each as one hardened container,
`hcw-addon-<id>`, from a digest-pinned image, on the loopback behind Caddy at
`<id>.lab.hybridcloudworks.com` (`lab-host/ansible/roles/addons/README.md`).
The first is `migration`, the Azure migration assessment. Three owner steps
turn one on, once; a release afterwards is a digest bump ("Bumping a pin" in
`lab-host/README.md`) and a run.

**1. Create the add-on's human-verification widget** (the `migration`
widget was created on 2026-10-11; its secret key goes into the vault with
the line below before the first bootstrap that deploys the row): one
widget per add-on, separate from the site's own, because the widget is bound
to the add-on's hostname and the add-on verifies the token with its own
secret. The exact page is
`https://dash.cloudflare.com/?to=/:account/turnstile`, **Add widget**, with
the widget name `hcw-addon-migration`, the hostname
`migration.lab.hybridcloudworks.com`, Managed mode and no pre-clearance. The
widget's **Site Key** is public: put it in `addons[].env.AMO_TURNSTILE_SITE_KEY`
of the `migration` row in `lab-host/ansible/group_vars/all.yml` in a pull
request. A new add-on's row starts with the provider's documented test key
`1x00000000000000000000AA`, and the `addons` role refuses to deploy a row
whose environment still carries a test key, because a widget's real secret
rejects the token a test key produces and no upload would ever verify. Then
copy
the **Secret Key** and, with it on the clipboard, set the vault key.
PowerShell:

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_addon_migration_turnstile_secret"
```

Success looks like: one line, `hcw-vault-set: set vault_addon_migration_turnstile_secret
(value not shown). Keys in the vault: …`, and exit 0. The value never
appears on a command line or in output. The `addons` role refuses to start
the container while this key is unset, naming the key and this line.

**2. Write the digest in.** The add-on's `v0.3.2` release prints
`docker.io/hybridcloudworks/img-mo-lab-addon@sha256:…` in its
`publish-images` run summary; the same value, read from the registry.
PowerShell, anywhere with Docker:

```powershell
docker buildx imagetools inspect docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.2
```

The `Digest:` line is the value for `image_digest` of the `migration` row in
`lab-host/ansible/group_vars/all.yml`: for `v0.3.2`,
`sha256:bd3e0a164429984d50382368f9789d47ffa1af48061221041326a0bd0ed35ade`,
read from the registry on 2026-10-25. A row whose digest is empty deploys nothing and
says so.
Merge, then run the playbook as after any merge. PowerShell:

```powershell
ssh hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"
```

Success looks like `failed=0` in the `PLAY RECAP`, the task
`addons : Say what runs` printing `Tool add-ons running: hcw-addon-migration`,
and `privilege_checks` passing its add-on container check. Then the health
read over SSH, PowerShell:

```powershell
ssh hcw-lab "curl -s http://127.0.0.1:18081/api/health"
```

Success looks like a JSON body with `"ok":true`, `"id":"migration"` and a
`"version"` matching the pinned tag without its `v` (`0.3.1`). From outside, the name answers
with the site-only `frame-ancestors` and the add-on's own headers. PowerShell:

```powershell
curl.exe -sI https://migration.lab.hybridcloudworks.com/ | findstr /i "x-addon content-security-policy x-frame-options location"
```

Success looks like `x-addon-id: migration`, a `content-security-policy` whose
`frame-ancestors` names `https://hybridcloudworks.com`, and no
`x-frame-options`; a browser visiting the same address at the top level is
sent to `https://hybridcloudworks.com/tools/migration`.

**3. Open the pane on the site.** The Function App setting
`ADDON_MIGRATION_URL` is a plain Terraform value
(`infra/functionapp.tf`), so the `hcw-azure` apply of the ADR 0035 pull
request sets it; nothing is seeded. Once applied,
`https://hybridcloudworks.com/tools/migration` shows the pane, and
`https://hybridcloudworks.com/admin/integrations?tab=services` (Tool add-ons,
*Migration add-on*, **Test**) answers `Connected: version 0.3.1, edition demo.`
Until the host runs the container, the same page and the status read say the
tool isn't available, which is the truth.

**Kill switches.** `enabled: false` on the row removes that one container
(the name then answers 503 with the site's sentence); `addons_enabled: false`
removes every add-on; unsetting `ADDON_MIGRATION_URL` in Terraform closes the
pane without touching the host. **Rollback** of a release is the previous
digest in the same row and a run. Logs, content-free by the add-on's design,
PowerShell:

```powershell
ssh hcw-lab "sudo docker logs --tail 100 hcw-addon-migration"
```

Restarting or replacing the container drops every in-memory assessment by
design.

### Cloud Crawler: the host steps

Cloud Crawler is the fourth tool add-on: a visitor uploads an export of their
Azure resources and gets a drift check. The first pull request of
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357) put
everything the host needs into this repository: its row in
`lab-host/ansible/group_vars/all.yml` (the `v0.2.0` image, pinned by its
digest, on port 18084), the vault key `vault_addon_cloud_crawler_turnstile_secret`
in the documents, and the Function App setting `ADDON_CLOUD_CRAWLER_URL` (the
address the site's backend reads to find the tool). **Nothing ran until the
four steps below were done.** The owner reported doing the vault check and the
playbook on 2026-10-26 ([a session's note on #1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357#issuecomment-6420765765)
quotes the playbook's `PLAY RECAP`), and HCP Terraform's commit status on the
merge commit of #1411 read Success that day, so the setting is applied. The
steps stay here for the next time this row changes (a new image digest, or a
host that has to be rebuilt). The catalogue said "coming" until a second pull
request flipped it, and that pull request waited for step 4 to succeed, so the
site never said "available" before the container ran. The last check, one real
upload, is [its own section](#cloud-crawler-the-first-real-upload). The pair's
page, [Cloud Crawler](../architecture/app-to-addon/cloud-crawler.md), has the
reasoning.

You need `ssh hcw-lab` to work from your PowerShell prompt ("Connect from a
desktop", above) and `gh` signed in as yourself. Start only after the first
pull request of #1357 has merged, because the Terraform run in the first step
exists only after the merge. Before that run is applied, the status address
answers that the tool is not set up (read on 2026-10-26), which is the right
"before" picture (PowerShell; you should see `{"configured":false}`):

```powershell
curl.exe -s https://api-azure.hybridcloudworks.com/api/public/addons/cloud-crawler/status
```

If you are repeating these steps later, a new image digest needs only steps 3
and 4, a rebuilt host needs steps 2 to 4, and step 1 (Terraform) is needed again
only when the setting itself changes.

**1. Confirm the Terraform run.** Terraform is the tool that builds Azure
settings from the files in `infra/`, and applying is yours to confirm. This run
adds one setting to the Function App. **Applying it restarts the Function App**
(Azure restarts an app whenever one of its settings changes, [Microsoft
Learn](https://learn.microsoft.com/azure/azure-functions/functions-app-settings#app-setting-considerations)):
requests in that moment can fail for a few seconds, and nothing is lost.

   1. Open the runs list for the `hcw-azure` workspace:
      <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>. The newest
      run for the merge of this pull request waits for confirmation.
   2. Read the plan. Under `azurerm_function_app_flex_consumption.hcw` you
      should see one app setting added, named `ADDON_CLOUD_CRAWLER_URL` (the
      page may hide its value). The summary line also carries the standing
      changes every run for this workspace shows (`3 to add, 1 to change, 3 to
      destroy` is the known Azure workaround, not something this change did),
      plus anything else that merged since the last apply. If the plan shows
      anything else being destroyed or changed that you cannot name, stop and
      do not confirm.
   3. For a machine reading of the same plan, start the plan check. It only
      reads, and changes nothing. It is the
      [TFC Plan Check workflow](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/tfc-plan-check.yml),
      and it reads the newest run of the workspace (PowerShell; you should see
      `Created workflow_dispatch event for tfc-plan-check.yml at main`):

      ```powershell
      gh workflow run tfc-plan-check.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
      ```

      Wait about ten seconds so the run exists, then watch it and print the
      page that holds its summary:

      ```powershell
      $id = gh run list --repo saulpatinojr/HCW-HybridCloudWorks --workflow tfc-plan-check.yml --limit 1 --json databaseId --jq '.[0].databaseId'; gh run watch $id --repo saulpatinojr/HCW-HybridCloudWorks --exit-status; gh run view $id --repo saulpatinojr/HCW-HybridCloudWorks --json url --jq .url
      ```

      Open that page. A good result is a summary that begins **Expected** and
      has no line starting `UNEXPECTED`. The command ending without an error
      is not enough on its own: the check finishes green, having read nothing,
      when its token is not set, and the summary then says so. If the `run :`
      line is not the run waiting in sub-step 1, the check did not read this
      plan; read the plan by eye (above) instead.

      For the run of 2026-10-26, one of the `DECLARED` lines read
      `DECLARED  azurerm_function_app_flex_consumption.hcw
      app_settings.ADDON_CLOUD_CRAWLER_URL: (absent) -> "https://cloud-crawler.lab.hybridcloudworks.com"`
      followed by its reason in brackets. That entry is deleted from
      `scripts/assert-expected-plan.mjs` now that the setting is applied. If you
      repeat this step for a change to the setting, add a new entry there first:
      without one, the summary shows an `UNEXPECTED` line for the setting, and
      you should not confirm until the entry is in.

      If it says `UNEXPECTED`, do not confirm; post the line as a comment on
      [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).

   4. Choose **Confirm & apply**. The run ends **Applied** within a minute or
      two. If it ends **Errored**, do not start a new run: post the error on
      #1357, and before anything else read the Function App's settings as the
      [deployment runbook](deployment-runbook.md#4-post-apply-verification)
      says (an apply that wrote the Function App and did not end green can
      leave a keyless `AzureWebJobsStorage` behind). Until the run is
      **Applied**, nothing else in this section can finish.

**2. Check the vault key is there (names only).** The playbook stops at the
add-on check if `vault_addon_cloud_crawler_turnstile_secret` is missing. It is
the secret half of the tool's human-verification widget (the widget
`HCW-CloudCrawler_AddOn`, created by the owner). The owner reported on
2026-10-26 that it is already in the host's vault; no session could read the
host's vault, so this is the check. The command
decrypts the vault on the host and prints only the key names, never a value
(PowerShell):

```powershell
ssh hcw-lab "set -o pipefail; sudo -n /usr/local/bin/ansible-vault view --vault-password-file /etc/hcw/ansible/vault-password /etc/hcw/ansible/vault.yml | grep -o '^vault_addon_[a-z_]*' | sort"; "exit code: $LASTEXITCODE"
```

The `set -o pipefail` makes the whole line fail if the vault cannot be read,
and the last part prints how it ended. You should see four lines, in this order: `vault_addon_cloud_assessment_turnstile_secret`,
`vault_addon_cloud_crawler_turnstile_secret`,
`vault_addon_migration_turnstile_secret` and
`vault_addon_network_assessment_turnstile_secret`, then `exit code: 0`. If you
see an error message (for example `Decryption failed`), no lines at all, or
any exit code other than 0, **stop**: the vault could not be read, so a line
that is not there proves nothing. Do not set any key; post the whole output as
a comment on [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).
Only when the command ended cleanly (`exit code: 0`) and the Cloud Crawler line
alone is missing, put the key in:

   1. Open the widget's page, <https://dash.cloudflare.com/?to=/:account/turnstile>,
      choose the widget `HCW-CloudCrawler_AddOn`, then **Settings**, and copy
      the **Secret key**.
   2. Run this line (PowerShell). It reads your clipboard when you press
      Enter, so paste the line at the prompt first, copy the secret, then press
      Enter. You should see one line, `hcw-vault-set: set
      vault_addon_cloud_crawler_turnstile_secret (value not shown). Keys in the
      vault: …`; the value never appears.

      ```powershell
      (Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_addon_cloud_crawler_turnstile_secret"
      ```

**3. Run the playbook on the host.** It is the same run as after any merge
("After a merge", above), so **it applies everything under `lab-host/` and
`vps-agent/` that has merged since the host's last run, not only this row.**
First read which commit the host last ran from (PowerShell; the file is
readable without `sudo`, and the output is a short piece of JSON holding a
commit hash and a time):

```powershell
ssh hcw-lab "cat /etc/hcw/applied-commit.json"
```

Anything under `lab-host/` or `vps-agent/` that merged after that commit is
applied by this run. A container is replaced only when its image or settings
changed, and a visitor part-way through an assessment on a replaced add-on
loses it, because add-ons keep nothing on disk by design. While the run
rebuilds the add-ons' firewall rules, their human verification briefly
cannot reach its provider, so an upload on any tool in that moment fails and
the visitor tries again. Nothing in this change deletes data; the run's other
work is described under "After a merge". Start it (PowerShell; it takes several
minutes and prints as it goes):

```powershell
ssh hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"
```

Success is a `PLAY RECAP` line for `localhost` with `failed=0`, and the task
`addons : Say what runs` printing `Tool add-ons running: hcw-addon-migration,
hcw-addon-network-assessment, hcw-addon-cloud-assessment,
hcw-addon-cloud-crawler`. If it stops instead:

- `hcw-addon-cloud-crawler needs TURNSTILE_SECRET from the vault key
  vault_addon_cloud_crawler_turnstile_secret, which is not set`: go back to
  the vault-key step (the second step), set the key, check the four names
  again, and run the playbook again. The roles after `addons` (Portainer,
  Vault, backups, the privilege checks, the record of the commit the host
  converged from) did not run, so the second run must finish them.
- A failure at **Verify build provenance attestation before pull** (a signed
  record of which workflow built the image, checked before the image is
  pulled). If the message says it could not reach the transparency log, run the
  playbook once more. If it says the identity does not match, do not work
  around it: post the output as a comment on
  [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).
- A failure at the health wait: the container started and did not answer within
  about a minute. Read its log, which holds no uploaded content (PowerShell):

  ```powershell
  ssh hcw-lab "sudo docker logs --tail 100 hcw-addon-cloud-crawler"
  ```

To take the tool off the host again, set `enabled: false` on the row in a pull
request and run this step again (the kill switch under "Kill switches" in
`lab-host/README.md`); the name then answers the site's "isn't available"
sentence.

**4. Check it from three places.** Each is read-only.

   1. From the host (PowerShell). You should see JSON containing `"ok":true`,
      `"id":"cloud-crawler"`, `"version":"0.2.0"`, `"edition":"lab"` and
      `"azureConnectivity":"disabled-by-design"`:

      ```powershell
      ssh hcw-lab "curl -s http://127.0.0.1:18084/api/health"
      ```

   2. From your own computer, through the internet (PowerShell). The name
      already resolves (the wildcard `*.lab.hybridcloudworks.com`, read from a
      public resolver on 2026-10-26). You should see `x-addon-id:
      cloud-crawler`, a `content-security-policy` whose `frame-ancestors`
      names `https://hybridcloudworks.com`, and no `x-frame-options`. A
      browser visiting the same address at the top level is sent to
      `https://hybridcloudworks.com/tools/cloud-crawler`, which shows the
      tool's page once the catalogue row is flipped and the site is deployed
      (before that, the "coming" page):

      ```powershell
      curl.exe -sI https://cloud-crawler.lab.hybridcloudworks.com/ | findstr /i "x-addon content-security-policy x-frame-options location"
      ```

      The first line of the full answer says `405 Method Not Allowed`. That is
      expected: this command asks with HEAD, which the tool does not answer,
      and the headers you are looking for come back anyway.

   3. Through the site's status address, the answer the second pull request
      waits for. The site remembers an answer, including a failed one, for a
      minute, so run this a minute or more after the playbook has finished
      (PowerShell):

      ```powershell
      curl.exe -s https://api-azure.hybridcloudworks.com/api/public/addons/cloud-crawler/status
      ```

      Success is `{"configured":true,"reachable":true,"version":"0.2.0",
      "edition":"lab",…}` with a list of capabilities that includes
      `upload-evidence`. If you still see `{"configured":false}`, the
      Terraform run (the first step) has not applied, or the Function App has
      not finished restarting: check that the run says **Applied**, wait two
      minutes and run it again. If you see `"reachable":false`, the site's
      backend cannot read the tool: repeat the first two checks above to find
      the side that fails (a name that does not resolve, a certificate error,
      or a container that is not running), then wait a minute before asking
      again.

On 2026-10-26 the third check succeeded and was recorded on [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).
If you repeat these steps, record the result on the ticket for that change. That
day's second pull request flipped the catalogue row, added the tool's address to
the site's frame policy and updated the add-on's integration guide; once it is
merged and the site is deployed, a visitor sees the tool at
<https://hybridcloudworks.com/tools/cloud-crawler>.

**Still not checked by any session:** that the secret in the vault is the right
one for this widget. The playbook only checks that it is not empty, so a wrong
secret passes every check above and fails the first real visitor; [the first
real upload](#cloud-crawler-the-first-real-upload) answers it. **Answered on
2026-10-26:** the container starts, and the name is served with a certificate
the site's backend accepts (the status route and the tool's address both
answered).

**Host memory (read on 2026-10-26 over a read-only connection, nothing changed).**
The host has 15,987 MiB, of which 1,577 MiB were used and 14,409 MiB were
available, with no swap. The eight running containers used about 330 MiB
together (each add-on 26 to 55 MiB against its 512 MiB limit; Coder 60 MiB;
its database 62 MiB). The Cloud Crawler add-on peaked at 269 MiB with three
maximum-size uploads at once in its own test (its pull request,
[HCW-CloudCrawler_AddOn#23](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/pull/23)),
against its 512 MiB limit. The worst case, where every limit is reached at the
same moment (4 x 512 + 5 x 2048 + 2560 = 14,848 MiB of limits, from the capacity
figures in [the labs host architecture](../architecture/labs-host.md) and the
`coder` role), would leave 1,139 MiB for the system; that needs five
workspaces at their 2 GiB limit and every add-on at its limit together and
has not been seen. The playbook has run, so run `ssh hcw-lab "free -m"` now and
again tomorrow, and post both readings on
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357); if
the `available` column is under 4,000 MiB, say so there.

### Cloud Crawler: the first real upload

This is the one check that proves the human check and the secret kept on the
host belong together. (The human check is Cloudflare Turnstile, a tick box that
tells people from scripts. Its public Site Key is published by the tool's page;
its private Secret key is kept in the host's vault.) Every earlier check passes
with a wrong secret, because the add-on only tests that the secret is not
empty, so the first visitor would be the one to find out. Do this once, after
the second pull request of [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357) has merged. You need a normal
browser window on your own computer. The sample export is made up (the
subscription `00000000-0000-0000-0000-000000000001` and names that start with
`hcw-sample` or `hcwsample`), so nothing private is uploaded.

**1. Deploy the site and check the deploy reached it (PowerShell).** The website
is deployed by hand, so merging does not publish it. If a run of the Deploy
Frontend workflow has not finished green since the pull request merged, start
one. You should see `Created workflow_dispatch event for deploy-azure-frontend.yml at main`:

```powershell
gh workflow run deploy-azure-frontend.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
```

The deploy job waits until one of its reviewers approves it for the
`production` environment. Open [the Deploy Frontend runs](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-azure-frontend.yml),
choose the newest run and approve it. When the run is green, run this line. It
asks whether the site's frame policy (the list of other addresses the site is
allowed to show inside its pages) now names the tool. You should see `True`:

```powershell
(curl.exe -sI https://hybridcloudworks.com/tools/cloud-crawler | Out-String) -match 'frame-src[^;]*https://cloud-crawler\.lab\.hybridcloudworks\.com'
```

If you still see `False` a few minutes after a green run, post the output on
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).

**2. Open the page.** Go to <https://hybridcloudworks.com/tools/cloud-crawler>.
If you use a content blocker, pause it for this site, because it can stop the
human check. You should see the heading "Cloud architecture drift check", the
toolbar word "Tool ready" within a few seconds, and inside the frame the heading
"Cloud Crawler" with the badges "Lab edition · no cloud connectivity by design"
and "Not production". The "Check for drift" button is greyed out and the note
beside it says "Add at least one evidence file, or use the sample export."

If you see "This tool isn't available right now." instead, the site's backend
cannot read the tool. Run this line; you should see
`"configured":true,"reachable":true` (the site remembers an answer for a
minute, so wait a minute between tries):

```powershell
curl.exe -s https://api-azure.hybridcloudworks.com/api/public/addons/cloud-crawler/status
```

If the frame shows "Human verification could not load; reload to try again.",
a content blocker is probably stopping the check: pause it and reload. If the
frame is blank, press F12, open the Console tab and post the red line on
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).

**3. Look at the theme.** Do this before the upload, because a reload throws a
result away. Press the light and dark button in the site's header (its label
reads "Switch to Dark Mode" or "Switch to Light Mode"), then reload the page
(F5). The tool inside the frame should follow the site. A button press alone
does not change an open tool, because the page does not reload the frame; the
reload is how the theme reaches it. If the tool is in the other look after the
reload, post which look the site and the tool were in.

**4. Use the sample.** Press **Use the sample export**. A file should appear in
the list under "1. What is built: your evidence". Leave "2. What you decided" on
"Starter decision". Under "3. Check for drift" there is a human-check box. It
may check by itself for a few seconds and then show a tick, or ask you to tick a
box; do that. Until it has a tick, the note beside the button reads "Complete the
human verification to run the check." The "Check for drift" button turns active
once it is ticked.

**5. Run the check.** Press **Check for drift**. Within a few seconds the note
beside the button should read "Done. The result is below." and a "Result"
section should appear, with the "not an audit" line, a summary, a table of
claims, findings, review notes and a draft decision record, then a "Report"
section. ("What "not an audit" means" and the draft decision record are
collapsed lines; click one to open it.) If you see any other message instead,
post it word for word on [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357). If it ends with `(code: ...)`, go to
"If the human check fails" below.

**6. Use the report buttons.** Press **Copy report**. The note under the buttons
should say "Report copied to the clipboard as Markdown." Then open Notepad and
press Ctrl+V: you should see the report text. (The tool has a second way of
copying that can print the same sentence even when the browser refused the
first, so Notepad is the real proof. "Select the report text below and copy it."
means both ways failed: post it.) Then press **Download report (Markdown)**. A
file named `cloud-crawler-report.md` should appear in your browser's downloads.
The note then reads "If the download did not start, use Copy report: downloads
can be blocked inside an embedded pane." That sentence shows even when it
worked, so the file in your downloads is the proof. "The file could not be
downloaded here; use Copy report instead." means downloads were blocked: post it.

**7. Delete the result.** Press **Delete my result now**. The button then reads
"Click again to delete it for good": press it again within six seconds. This
deletes only the made-up result you just created. The result sections should
disappear, and "Your result was deleted." shows beside the "Check for drift"
button, higher up the page.

**8. Say so on [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357).** Steps 1 and 2 are the ticket's "Done when"
(the status address answers and the page frames the tool). Steps 3 to 7 are the
checks nothing earlier could make. Post which steps passed and the exact words of
any that did not.

**If the human check fails** (no tick appears, or step 5 shows a message that
ends with `(code: ...)`), read the code first:

- `(code: invalid-input-secret)` means Cloudflare did not accept the secret kept
  on the host, so it is probably not this widget's secret: go to item 3.
- `(code: invalid-input-response)` or `(code: timeout-or-duplicate)` means the
  tick expired (after about five minutes) or was used twice: reload the page and
  try again. [Cloudflare lists the codes](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
- No tick at all, or "Human verification could not load; reload to try again.":
  go to items 1 and 2.

1. See what the tool publishes to visitors (PowerShell). You should see
   `"turnstile":{"required":true,"siteKey":"0x4AAAAAAFmYfaPCx8djlDfP"}` in the
   JSON. A different key, or `"required":false`, means the row in
   `lab-host/ansible/group_vars/all.yml` is not what the container runs; post the
   line on [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357):

   ```powershell
   curl.exe -s https://cloud-crawler.lab.hybridcloudworks.com/api/health
   ```

2. Open the widget's page, <https://dash.cloudflare.com/?to=/:account/turnstile>
   (type it exactly as written; Cloudflare swaps in your account), and choose
   the widget `HCW-CloudCrawler_AddOn`. Its **Site Key** must be
   `0x4AAAAAAFmYfaPCx8djlDfP`, and its hostnames must include
   `cloud-crawler.lab.hybridcloudworks.com`. If the hostname is missing, add it
   there and repeat steps 4 and 5 above.
3. If both match, the secret on the host is probably the wrong one; the code in
   the message decides. On the widget's page choose **Settings** and copy the
   **Secret key**. Then paste this line at the prompt first and press Enter only
   afterwards: it reads your clipboard when you press Enter. You should see one
   line, `hcw-vault-set: set vault_addon_cloud_crawler_turnstile_secret (value
   not shown). Keys in the vault: …`:

   ```powershell
   (Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_addon_cloud_crawler_turnstile_secret"
   ```

   Copy any other text afterwards so the secret does not stay on your
   clipboard, and never paste the secret into the ticket. Then run the playbook
   again (step 3 of the host steps above) so the container restarts with the new
   secret, and repeat steps 4 and 5 above.

**To close the tool again.** Either unset `ADDON_CLOUD_CRAWLER_URL` in
`infra/functionapp.tf` through a pull request and the owner's Terraform run (the
page then shows "This tool isn't available right now."), or set the catalogue
row back to `coming` through a pull request and deploy the site again.

## Runtime advisories

**Stated 2026-10-07** (#949, estate review LAB-3). The lab host runs
visitors' and learners' code in containers, so the container runtime is the
boundary between that code and the host: runc (which Docker ships inside the
`containerd.io` package), containerd, and Docker Engine. All three are pinned
and held by the `docker` role, so `unattended-upgrades` never moves them, and
every runtime fix reaches the host through a pin bump in
`lab-host/ansible/group_vars/all.yml`, a merge, and a `bootstrap.sh` run.
These are the times that path is held to.

### Response times

The clock starts when the fixed package is in Docker's apt repository for
Ubuntu 26.04 (`download.docker.com/linux/ubuntu`, suite `resolute`), which is
what the host installs from, and stops when `bootstrap.sh` has installed it
on the host.

| Advisory | Fix on the host within | How |
| --- | --- | --- |
| Critical, or a container escape with a public exploit, at any severity | 48 hours | Dispatch the weekly workflow at once (below), merge its pull request, run `bootstrap.sh` |
| High | 7 days | The weekly pull request if it falls inside the 7 days, otherwise a dispatch as above |
| Medium or Low | The next weekly pull request | Merged with that week's bumps, then `bootstrap.sh` |

While a Critical fix is not yet in Docker's repository, the host's own
answer is to stop taking new code: the kill switches in
`lab-host/README.md` ("Kill switches") close sign-ups or stop Coder, and
stopping the `hcw-labs-agent` service stops the public jobs. Reopen when the
fix is installed.

### What runs on its own

- **Every day at 03:00 host time, on the host,** from the playbook run that
  applies LAB-4 (#950): `hcw-playbook-drift.timer` (the `hardening` role) runs
  `ansible-playbook -i inventory/localhost.yml site.yml --check --diff` from
  the applied checkout (`/opt/hcw-src/lab-host/ansible`), before the Coder dump
  (03:30) and the idle reboot (04:30). If any task reports changed or the playbook
  fails, it logs at `daemon.warning` under the tag `hcw-playbook-drift` and exits
  non-zero, triggering `OnFailure=hcw-unit-failed@%n.service` which pages
  `alert-lab-unit-failed`. On a clean run with no drift, it logs at `daemon.notice`
  and exits 0. To run it by hand (bash, on the host):
  `sudo systemctl start hcw-playbook-drift.service; sudo journalctl -t hcw-playbook-drift --since -5min --no-pager`.
- **Every day, on the host,** from the playbook run that applies #986
  (merged 2026-10-07, not yet on the host at the 2026-10-08 review:
  [Labs host, Applied state](../architecture/labs-host.md#applied-state)):
  `hcw-held-upgradable.timer` (the `hardening`
  role, at 07:15 host time) logs one line per held package that apt could
  upgrade, at `daemon.warning` with the tag `hcw-held-upgradable`, which the
  Arc data collection rule ships to the Management workspace as a `Syslog`
  row with that `ProcessName`. No line at warning means nothing held has an
  upgrade waiting; the all-clear line stays on the host at `notice`. Since
  #1172 (LAB-13, #959) the same run also logs `a reboot is pending since
  <date> (<n> days)` at warning while `/var/run/reboot-required` exists,
  dated from the first night the idle reboot saw it (the marker's own time
  moves with every upgrade that rewrites it): the 04:30 reboot (next
  bullet) waits for a night with nobody logged in and no lab job or Coder
  workspace up, so the owner's window is to log out before 04:30, or to
  reboot at a time of their choosing (bash, on the host,
  `sudo systemctl start hcw-reboot-when-idle.service` asks the same
  questions and reboots only when they all come back idle; see the next
  bullet for `sudo reboot`, which asks none); a pending line a week old is
  the sign that neither has happened and a fix that needs the reboot is
  still waiting. An alert on those rows is not built yet: that is PLAT-4's
  work, not this page's.
- **Every day at 04:30 host time, on the host,** from the playbook run that
  applies ask 2 of LAB-13 (#959): `hcw-reboot-when-idle.timer` (the
  `hardening` role) reboots the host for a pending upgrade only when
  `/var/run/reboot-required` exists, logind lists no login session (class
  `user`, or `user-` and a suffix), `docker ps --filter label=hcw.lab-job`
  lists no lab job container up (created, running, paused or restarting),
  and the Coder sandbox daemon (`/run/hcw-coder-docker/docker.sock`, when it
  is there) lists no workspace container up, all asked at the hour itself
  and asked again once the labs agent has confirmed it is idle. Workspaces
  run on that daemon, which the host daemon does not see, and a person
  working in one has no logind session, so without this question a
  workspace in use at 04:30 would be rebooted. Between the two looks the
  script writes `/run/hcw-maintenance/reboot-hold`, and the labs agent
  claims no new job while it holds; once it has no claim in flight and no
  job running, it acknowledges the hold by writing its expiry to
  `/run/hcw-labs-agent/maintenance-ack`. The script waits up to 45 s for
  that acknowledgement (none is needed when systemd says the agent is
  inactive or failed) and defers the night without it, so no job can be
  running or starting at the second look, or between it and the reboot
  (CodeRabbit on #1191, two rounds). unattended-upgrades
  no longer reboots on its own: it asked `users` when the upgrade ran, some
  twenty-two hours before the reboot it then scheduled with no further
  question, and it never asked about jobs. On this host `users` and `who`
  print nothing even with a session open (rust-coreutils reads utmp, which
  systemd no longer writes; measured 2026-10-15), so that check never
  deferred anything. One line per night under the tag
  `hcw-reboot-when-idle`: `rebooting; pending since <date> (<n> days)` and
  the `deferred:` lines at `warning`, shipped as `Syslog` rows; `no reboot
  is pending` at `notice`, on the host. A deferred night tries again the
  next night. **From the seventh day pending, each `deferred:` line is at
  `err` and ends `overdue at 7: log out before 04:30, or reboot at a time
  of your choosing`**: that is the line to act on, by logging out before
  04:30, stopping a workspace left running, or rebooting now. To reboot now
  with every check above, bash, on the host:
  `sudo systemctl start hcw-reboot-when-idle.service`. Good is the host
  going down within about a minute; a `deferred:` line in
  `sudo journalctl -t hcw-reboot-when-idle -n 5 --no-pager` names what is
  still up. `sudo reboot` is an override that asks nothing: it ends any
  login session, a running lab job (reported to its visitor as interrupted,
  LAB-13) and any Coder workspace in use, so use it only when that is
  intended (CodeRabbit on #1191). A run of `deferred: the lab agent did not confirm
  it was idle` nights means the agent has a job that does not end, is
  stuck, or is older than the acknowledgement; bash, on the host,
  `systemctl status hcw-labs-agent --no-pager` and `sudo journalctl -u
  hcw-labs-agent --since -1d` say which. The days count from the first night a run saw the
  marker (kept in `/run/hcw-maintenance/reboot-pending-since`, which a
  reboot clears with the marker), not from the marker's own time, which
  every upgrade that wants a reboot rewrites. It is a row in Log Analytics,
  not a page: no alert rule matches it yet (PLAT-4). An `apt-config`, a
  `loginctl` or a docker daemon that cannot answer fails the unit, and
  `alert-lab-unit-failed` pages (`docs/runbooks/alerting-and-support.md`);
  stopping the unit by hand does not (it exits 143, which the unit counts
  as success). Bash, on the host:
  `journalctl -t hcw-reboot-when-idle --since -7d` is the last week's
  decisions; `lab-host/ansible/roles/hardening/README.md`, item 8, is the
  whole table.

  The run that applies it hands the reboot over in order: it looks for a
  reboot unattended-upgrades already scheduled, installs and enables the
  timer, reads it back active, turns unattended-upgrades' own reboot off,
  and reads back the `Automatic-Reboot` apt itself ends up with, stopping
  if another file in `/etc/apt/apt.conf.d` sets it back on (the message
  gives the line that finds it). A `shutdown -r` that unattended-upgrades'
  log names is cancelled; any other scheduled reboot stops the run before
  anything is written, and the message says what to do (it cannot tell
  unattended-upgrades' `shutdown -r` from root's own for the same minute
  without that log line, so it does not guess). A run that cancels such a
  reboot and then stops before the override leaves that one night with no
  reboot; unattended-upgrades' next daily run schedules it again, and
  re-running `bootstrap.sh` completes the hand-over. Two checks after that run,
  bash, on the host, while logged in over SSH. First, `loginctl
  list-sessions` lists your login with `CLASS` `user` (on 2026-10-15:
  session 384, `hcwadmin`, `user`); that row is what defers the reboot, and
  the `manager` and `manager-early` rows beside it (hcwadmin's service
  manager and hcw-coder-docker's lingering one) do not. Second, `shutdown
  --show` prints `No scheduled shutdown.`.

  **A line that reads `standing down: unattended-upgrades' own
  Automatic-Reboot is on`** means two reboot mechanisms are installed, and
  this one is doing nothing: the host was rolled back to a revision before
  this timer, or a run stopped after enabling it and before writing the
  override. unattended-upgrades is the one rebooting then, as it did before.
  To keep it that way, withdraw the timer. Bash, on the host:

  ```bash
  sudo systemctl disable --now hcw-reboot-when-idle.timer && sudo rm -f /etc/systemd/system/hcw-reboot-when-idle.service /etc/systemd/system/hcw-reboot-when-idle.timer /usr/local/sbin/hcw-reboot-when-idle /run/hcw-maintenance/reboot-hold /run/hcw-maintenance/reboot-pending-since && sudo systemctl daemon-reload && systemctl list-timers hcw-reboot-when-idle.timer
  ```

  Success is a line reading `0 timers listed.` (systemd adds a hint about
  `--all` under it). To have this timer reboot instead,
  run `bootstrap.sh` from a revision that has it; the stand-down stops on
  its own once the override turns `Automatic-Reboot` off. Before rolling
  back on purpose, the same line withdraws it first: until the rollback's
  run turns unattended-upgrades' reboot back on, neither reboots, and after
  it only unattended-upgrades does.

  **What it does not cover, on purpose** (review of #1191):

  - **The handshake with the agent is the agent's own word, and nothing
    more.** The script reboots after an acknowledgement naming its hold,
    which the agent writes only on a tick with no claim in flight and no
    job running, and the second look still asks logind and both daemons.
    It trusts the agent to count its own claims and jobs; the poll tests
    (`vps-agent/lib/poll.test.js`) are what hold it to that. Without an
    acknowledgement in 45 s it defers, so the failure modes are a night
    without a reboot, never a reboot through a job.
  - **The first `bootstrap.sh` that applies this.** `site.yml` runs the
    `hardening` role, which enables the timer, before the `labs_agent`
    role restarts the agent with the code that acknowledges the hold. The
    old agent, until then, never acknowledges, so a 04:30 inside that one
    run defers the night instead of rebooting: safe, and the next night
    asks again with the new agent. Starting `bootstrap.sh` near 04:30 is
    therefore safe.
  - **unattended-upgrades scheduling during the run.** The check for a
    reboot unattended-upgrades already scheduled runs before the override
    turns its reboot off. If its daily run fires in the minutes between
    the two, it can schedule one more `shutdown -r` for 04:30, which fires
    without either question. The second check after the run, `shutdown
    --show` printing `No scheduled shutdown.`, is what catches it; bash, on
    the host, `sudo shutdown -c` cancels it.
- **Tuesdays 05:20 UTC:** `publish-lab-image.yml` rebuilds the lab images and
  publishes them only when the `full` image's Debian packages moved; each
  publish opens the `chore/lab-pins-image-digests` pull request.
- **Tuesdays 06:45 UTC:** `lab-supply-chain.yml` compares every lab host pin
  with its publisher, opens or updates the `chore/lab-pins-host` pull
  request with each behind pin moved and its checksum or digest beside it,
  proposes the newest lab image base digest and ansible-core's newest
  release in its line (every wheel's hash read from PyPI) as
  `chore/lab-pins-image-base`, proposes the newest release of each tool and
  Terraform provider baked into the lab images (Terraform, kubeconform,
  Helm, kubectl, the Azure CLI; azurerm, azapi, alz, random, modtm, time),
  each with the publisher's checksum, as `chore/lab-pins-image-tools`,
  scans the two published lab images with
  Trivy, and opens or comments on one issue when anything is due,
  including any pin it could not move because the publisher served no
  checksum to verify it against. `bootstrap.sh` installs the host's own
  ansible-core from the same `lab-image/versions.env` lines with every
  wheel hash-checked, so a merged ansible-core move reaches the host on the
  next run, which prints `ansible-playbook [core <that release>]` before
  the play.

### What the owner does

**Watch the three projects' advisories**, once: on each page below,
**Watch** → **Custom** → **Security alerts**.

- https://github.com/opencontainers/runc/security/advisories
- https://github.com/containerd/containerd/security/advisories
- https://github.com/moby/moby/security/advisories

**For a 48-hour advisory, start the weekly run now.** PowerShell:

```powershell
gh workflow run lab-supply-chain.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
```

Success is no output and exit code 0. About five minutes later the pull
request is open or updated; this lists it, and a successful result is one
row whose branch is `chore/lab-pins-host`:

```powershell
gh pr list --repo saulpatinojr/HCW-HybridCloudWorks --head chore/lab-pins-host
```

No row, and the run's summary saying the `containerd.io (carries runc)` row
is `current`, means Docker has not published the fix for 26.04 yet: the
kill switches above apply until it has.

**Merge it** when its checks are green (a session merges on green, per
`.claude/CLAUDE.md`). Its body names every value it moved and where each
checksum was read.

**Install it.** PowerShell:

```powershell
ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"
```

A good run ends with a `PLAY RECAP` line for `localhost` showing `failed=0`
and `unreachable=0`. The package upgrade restarts the Docker daemon, which
stops running workspaces and jobs; they start again on the next visit.

**Check what runs.** PowerShell:

```powershell
ssh hcw-lab "dpkg-query -W docker-ce containerd.io && runc --version"
```

Success is the versions the pull request named, and runc's own version from
the `containerd.io` package. Then the daily report, run now. PowerShell:

```powershell
ssh hcw-lab "sudo systemctl start hcw-held-upgradable.service && sudo journalctl -t hcw-held-upgradable --since -5min --no-pager"
```

Success is a line `no held package is upgradable: ...` (or warning lines
only for packages the advisory did not concern). A warning line naming
`containerd.io` or `docker-ce` means the run installed an older version
than Docker now offers: the weekly pull request is behind again, and the
next dispatch moves it.

The hand procedure behind all of this, for a pin the workflow cannot move,
is `lab-host/README.md`, "Bumping a pin".

## Arc onboarding

**State: not yet run.** The Terraform half is in `infra/lab-hybrid.tf` and the
host half is the `arc` role in `lab-host/ansible/`, which does nothing until
the host's arc fact is set (below). Onboarding is two runs of one script,
`scripts/lab/Register-LabArc.ps1`, on the workstation, with one `hcw-azure`
run between them: the first run (step 2) prepares the identity and the
secret and prints what to set in the workspace, the owner sets it and
confirms the run (step 3), and the second run, with `-Connect` (step 4),
connects the host, removes the credential and adds the monitoring. When the
read-back in step 4 first returns Connected, change the Arc rows in
[Labs host](../architecture/labs-host.md) and the Arc rows of
[Required inputs §4.7](../standards/required-inputs.md#47-vps-agent-hostinger-env-never-committed)
in the same pull request.

## What each side owns

| Piece | Where | Created by |
| --- | --- | --- |
| Resource group `rg-lab-hybrid-prod-cus` | `infra/lab-hybrid.tf` | `hcw-azure` apply |
| Data collection rule `dcr-lab-hybrid-prod-cus`: heartbeat, `auth`/`authpriv` syslog at Info and above, into `log-plat-prod-cus-01` | `infra/lab-hybrid.tf` | `hcw-azure` apply |
| Onboarding service principal `sp-arc-onboarding-lab-hybrid-prod-cus`: single tenant, no role of its own | Entra | The first run, step 2 (the run identity has no Entra role) |
| Its client secret | Entra, and the host's Ansible vault as `vault_arc_service_principal_secret` beside the three identifiers | Minted by the first run, valid 24 hours; deleted from both by `-Connect` once the host is Connected |
| Its only grant, Azure Connected Machine Onboarding on the group | `infra/lab-hybrid.tf`, once `arc_onboarding_principal_id` is set | `hcw-azure` apply, step 3 |
| The run identity's Resource Policy Contributor on the group, so Terraform can write the policy assignment | Azure RBAC | The first run, step 2 (Terraform does not grant itself rights) |
| Audit-only Linux baseline assignment `audit-linux-baseline-lab-hybrid` | `infra/lab-hybrid.tf`, once `lab_hybrid_policy_enabled` is true | `hcw-azure` apply, step 3 |
| The arc fact `/etc/ansible/facts.d/hcw_arc.fact` | The host | `-Connect`, step 4 |
| Arc machine `arcs-lab-hybrid-prod-cus-01` | Azure, created by `azcmagent connect` | The `arc` role, in the `bootstrap.sh` run `-Connect` starts |
| Azure Monitor Agent extension and the rule's association to the machine | Azure | `-Connect`, step 4 (neither can exist before the machine does) |

Defender for Servers stays off. Nothing here, in Terraform or on the host,
enables it.

## Why the switch is on the host

`arc_enabled` in `lab-host/ansible/group_vars/all.yml` is not a literal: it
is true exactly when `/etc/ansible/facts.d/hcw_arc.fact` on the host is JSON
whose `enabled` is `true`, which Ansible reads as the local fact
`ansible_local.hcw_arc` whenever it gathers facts. `-Connect` writes that
file, and nothing else does. The switch belongs to the host installation
because Arc membership does. A rebuilt host is not onboarded whatever the
repository says, and a repository-wide `arc_enabled: true` would stop every
rebuilt host's first `bootstrap.sh` run at the role's fail-closed check,
before any role after `arc` had run. Kept on the host, the flag can go on
from the one command that also connects, with no pull request, and a
rebuilt host comes up without it. The file stays, so every later run keeps
the Connected host's agent at the pin in `group_vars`. A file that is
missing, is not JSON, or says anything but `"enabled": true` reads as off,
which was checked on Ubuntu 26.04 with the pinned ansible-core 2.21.4: with
no file every `arc` task is skipped, and with it the role installs the agent
and stops at its vault check when the vault is empty.

## Before you start

- This change is merged to `main`, and the host has been provisioned and has
  run `bootstrap.sh` at least once (`lab-host/README.md`, "First run"), so
  the vault password `/etc/hcw/ansible/vault-password` exists.
- The host has the vault helper `/usr/local/sbin/hcw-vault-set`, which
  `bootstrap.sh` installs (the `vault_tools` role): it takes a value on
  standard input and sets one key in the Ansible vault, printing no value.
  The script writes the four `vault_arc_*` keys only through it, and stops
  before minting anything when it is missing.
- This desktop reaches the host: `ssh hcw-lab hostname` prints its name
  ("Connect from a desktop", above).
- You can create app registrations in the tenant (Application
  Administrator, Cloud Application Administrator or Global Administrator)
  and grant roles on `rg-lab-hybrid-prod-cus` (Owner, User Access
  Administrator or Role Based Access Control Administrator there).
- The host runs Ubuntu 26.04 LTS on x86-64 (owner decision 2026-09-26).
  Microsoft Learn lists Ubuntu 26.04 on x86-64 (not Arm64) as supported for
  [Arc-enabled servers](https://learn.microsoft.com/azure/azure-arc/servers/prerequisites#supported-operating-systems)
  and Ubuntu 26.04 LTS as supported by the
  [Azure Monitor Agent](https://learn.microsoft.com/azure/azure-monitor/agents/azure-monitor-agent-supported-operating-systems),
  both read 2026-09-26, so there is no support gap. The `arc` role installs
  `azcmagent` from `packages.microsoft.com/ubuntu/26.04/prod`, which
  Microsoft signs with `microsoft-2025.asc` rather than the older
  `microsoft.asc`; the role picks the key, and its pinned checksum, by
  release.
- `az` is signed in to the tenant. The script checks, and prints this line
  when it is not; a browser opens:

```powershell
az login --tenant saulpatinojrhotmail.onmicrosoft.com
```

## 1. Confirm the merge run in hcw-azure

The merge creates a run that stops at **planned** at
`https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs`. Every plan in
this workspace carries the permanent apply-cycle diff (the
`RUNTIME_CONFIG_WRITER` change and three `azapi_*` replacements,
`infra/functionapp.tf`), so the counts below include it.

- Expected: **`Plan: 4 to add, 1 to change, 3 to destroy`**. The one real
  line is `azurerm_monitor_data_collection_rule.lab_hybrid will be created`.
- If `rg-lab-hybrid-prod-cus` has never been applied (the #664 change),
  expect **`Plan: 6 to add, 1 to change, 3 to destroy`**: the rule plus
  `azurerm_resource_group.lab_hybrid` and
  `azurerm_role_assignment.func_lab_hybrid_reader`.

Anything else is not this change; stop and read the plan. Confirm and apply.
Then check the group exists; success prints `true`:

```powershell
az group exists -n rg-lab-hybrid-prod-cus --subscription sub-app-site-prod-cus
```

The script checks the same and stops, pointing here, when the group is
missing.

## 2. The first run

PowerShell, from the repository root on `main` once this change has merged
(`Test-Path scripts/lab/Register-LabArc.ps1` prints `True` when the working
tree has the script):

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1
```

Adding `-WhatIf` to that line shows what it would do and changes nothing:
Entra, Azure and the host are only read.

**What it does**, printing one line per step:

1. Checks `az` is signed in to the tenant, resolves `sub-app-site-prod-cus`
   to its id by name, and checks `rg-lab-hybrid-prod-cus` exists there.
2. Reads the host over `ssh hcw-lab`: whether `azcmagent` is installed and
   Connected, whether the arc fact is set, whether the vault helper is
   there, and which `vault_arc_*` keys the vault holds. Names only: the
   three identifiers are GUIDs and are compared, and the secret is only
   checked against the first characters Entra shows for it, on the host.
3. Finds or creates the app registration and service principal
   `sp-arc-onboarding-lab-hybrid-prod-cus`: single tenant, no credential, no
   role. It prints the service principal's **object id**, the value
   Terraform needs; the application id is a different GUID, the one
   `azcmagent` signs in with.
4. Grants the Terraform run identity `id-plat-terraform-prod-cus-01`
   **Resource Policy Contributor** on `rg-lab-hybrid-prod-cus` only, unless
   it holds it or the audit policy assignment already exists. Contributor
   excludes `Microsoft.Authorization/*/Write`, so without this the apply in
   step 3 fails on `policyAssignments/write`. Never on the subscription,
   where the IaC repository standard forbids a workload repository
   assigning policy.
5. Unless the host is already Connected, mints a client secret valid for 24
   hours (`az ad app credential reset --append --end-date`, so no other
   credential is touched) and writes it into the vault through
   `hcw-vault-set` as `vault_arc_service_principal_secret`, with
   `vault_arc_service_principal_id`, `vault_arc_tenant_id` and
   `vault_arc_subscription_id`. The secret goes from `az`'s output into a
   variable and from there to `ssh`'s standard input, and the variable is
   cleared: it is never shown, never written to a file on the desktop and
   never on a command line. It then reads the vault back, and deletes the
   secret from Entra again if the vault does not hold it. A second run
   keeps a secret it finds in the vault while it has an hour left, and
   deletes any other secret on the registration before it mints.
6. Checks whether `hcw-azure` has applied the onboarding grant and the
   audit policy assignment, and for each that is missing prints the
   workspace variable to set, the address to set it at, and the plan to
   expect (step 3).

**Should `lab_hybrid_policy_enabled` be on? Yes.** ADR 0032 decision 3 makes
machine configuration audit only, not absent; #663 is done only when "the
policy assignment shows a compliance state"; and the labs page reads the
machine's compliance. The script prints the variable whenever the
assignment is missing and the run identity can write it.

*2026-10-07:* the `arc` role turns guest configuration off on the Arc agent
(owner decision, ADR 0032 amendment of that date; #984). From the playbook
run that applies it, the assignment has no agent on the host to evaluate it
and cannot produce a compliance state. That run had not happened at the
2026-10-08 review, when Arc still reported `guestConfigurationEnabled:
"true"` (#1009; [Labs host, Applied state](../architecture/labs-host.md#applied-state)).
The public estate card counts the baseline as not applicable to the lab
rather than as a failure (`NOT_APPLICABLE_POLICIES` in
`functions/src/lib/labs/estate.js`). The answer above stands as written
until the owner decides on #952 whether to keep the switch, remove the
assignment, or turn guest configuration back on.

**What success looks like.** The run ends with the two variables, the plan
to expect and the `-Connect` line, then `Changed:` naming what it did, and
exits 0. A second run changes nothing and says `No changes:`. If
`id-plat-terraform-prod-cus-01` cannot be found by its exact name, the run
says so, leaves the policy variable out, and onboarding goes ahead without
it; grant the role on the group by hand later and run the script again, and
it prints the variable then.

## 3. Set the workspace variables and apply

The first run prints the values; they go at
`https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables`, each with
**+ Add variable**, category **Terraform variable** (not Environment
variable), **Sensitive** unticked. If one already exists, edit it to the
printed value.

| Key | Value | HCL |
| --- | --- | --- |
| `arc_onboarding_principal_id` | the **object id** the first run prints, lower case | off |
| `lab_hybrid_policy_enabled` | `true` | on |

Then start a run from `https://app.terraform.io/app/hcw/workspaces/hcw-azure`
with **New run**, type **Plan and apply**.

- Expected: **`Plan: 5 to add, 1 to change, 3 to destroy`**, or 4 to add if
  the run printed only one variable. The real lines are
  `azurerm_role_assignment.arc_onboarding[0] will be created` and
  `azurerm_resource_group_policy_assignment.lab_hybrid_linux_baseline[0]
  will be created`; the rest is the permanent diff.

Anything else is not this change: discard the run and read the plan.
Otherwise confirm and apply. An apply that fails with `AuthorizationFailed`
on `policyAssignments/write` means the grant from step 2 has not reached
Azure yet: wait a minute and start another run.

Read back: run the first run's line again. Success is
`Azure: sp-arc-onboarding-lab-hybrid-prod-cus holds Azure Connected Machine
Onboarding on rg-lab-hybrid-prod-cus, applied by hcw-azure. Nothing to set
there.` and `No changes:`.

## 4. The second run: connect, remove the credential, add the monitoring

PowerShell, from the repository root:

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1 -Connect
```

`-WhatIf` works here too: the vault removal runs in check mode on the host
and `bootstrap.sh` does not run.

**What it does:**

1. The first run's checks, then, read only, that the service principal
   holds Azure Connected Machine Onboarding on the group. Without it, it
   prints step 3's variables and stops.
2. When the host is not Connected: stops if a machine resource
   `arcs-lab-hybrid-prod-cus-01` is left from an earlier host (it prints the
   `az resource delete` line that removes it); makes sure a live secret is
   in the vault, minting a new one if the first run's has expired or has
   less than an hour left; writes the arc fact; runs
   `sudo /opt/hcw-src/lab-host/bootstrap.sh`, whose output it shows; and
   waits for `azcmagent` to report Connected. If the host does not connect,
   it removes the fact it wrote, so later `bootstrap.sh` runs are not
   stopped at the `arc` role, and stops with the reason.
3. Once Connected, deletes every client secret on the registration and the
   four `vault_arc_*` keys from the vault (decrypted into a root-only
   temporary directory, those keys dropped, every other key checked to be
   exactly as it was, re-encrypted, decrypted again and compared, moved into
   place), and reads both back empty. ADR 0032: the credential is never on
   the host after onboarding. The principal and its grant stay; without a
   credential they cannot be used, and re-onboarding needs only a new
   secret. The `arc` role needs none of the four keys on a Connected host.
4. Installs the Azure Monitor Agent extension (`AzureMonitorLinuxAgent`,
   publisher `Microsoft.Azure.Monitor`, automatic upgrade on) and waits for
   it to succeed, then associates `dcr-lab-hybrid-prod-cus` with the
   machine as `dcra-lab-hybrid-prod-cus`. Both are Azure-side and need the
   machine, which is why neither is in Terraform; both are needed, because
   an association made outside the portal's rule wizard does not install
   the agent, and an agent with no rule collects nothing. Each is left alone
   when it is already there. Both use `az rest`, so no `az` extension is
   installed.

**What success looks like.** The run ends with

```text
Arc: arcs-lab-hybrid-prod-cus-01 is Connected in rg-lab-hybrid-prod-cus, the onboarding secret is gone from Entra and the vault, and the Azure Monitor Agent sends to dcr-lab-hybrid-prod-cus.
```

and exits 0. A second run changes nothing and says `No changes:`. Exit 2
means the host is Connected and the credential is gone, but the extension or
the association is not finished; the run says which, and `-Connect` again
picks up from there. Exit 1 is a stop with its reason, before anything after
it changed. Read back from Azure, PowerShell:

```powershell
az connectedmachine list -g rg-lab-hybrid-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json | Select-Object name, status, agentVersion, osName
```

Success is **one row**: `arcs-lab-hybrid-prod-cus-01`, `status`
**Connected**, `agentVersion` `1.68.03532.1399` (the pin in
`group_vars/all.yml`), `osName` `linux`. The first `az connectedmachine`
command offers to install the `connectedmachine` CLI extension; accept it.
On the host, bash:

```bash
sudo /opt/azcmagent/bin/azcmagent show
```

prints `Agent Status : Connected`, `Resource Name : arcs-lab-hybrid-prod-cus-01`
and `Resource Group Name : rg-lab-hybrid-prod-cus`.

| The run says | What it means | What to do |
| --- | --- | --- |
| `does not hold Azure Connected Machine Onboarding` | Step 3 has not been applied | Step 3, then `-Connect` again |
| `a machine resource arcs-lab-hybrid-prod-cus-01 already exists` | It is left from an earlier host, and `azcmagent connect` cannot take it over | Run the `az resource delete` line it prints, then `-Connect` again |
| `hcw-vault-set is not on hcw-lab` | The helper is missing, so nothing was minted | Run `bootstrap.sh`: its `vault_tools` role installs the helper (`lab-host/README.md`, "The vault"). Then run again |
| `The arc role did not run: azcmagent is not installed` | The play stopped before `arc`, or the commit `bootstrap.sh` ran predates `arc_enabled` reading the fact | The `PLAY RECAP` above names the task; `bootstrap.sh` runs current `main` |
| `AZCM0041` with `invalid_client` in the role's output | A wrong secret or application id in the vault | Run the first run (it replaces the secret), then `-Connect` |
| `AuthorizationFailed` in the role's output | The grant has not reached Azure yet | Wait two minutes, then `-Connect` again |
| `did not reach Succeeded` for the extension | The Azure Monitor Agent failed to install | The portal address it prints shows the extension's status message; fix, then `-Connect` again |

## 5. Confirm the heartbeat, the syslog and the compliance state

The Management workspace is read by its customer id, computed here:

```powershell
$wsId = (az monitor log-analytics workspace show -g rg-mgmt-plat-prod-cus -n log-plat-prod-cus-01 --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId
```

```powershell
az monitor log-analytics query --workspace $wsId --analytics-query "Heartbeat | where TimeGenerated > ago(15m) | where _ResourceId contains 'arcs-lab-hybrid-prod-cus-01' | summarize beats = count(), latest = max(TimeGenerated) by Computer, Category" -o table
```

Success is one row, `Category` `Azure Monitor Agent`, with `beats` near 15:
the agent writes one a minute to every workspace an associated rule names.
Allow ten minutes after step 4 for the first. The syslog, allowing an hour
for an SSH login to have happened:

```powershell
az monitor log-analytics query --workspace $wsId --analytics-query "Syslog | where TimeGenerated > ago(1h) | where _ResourceId contains 'arcs-lab-hybrid-prod-cus-01' | summarize count() by Facility" -o table
```

Success is rows for `auth` and/or `authpriv` and **no other facility**; a
third facility means the rule has been changed outside Terraform.

The compliance state. The first evaluation of a machine-configuration
assignment can take several hours; this asks for one now:

```powershell
az policy state trigger-scan -g rg-lab-hybrid-prod-cus --subscription sub-app-site-prod-cus --no-wait
```

```powershell
az policy state list -g rg-lab-hybrid-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json | Select-Object policyAssignmentName, complianceState, timestamp
```

Success is a row for `audit-linux-baseline-lab-hybrid` whose
`complianceState` is `Compliant` or `NonCompliant`. Either is a result: the
assignment audits and never remediates, and a `NonCompliant` host lists its
failing baseline rules at
`https://portal.azure.com/#view/Microsoft_Azure_Policy/PolicyMenuBlade/~/Compliance`
under that assignment. No row yet means the evaluation has not run.

**Done when** step 4's read-back shows one Connected row, the Heartbeat
query returns the host, and the compliance query shows a state for it (the
#663 acceptance).

## Disconnecting

Disconnecting deletes the machine resource, and with it the rule
association and the guest assignment the policy created. Do it in this
order, or the next playbook run fails closed looking for a credential that
step 4 deleted.

1. Turn the switch off on the host by removing the arc fact. Bash, on the
   host; with the file gone, the `arc` role touches nothing on the next run:

   ```bash
   sudo rm -f /etc/ansible/facts.d/hcw_arc.fact
   ```

2. Remove the agent extension, then the machine resource. PowerShell; each
   asks for confirmation:

   ```powershell
   az connectedmachine extension delete --name AzureMonitorLinuxAgent --machine-name arcs-lab-hybrid-prod-cus-01 -g rg-lab-hybrid-prod-cus
   ```

   ```powershell
   az connectedmachine delete -g rg-lab-hybrid-prod-cus -n arcs-lab-hybrid-prod-cus-01
   ```

3. Reset the agent on the host. `--force-local-only` because the Azure
   resource is already gone and the onboarding principal cannot delete one
   (its role has no delete). Bash, on the host:

   ```bash
   sudo /opt/azcmagent/bin/azcmagent disconnect --force-local-only
   ```

Success: step 4's read-back returns no rows, and
`sudo /opt/azcmagent/bin/azcmagent show` on the host prints
`Agent Status : Disconnected`. The package stays installed and held; remove
it with `sudo apt-mark unhold azcmagent && sudo apt-get purge -y azcmagent`
(bash, on the host) only if the host is leaving Arc for good.

## Re-onboarding a rebuilt host

A rebuilt host has no arc fact and no Arc identity, so its first
`bootstrap.sh` run leaves Arc alone and completes. The machine resource of
the old host blocks the new one: delete it first (step 2 of
"Disconnecting"), or let `-Connect` stop and print the one line that does.
Then run step 2 and step 4 again. The principal and its grant are still
there, so the first run only mints a new secret and says `Nothing to set
there`, and `-Connect` onboards the new host.

Both steps reach the host over `ssh hcw-lab` on port 22, with the direct
block (`Connect-Lab.ps1` without `-Arc`). SSH is open for them: the
hardening role closes port 22 at ufw and binds sshd to the loopback only
while Arc SSH is ready (#953 stage 3, #1257). Until `-Connect` has
onboarded the agent, each run says `Port 22 stays open to the internet on
this run, and sshd listens on every address`. The first `bootstrap.sh` run after
onboarding closes it, so before that run make Arc SSH work for the new
machine: the `hcw-azure` run that recreates its connectivity endpoint and
SSH service configuration, then `Connect-Lab.ps1 -Arc` and its test (steps
1, 4 and 5 of "Connect through Azure Arc"). Run that `bootstrap.sh` through
Arc. The role reads only the agent's side, so it cannot tell whether the
endpoint exists in Azure.

## Troubleshooting

- **`Expired`** in step 4's read-back: the agent has not reached Azure for
  45 days and its identity certificate is gone. Disconnect
  ("Disconnecting", all three steps) and re-onboard.
- **`Disconnected`** in step 4's read-back with the agent running: outbound
  443 to Azure is blocked somewhere. Bash, on the host:
  `sudo /opt/azcmagent/bin/azcmagent check --location centralus` names the
  endpoint that fails.
- **No Heartbeat rows** with the extension `Succeeded`: the association is
  missing (run `-Connect` again; it adds one that is not there), or the rule
  and the workspace are in different regions. Both are `centralus` by
  construction: the rule takes the workspace's location in
  `infra/lab-hybrid.tf`.
- **A later `bootstrap.sh` run stops at `arc : Refuse to onboard without the
  four Arc vault values`**: the arc fact is set but the host is not
  Connected, which a failed `-Connect` does not leave behind (it removes the
  fact it wrote). Run `-Connect` again, or turn the switch off (step 1 of
  "Disconnecting").
