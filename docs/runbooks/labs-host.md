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
accepts inbound 22, 80 and 443 only, and the site's one view of it is the read-only
status proxy in the Function App ([Labs host, Exposure](../architecture/labs-host.md#exposure)).
SSH from a desktop is the only shell. When SSH is not working, hPanel's
**Web Console** is the break-glass: https://hpanel.hostinger.com/vps,
**Manage** on the server, then **Web Console** on its overview. It usually
signs in by itself; when it asks, Hostinger's instructions are `root` and
the root password.

**Whether the Web Console goes through sshd is unverified (#953).**
Hostinger's own page says the session "functions exactly like a standard
SSH connection"
([How to use the Hostinger VPS Web Console](https://www.hostinger.com/support/how-to-use-the-web-console-in-hostinger/)).
If it is an SSH login as root, `PermitRootLogin no`, `AllowUsers hcwadmin`,
publickey only and root's empty `authorized_keys` would all refuse it, and
the break-glass would be gone. What is known (read on the host
2026-10-16): root login over SSH has been off since 2026-09-26, the journal
shows no SSH login as root and no console login since then, and a getty
runs on `tty1` and on the serial port `ttyS0`, which a VNC or serial
console would use. None of that proves which one hPanel uses, so the owner
checks it before and after the first run below.

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
   the break-glass has to be settled before port 22 closes.

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
SSH**, and port 22 then closes to the internet, in a later change. Arc SSH
carries the session through a relay the host's Arc agent dials out to, so
sshd needs no open port; sshd still asks for the same pinned key. Until
port 22 closes, the direct block above keeps working, and running the script
without `-Arc` puts it back.

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

Port 22 closes only after step 5 here and those console checks have both
succeeded, in a later change, which also makes the SSH login alert (#953)
page on any accepted login that did not come through Arc.

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
   printed; `infra-lab/README.md`, step 6). Reinstalling wipes the disk: the
   Ansible vault on the host, Portainer's data and Vault's data go with it.
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
   server's host name.
6. **First run**: `infra-lab/README.md`, step 7. Success is `host check: no
   other workloads found` near the top (above), and, because there is no
   vault yet and Coder is on (since 2026-09-28), a `PLAY RECAP` for
   `localhost` with `failed=1` at `coder : Refuse to enable Coder without
   its three vault secrets`. Every role before it has run, so root login is
   off and `hcw-vault-set` is installed; the re-run in step 7 finishes the
   rest. Run `Connect-Lab.ps1` again without `-User root`.
7. **Everything the disk held, again.** Create the Ansible vault's
   password and set its keys (`lab-host/README.md`, "The vault"), rotating
   the values marked "rotate on every host rebuild" in
   [Required inputs §4.7](../standards/required-inputs.md#47-vps-agent-hostinger-env-never-committed)
   (the Caddy DNS token and the Coder GitHub OAuth secret). Then re-run
   `bootstrap.sh`, which now ends with `failed=0`. The agent's key
   pair is new, and the vault that held its four keys is gone, so run "The
   lab agent's go-live" (below) again: it appends the new certificate and
   writes the four keys back. Re-onboard Arc ("Re-onboarding a rebuilt host", below).
   Portainer gets a new administrator and its licence key (below).
   **Keep the old Vault recovery keys.** The Vault snapshot about to be
   restored carries its own recovery authority, and after the restore those
   five keys, the ones already in the password manager, are the restored
   Vault's; `generate-root` needs three of them. Nothing from the old Vault
   is deleted until the restore below has succeeded, and then it is the
   *fresh* initialisation's keys and root token that are deleted, because
   they open nothing any more.
   **Then the restore from the container** ("Off-host backups", below, has
   what each line does). The `bootstrap.sh` run just made installed
   `hcw-backup-restore`, and the host is Connected to Arc again, so it reads
   the container. Bash, on the host, Coder first:

   ```bash
   sudo /usr/local/sbin/hcw-backup-restore list
   ```

   ```bash
   sudo /usr/local/sbin/hcw-backup-restore coder --yes
   ```

   Success is `restored coder/coder-<UTC stamp>.sql.gz into coder-postgres`
   and the `buildinfo` line under "Enabling" in `lab-host/README.md`
   answering within a minute; signed-in learners and the templates are back.
   **Vault, in this order, because the snapshot was taken under the Azure
   Key Vault seal and only a Vault under the same seal can open it.** First
   put the new host under the seal before Vault holds anything: steps 4 and 5
   of "HashiCorp Vault: moving to auto-unseal" (the seal fact, then the key
   read as the Arc identity), then one more `bootstrap.sh` run, which renders
   the seal into Vault's configuration; `vault status` then says `Seal Type
   azurekeyvault` and `Initialized false`. Initialise it under the seal:

   ```bash
   vault operator init -recovery-shares=5 -recovery-threshold=3
   ```

   Hold its root token in PowerShell on the workstation, the way the seed's
   token is held, and restore:

   ```powershell
   $t = [Net.NetworkCredential]::new('', (Read-Host 'Vault root token' -AsSecureString)).Password
   ```

   ```powershell
   $t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-backup-restore vault --yes"; $t = $null
   ```

   The helper refuses a Vault whose seal is not `azurekeyvault`, naming the
   two steps above. Success is `Vault accepted vault/vault-<UTC stamp>.snap
   for restore and now reports Initialized true, Sealed false`. That is
   acceptance, not completion: Vault replaces its data in the background, so
   before relying on it, bash, on the host:

   ```bash
   sudo journalctl -u vault -n 30 --no-pager && vault status
   ```

   Good is the log reporting the restore completed and the seal
   re-established, `Sealed false`, and `vault status` with no error. If it
   reports `Sealed true`, `sudo systemctl restart vault` unseals it with the
   same key. Now the fresh initialisation's five recovery keys and root token
   can be deleted from the password manager: Vault's data is the snapshot's,
   whose recovery keys are the old ones. The snapshot's own root token was
   revoked when the snapshot was taken, so the snapshot token file is seeded
   again with a root token from `generate-root`, using three of the *old*
   recovery keys ("The root token", below, has the Vault 2.x switch it
   needs; "Off-host backups" has the seed line).
   **Last rehearsed / elapsed:** not yet. The rehearsal is the owner's, on a
   fresh VPS: the time from the reinstall click to Coder answering on the
   restored database and Vault unsealed with the snapshot's data goes here,
   with the date. Until a date stands here, this restore is untested.
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
The live host has accounts, so this does not apply to it.

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
<https://hybridcloudworks.com/admin/health?tab=checks>, under Enhanced, and
the health pulse records each every five minutes.

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
agent on 40341 to 40344, and each tool add-on on its own port. Only sshd
(TCP 22) and Caddy (TCP 80 and 443) are public. The last check of every run
(`roles/privilege_checks`, `tasks/listeners.yml`; #958, LAB-12) reads every
TCP and UDP listener with `ss`, including the ports the rootless sandbox
forwards for a workspace. It fails the run if anything else listens beyond
the loopback, naming each one: `These listen beyond the loopback, and only
TCP 22, 80, 443 may: …`.

When it fails, this names the process behind each one, bash on the host:

```bash
sudo ss -ltnup
```

Bind that service to `127.0.0.1` (for a container, publish
`127.0.0.1:<port>:<port>`), or stop it, then run `bootstrap.sh` again. Good
is a recap with `failed=0`. Port 22 leaves `privilege_checks_public_tcp_ports`
when it closes to the internet (#953, stage 3).

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
`portainer : Say how to reach Portainer` printing `Portainer 2.45.1 answers
on https://127.0.0.1:9443 on this host and nowhere else`.

**The first sign-in.** Two guards stand in front of a fresh Portainer, and
both were measured on the pinned 2.45.1 on 2026-09-26. Until an
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

Success looks like: the command prints nothing and exits 0. The value never
appears on a command line or in output. The `addons` role refuses to start
the container while this key is unset, naming the key and this line.

**2. Write the digest in.** The add-on's `v0.3.1` release prints
`docker.io/hybridcloudworks/hcw-addon-migration@sha256:…` in its
`publish-images` run summary; the same value, read from the registry.
PowerShell, anywhere with Docker:

```powershell
docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-addon-migration:0.3.1
```

The `Digest:` line is the value for `image_digest` of the `migration` row in
`lab-host/ansible/group_vars/all.yml`: for `v0.3.1`,
`sha256:88b8d08892860f753c02f405d1b3b99146aed5e460b04a1c426670d9e5e5dd61`,
written in on 2026-10-11. A row whose digest is empty deploys nothing and
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
`"version"` matching the pinned tag (`0.3.1`). From outside, the name answers
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
  `chore/lab-pins-image-base`, scans the two published lab images with
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
