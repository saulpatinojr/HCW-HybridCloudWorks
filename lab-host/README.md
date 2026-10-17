# lab-host

Configuration management for the Hostinger lab host: the on-premises half of
the hybrid estate in #656, Phase 2 (#662), on the decisions in ADR 0032.
Terraform in `infra-lab/` (#661) adopts the existing VPS and writes its DNS;
everything on the host after that is here, so nothing beyond the one
bootstrap command below is done by hand over SSH and a follower can read
every step.

## What runs on the host

What `main` configures. The host runs the commit its last `bootstrap.sh`
run checked out, and nothing re-runs it on its own (#950), so a merged
change is on the host only after the owner's next run; which merged changes
the host has not run yet is
[Labs host, Applied state](../docs/architecture/labs-host.md#applied-state).

| Role | Installs | Where |
| --- | --- | --- |
| `hardening` | `hcwadmin` key-only login with passwordless sudo, sshd drop-in (`PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`), ufw deny-in/allow-out with TCP 22, 80, 443, unattended-upgrades with its own reboot off and `hcw-reboot-when-idle.timer` rebooting at 04:30 only with nobody logged in and no lab job container running, asked twice with new lab jobs held between (LAB-13), fail2ban sshd jail | `/etc/ssh/sshd_config.d/00-hcw-hardening.conf`, `/etc/sudoers.d/90-hcw-admin`, `/etc/apt/apt.conf.d/52hcw-unattended-upgrades`, `/usr/local/sbin/hcw-reboot-when-idle`, `hcw-reboot-when-idle.timer`, `/run/hcw-maintenance/reboot-hold` (only while the idle reboot holds new lab jobs), `/etc/fail2ban/jail.d/hcw-sshd.local` |
| `vault_tools` | `hcw-vault-set`, which sets one key of the Ansible vault from stdin and prints no value ("The vault", below), and the vault's directory, root-only. The Ansible vault the playbook reads, not HashiCorp Vault, which is the `vault` role | `/usr/local/sbin/hcw-vault-set` (root:root, 0750), `/etc/hcw/ansible` (root:root, 0700) |
| `arc` | Azure Connected Machine agent 1.68.03532.1399 from Microsoft's apt repository, held, then `azcmagent connect` to `rg-lab-hybrid-prod-cus` as `arcs-lab-hybrid-prod-cus-01` with the onboarding service principal from the vault, skipped once Connected. Nothing until `arc_enabled` is true, which is the host's own switch: the arc fact `scripts/lab/Register-LabArc.ps1 -Connect` writes ("Azure Arc", below) | `/opt/azcmagent/`, `/etc/apt/sources.list.d/microsoft-prod.sources`; the connect configuration is a temporary root-only file deleted in the same run; the switch is `/etc/ansible/facts.d/hcw_arc.fact` |
| `docker` | Docker Engine 29.8.1, buildx 0.37.1, compose 5.5.1 and the rootless extras from Docker's apt repository, held; `json-file` logs 10 MB x 3, `live-restore`, **`userns-remap: default`** with the containerd image store off (LAB-5): a container's root is an unprivileged uid on the host. The run that turns the remap on stops the running containers, restarts the daemon at once and carries Coder's PostgreSQL volume and Portainer's into the new data root (`roles/docker/README.md`, "User namespaces") | `/etc/docker/daemon.json`, `/usr/local/libexec/hcw-docker-volume-carry`, `/var/lib/hcw-docker/userns-carry/` |
| `node_exporter` | node_exporter 1.12.1, host-native, SHA256-verified, `127.0.0.1:9100` only | `/usr/local/bin/node_exporter`, `node_exporter.service` |
| `caddy` | Caddy 2.11.4 built with `caddy-dns/cloudflare` 0.2.4, host-native under systemd; TLS for `lab.hybridcloudworks.com`, `*.lab.hybridcloudworks.com` and `*.coder.lab.hybridcloudworks.com` via DNS-01; placeholder response at the apex. Panes only (owner decision 2026-09-28): every name can be framed by the site alone, and a top-level browser visit is redirected to `https://hybridcloudworks.com/education/labs` (`roles/caddy/README.md`, "Panes only") | `/usr/local/bin/caddy`, `/opt/caddy/bin/` (versioned binary and its `.provenance`), `/etc/caddy/Caddyfile`, `/etc/caddy/conf.d/`, `/etc/caddy/env` (root:caddy, 0640), `caddy.service` running as `caddy` |
| `coder_sandbox` | A **rootless** Docker daemon for Coder's workspaces, run by the unprivileged system user `hcw-coder-docker` from a systemd user unit kept up by lingering, with its own subordinate id range and the cpu, memory and pids controllers delegated so the workspace limits hold (LAB-5). Every workspace runs here, and a privileged container a compromised Coder server asks for is that user's, never root's. Off while Coder is | User `hcw-coder-docker` (home `/var/lib/hcw-coder-docker`, the daemon's data under `~/.local/share/docker`), `/etc/systemd/user/hcw-coder-docker.service`, socket `/run/hcw-coder-docker/docker.sock` (directory from `/etc/tmpfiles.d/hcw-coder-docker.conf`), `/etc/systemd/system/user@.service.d/delegate.conf` |
| `host_firewall` | The host's own iptables chains, each jumped to first, above ufw (#954, #958): `HCW-SANDBOX-OUT` for everything the `coder_sandbox` user sends (the sandbox daemon and its workspaces), which allows DNS to systemd-resolved's stub, TCP 443 to the host's own non-loopback addresses and TCP 80 and 443 to public ones, and refuses the rest of the host and every private and reserved range; `HCW-BRIDGE-IN` for what containers on `docker0` and `br-*` send to the host, which allows TCP 80 and 443 and the replies to the host's own connections; `HCW-CONTROL-OUT`, which refuses the host's own new connections to Coder's internal network (`coder-control`, subnet read from Docker and the Compose file). Loaded at boot after ufw and before Docker, a failure reported to `hcw-unit-failed@`, and the sandbox user's manager requires it, so the sandbox daemon never starts without it. `host_firewall_state: absent` takes all of it out. Never touches ufw's rules or DOCKER-USER (`roles/host_firewall/README.md`) | `/etc/hcw/firewall/` (`hcw.v4.rules`, `hcw.v6.rules`, `hcw.jumps`), `/usr/local/libexec/hcw-host-firewall`, `hcw-host-firewall.service`, `/etc/systemd/system/user@<uid>.service.d/hcw-host-firewall.conf` |
| `coder` | Coder Community edition v2.37.3, PostgreSQL 18.6 and a Docker socket proxy (tecnativa/docker-socket-proxy 0.3.0, read-only, holding the `coder_sandbox` daemon's socket and never the host's; LAB-5) under Docker Compose from `../coder/docker-compose.yml`, all by digest; the Caddy route for `coder.lab` and `*.coder.lab`; a nightly `pg_dump` keeping seven days; `hcw-coder-template-push`, which publishes the workspace template from the checkout ("Publishing the template", below); Coder automation, which once the owner seeds a rotation credential renews the site's status token daily and publishes the template on every run that changes it (`docs/runbooks/labs-host.md`, "Automatic renewal"). On since 2026-09-28, for members of the `HybridCloudWorks` GitHub organisation only | `/etc/hcw/coder/` (`docker-compose.yml`, `.env`, `coder.env` and `coder-postgres.env`, the last two root 0600, `automation.json`, and `automation/rotation-token`, root 0600 in a 0700 directory), `/etc/caddy/conf.d/10-coder.caddy`, `/usr/local/sbin/coder-postgres-backup`, `/usr/local/sbin/hcw-coder-template-push` and `/usr/local/sbin/hcw-coder-automation-seed` (root:root, 0750), `/usr/local/libexec/hcw-coder-automation`, `coder-postgres-backup.timer`, `hcw-coder-automation.timer`, `/var/backups/coder/`, `/var/lib/hcw-coder-automation/` |
| `labs_agent` | `vps-agent` host-native as `hcw-labs-agent.service` under user `hcw-labs-agent`, **in no docker group** (LAB-5): it reaches Docker through `hcw-labs-agent-docker-proxy`, HAProxy 3.4.6 by digest with the allowlist in `roles/labs_agent/templates/docker-proxy.haproxy.cfg.j2` (the calls a job makes, and no create body that asks for privilege, a host namespace, a device, a mount or a bind beyond the job's own directory), on a Unix socket only the agent's group may open. Node.js 26.10.0 from NodeSource, repository checkout at the commit the playbook runs from, certificate generated on the host | `/opt/hcw-labs-agent`, `/etc/hcw/labs-agent.env` (root, 0600), `/etc/hcw/labs-agent.pem` (root:hcw-labs-agent, 0640), `/etc/hcw/labs-agent.crt`, `/etc/hcw/labs-agent-docker-proxy/haproxy.cfg`, socket `/run/hcw-labs-agent-docker/docker.sock` (root:hcw-labs-agent, 0660) |
| `lab_images` | Every image a lab job runs, pulled by digest before any job needs it: each value of `IMAGES` in `vps-agent/lib/capabilities.js` into the host daemon, and the Coder workspace image from `../coder/templates/hcw-lab/main.tf` into the `coder_sandbox` daemon while `coder_enabled` is true. Read from the checkouts, never copied, so a pin bump needs no edit here; digests no pin names are removed from the lab's own repositories and nothing else is touched (`roles/lab_images/README.md`) | Docker's image store; the plan is `roles/lab_images/files/lab-images.mjs`, run from the playbook's checkout |
| `addons` | The tool add-ons (ADR 0035): one hardened container per enabled row of `addons` in `group_vars`, `hcw-addon-<id>`, from `docker.io/hybridcloudworks/hcw-addon-<id>` by digest, published on **127.0.0.1:<port> only** (migration 18081), read-only root, every capability dropped, no volume, no socket, under the user-namespace remap, the row's env plus each secret from the vault key it names; a Caddy route per name with a 503 that is the site's own sentence while the container is stopped, and a direct-visit redirect to the add-on's page on the site. A row with an empty digest is not deployed and the run says so ("Tool add-ons", below) | Containers `hcw-addon-<id>`, `/etc/caddy/conf.d/20-addons.caddy` |
| `portainer` | Portainer Business Edition 2.45.1 (LTS) by digest, one container with the Docker socket (and `--userns=host`, which the socket needs under the remap), HTTPS on **127.0.0.1:9443 only**, plain HTTP off, no Caddy route; reached through an SSH tunnel. Nothing until `portainer_enabled` is true | Container `portainer`, volume `portainer-data` |
| `vault` | HashiCorp Vault 2.1.1 host-native as `vault.service` under user `vault`, the download checked against HashiCorp's signature on SHA256SUMS; raft storage; API on **127.0.0.1:8200** and cluster port on **127.0.0.1:8201**, TLS from a certificate generated on the host. For lab-host secrets only; never initialised or unsealed by the role. Nothing until `vault_enabled` is true | `/usr/local/bin/vault`, `/opt/vault/` (downloads, signing key), `/etc/vault.d/vault.hcl` (root:vault, 0640), `/etc/vault.d/tls/`, `/var/lib/vault` (vault, 0700), `/etc/profile.d/hcw-vault.sh` |
| `backups` | Off-host backups (LAB-9): `hcw-backup-upload`, which puts one file in the `host-backups` container of `stlabhybridprodcus01` as the Arc machine's identity (a token from the agent on 127.0.0.1:40342 by `hcw-arc-token`; no storage key on the host), the Coder dump uploaded after it is written, a nightly Vault raft snapshot (`hcw-vault-backup.timer`, 03:45 UTC) with a token the owner seeds once (`hcw-vault-backup-seed`), and a listing of the container at every run to prove the grant. On while Arc is | `/usr/local/sbin/hcw-backup-upload`, `/usr/local/sbin/hcw-vault-backup-seed`, `/usr/local/libexec/hcw-arc-token`, `/usr/local/libexec/hcw-vault-backup`, `/etc/hcw/backups/`, `/var/backups/vault/`, `hcw-vault-backup.service` and `.timer` |
| `privilege_checks` (from `post_tasks`) | Nothing but its check script: fails the run unless `hcw-labs-agent` is in no docker group, `docker info` reports `name=userns`, the agent's proxy socket is root:hcw-labs-agent 0660, one shell-echo job run as the agent user through the proxy prints its payload while `docker ps` and a privileged `docker run` are refused, (with Coder on) `coder-docker-proxy` carries every policy key the installed Compose file sets, mounts the sandbox daemon's socket directory alone, and that daemon reports `name=rootless`, and every deployed `hcw-addon-<id>` is read-only, has every capability dropped, is not privileged, has no bind mount, publishes on `127.0.0.1` only and is not in the host's user namespace (ADR 0035) | `/usr/local/libexec/hcw-labs-agent-proxy-check.mjs` |

Each role's `README.md` explains its decisions; `meta/argument_specs.yml` is
its variable contract. Every version, digest and checksum is in
`ansible/group_vars/all.yml`, and the collections are pinned in
`ansible/requirements.yml`.

`site.yml` runs the roles in that order: `vault_tools` straight after
`hardening`, because `hcw-vault-set` is how a missing vault key is added and
a later role that stops on one should find it installed; `arc` next,
because the agent needs nothing the later roles install and the host should
appear in Azure even when a later role fails; `docker` before every role
that runs a container, because it restarts the daemon at once when its
configuration changes; `coder_sandbox` before `coder`, because Coder's
proxy mounts that daemon's socket directory; `coder` after `caddy`, because
its route is a file in Caddy's `conf.d`, and before `labs_agent`;
`host_firewall` between `coder_sandbox` and `coder`, because its jump
matches the user `coder_sandbox` creates and no workspace should start
before its chains are loaded;
`lab_images` straight after `labs_agent`, because its plan runs on the
Node.js that role installs and reads the agent's checkout; `addons` after
`lab_images`, because it needs docker and caddy and nothing of coder's, and
stops on a row being deployed (enabled, with a digest) whose vault key is
unset; `portainer` and `vault` after those, because nothing above needs
either, so a failure there leaves the lab services configured; `backups`
last, because it hooks the dump `coder` installs, snapshots the Vault `vault`
runs and uploads both as the identity `arc` connected, and nothing needs it;
and `privilege_checks` from `post_tasks`, after every role and the handlers
they notified. Docker
Compose on this host is for Coder and its PostgreSQL only (ADR 0032); Portainer
and the tool add-ons are single containers their roles run directly (the
add-ons by ADR 0035 decision 8, which amends ADR 0032's line), Caddy, the agent
and Vault are host services, and Coder's Caddy route is
`/etc/caddy/conf.d/10-coder.caddy`, the pattern `00-apex.caddy` shows, with
the add-ons' at `20-addons.caddy`.

Only sshd (22) and Caddy (80 and 443) listen on a public address.
node_exporter, Coder, the tool add-ons, Portainer and Vault listen on
`127.0.0.1`, and the three that publish through Docker (Coder, the add-ons,
Portainer) name `127.0.0.1` in the publish itself, because Docker's iptables
rules for a published port come before ufw's.

## Container-runtime privilege separation (LAB-5)

Two Docker daemons and three ways in, kept apart (estate review
2026-10-06, finding LAB-5; ADR 0032, amendment of 2026-10-07). Merged
2026-10-07 (#987); the 2026-10-08 review found the host had not run it yet
([Labs host, Applied state](../docs/architecture/labs-host.md#applied-state)),
so what follows is the host from its next `bootstrap.sh` run:

- **The host daemon remaps user namespaces.** `userns-remap: default`, so
  a job container's root, and Coder's server's and PostgreSQL's, is an
  unprivileged uid of the `dockremap` range on the host. Only three of this
  host's own containers opt out (`--userns=host`), because each must open
  a Docker socket: the two proxies and Portainer.
- **The agent is in no docker group.** It reaches the host daemon through
  `hcw-labs-agent-docker-proxy`, whose allowlist is the exact calls a job
  makes (read from Docker CLI 29.8.1, `scripts/fixtures/docker-cli-agent-requests.json`)
  and whose create rules refuse a privileged container, a host namespace,
  the remap's opt-out, a device, a mount, an added capability and any bind
  but the job's own read-only directory. `scripts/lab-host-docker-proxy.test.mjs`
  runs the file's rules against the recorded calls and those escapes.
- **Coder never reaches the host daemon.** Its proxy holds the socket of
  the `coder_sandbox` daemon, rootless under `hcw-coder-docker`, where every
  workspace runs. The proxy still reads paths only; the containment is that
  whatever it lets through is that user's.

`roles/privilege_checks` checks all three at the end of every run and fails
it with what to do. After the bootstrap that first turns this on, the owner
pastes the verification in the
[Labs host runbook](../docs/runbooks/labs-host.md#container-runtime-privilege-separation-lab-5);
that page also says what the switch costs (running workspaces and jobs are
stopped, and workspaces start again on the sandbox daemon with an empty
home volume) and how to take it back.

## First run

The VPS already exists, and the `hostinger/hostinger` provider runs a
post-install script only at purchase or at reinstall, so there is none: the
owner clones this repository onto the host and runs `bootstrap.sh` as root
over SSH, with the one line in `infra-lab/README.md`, step 7. It needs a key
in `/root/.ssh/authorized_keys` first (step 6 there), and that key must be
one `hardening_admin_authorized_keys` in `ansible/group_vars/all.yml` pins:
the `hardening` role writes `hcwadmin`'s keys from that list alone, empties
root's and turns root and password login off, and it refuses to run when
the list does not hold the key of the most recent SSH login, which on that
run is root's with this key (#953). The script checks the host is Ubuntu 26.04 LTS (24.04
LTS is accepted and says it is the fallback; anything else stops), then
checks the host is empty (below), installs
`uv` 0.12.19 from its GitHub release after checking the archive's SHA256,
has uv install CPython 3.14.7, clones
this repository into `/opt/hcw-src` (or fetches, when the clone exists),
checks out the current `main` commit detached and prints its full sha
(`HCW_REPO_REF`, below), installs `ansible-core` on that CPython from the
`ANSIBLE_CORE_*` lines of that commit's `lab-image/versions.env` with every
wheel hash-checked, installs the collections and runs `site.yml`
against localhost. Without a
vault the play stops at the `coder` role, on purpose: Coder is on (since
2026-09-28) and the role will not start it without its three vault keys.
Every role before it has run by then, so the host is hardened,
`hcw-vault-set` is installed, Docker and node_exporter run, and Caddy
serves an HTTP-only apex answering 503 that says TLS is off (and imports no
routes, so nothing can leak over plaintext). The `PLAY RECAP` shows
`failed=1`, and the failed task is `coder : Refuse to enable Coder without
its three vault secrets`. Create the vault and add its keys ("The vault",
below), then re-run; that run configures the rest and ends with `failed=0`.

### The first-run host check

`bootstrap.sh` configures only a host that was prepared for it. On a host
it has never accepted it looks, before it changes anything, for signs of
another workload, and refuses when it finds one. It exits 3, lists what it
found, and names the two ways on. The checks, each something this
repository never creates on a host it has not accepted:

- any Docker container, running or stopped (the `docker` role restarts the
  daemon, and a restart starts every stopped container whose restart policy
  is `always`);
- an installed `actions.runner.*` systemd unit (a self-hosted runner);
- Kubernetes: a `k3s`, `k0s`, `rke2`, `kubelet` or `microk8s` unit,
  `/usr/local/bin/k3s`, `/etc/rancher`, `/var/lib/rancher`,
  `/etc/kubernetes` or `/var/lib/kubelet`;
- `/opt/hcw-src` or `/opt/hcw-labs-agent` holding anything but a checkout of
  this repository;
- anything else under `/opt`;
- a TCP listener other than sshd on 22 and systemd-resolved on
  `127.0.0.53:53` and `127.0.0.54:53`.

The first run that passes writes `/etc/hcw/bootstrap-host-accepted` before
its first change, and every run that finishes records its commit there.
While that file exists, runs skip the check, so a first run that fails
half-way can be re-run: what it left behind is this repository's own, and
the host was judged before any of it existed. The procedure the refusal
points at, reinstalling the server, is
[docs/runbooks/labs-host.md](../docs/runbooks/labs-host.md), "Reinstalling
the host". The other way is to accept the host knowingly, only when every
listed item is meant to stay and may be disrupted: the run then moves Docker
to its pinned version and restarts it, enables ufw with only 22, 80 and 443
open, and replaces sshd's login settings, whatever those workloads need.
Bash, on the host, as root:

```bash
HCW_ADOPT_NONEMPTY_HOST=1 /opt/hcw-src/lab-host/bootstrap.sh
```

The marker then says `accepted_as=adopted`, with one `adopted_with=` line
per item that was found. Delete the marker only to make the next run check
again.

### Which Python runs what

Owner rule 2026-09-26: Python is on the newest release line and no more than
two patch releases behind that line's newest. On 2026-09-26 that is 3.14.7,
so the floor is 3.14.5, and Ubuntu 26.04's own `/usr/bin/python3` is 3.14.4
(the `python3.14` package; the `python3` package is 3.14.3). So:

| Runs | Interpreter | Why |
| --- | --- | --- |
| `ansible`, `ansible-playbook`, `ansible-galaxy`, `ansible-vault` (the control side) | CPython 3.14.7 from uv, under `/opt/uv/python`, in the venv the link `/opt/uv/ansible-core` (`HCW_ANSIBLE_VENV`) points to, one generation per build under `/opt/uv/ansible-core-generations`, linked into `/usr/local/bin` through that link | The rule. `PYTHON_VERSION` at the top of `bootstrap.sh` is the pin; uv checks the download against the SHA256 it carries for that build, and uv itself is checked against `UV_SHA256`. ansible-core and every wheel it depends on are the `ANSIBLE_CORE_VERSION`, `ANSIBLE_CORE_SHA256` and `ANSIBLE_CORE_DEPS` lines of `lab-image/versions.env`, the lines the lab image is built from; `bootstrap.sh` keeps no copy, writes them as one `name==version --hash=sha256:<hex>` line each, and installs them with `uv pip install --require-hashes --only-binary :all:`, which refuses a wheel whose SHA256 differs and any dependency the file does not list |
| Every module the play runs on the host | `/usr/bin/python3`, the distribution's (3.14.4 on 26.04, 3.12.3 on 24.04) | **The one recorded exception.** `python3-apt`, `python3-debian` and `python3-docker`, which the `apt`, `deb822_repository` and `community.docker` modules import, are Ubuntu packages built for that interpreter and cannot be loaded by another. `ansible_python_interpreter` in `ansible/inventory/localhost.yml` says so |

A successful run prints, before the play starts, `ansible-playbook [core
<ANSIBLE_CORE_VERSION from versions.env>]` and a `python version = 3.14.7`
line; a run that installs says `installing ansible-core <version> and the <n>
wheels it depends on into /opt/uv/ansible-core-generations/<generation>`
first, and `switched /opt/uv/ansible-core to <that generation>` once it has
passed. Moving Python is a change to `PYTHON_VERSION` (and
`UV_VERSION`/`UV_SHA256` when the newer Python needs a newer uv); moving
ansible-core is a change to `lab-image/versions.env` (its section in
`lab-image/README.md`, "Updating a version"). Either needs a new generation,
a directory whose name starts with the ansible-core release, the Python and
the first twelve hex digits of the requirements file's SHA256, and ends with
the build's UTC time and a random tag (a copy of the requirements is kept in
it as `hcw-requirements.txt`). The script builds it beside the one in use,
checks it with `uv pip check`, the package count and its own `--version`,
and only then moves the link, so a failed download, hash or check stops the
run with the host still on the environment it was using. That holds when
the one in use is itself a build of the same pins that has stopped passing
those checks: a rebuild gets a directory of its own, and the old build is
removed only after the link has moved off it. A generation of other pins
that the link moved from is kept until the next move, so `HCW_REPO_REF` back
to the commit that pinned it switches back without a download.

The ansible-core uv tool an earlier script installed under `/opt/uv/tools`,
without hashes, is removed after the play of the first run whose play
installs an `hcw-vault-set` that no longer runs that tool's Python. Until
then the helper on the host still needs it, so a `--check` run, a run whose
`--tags` leave out `vault_tools`, or a play that stops early keeps it.

## Re-running

Bash, on the host, as the `hcwadmin` user the first run created:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh
```

A successful run ends with a `PLAY RECAP` line for `localhost` showing
`failed=0` and `unreachable=0`. On a host that is already configured, the
one change every run makes is its last task, **Record the commit this host
converged from, for the agent's heartbeat**, which writes
`/etc/hcw/applied-commit.json` (`root:root` `0644`: the commit, its committer
date and the time the run finished); anything else changed names the task
that changed it. A run that fails before that task leaves the previous
record, so the record only ever names a commit the whole playbook converged
from, and a `--check` run writes nothing.

The agent sends that record on every heartbeat, and the site compares it
with `main` (#1009): the Labs **Agents** tab shows `commit <8 hex> ·
converged <time>` on the agent's card with the verdict under it, and the
Health Hub's **Lab host runs main** turns critical once a change under
`lab-host/` or `vps-agent/` has waited on `main` for more than a day without
a run. Nothing re-runs the playbook for you: the check raises the lag, and
the line above clears it.

**The same run publishes the Coder templates; nothing follows it.** Its
`coder` role publishes each template whose files changed with the host's
own rotation credential, before `lab_images` removes the images the
checked-out commit no longer names. Those include, after the move to Docker
Hub (#1002, #1003), the GHCR images an older template version still names,
which is why the publish happens inside the run. "Publishing the template",
below, is the fallback for a host without a working credential. The
runbook: [After a merge](../docs/runbooks/labs-host.md#after-a-merge-the-playbook-then-the-template-at-once).

A checkout cloned before the repository moved to saulpatinojr (2026-10-07)
is repointed by the run: `bootstrap.sh` sets `/opt/hcw-src`'s origin to
`HCW_REPO_URL` when they differ and logs the address it fetches from, and
the `labs_agent` role's git task does the same for the agent's checkout
(#1009).

To see what a run would change without changing it, pass the playbook flags
through (bash, on the host):

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --check --diff
```

### Running part of the play

A full run is the host's convergence and takes its time (the twenty slowest
tasks are printed after the recap, so a run says where its minutes went). When
one area changed — a pin set merged, an add-on's digest moved — the run can be
narrowed to the roles that own it. Every role carries its own name as a tag;
the pre-flight checks and the privilege checks run whatever the tags. Bash, on
the host, one line each:

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags lab_images,coder
```

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags addons
```

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags docker,labs_agent
```

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh --tags caddy
```

The first is a `chore/lab-pins-image-digests` merge (the `lab_images` role
pulls the new images and removes the ones they replaced; the `coder` role
republishes the templates that name them). The second is an add-on row's
digest. The third is a Docker Engine or containerd move from the host pin set
(the daemon restarts; `labs_agent` restarts the agent's socket proxy onto the
daemon's new socket). The tags are the role names in `ansible/site.yml`:
`hardening`, `vault_tools`, `arc`, `docker`, `node_exporter`, `caddy`,
`coder_sandbox`, `host_firewall`, `coder`, `labs_agent`, `lab_images`,
`addons`, `portainer`, `vault`, `backups`.

Two things a narrowed run is not. It is not a convergence: `bootstrap.sh`
does not record it as a completed run and the play does not write the
commit the agent reports, so the site keeps saying the host is behind until
the next full run — which is the one to run after anything that touched more
than one area, and in any week nothing else did. And it does not stand in
for a first run: a role re-applied alone relies on the host state the full
run left (`docker` installed, the vault present); on a host that never
converged, run the whole play.

### Which commit runs

Every run brings the host to the current `main`: to move the host to a
change, merge it and re-run the line above. There is no pin to bump.
`bootstrap.sh` fetches, resolves `HCW_REPO_REF` (default `origin/main`) to
a full sha, checks that sha out detached in `/opt/hcw-src` and runs the
playbook from it, and the agent runs the same commit, because
`labs_agent_repo_ref` in `ansible/group_vars/all.yml` reads the playbook's
own checkout. `main` is protected by the repository ruleset — every change
arrives by pull request, nobody can bypass it, and the required checks
include `ansible-lint (lab-host)` and `coder (lab-host)` — so a commit on
`main` has passed the same checks a pinned sha had to. A pin could not do
better: a pull request cannot name its own merge commit, so a pin always
lagged one merge behind and every lab-host change needed a second pull
request to take effect.

A run prints the commit before anything changes, as
`[bootstrap] checking out origin/main at <40-character sha>`, and again as
`[bootstrap] running site.yml from <sha> against localhost`. When the
commit carries a different `bootstrap.sh` from the one that started (a uv
or Python bump), the run says
`carries a different bootstrap.sh; handing over to it` and continues as the
new script, on the same sha. An ansible-core bump needs no handover: it is
in `lab-image/versions.env`, which the script reads from the commit it has
just checked out.

`HCW_REPO_REF` also takes any sha or ref the fetch can see, to hold a host
back or roll it back. Because a plain run also applies whatever has merged
since the last one, the first line below is the one to use when only the
vault changed and nothing else should. Bash, on the host. Re-apply the
commit the host runs now, without moving it:

```bash
sudo HCW_REPO_REF=HEAD /opt/hcw-src/lab-host/bootstrap.sh
```

Roll back to `main` as it was before the most recent merge:

```bash
sudo HCW_REPO_REF=origin/main~1 /opt/hcw-src/lab-host/bootstrap.sh
```

A rollback to a commit whose `bootstrap.sh` predates the generations above
(it has no `HCW_ANSIBLE_VENV` line) works the same way. That script installs
ansible-core as a uv tool only when `/usr/local/bin/ansible-playbook` does
not already report its pins, so before handing over to it the current script
removes that one link when it points through `/opt/uv/ansible-core`. The
older script then reinstalls its uv tool, and its play installs the
`hcw-vault-set` that runs that tool's Python. Running an older checkout's
script directly, without the handover, skips that step; remove the link
first:

```bash
sudo rm -f /usr/local/bin/ansible-playbook
```

Move the playbook to current `main` but keep the agent on the commit it
runs now (an explicit `-e` wins over `group_vars`, and the stamp that
decides whether to reinstall its dependencies follows the commit the agent
is checked out at):

```bash
sudo /opt/hcw-src/lab-host/bootstrap.sh -e labs_agent_repo_ref="$(sudo git -C /opt/hcw-labs-agent rev-parse HEAD)"
```

A hold lasts one run. The next plain run returns the playbook and the agent
to current `main`.

## The vault

Secrets never enter the repository. They live on the host in
`/etc/hcw/ansible/vault.yml`, encrypted with Ansible Vault, and the vault
password is `/etc/hcw/ansible/vault-password`, root-only. `bootstrap.sh`
passes both when they exist and runs without them when they do not.

The password comes first, once per host. Bash, on the host (the
`vault_tools` role creates the directory too, root-only, so the first line
matters only before the first `bootstrap.sh` run has finished):

```bash
sudo install -d -m 0700 -o root -g root /etc/hcw/ansible
```

```bash
sudo sh -c 'umask 077 && openssl rand -base64 32 > /etc/hcw/ansible/vault-password'
```

### Setting a key

`/usr/local/sbin/hcw-vault-set`, installed by the `vault_tools` role, sets
one key from the value on its standard input. The value never appears on a
command line, in a shell history or in any output. It creates `vault.yml` when
there is none, keeps every other key, and replaces the file by rename, so
the file is always the old vault or the new one. It is one line from the
workstation, and the line is the same for every key except its last word,
the key's name. PowerShell, for the Cloudflare token:

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_cloudflare_api_token"
```

The line reads the clipboard when you press Enter, and copying the line
itself fills the clipboard. So the order is:

1. Paste the line at the prompt, and do not press Enter.
2. Copy the value.
3. Press Enter.

Success is one line naming the key and every key now in the vault, with no
value:

```text
hcw-vault-set: set vault_cloudflare_api_token (value not shown). Keys in the vault: vault_caddy_acme_email, vault_cloudflare_api_token, ...
```

`the value on stdin was empty; nothing changed` means the clipboard was
empty, and `refusing key name` means the last word is not `vault_` followed
by lower-case letters, digits and underscores, or is a name the playbook
itself defines (below). In both cases the vault is exactly as it was. `no vault password at /etc/hcw/ansible/vault-password`
means the two lines above have not run. `-n` makes `sudo` fail at once
rather than wait at a password prompt nobody can see; `hcwadmin`'s sudo
asks for none.

The keys:

| Key | Read by | What it is |
| --- | --- | --- |
| `vault_cloudflare_api_token` | `caddy` | The **runtime** Cloudflare API token Caddy uses for DNS-01, distinct from the one Terraform holds in #661. See the note below on its scope |
| `vault_caddy_acme_email` | `caddy` | Optional. ACME account contact for expiry mail |
| `vault_labs_agent_api_base` | `labs_agent` | `LABS_AGENT_API_BASE`: the Functions API base including `/api`, as the host reaches it: `https://api-azure.hybridcloudworks.com/api`, through Cloudflare. Not the `func-site-prod-cus-01` app's `azurewebsites.net` host: the Function App's origin lock (`functions_origin_lock_enabled`, on since 2026-08-20) denies every address outside Cloudflare's ranges, and this host is outside them, so that host answers it 403. Written by `scripts/lab/Register-LabAgent.ps1` (below) |
| `vault_labs_agent_tenant_id` | `labs_agent` | `LABS_AGENT_TENANT_ID`. Written by the same script |
| `vault_labs_agent_client_id` | `labs_agent` | `LABS_AGENT_CLIENT_ID`: this agent's confidential app registration, `sp-labs-agent-lab-hybrid-prod-cus-01`. Written by the same script |
| `vault_labs_agent_api_scope` | `labs_agent` | `LABS_AGENT_API_SCOPE`: `api://<API client id>/.default`, matching the app's `ENTRA_API_AUDIENCE`. Written by the same script |
| `vault_coder_oauth2_github_client_id` | `coder` | `CODER_OAUTH2_GITHUB_CLIENT_ID`: the GitHub OAuth app the owner creates in #682 |
| `vault_coder_oauth2_github_client_secret` | `coder` | `CODER_OAUTH2_GITHUB_CLIENT_SECRET` |
| `vault_addon_migration_turnstile_secret` | `addons` | `TURNSTILE_SECRET` for `hcw-addon-migration`: the secret key of the migration add-on's own human-verification widget, separate from the site's ("Tool add-ons", below). The role refuses to start the container while it is unset |
| `vault_coder_postgres_password` | `coder` | The `coder` database user's password. Letters, digits and `. _ ~ -` only (it sits unescaped in a URL); `openssl rand -hex 32` makes one |
| `vault_arc_service_principal_id` | `arc` | Application (client) id of `sp-arc-onboarding-lab-hybrid-prod-cus`, the Arc onboarding service principal. Written by `scripts/lab/Register-LabArc.ps1` ("Azure Arc", below) |
| `vault_arc_service_principal_secret` | `arc` | Its client secret, valid for 24 hours. Used once by `azcmagent connect`; written by the same script and deleted, from the vault and from Entra, by its `-Connect` run once the host is Connected |
| `vault_arc_tenant_id` | `arc` | The Entra tenant id. Written and removed by the same script |
| `vault_arc_subscription_id` | `arc` | The application subscription's id (`sub-app-site-prod-cus`), resolved by name. Written and removed by the same script |

PowerShell, one line per key set by hand, each with the order above:

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_cloudflare_api_token"
```

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_caddy_acme_email"
```

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_coder_oauth2_github_client_id"
```

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_coder_oauth2_github_client_secret"
```

The PostgreSQL password is made on the host and goes straight into the
vault, so it is never on a screen or a clipboard. Only for a database that
does not exist yet, which is a new or rebuilt host; a running one is
changed with "Rotating the PostgreSQL password", below. PowerShell:

```powershell
ssh hcw-lab "openssl rand -hex 32 | sudo -n /usr/local/sbin/hcw-vault-set vault_coder_postgres_password"
```

The four `vault_arc_*` keys are written by `scripts/lab/Register-LabArc.ps1`
and the four `vault_labs_agent_*` keys by `scripts/lab/Register-LabAgent.ps1`
(both below). Once the keys are in, re-run
`bootstrap.sh` ("Re-running", above); `HCW_REPO_REF=HEAD` applies the vault
without moving the host to a newer commit.

`vault_enabled`, `vault_version`, `vault_checksum` and
`vault_pgp_key_checksum` in `ansible/group_vars/all.yml` are not keys of
this file: they belong to the role that runs HashiCorp Vault (below), whose
name is `vault`, and none of them is a secret. Neither are that role's own
`vault_*` defaults and vars, such as `vault_api_port`. `bootstrap.sh`
passes `vault.yml` with `-e`, and an extra var outranks every other
variable, so a key there with one of those names would silently replace
it. `hcw-vault-set` refuses any key the playbook defines: a top-level
variable of `ansible/group_vars/`, `host_vars/` or any role's `defaults/`
or `vars/`, or a name a play, the inventory, or a role's task or handler
sets as it runs (`vars`, `register`, `set_fact`). It reads those from the
checkout the host runs, `/opt/hcw-src`, each time, so a variable added
later is refused without a change to the helper
(`ansible/roles/vault_tools/README.md` has the exact list).
Refused, it prints the file that defines the name, for example:

```text
hcw-vault-set: refusing key name 'vault_enabled': lab-host/ansible/group_vars/all.yml defines it, and vault.yml is passed with -e, so the key would override that variable; nothing changed
```

None of the keys in the table above is refused (the helper's test checks
each one against the checkout).

The four `vault_labs_agent_*` keys and the three `vault_coder_*` keys can be
added later: until all four exist the agent stays stopped and the play says
so, and until the three exist the play stops at the `coder` role (Coder is
on). The four agent keys are not typed in by hand:
`scripts/lab/Register-LabAgent.ps1` writes them ("The agent identity",
below), merging them into `vault.yml` and leaving every other key as it
was, or creating the file with only those four when it does not exist yet.
Either order works with `hcw-vault-set`. The four `vault_arc_*` keys are
read only while `arc_enabled` is true and the host is not yet Connected,
and they are not typed in by hand either: `scripts/lab/Register-LabArc.ps1`
writes them through the host's `/usr/local/sbin/hcw-vault-set` and its
`-Connect` run removes them once the host is Connected ("Azure Arc",
below).

`hcw-vault-set` only adds and replaces. To remove a key, or to read the
vault, open it in an editor. Bash, on the host:

```bash
sudo /usr/local/bin/ansible-vault edit --vault-password-file /etc/hcw/ansible/vault-password /etc/hcw/ansible/vault.yml
```

`hcw-vault-set` writes the file back from its parsed keys, sorted, so a
comment added in the editor does not survive its next run. Re-run
`bootstrap.sh` after either.

### The Cloudflare runtime token and its scope

Caddy answers the DNS-01 challenge for all three names through CNAME
delegation: `_acme-challenge.lab.hybridcloudworks.com` and
`_acme-challenge.coder.lab.hybridcloudworks.com` point into a dedicated lab
zone, and Caddy follows the CNAME to write the TXT record there. That zone
does not exist yet (owner decision 2026-09-25), so `infra-lab/dns.tf`
writes no delegation records; they are added there when it does. Once that zone exists, the runtime token needs `Zone:DNS:Edit` on the
lab zone only. **Until it exists, the token has `Zone:DNS:Edit` on the
production `hybridcloudworks.com` zone.** That is the interim risk ADR 0032
accepts, and it is written here so the follow-up — re-issue the token scoped
to the lab zone and rotate it in the vault — is a recorded step, not a
forgotten one. The token is in `/etc/caddy/env` and nowhere else on the
host. That file is owner `root`, group `caddy`, mode `0640` (ADR 0032): the
`caddy` unit runs as the non-root `caddy` user and reads it through
`EnvironmentFile=`, so the group read is what lets certificate renewals
keep working, and nobody outside that group can read it. The play writes
it with `no_log`.

## Coder

The `coder` role (#679) runs Coder Community edition and its PostgreSQL from
`../coder/docker-compose.yml` under `/etc/hcw/coder`, behind Caddy at
`https://coder.lab.hybridcloudworks.com`. The files, the workspace template
and the hardening test are described in
[`../coder/README.md`](../coder/README.md); this section is the operating
procedure. `ansible/group_vars/all.yml` holds the switches: `coder_enabled`
(`true` since 2026-09-28), `coder_oauth2_github_allowed_orgs`
(`[HybridCloudWorks]` since the same day), `coder_oauth2_github_allowed_teams`
(`[HybridCloudWorks/lab-learners]` since 2026-10-16),
`coder_oauth2_github_allow_signups` (`false` since 2026-10-16) and
`coder_max_workspaces` (`5`).

**Coder is reached through panes on the site, never directly** (owner
decision 2026-09-28). Opened in a browser tab, any Coder page, dashboard or
workspace app, is redirected to https://hybridcloudworks.com/education/labs.
Inside a pane on the site it works as usual. So the steps below check Coder
from the command line or in a pane, and the one browser step at the top
level is the GitHub sign-in, because GitHub's pages cannot be framed. The
CLI, the workspace agents and the site's status proxy send no browser
navigation headers, so they are unaffected.

**What a pane opens is the lab launcher**, not a Coder page:
`https://coder.lab.hybridcloudworks.com/_hcw/lab/?lab=<id>`, four static
files from `../coder/launcher/` that the `coder` role installs in
`/etc/caddy/hcw-lab-launcher` and Caddy serves
(`ansible/roles/coder/templates/10-coder.caddy.j2`). Coder's dashboard opens code-server in a new window or tab, which the
panes-only rule turns into the labs page, so from the dashboard the editor
never opened in a pane. The launcher reads the learner's workspace with
their own session. A workspace that does not exist yet gets
Coder's own create page, once the launcher has read that the `hcw-lab`
template exists (without it, the pane says `Lab workspaces aren't available
right now.` rather than show Coder's own error), where the learner confirms.
A stopped one the launcher starts itself (owner, 2026-10-07; #911): the one
write it makes, the same `POST …/builds { transition: "start" }` Coder's
Start button makes, with the CSRF token read from Coder's own page, once per
visit, on the template's active version when the workspace is outdated so a
template change reaches every lab on its next open. A failed build is not
started blind, and when Coder refuses or its page carries no token the
launcher frames Coder's workspace page with Start, as before. Once
code-server is healthy the launcher replaces itself with code-server's own
name, `code-server--<workspace>--<owner>.coder.lab.hybridcloudworks.com`.
Each learner has one workspace per lab, named in the launcher's
`LAB_WORKSPACES` (`lab-lzb`, `lab-tfv` and `lab-asc`, the same names as the
site's catalogue), and one of them runs at a time: every template refuses a
second start until the first stops, and the launcher says which lab to stop,
then starts this one when it has (#954; [`../coder/README.md`](../coder/README.md),
"Running workspaces and sign-ins", which also has the workspaces' cloud
sign-ins, kept in memory). The launcher has no top-level exemption: opened
in a tab, it is redirected like any other Coder page.

**An empty allowlist is not a lock.** Coder treats an empty
`CODER_OAUTH2_GITHUB_ALLOWED_ORGS` as "no organisation restriction" and lets
any GitHub account sign in, so `site.yml` asserts in `pre_tasks`, and the
role asserts again, that the list is non-empty whenever `coder_enabled` is
true and fails the play otherwise; with `coder_enabled: false` the asserts
are skipped. The team list is the same: an empty
`CODER_OAUTH2_GITHUB_ALLOWED_TEAMS` lets every member of the organisation in,
so the role refuses it too, and refuses a team whose organisation is not in
the organisation list ("Who signs in", below).

### Turning it on

Owner decision 2026-09-28: Coder runs, and only members of the
`HybridCloudWorks` GitHub organisation may sign in. The change that
recorded it set `coder_enabled: true` and
`coder_oauth2_github_allowed_orgs: [HybridCloudWorks]`; the other two
things Coder needs were in place that day. The same three are what a
rebuilt host needs:

1. The GitHub OAuth app (#682), owned by the organisation, with homepage
   `https://coder.lab.hybridcloudworks.com` and callback
   `https://coder.lab.hybridcloudworks.com/api/v2/users/oauth2/github/callback`.
   It is listed at
   https://github.com/organizations/HybridCloudWorks/settings/applications;
   a new one is made at
   https://github.com/organizations/HybridCloudWorks/settings/applications/new.
2. The three `vault_coder_*` keys, with the lines under "Setting a key"
   above: the client id and secret from the app's page, and the PostgreSQL
   password made on the host.
3. The two switches in `ansible/group_vars/all.yml`, then a `bootstrap.sh`
   run (above), which checks out the merged `main`. Bash, on the host:

   ```bash
   sudo /opt/hcw-src/lab-host/bootstrap.sh
   ```

The play refuses to continue if the allowlist is empty, if any of the three
vault keys is missing, if the password holds a character outside
`A-Za-z0-9._~-`, or if five workspaces at 2 GiB plus 2.5 GiB of headroom
exceed the host's memory. Nothing creates a Coder user: the first person to
sign in becomes the owner ("First admin sign-in", below), so the owner signs
in before anyone else is told the lab is open.

On the run that turns it on, the `PLAY RECAP` shows `failed=0`. The
changed tasks are Coder's: the Compose file, both environment files,
`Start Coder and PostgreSQL`, the Caddy route and its reload, and the
backup timer. The pull of the workspace image (`lab_images`, about 2.7 GB)
also changes, and takes minutes. The same run from 2026-09-28's `main` also
changes `vault_tools : Install hcw-vault-set` once, the Caddyfile and the
apex route (their visitor wording), and the agent's checkout, as after any
merge. Success then looks like `docker ps` showing `coder` and `coder-postgres`
(`sudo docker compose --project-directory /etc/hcw/coder ps` prints both
with `running` and the database `healthy`), and Coder answering through
Caddy. PowerShell, on the workstation:

```powershell
Invoke-RestMethod https://coder.lab.hybridcloudworks.com/api/v2/buildinfo | Select-Object version
```

That prints `v2.37.3` followed by a build suffix. That answer is also what
opens the site's panes: the site's status read asks the same address, with
no token, and a lab's pane opens once it answers. Signed out, a pane shows
`You're not signed in. Use Sign in with GitHub above to open your lab
workspace here.`, and the page's **Sign in with GitHub** button is the way
in.

### First admin sign-in

There is no password account. Password authentication is off in the
Compose file, and Coder makes the first GitHub sign-in on an empty
deployment the **owner** (its `oauthLogin` allows the first user regardless
of the sign-up setting and grants the owner role). So the owner signs in
with GitHub before anyone else does. GitHub's pages cannot be framed, so
this is the one Coder step taken at the top level: open this address in
the browser, which starts Coder's GitHub sign-in:

https://coder.lab.hybridcloudworks.com/api/v2/users/oauth2/github/callback

GitHub asks the first time whether to authorize the app. The browser then
lands on https://hybridcloudworks.com/education/labs, where every top-level
visit to the lab ends, and the panes there are signed in. That landing is
the success; a Coder page in the tab would mean the panes-only rule is not
applied. To confirm the account is the owner, make a token of yours in a
pane and hold it in `$t` (step 1 of "The status token for the site",
below), then run Coder's CLI inside the `coder` container with it,
PowerShell:

```powershell
$t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder users show me; }'"
```

Success is a `Roles` row reading `Owner`. Every later sign-in is a member.

The site's panes do not wait for the status token ("The status token for
the site", below): they open as soon as Coder answers, and this sign-in is
what they then use. The **Sign in with GitHub** button on any lab's page on
the site starts the same sign-in in a tab of its own, and brings that tab
back to the lab.

If the tab shows `You aren't a member of an authorized team in the
[HybridCloudWorks] Github organization(s)!`, the account is in the
organisation but not in the `lab-learners` team ("Who signs in", below).
If it shows `You aren't a member of the authorized Github
organizations!` instead of the labs page, GitHub did not report the account
as a member of `HybridCloudWorks` to the app. Either the account is not a
member, or the organisation restricts OAuth app access and has not approved
this app; that policy is at
https://github.com/organizations/HybridCloudWorks/settings/oauth_application_policy.
No Coder account was created, so the next successful sign-in is still the
first.

### Who signs in

Owner decision 2026-10-16 (#954): only members of the GitHub team
`HybridCloudWorks/lab-learners` sign in, and sign-ups are off. Read in
Coder v2.38.0's source (`coderd/userauth.go`, `userOAuth2Github` and
`oauthLogin`), a GitHub sign-in passes three gates in order:

1. **The organisation.** The account must be an active member of
   `HybridCloudWorks` (`CODER_OAUTH2_GITHUB_ALLOWED_ORGS`).
2. **The team.** It must then be a member of `lab-learners` in that
   organisation (`CODER_OAUTH2_GITHUB_ALLOWED_TEAMS`, written
   `<organisation>/<team-slug>`). Coder looks for a team only inside an
   organisation that passed the first gate, which is why the role refuses a
   team in any other organisation: it would let nobody in.
3. **The account.** With `CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS=false`, a
   sign-in that matches no Coder account is refused with `Signups are
   disabled` and `Please contact your Coder administrator to request
   access.`, and nothing is created. Coder matches an account first by the
   GitHub account it was linked to at an earlier sign-in, then by the
   GitHub account's **primary, verified** email address. So a learner's
   first sign-in works only once the owner has created their account with
   that address and the GitHub login type; it then links to the GitHub
   account and is matched that way from then on. The one exception is the
   very first account on an empty deployment, which Coder always admits
   and makes the owner ("First admin sign-in", above).

**Existing accounts keep working.** Nothing deletes or suspends an
account, and a session already open is not checked again: Coder checks the
organisation and the team only when someone signs in with GitHub, and an
open browser session is extended while it is used (24 hours of idleness
ends it, Coder's default). Every later GitHub sign-in passes all three
gates again, so an account outside the team is refused at its next sign-in.
On 2026-10-16 the deployment had one account that signs in with GitHub,
the owner's, who is in the team. `hcw-status` ("The status token for the
site", below) is not affected at all: it never signs in, Coder cannot even
match a GitHub sign-in to its `.invalid` address, and the tokens it acts
with (`coder tokens create`, login type `token`) are not checked against
GitHub by any gate.

Adding a learner is therefore two steps, the team and then the account,
and removing one is the team and then a suspension; both, with the lines
to paste, are in `docs/runbooks/labs-host.md`, "Coder sign-in: adding and
removing a learner".

### Publishing the template

**Normally nobody runs this.** Every `bootstrap.sh` run publishes each
template under `coder/templates` whose files changed, with the host's own
rotation credential (`ansible/roles/coder/README.md`, "Publishing the
template"), and has needed no token since that credential was seeded on
2026-10-10. What follows is the fallback for when there is no working
rotation credential, such as a rebuilt host. Pass a template's name to
publish one other than `hcw-lab`.

`/usr/local/sbin/hcw-coder-template-push`, which the `coder` role installs,
publishes the template from the host with the Coder CLI that is already
inside the `coder` container, so nothing is installed on the workstation
and the `winget install Coder.Coder` this section used to start with is not
needed.

**The token.** Yours, short-lived, made in a pane: step 1 of "The status
token for the site", below, has where Coder's **Tokens** page is and how to
make `hcw-setup` with the shortest expiry the form offers. Publishing needs
the Owner or Template Admin role, and the owner's account is Owner. The
site's `hcw-status` token cannot publish, by design: its scopes only read.
The helper reads the token from standard input and nowhere else, so it is
never on a command line on the host, never printed and never written to a
file.

**The line.** PowerShell, with the token held in `$t` as step 1 of "The
status token for the site" shows, not on the clipboard:

```powershell
$t | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-coder-template-push"
```

It publishes what `/opt/hcw-src` holds, which is the commit the last
`bootstrap.sh` run checked out ("Which commit runs", above). So when a
change to the template merges, re-run `bootstrap.sh` first, then this line.
The helper copies `main.tf`, `.terraform.lock.hcl` and `README.md` (every
`*.tf`, the lock file and the README, never the test beside them) from
`/opt/hcw-src/lab-host/coder/templates/hcw-lab` into a new temporary
directory in the `coder` container, runs `coder templates push hcw-lab
--directory <that directory> --yes` and then `coder templates edit hcw-lab
--default-ttl 1h --yes` there, reads the active version and the default
autostop back, and removes the directory. `templates push` creates the
template the first time and publishes a new version after that; it has no
TTL flag, which is why the edit follows it. `1h` is
`coder_template_default_ttl` in `ansible/roles/coder/defaults/main.yml`,
the one place it is set. `ansible/roles/coder/README.md`,
"hcw-coder-template-push", has each step.

**Success** starts with a line naming the three files, then Coder's own
output: the provisioner's log of the template's resources, `Updated version
at <time>!` (the first publish prints `The hcw-lab template has been
created at <time>!` above it) and `Updated template metadata at <time>!`.
The last line is the helper's, with the version name Coder chose:

```text
hcw-coder-template-push: published hcw-lab from /opt/hcw-src/lab-host/coder/templates/hcw-lab. Active version: <version name>. Default autostop: 1h0m0s.
```

Anything else ends with a non-zero exit and says why:

| Message | Means |
| --- | --- |
| `the token on stdin was empty` | The clipboard was empty. Nothing was published |
| `the first line on stdin is not a Coder token` | The clipboard held something else, usually the line itself: paste the line first, then copy the token. What it held is not shown. Nothing was published |
| `You are signed out or your session has expired` | Coder's answer to a token that has expired or been deleted. Make another in the pane |
| `Coder is probably not running` | The `coder` container is not up (`sudo docker compose --project-directory /etc/hcw/coder ps`, bash, on the host) |
| `publishing hcw-lab failed` | Coder refused a step; its own message is above this line |

Re-running is safe: every run publishes a new version and sets the
autostop again, so a run that failed after the push is settled by the next
one that succeeds. Afterwards, delete `hcw-setup` in the pane (step 5 of
"The status token for the site") or let it expire.

**When.** Once, to create the template, and again whenever `main.tf`, its
lock file or the template's README changes on `main`, after the
`bootstrap.sh` run that checks the change out. `../coder/README.md`,
"Updating", lists the changes that need it.

**Or not at all, once the rotation credential is seeded** (owner approval
2026-10-08; `docs/runbooks/labs-host.md`, "Automatic renewal"). Every
`bootstrap.sh` run then publishes the template itself, with that credential
on this same helper's stdin, whenever one of the files above or the default
autostop changed since its last successful publish, and says so in the
`coder` role's output. The line above stays the way to publish by hand.

**What a workspace from it looks like.** It is what a lab's pane on the
site creates, through the lab launcher: for example
https://hybridcloudworks.com/education/labs/terraform-validate-walkthrough,
signed in, shows Coder's `Warning: Automatic Workspace Creation` dialog
with `lab: terraform-validate-walkthrough` under Parameters. **Confirm and
Create** creates the workspace `lab-tfv`, and once code-server is healthy
the pane opens it with that lab's folder: trusted, so with no Restricted
Mode banner; with no Chat panel; on the folder's README where it has one
(the Landing Zone Builder lab's does), on VS Code's Welcome page where it
has none. Those are the template's editor settings (`settings` in
`main.tf`). A workspace built before a publish keeps the version it was
built from: when the pane shows Coder's page for it, as it does while the
workspace is stopped, **Update and start…** starts it on the new version
and **Start** on the old one. Before the template exists at all, a lab's
pane says `Lab workspaces aren't available right now.` and never opens
Coder's create page.

### The status token for the site

The site's Coder card (#680) reads Coder with `CODER-STATUS-TOKEN`, from
the Function App, never the browser. `functions/src/lib/labs/coder-status.js`
makes three calls with it: `GET /api/v2/templates`, `GET
/api/v2/templateversions/{id}` for each template's active version, and `GET
/api/v2/workspaces?q=status:running`, whose `count` is the running figure
on the card. Its requests carry no `Sec-Fetch-Dest`, so the panes-only
rule passes them.

**The token is not what opens the panes.** Whether Coder answers comes from
`GET /api/v2/buildinfo`, which needs no token, and a lab's pane opens on
that alone, with only `CODER-URL` set. Without the token, or with one Coder
refuses (expired or revoked), the card says only that Coder is reachable,
lists no templates and counts nothing, and the Function App logs a warning
naming `CODER_STATUS_TOKEN`. So the panes work before this section is done,
and keep working if the token lapses.

**What the token is, and why.** On Coder Community v2.37.3 the least
privilege that answers all three correctly is a token scoped to
`template:read` and `workspace:read`, belonging to a user of its own,
`hcw-status`, that holds the Template Admin role. Each part was measured on
2026-09-28 against the pinned image, with one workspace running that
belonged to another user:

- **A user of its own**, so the token is not the owner's, and its calls
  show in Coder's logs as `hcw-status`. Community cannot make a user that
  has no sign-in: `--login-type none` needs a service account, and the
  server answers `Service Accounts is a Premium feature`. A password user is
  refused while password sign-in is off (`Password based authentication is
  disabled!`). So `hcw-status` is a GitHub user whose address,
  `coder-status@hybridcloudworks.invalid`, is on a domain that cannot
  receive mail. GitHub cannot verify it for any account, so no GitHub
  sign-in can ever become this user; only the token can act as it.
- **Template Admin**, because it is the only role below Owner that can read
  every user's workspaces. As Member, Auditor or User Admin, the running
  count answered `0` while the workspace ran, and the card would have shown
  an idle lab.
- **The two scopes**, because they cap Template Admin at reading.
- **`api_key:read` as well, since 2026-10-05 (#763)**, so the token can read
  its own record — `GET /api/v2/users/me/keys/{id}`, the id being the part
  of the token before the dash — and the Integrations card can say when it
  expires: `Status token expires on <day> (<n> days)`, red inside the last
  30 days with the renewal steps named. Coder documents the scope as "View
  API keys"; it reads key metadata, never a secret. A token made without it
  (the 2026-09-28 one) is refused that read, and Coder v2.38 says so with
  **404**, not 403: its `apiKeyByID` handler answers an unauthorized read as
  not found (`httpapi.Is404Error`). Both codes mean the scope (#1009), and
  the card says `Status token expiry unknown: … Re-issue the token with
  api_key:read added`. Re-issuing is the steps below, with the scope on the
  `coder tokens create` line as written there.

| `hcw-status`'s role, and the token's scope | The three calls | Change a template | Delete a template | Stop a workspace |
| --- | --- | --- | --- | --- |
| Template Admin, `template:read` and `workspace:read` | 200, 200, `count` 1 | Refused (`rbac: forbidden`; nothing changed) | 403 | 403 |
| Template Admin, no scope | 200, 200, `count` 1 | **200, changed** | **200, deleted** | 403 |
| Member, Auditor or User Admin | 200, 200, `count` **0** | Refused | not tried | Refused |

**Before you start.** Coder is on and you have signed in as its owner
("First admin sign-in", above). The steps run Coder's CLI inside the `coder`
container on the host, over `ssh hcw-lab`, so nothing is installed on the
workstation and nothing is a top-level visit. The CLI needs one token of
yours to act as the owner, which it reads from standard input, so it never
appears on a command line.

1. **A token of yours, made in a pane.** The panes open as soon as Coder
   answers, before this token exists, so the token the CLI needs is made
   in Coder's own **Tokens** page inside one:

   1. Signed in (the **Sign in with GitHub** button on the page below does
      it), open the pane of a lab you have no workspace for yet. The first
      time, that is any of them, for example
      https://hybridcloudworks.com/education/labs/landing-zone-builder-output.
   2. The pane shows Coder's own page for creating that workspace, with a
      dialog titled `Warning: Automatic Workspace Creation`. Choose
      **Cancel**. The page stays, now as Coder's create form, with Coder's
      account menu at its top right.
   3. Open that menu, choose **Account**, then **Tokens** (Coder's path is
      `/settings/tokens`), then **Add token**. Name it `hcw-setup` (delete
      an older `hcw-setup` first: names are unique), choose the shortest
      expiry the form offers, and create it. Keep the page open: Coder
      shows the token once.
   4. Hold it in PowerShell. Paste this line, press Enter, then paste the
      token at the masked prompt and press Enter:

      ```powershell
      $t = [Net.NetworkCredential]::new('', (Read-Host 'hcw-setup token' -AsSecureString)).Password
      ```

      A variable, not the clipboard, because every later line is itself
      copied from this page: on 2026-09-28 copying step 3's line replaced
      the token on the clipboard, and Coder answered `You are signed out`
      to the line's own text.

   Do it within ten minutes of opening the pane: after that the pane stops
   waiting for the workspace and says the workspaces are unavailable, and
   reloading the page starts it again. A lab whose workspace is stopped
   shows Coder's workspace page instead, with the same menu, which works
   too; one whose workspace is running opens the editor, which has no menu.

   A named token rather than the sign-in session, which this step used to
   take out of the browser's developer tools: it is created and deleted
   (step 5) in Coder's own page, it expires on its own well before the
   session would be renewed, and copying it does not copy the browser's
   whole signed-in session.

2. **The user and its role.** PowerShell, with that token in `$t`:

   ```powershell
   $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder users show hcw-status >/dev/null 2>&1 || coder users create --username hcw-status --email coder-status@hybridcloudworks.invalid --login-type github; coder users edit-roles hcw-status --roles template-admin --yes && coder users show hcw-status; }'"
   ```

   Success is the user's table with `Username` `hcw-status`, `Status`
   `dormant` and `Roles` `Template Admin`. The first run prints `A new user
   has been created!` above it, with a note about GitHub sign-in that does
   not apply to this user. A second run changes nothing. `You are signed
   out or your session has expired` means `$t` does not hold the step 1
   token: repeat step 1's last line.

3. **The status token, into `$s`.** PowerShell. The token is captured, so
   it is never on the screen, and success prints nothing:

   ```powershell
   $s = $t | ssh hcw-lab "sudo -n docker exec -i -e CODER_URL=http://127.0.0.1:7080 coder sh -c 'tr -d \\r | { read -r CODER_SESSION_TOKEN; export CODER_SESSION_TOKEN; coder tokens create --user hcw-status --lifetime 1y --scope template:read --scope workspace:read --scope api_key:read --scope user:read; }'"
   ```

   Check what `$s` holds, PowerShell:

   ```powershell
   Invoke-RestMethod 'https://coder.lab.hybridcloudworks.com/api/v2/workspaces?q=status:running' -Headers @{ 'Coder-Session-Token' = "$s".Trim() } | Select-Object count
   ```

   Success is a `count` row (`0` until someone starts a workspace). A `401`
   means `$s` holds no token, because step 3 printed an error instead of
   one; repeat step 1's last line and step 3.

4. **Seed it.** Put it on the clipboard. Nothing is copied from this page
   after this line, so it stays there. PowerShell:

   ```powershell
   "$s".Trim() | Set-Clipboard
   ```

   Then at https://hybridcloudworks.com/admin/integrations?tab=keys, in the
   Hybrid Lab section, paste into **Coder status token** and save.
   Success is the row's light turning green. A minute later (the card's read
   is cached for one), PowerShell:

   ```powershell
   Invoke-RestMethod https://api-azure.hybridcloudworks.com/api/public/labs/coder-status | Select-Object configured, reachable, templates, capacity
   ```

   Success is `configured` `True` and `reachable` `True`, with `capacity`
   showing `running` as a number and `max` 5, and `templates` listing
   `hcw-lab` once it is published ("Publishing the template", above; empty
   before that). On https://hybridcloudworks.com/admin/integrations the
   Hybrid Lab card's test then ends `Status token expires on <day> (<n>
   days)` — the reminder that replaces a calendar (#763). `running` still empty (no number) means Coder refused the
   token, and the check in step 3 tells why. `reachable` `False` means Coder
   did not answer at all, token or not.

5. **Clean up.** Clear both variables and the clipboard, PowerShell:

   ```powershell
   Remove-Variable t, s; Set-Clipboard -Value ' '
   ```

   Then retire the step 1 token. In a pane, as in step 1: **Account**,
   **Tokens**, then delete `hcw-setup`. It would expire on its own after
   the form's shortest lifetime (seven days), but nothing needs it once
   this section is done.

`CODER_STATUS_TOKEN` was first seeded on 2026-09-28 and came off
`EXPECTED_UNRESOLVED` in `scripts/check-unresolved-secrets.mjs` the same
day, so an unresolved reference now fails the monitor like any other.

The token expires a year after step 3: the one seeded on 2026-09-28
expires on 2027-09-28, and #763 is the reminder, due a month before. If it
lapses first, the panes keep opening and the card stops listing templates
and counting workspaces until it is renewed. **Since 2026-10-08 the host
renews it** once the owner has seeded the rotation credential
(`docs/runbooks/labs-host.md`, "Automatic renewal"): a 90-day token with the
three read scopes and `user:read`, handed to the site and stored in Key Vault without the
clipboard, from the day the token the site holds turns 60 days old. Step 2
above still makes `hcw-status`, which that needs. To renew by hand, run
steps 1, 3, 4 and 5 again. Step 3 makes a
new token each time (Coder names each one, which is why the line gives no
`--name`), and the old one stops working at its own expiry.
`coder tokens list --all` lists both, with `hcw-status` as their owner.

**The lab host can renew it instead (2026-10-08).** The host mints the new
token itself and hands it to the site through the lab agent's own
certificate, never Key Vault, which still refuses the host:
`vps-agent/bin/report-coder-automation.js` posts it to `POST
/api/agent/reportCoderAutomation`, and the site stores it as
`CODER-STATUS-TOKEN` only after three reads with it answer exactly 200: the
running-workspaces read above gives a count, `GET /api/v2/users/me` names
`hcw-status` (or `CODER_STATUS_USER`), and the token's own key record lists
`template:read`, `workspace:read` and `api_key:read`, with `user:read` the
one more it may carry. An unscoped key, a key with any other scope, or
another user's key is refused (`functions/src/lib/labs/coder-status.js`,
`verifyStatusToken`). Coder v2.38 shows a token its own user and key record
only with `user:read` (both reads load the caller's user through its
authorizing store), so the host should mint with `--scope user:read` added
to the three on step 3's line; that is from Coder's source and not yet
measured on the lab's Coder. Each run also
says how it went, and the Hybrid Lab card at
https://hybridcloudworks.com/admin/integrations?tab=services&group=labs
shows that under **Coder**: when the token was last renewed, when the
host's rotation credential expires, when the template was last published,
the last check, and its last error in amber or red. Until the host is set
up the card reads `Automatic renewal not set up yet`, and the steps above
stay the way to renew by hand either way. Setting the host up is
"Automatic renewal".

### Kill switches

Two, in ADR 0032's words, and emptying the allowlist is neither.

**No new learners; existing ones keep working.** This is how the lab runs
since 2026-10-16: `coder_oauth2_github_allow_signups: false` in
`ansible/group_vars/all.yml`, so no sign-in creates an account, and a new
learner exists only once the owner creates their account ("Who signs in",
above). Not creating accounts is the switch. To refuse even someone whose
account was made but who has not signed in yet, suspend that account, the
same line as removing a learner in `docs/runbooks/labs-host.md`, "Coder
sign-in: adding and removing a learner".

**Everyone, at once.** Immediate, bash, on the host:

```bash
sudo docker compose --project-directory /etc/hcw/coder stop coder
```

Caddy then answers **503** `Lab workspaces aren't available right now.`,
the site's own sentence for the same state, for
`coder.lab` and every `*.coder.lab` name; running workspaces lose their
agent connection and stop themselves at their deadline. The lab launcher's
files are Caddy's own, so a pane opened after the stop still loads the
launcher; its reads of Coder then get that 503, and within about fifteen
seconds it says the same sentence. Within a minute the site's status read
sees Coder gone too, and the lab pages stop opening panes at all. Durable: a pull
request setting `coder_enabled: false`, which also removes the Caddy route
(the names answer Caddy's 404) and stops the backup timer; the PostgreSQL
volume stays, so re-enabling brings the same users and templates back.
Those two answers, the 503 and the 404, are what a pane or a command-line
client sees. A top-level browser visit is still redirected to the labs page
first, as it is while Coder runs. To resume after an immediate stop:

```bash
sudo docker compose --project-directory /etc/hcw/coder up -d
```

### Rotating the GitHub OAuth secret

Regenerate the secret on the OAuth app's page under
https://github.com/organizations/HybridCloudWorks/settings/applications
and put it in the vault. PowerShell, pasted first, then copy the secret,
then Enter ("Setting a key", above):

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_coder_oauth2_github_client_secret"
```

Then re-run `bootstrap.sh`. The play rewrites
`coder.env` and Compose recreates the `coder` container because its
environment changed; the `PLAY RECAP` shows `changed` for those two tasks
and the login page, in a pane, still offers GitHub. Learners already
signed in keep their sessions.

### Rotating the PostgreSQL password

The database stores the password at first initialisation, so a vault edit
alone would lock Coder out. Change it in the database first, then in the
vault. Bash, on the host; the line generates the new value, sets it in the
database and then in the vault, and never prints it:

```bash
NEW="$(openssl rand -hex 32)" && sudo docker compose --project-directory /etc/hcw/coder exec -T coder-postgres psql -U coder -d coder -v ON_ERROR_STOP=1 -c "ALTER USER coder PASSWORD '$NEW'" && printf '%s\n' "$NEW" | sudo -n /usr/local/sbin/hcw-vault-set vault_coder_postgres_password; unset NEW
```

Success prints `ALTER ROLE` and then `hcw-vault-set: set
vault_coder_postgres_password (value not shown)` with the vault's key
names. Re-run `bootstrap.sh` promptly, with `HCW_REPO_REF=HEAD`
("Re-running", above): Coder's open connections keep working, new ones fail
until the run recreates the container with the new URL.

### Backups and restore

The timer writes `/var/backups/coder/coder-<UTC timestamp>.sql.gz` nightly
and keeps seven days, and, while the host is Connected to Arc, uploads each
dump as it is written to the `host-backups` container of
`stlabhybridprodcus01` as the Arc identity (`ansible/roles/backups/README.md`;
LAB-9). The local copies are the convenience against operator error; the
off-host copy, immutable for 35 days, is the backup
(`docs/architecture/labs-host.md`). Vault's raft store is snapshotted to
`/var/backups/vault/` and uploaded the same way at 03:45 UTC once the owner
has seeded its token (`docs/runbooks/labs-host.md`, "Off-host backups").
Bash, on the host, to see the dumps and to take one now:

```bash
sudo ls -l /var/backups/coder
```

```bash
sudo systemctl start coder-postgres-backup.service && sudo systemctl status coder-postgres-backup.service --no-pager
```

Every upload is one journal line tagged `hcw-backup-upload`; the last three
nights, bash, on the host:

```bash
sudo journalctl -t hcw-backup-upload --since -3d --no-pager
```

**From the container**, which is what a rebuilt host does
(`docs/runbooks/labs-host.md`, "Reinstalling the host", step 7):
`hcw-backup-restore` lists the blobs as the Arc identity, fetches the newest
(or a named one) to `/var/backups/restore/`, and with `--yes` does the three
lines below as one command, or restores a Vault snapshot with a token on
stdin (`ansible/roles/backups/README.md`, "Restore"). Bash, on the host:

```bash
sudo /usr/local/sbin/hcw-backup-restore list
```

```bash
sudo /usr/local/sbin/hcw-backup-restore coder --yes
```

Success is `restored coder/coder-<UTC stamp>.sql.gz into coder-postgres`.

**From a local copy**, the newest dump into an empty database — three
lines, bash, on the host: stop Coder, recreate the database from the dump,
start Coder.

```bash
sudo docker compose --project-directory /etc/hcw/coder stop coder
```

```bash
sudo sh -c 'docker compose --project-directory /etc/hcw/coder exec -T coder-postgres psql -U coder -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE coder" -c "CREATE DATABASE coder OWNER coder" && gunzip -c "$(ls -t /var/backups/coder/coder-*.sql.gz | head -1)" | docker compose --project-directory /etc/hcw/coder exec -T coder-postgres psql -U coder -d coder -v ON_ERROR_STOP=1 -q'
```

```bash
sudo docker compose --project-directory /etc/hcw/coder start coder
```

Success is `DROP DATABASE`, `CREATE DATABASE`, no error from the third
`psql`, and the `buildinfo` line under "Enabling" answering again within a
minute.

## Tool add-ons

The `addons` role runs the tool add-ons (ADR 0035; the standard is
`docs/standards/addon-integration-standard.md`; the role's decisions are
`ansible/roles/addons/README.md`): independently built tools the site shows
in a sandboxed pane at `https://hybridcloudworks.com/tools/<id>`, each one
hardened container on the loopback behind Caddy at
`<id>.lab.hybridcloudworks.com`. The first row is `migration`, the Azure
migration assessment, image `docker.io/hybridcloudworks/hcw-addon-migration`,
on `127.0.0.1:18081`.

### Turning one on

Three things, in the pull request that adds or enables the row, and one on
the host. In `ansible/group_vars/all.yml`: the row's `enabled: true`, its
`image_tag` and `image_digest` ("Bumping the digest", below), and the
widget's public site key in `env.AMO_TURNSTILE_SITE_KEY`. On the host, the
widget's secret in the vault, the same one line as every other key:

```powershell
(Get-Clipboard -Raw) | ssh hcw-lab "sudo -n /usr/local/sbin/hcw-vault-set vault_addon_migration_turnstile_secret"
```

Then merge and re-run `bootstrap.sh` (above). The role refuses to start a
container whose vault key is unset, naming the key and that line. Creating
the widget is the owner's step in `docs/runbooks/labs-host.md`, "Tool
add-ons", with the exact page and fields; one widget per add-on, separate
from the site's own, because the widget is bound to the add-on's hostname.

### The verification widget

The add-on gates every upload with a human-verification token it verifies
server side with the secret above. The site key is public (the add-on
publishes it in `/api/health` so the pane renders the widget), so it lives
in `group_vars`; the secret never does. The `migration` row carries its own
widget's site key (`hcw-addon-migration`, created 2026-10-11). The role
refuses to deploy any row whose environment still carries one of the
provider's documented test keys (`addons_test_site_keys`): a real widget
secret rejects the token a test key produces, so the pair would never verify
an upload. A new add-on's row starts with a test key until its own widget
exists.

### Bumping the digest

An add-on release is a `v*` tag in its repository whose `publish-images`
workflow pushes `docker.io/hybridcloudworks/hcw-addon-<id>:<version>` and
prints the image index digest in its run summary. Read the same value from
the registry; PowerShell or bash, anywhere with Docker:

```powershell
docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-addon-migration:0.3.0
```

The `Digest:` line is `image_digest`, and `0.3.0` is `image_tag`, of the
`migration` row in `ansible/group_vars/all.yml`. Merge and re-run
`bootstrap.sh`; the role pulls by digest and recreates the container. A row
with an **empty** digest is not deployed: the run says
`hcw-addon-migration is enabled but addons[].image_digest for migration is empty`
and the name answers 503 with the site's sentence until the digest is
written in. Rollback is the previous digest and a run.

### Kill switches

`enabled: false` on the row removes that container; `addons_enabled: false`
removes every add-on and the Caddy route; on the site, unsetting the
`ADDON_<ID>_URL` Function App setting in `infra/functionapp.tf` closes the
pane without touching the host. Each is one line and a run.

## Portainer

The `portainer` role runs Portainer Business Edition for the owner
(owner decision 2026-09-26; `ansible/roles/portainer/README.md` has the
edition, its licence and the pin). It holds the Docker socket, which is root
on this host, so it is published on `127.0.0.1:9443` and nowhere else, has
no Caddy route, and is reached through an SSH tunnel: whoever can open the
tunnel already has an SSH login, which is `sudo`.

### Turning it on

In a pull request, set `portainer_enabled: true` in
`ansible/group_vars/all.yml`, merge it and re-run `bootstrap.sh` (above).
Success is a `PLAY RECAP` with `failed=0` and the task `portainer : Say how
to reach Portainer` printing `Portainer 2.45.1 answers on
https://127.0.0.1:9443 on this host and nowhere else`.

### The first sign-in, and every visit after it

Every visit is one PowerShell line on the workstation, which opens a shell
on the host and the tunnel together, then <https://localhost:9443>:

```powershell
ssh -L 9443:127.0.0.1:9443 hcw-lab
```

The first sign-in has two more steps, because a fresh Portainer stops
serving five minutes after it starts and wants the one-time setup token it
prints in its log: restart it and read the token from inside that shell,
then create the administrator and enter the licence key. The steps, and
what success looks like, are in
[docs/runbooks/labs-host.md](../docs/runbooks/labs-host.md), "Portainer
through an SSH tunnel". The administrator's password is in the owner's
password manager and the licence key is entered in Portainer's UI; neither
is in the repository or the Ansible vault.

### Turning it off

Durable: a pull request setting `portainer_enabled: false`, merged and
applied. The container is removed and the `portainer-data` volume stays, so
turning it back on brings back the same administrator, settings and
licence. Immediate, bash, on the host (the next run starts it again while
`portainer_enabled` is true):

```bash
sudo docker stop portainer
```

## HashiCorp Vault

The `vault` role runs HashiCorp Vault host-native, for **lab-host secrets
only** (owner decision 2026-09-26; `ansible/roles/vault/README.md` has the
verification chain, TLS and mlock). Not the Ansible vault above: that one
holds what the playbook needs and lives in `/etc/hcw/ansible`.

**The boundary.** This host runs learner workloads, and an escape from a
workspace or a job container is root on the host, which can read an
unsealed Vault's memory. So this Vault never holds a production
HybridCloudWorks secret: those stay in Azure Key Vault
`kv-site-prod-cus-01`. Nor does it hold anything that exists nowhere else,
because the host holds no data of record (ADR 0032); every value in it must
be one its issuer can issue again.

### Turning it on

In a pull request, set `vault_enabled: true` in
`ansible/group_vars/all.yml`, merge it and re-run `bootstrap.sh` (above).
Success is a `PLAY RECAP` with `failed=0` and the task `vault : Say what
state Vault is in` printing `It is not initialised`. The role never
initialises or unseals Vault; the next section is the owner's.

### Initialising, unsealing, and after every restart

Owner steps, over SSH, in
[docs/runbooks/labs-host.md](../docs/runbooks/labs-host.md), "HashiCorp
Vault: initialising and unsealing": `vault operator init` once, whose five
unseal keys and root token go to the owner's password manager and nowhere
else, then `vault operator unseal` three times. What a restart does depends
on the seal. **Under Shamir keys a restart seals Vault**, and so does every
reboot, including the idle reboot at 04:30 (`hcw-reboot-when-idle.timer`),
so the three unseals are repeated after each. **Under auto-unseal it
unseals itself**, the idle reboot included, with no key typed; the five
keys are recovery keys then and cannot unseal it (next section). This host
has auto-unsealed since 2026-09-29, so after a reboot there is nothing to
type; `vault status` says which seal a host is on, `Seal Type
azurekeyvault` with `Recovery Seal Type shamir` for auto-unseal, `Seal
Type shamir` alone for keys. The login shell sets
`VAULT_ADDR=https://127.0.0.1:8200` and `VAULT_CACERT`
(`/etc/profile.d/hcw-vault.sh`), so `vault status` needs no flags; success
before initialising is `Initialized false` and `Sealed true`, exit code 2.

### Auto-unseal

On since 2026-09-29 (#726; ADR 0032, amendment of that date): the owner
accepted the trade and ran the migration, and a restart came back unsealed
with no keys typed. With it on, Vault unseals itself at every start with the key
`vault-seal` in the lab-only Key Vault `kv-labhybrid-prod-cus-01`
(`infra/lab-hybrid.tf`), signing in as the Arc machine's identity through
the agent on `127.0.0.1:40342`. Nothing is stored on the host for it. The
five Shamir keys become recovery keys, which can no longer unseal Vault:
if Key Vault or the key is unreachable, Vault stays down until it is back.

The switch is on the host, as Arc's is: `/etc/ansible/facts.d/hcw_vault_seal.fact`
holding `{"enabled": true}`. The `vault` role writes the seal only after it
has read the key through Key Vault as the Arc identity, and refuses to drop
it while Vault's data is under it (`ansible/roles/vault/README.md`,
"Auto-unseal"). Moving the running Vault onto it is the owner's
`vault operator unseal -migrate`, one line at a time, in
[docs/runbooks/labs-host.md](../docs/runbooks/labs-host.md), "HashiCorp
Vault: moving to auto-unseal". Once it is on, never run `bootstrap.sh` with
`HCW_REPO_REF` at a commit older than #726: that role knows nothing of the
seal and would write a configuration without it.

### Turning it off

Durable: a pull request setting `vault_enabled: false`, merged and applied.
The unit is stopped and disabled and `/var/lib/vault` stays, so turning it
back on brings back the same Vault, sealed. Immediate, bash, on the host
(the next run starts it again while `vault_enabled` is true):

```bash
sudo systemctl stop vault
```

## The agent identity

The first run generates the agent's private key **on the host** and never
moves it: `/etc/hcw/labs-agent.pem` holds the key and certificate as
`root:hcw-labs-agent` mode `0640`, so root owns it, the service reads it
through its group, and nobody else can (no ACLs). The certificate alone is
`/etc/hcw/labs-agent.crt`, and its CN is the agent id (`labs_agent_id`,
`vps-hostinger-01`).

Everything else the agent needs is one owner step, run once on the
workstation: `scripts/lab/Register-LabAgent.ps1`. It checks `az` is signed
in to the tenant; reads that certificate over `ssh hcw-lab` (the host checks
it against the private key and only reports whether they match); creates or
finds the app registration and service principal
`sp-labs-agent-lab-hybrid-prod-cus-01`; appends the certificate to it,
never replacing another credential; assigns it the one grant the Entra side
of the API checks, the `LabAgent` app role on the HCWSite API; has you
register the agent on the site, which writes the API's second gate, the
`lab_agents/vps-hostinger-01` registry document; writes the four
`vault_labs_agent_*` keys above into the vault; runs `bootstrap.sh`; and
reads the agent's state and journal to say whether it is heartbeating. The
registration is the one step done in the browser, because the route that
writes the document (`POST /api/cms/labs/agents`, #740) needs an admin's
sign-in: the script prints
https://hybridcloudworks.com/admin/labs?tab=agents with the agent id and the
service principal's object id to paste into **Register agent**, and waits
for Enter. It never prints a secret: the certificate is public, the four
values and the object id are identifiers, and the vault password never
leaves the host. A second run changes nothing and says so, without waiting,
and `-WhatIf` shows what a run would change.
PowerShell, from the repository root on `main` once this change has merged
(`Test-Path scripts/lab/Register-LabAgent.ps1` prints `True` when the working
tree has the script); when `az` is not signed in, the script stops and
prints the `az login` line to run first:

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabAgent.ps1
```

Success is the line `Agent: hcw-labs-agent is active and has logged no
failure since it started: it is heartbeating.` near the end of the run,
which then exits 0, and `vps-hostinger-01` Online at
https://hybridcloudworks.com/admin/labs?tab=agents.

### Revoking an agent

Revocation has two layers:
1. **Immediate site deactivation**: **Deactivate** on the agent's card in
   https://hybridcloudworks.com/admin/labs?tab=agents makes the Functions API
   immediately refuse any call from the agent with HTTP 403, and **Activate** undoes
   that.
2. **Entra credential deletion**: To permanently revoke the certificate on the app
   registration itself, list the credentials with
   `az ad app credential list --id $LABS_AGENT_CLIENT_ID` and remove the key with
   `az ad app credential delete --id $LABS_AGENT_CLIENT_ID --key-id <KEY_ID>`.

Every result the script can end with, and what each means, is
[docs/runbooks/labs-host.md](../docs/runbooks/labs-host.md), "The lab
agent's go-live".

## Rotating the agent certificate

The generated certificate is valid for 180 days and nothing renews it by
itself; the daily host timer (`hcw-cert-expiry-check.timer`) logs an expiry warning
to syslog once it is within 60 days of expiry (`labs_agent_certificate_warn_days`),
and the agent's card in Admin → Labs reflects the certificate's expiry date.
Rotation is a two-step swap so the agent never holds a key whose certificate
the app registration has not seen. Bash, on the host:

```bash
sudo sh -c 'umask 077 && openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 180 -subj "/CN=vps-hostinger-01" -keyout /etc/hcw/labs-agent.next.pem -out /etc/hcw/labs-agent.next.crt && cat /etc/hcw/labs-agent.next.crt >> /etc/hcw/labs-agent.next.pem'
```

Register the new certificate before the agent uses it, with the same script
as the first time. PowerShell, on the workstation, from the repository root:

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabAgent.ps1 -NextCertificate
```

It reads `/etc/hcw/labs-agent.next.crt`, checks it against
`labs-agent.next.pem` on the host, appends it to the app registration and
leaves the old certificate there; it touches neither the vault nor
`bootstrap.sh`. It ends by printing the swap below as one PowerShell line.
The same swap, bash, on the host:

```bash
sudo sh -c 'mv /etc/hcw/labs-agent.next.pem /etc/hcw/labs-agent.pem && mv /etc/hcw/labs-agent.next.crt /etc/hcw/labs-agent.crt && chown root:hcw-labs-agent /etc/hcw/labs-agent.pem && chmod 0640 /etc/hcw/labs-agent.pem && chmod 0644 /etc/hcw/labs-agent.crt && systemctl restart hcw-labs-agent'
```

Success looks like the agent back to Online on
https://hybridcloudworks.com/admin/labs?tab=agents within a minute, and
`sudo journalctl -u hcw-labs-agent -n 20 --no-pager` showing no `heartbeat
failed` line after its `starting against` line (a heartbeat that works logs
nothing). Only then remove the old certificate: run the script once more
without `-NextCertificate`, and once it finds the agent heartbeating it
prints the `az ad app credential delete` line for each other certificate on
the registration. A re-run of the play afterwards reports the certificate
task unchanged, because the file exists, and the expiry warning is gone.

## Azure Arc

The `arc` role (#663) onboards the host to Azure Arc, and it does nothing
until the host says so: `arc_enabled` in `ansible/group_vars/all.yml` reads
the local fact `/etc/ansible/facts.d/hcw_arc.fact` and is true only when
that file is JSON whose `enabled` is `true`. Arc membership belongs to the
host installation, not the repository: a rebuilt host has no fact, so its
first run leaves Arc alone and completes instead of stopping at the role's
fail-closed vault check before any later role runs.

Onboarding is two runs of `scripts/lab/Register-LabArc.ps1` on the
workstation, with one `hcw-azure` run between them. PowerShell, from the
repository root on `main` once this change has merged
(`Test-Path scripts/lab/Register-LabArc.ps1` prints `True` when the working
tree has the script). The first run creates the onboarding service
principal, lets the Terraform run identity write the audit policy, puts a
24-hour client secret and its three identifiers into the vault through
`/usr/local/sbin/hcw-vault-set`, and prints the workspace variables and the
plan to expect:

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1
```

After the apply, the second run writes the fact, runs `bootstrap.sh`, waits
for Connected, deletes the secret from Entra and the four `vault_arc_*` keys
from the vault, and installs the Azure Monitor Agent with its data
collection rule:

```powershell
pwsh -NoProfile -File scripts/lab/Register-LabArc.ps1 -Connect
```

The secret is never printed or written to the desktop: it goes from `az`'s
output to `ssh`'s standard input. Each run is idempotent and takes
`-WhatIf`. What each step prints, what success looks like and how to
disconnect is [docs/runbooks/labs-host.md](../docs/runbooks/labs-host.md),
"Arc onboarding".

## Validating without a host

Neither `ansible-core` nor `ansible-lint` is installed on the Windows
workstation; the checks run in the container CI's pip pins match, pinned by
digest so the result cannot change without a repository change. PowerShell,
from the repository root:

```powershell
docker run --rm -v "${PWD}\lab-host:/work" -w /work/ansible ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 sh -c "ansible-galaxy collection install -r requirements.yml >/dev/null && ansible-lint --profile production && ansible-playbook --syntax-check -i inventory/localhost.yml site.yml"
```

The same in bash (Git Bash or Linux), from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/lab-host:/work" -w /work/ansible ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 sh -c "ansible-galaxy collection install -r requirements.yml >/dev/null && ansible-lint --profile production && ansible-playbook --syntax-check -i inventory/localhost.yml site.yml"
```

A passing result prints `Passed: 0 failure(s), 0 warning(s) in N files
processed of M encountered. Profile 'production' was required, and it
passed.` followed by `playbook: site.yml`. That digest is
`community-ansible-dev-tools:latest` as of 2026-09-23 (ansible-lint 26.9.0,
ansible-core 2.21.4, the same pins CI installs with pip); when the pins in
`ci.yml` move, move this digest with them. CI runs the same two commands in
the `ansible-lint (lab-host)` job of `.github/workflows/ci.yml`, gated on
changes under `lab-host/`.

The same job runs the test of `hcw-vault-set`
(`ansible/roles/vault_tools/README.md`, "Tests"). It runs as root, which
the image is, against a scratch vault. PowerShell, from the repository root:

```powershell
docker run --rm -v "${PWD}\lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/vault_tools/tests/hcw-vault-set.test.sh
```

The same in bash (Git Bash or Linux), from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/vault_tools/tests/hcw-vault-set.test.sh
```

A passing result has no `not ok` line and ends with
`hcw-vault-set.test.sh: all` and the number of checks, then `checks passed`.

The same job runs the test of `hcw-coder-template-push`
(`ansible/roles/coder/README.md`, "Tests"): the helper rendered with the
role's defaults, run against a stub `docker`. It needs neither root nor
Docker. PowerShell, from the repository root:

```powershell
docker run --rm -v "${PWD}\lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/coder/tests/hcw-coder-template-push.test.sh
```

The same in bash (Git Bash or Linux), from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/coder/tests/hcw-coder-template-push.test.sh
```

A passing result has no `not ok` line and ends with
`hcw-coder-template-push.test.sh: all` and the number of checks, then
`checks passed`.

The same job runs the test of Coder automation
(`ansible/roles/coder/README.md`, "Tests"): `hcw-coder-automation` run
against a fake Coder API, a fake `systemd-run`, a fake site CLI and a fake
push helper, and the role's templates rendered with its defaults. It needs
neither root nor Docker on a host with Python, Jinja2 and PyYAML; in a
container, PowerShell, from the repository root:

```powershell
docker run --rm -v "${PWD}:/repo:ro" -w /repo python:3.14-slim bash -c "pip install -q jinja2 pyyaml && python3 lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py"
```

The same in bash (Git Bash or Linux), from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo:ro" -w /repo python:3.14-slim bash -c "pip install -q jinja2 pyyaml && python3 lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py"
```

A passing result has no `not ok` line and ends with
`hcw-coder-automation.test.py:` and the number of checks, then `passed, 0
failed`. The whole repository is mounted, because one check reads the
runbook in `docs/`; with `lab-host/` alone that line reads `skip -`.

The same job runs the test of the daily held-package report
(`ansible/roles/hardening/README.md`, "Tests"): the script and its units
rendered with the role's defaults, run against stub `apt-mark`, `apt` and
`logger`. It needs neither root nor Docker. PowerShell, from the repository
root:

```powershell
docker run --rm -v "${PWD}\lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/hardening/tests/hcw-held-upgradable.test.sh
```

The same in bash (Git Bash or Linux), from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd)/lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/hardening/tests/hcw-held-upgradable.test.sh
```

The same job also runs `roles/hardening/tests/unattended-upgrades.test.sh`,
which renders the unattended-upgrades override with the role's defaults and
asserts it names the allowed origins itself and leaves the reboot to
`hcw-reboot-when-idle.timer`, and
`roles/hardening/tests/hcw-reboot-when-idle.test.sh`, which renders that
timer's script and units and runs the script against stub `apt-config`,
`loginctl`, `docker`, `sleep`, `systemctl` and `logger`: a stand-down while
unattended-upgrades' own reboot is on, no reboot with a login session
(class `user`) open or a lab job container running, none held back by
lingering service managers, a failed run when `apt-config`, `loginctl` or
docker cannot answer, a deferral when the labs agent does not acknowledge
the hold in time, a deferral for a job or a login that appears while new
lab jobs are held before the second look, and exactly one `systemctl
reboot` when idle at both looks (LAB-13, #959). The two container
lines above run either with its path in place of the held-package test's;
mounted alone, `lab-host/` has no `vps-agent/` beside it, so one line of
the reboot test reads `skip -` instead of comparing the job label with the
agent's.

A passing result has no `not ok` line and ends with
`hcw-held-upgradable.test.sh: all` and the number of checks, then
`checks passed`. Mounted alone, `lab-host/` has no `infra/` beside it, so
one line reads `skip -` instead of comparing the data collection rule; CI
compares it.

The same job runs the test of `hcw-docker-volume-carry`
(`ansible/roles/docker/README.md`, "User namespaces"), which copies Coder's
PostgreSQL volume into the remapped data root. It chowns, so it runs as
root, which the image is. PowerShell, from the repository root:

```powershell
docker run --rm --network none -v "${PWD}\lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/docker/tests/hcw-docker-volume-carry.test.sh
```

The same in bash (Git Bash or Linux), from the repository root:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(pwd)/lab-host:/work:ro" -w /work/ansible --entrypoint bash ghcr.io/ansible/community-ansible-dev-tools@sha256:775c81d53058009dd47b97872f4a86d3b0a9ce16ad9af3cc48514ce4197aa787 roles/docker/tests/hcw-docker-volume-carry.test.sh
```

A passing result has no `not ok` line and ends with
`hcw-docker-volume-carry.test.sh:` and the number passed, then `0 failed`.
The agent's Docker proxy configuration is checked by
`scripts/lab-host-docker-proxy.test.mjs` (the `scripts (operations)` row)
and parsed by `haproxy -c` in the same `ansible-lint (lab-host)` job.

The Coder files have their own checks — the hardening test, the Compose
parse and `terraform validate` — listed in
[`../coder/README.md`](../coder/README.md) and run by the
`coder (lab-host)` job of the same workflow on changes under
`lab-host/coder/`.

## Bumping a pin

Most of this is automated (#949). Every Tuesday
`.github/workflows/lab-supply-chain.yml` runs
`scripts/lab-pins-upstream.mjs --bump host`, which moves every pin it watches
that is behind its publisher (Docker Engine, containerd, buildx, compose,
Caddy and its Cloudflare module, Coder, PostgreSQL, Portainer, Vault,
node_exporter, Node.js) together with the checksum or digest it read from
that publisher. It also re-reads the pins that are current but can be
rebuilt under the same name, an image tag re-pushed on a patched base or a
package given a new Debian revision, and moves the digest or revision when
it changed. Two files are held to those pins and move with them: the caddy
test's `CADDY_SHA512` (the release tarball's SHA512 from the publisher's
checksums file) and `scripts/fixtures/docker-cli-agent-requests.json`, which
`scripts/lab/record-docker-cli-fixture.mjs` re-records with the pinned
docker-ce-cli installed into a temporary directory from Docker's apt index:
the signing key checked against `docker_apt_key_checksum`, the InRelease
verified against it with gpgv, the index by the InRelease, the .deb by the
index. It opens or updates one pull request on the branch
`chore/lab-pins-host` whose body says where each value was read. A pin whose
checksum it could not verify is not moved; it is listed in the weekly issue,
and this section is how a person moves it. The same run proposes the lab
image's newest base digest and ansible-core's newest release in its line,
which this host installs too (`chore/lab-pins-image-base`), and each publish of
the lab images proposes their new digests to the two places that pin them
(`chore/lab-pins-image-digests`). Merging changes nothing on the host until
`bootstrap.sh` runs. The prose dates beside each pin in `group_vars/all.yml`
record the last read by hand; an automated bump's evidence is its pull
request. How fast a runtime advisory is fixed is
[`docs/runbooks/labs-host.md`](../docs/runbooks/labs-host.md), "Runtime
advisories".

| Pin | Lives in | How to read the current value |
| --- | --- | --- |
| Docker, buildx, compose, rootless extras | `docker_release_pins`, one entry per Ubuntu codename (the version strings name the release); `docker-ce-rootless-extras` takes the engine string | `roles/docker/README.md` |
| Azure Connected Machine agent | `arc_agent_version` | `roles/arc/README.md` |
| apt signing keys | `docker_apt_key_checksum`, `labs_agent_node_apt_key_checksum`, `arc_apt_key_checksums` (per codename: Microsoft signs the 26.04 and 24.04 repositories with different keys) | The bash lines below this table; a changed key is a decision, not a refresh |
| Caddy, Cloudflare module, builder image digest | `caddy_*` | `roles/caddy/README.md`; the digest is the index from `docker buildx imagetools inspect caddy:2.11.4-builder`, and the image is pulled by that digest, not by tag |
| Coder, PostgreSQL | `coder_image_*`, `coder_postgres_image_*` | `roles/coder/README.md`; index digests from `docker buildx imagetools inspect`, run as `image@digest` |
| Workspace image, Terraform providers, `code-server` module | `templates/hcw-lab/main.tf` under `../coder` | `../coder/README.md`, "Updating"; republished with `hcw-coder-template-push` after the `bootstrap.sh` run that checks it out ("Publishing the template", above). While `coder_enabled` is true, that run also pulls the new workspace digest (`lab_images`) |
| Job images | `IMAGES` in `vps-agent/lib/capabilities.js` | The comment above `IMAGES` there. Nothing to bump here: the next run pulls the new digest and removes the one it replaced (`roles/lab_images/README.md`) |
| The agent's Docker proxy (HAProxy) | `labs_agent_docker_proxy_image_tag`, `labs_agent_docker_proxy_image_digest` | The newest release of HAProxy's newest LTS line (https://endoflife.date/api/v1/products/haproxy/), the `-alpine` tag's index digest from the registry's `Docker-Content-Digest` and `docker buildx imagetools inspect`, which must agree. CI parses the proxy's configuration with `haproxy -c` at the new digest. No floor checks it |
| node_exporter | `node_exporter_version`, `node_exporter_checksum` | `roles/node_exporter/README.md` |
| AddOn images | `addons[].image_tag`, `addons[].image_digest`, one row per tool add-on | The add-on release's `publish-images` run summary prints the digest; `ansible/roles/addons/README.md`, "Bumping a pin", has the `docker buildx imagetools inspect` line. Hand-moved: `scripts/lab-pins-upstream.mjs` has no publisher newest for these, and no floor checks `image_tag` on a row |
| Portainer | `portainer_image_tag`, `portainer_image_digest` | `roles/portainer/README.md`, "Bumping the pin"; the newest LTS from Portainer's release list, the index digest from `docker buildx imagetools inspect`. No floor checks it: endoflife.date has no Portainer product |
| HashiCorp Vault and its signing key | `vault_version`, `vault_checksum`, `vault_pgp_key_checksum` | `roles/vault/README.md`, "Bumping the pin"; the checksum is the `linux_amd64.zip` line of the release's signed SHA256SUMS, and `scripts/version-floors.json` holds the version to the newest line. A changed key is a decision, not a refresh |
| Node.js | `labs_agent_node_version`; the line is `labs_agent_node_apt_repository_url` in `roles/labs_agent/defaults/main.yml` | NodeSource `node_26.x` package index |
| Repository commit | Not pinned. `HCW_REPO_REF` in `bootstrap.sh` defaults to `origin/main`, and `labs_agent_repo_ref` reads the playbook's own checkout | Nothing to bump: merge, then re-run. The run prints the sha; holding or rolling back a host is under "Re-running" |
| Collections, including the one transitive dependency | `requirements.yml` | Galaxy |
| Ansible tooling | `ANSIBLE_CORE_VERSION`, `ANSIBLE_CORE_SHA256` and `ANSIBLE_CORE_DEPS` in `../lab-image/versions.env`, which `bootstrap.sh` installs from (the weekly `chore/lab-pins-image-base` pull request moves them within their line); the pip pins in `ci.yml`; the image digest above | PyPI's JSON API (`https://pypi.org/pypi/<name>/<version>/json`, the wheel's `digests.sha256`); the image's `RepoDigests` |
| Python and uv | `PYTHON_VERSION`, `UV_VERSION` and `UV_SHA256` at the top of `bootstrap.sh` | https://www.python.org/downloads/ for the newest release; https://github.com/astral-sh/uv/releases for uv, whose `.sha256` asset beside `uv-x86_64-unknown-linux-gnu.tar.gz` is the value |
| Sigstore cosign | `cosign_version`, `cosign_checksum` in `ansible/group_vars/all.yml`; `COSIGN_VERSION`, `COSIGN_SHA256` at the top of `bootstrap.sh` | https://github.com/sigstore/cosign/releases, whose `cosign_checksums.txt` asset beside `cosign-linux-amd64` is the value (`roles/addons/README.md`) |

All in `ansible/group_vars/all.yml` unless the table says otherwise.

The apt signing key checksums are read with these three lines, bash, from
anywhere with network access; each prints the hex that goes after `sha256:`
in the matching variable. Docker's key first:

```bash
curl -sL https://download.docker.com/linux/ubuntu/gpg | sha256sum
```

NodeSource's key:

```bash
curl -sL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sha256sum
```

Microsoft's keys, for the Arc agent. The first is the `resolute` entry of
`arc_apt_key_checksums` (it signs the 26.04 repository), the second the
`noble` entry (it signs the 24.04 one):

```bash
curl -sL https://packages.microsoft.com/keys/microsoft-2025.asc | sha256sum
```

```bash
curl -sL https://packages.microsoft.com/keys/microsoft.asc | sha256sum
```
