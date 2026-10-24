# Labs host

The estate record for the lab host: the one machine in the estate that is not
in Azure. It is the on-premises half of the hybrid estate described in
[ADR 0032](../decisions/0032-learner-labs-platform.md), and this page is where
its shape is written down so that a change to it is a change to a document.

**State: live, and behind `main`.** The host runs: it is configured by the
playbook in `lab-host/`, Arc-connected, Coder answers on its public name, and
the job runner heartbeats (read-only review of 2026-10-08, #1009). This page
describes what `main` holds, and the host holds what its last `bootstrap.sh`
run checked out, which was before the changes listed under
[Applied state](#applied-state). Nothing re-runs the playbook on its own
(#950), so a merged change is on the host only after the owner's next run. A
row whose change has not reached the host says so. The Terraform that adopts
the VPS is in [`infra-lab/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/infra-lab)
(#661); its state is the Provisioning row. When a row changes, its status
changes here in the same pull request.

This page carries no addresses. The host's IP, its Hostinger identifiers and
its SSH host keys are read from the `hcw-lab` workspace and from the host
itself, never from a published page.

## Summary

| Attribute | Value | Status |
| --- | --- | --- |
| Provider | Hostinger, billed outside Azure ([cost analysis](cost-analysis.md)) | live |
| Plan | KVM 4 (4 vCPU, 16 GB RAM, 193 GB NVMe): read on the host on 2026-10-14 (`nproc` 4, `free -m` 15987 MB, `df -h /` 193 GB, 12 % used) — large enough for Coder workspaces beside the job runner | live |
| Provisioning | Terraform in [`infra-lab/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/infra-lab): `hostinger/hostinger` provider 0.1.23, HCP Terraform workspace `hcw/hcw-lab`, working directory `infra-lab/`, auto-apply off. The existing VPS is **adopted by an `import` block, never created**, because creating a `hostinger_vps` is a purchase and destroying one cancels it; `infra-lab/README.md` has the owner's steps and the plan counts to read before any apply | code in repository; whether the `hcw/hcw-lab` workspace exists is not readable from a session (no HCP Terraform token) and was not read; the VPS itself, read 2026-10-15: Azure Arc `Connected` (agent 1.68, `arcs-lab-hybrid-prod-cus-01`, last status change 2026-10-10), Ubuntu 26.04.1 LTS, up one week |
| Configuration | Ansible, from a playbook in this repository, run by the owner with `lab-host/bootstrap.sh` | live, and behind `main`: last converged 2026-10-14 05:08 UTC at `de0be17a` (`/etc/hcw/applied-commit.json`, read 2026-10-15; [Applied state](#applied-state)) |
| Operating system | Ubuntu 26.04 LTS, x86-64 (owner decision 2026-09-26: the latest LTS, and the VPS stays on it). `lab-host/` still accepts 24.04 LTS as a stated fallback and refuses anything else | running on the VPS; a clean reinstall is pending (owner decision 2026-09-26, [ADR 0032](../decisions/0032-learner-labs-platform.md) amendment of that date) |
| Runtime | Docker Engine only; no Kubernetes (owner decision 2026-09-24) | live |
| Public names | `lab.hybridcloudworks.com`, `*.lab.hybridcloudworks.com` and `*.coder.lab.hybridcloudworks.com`, Cloudflare DNS records managed from `hcw-lab` (`infra-lab/dns.tf`: the `lab` A record and CNAMEs to it for `*.lab`, `coder.lab` and `*.coder.lab`, all DNS-only; `coder.lab` has its own record because `*.coder.lab` makes it an empty non-terminal that `*.lab` does not answer for). One Caddy certificate carries all three names, issued by DNS-01. The target is the `_acme-challenge.lab` and `_acme-challenge.coder.lab` delegations into a dedicated lab zone; until that zone exists (owner decision 2026-09-25: none yet) there are no delegation records and Caddy writes its challenges in the production zone, the interim ADR 0032 accepts | live; DNS, the edge and the CSP matched the repository on 2026-10-08 (#1009) |
| Hybrid control plane | Azure Arc-enabled server in `rg-lab-hybrid-prod-cus`; heartbeat, auth syslog, service syslog at Warning and above, and four host counters to the Log Analytics workspace in `rg-mgmt-plat-prod-cus`; three alert rules there page the owner on heartbeat absence (30 min), root disk past 85%, and a watched unit failing (LAB-2, 2026-10-06) | live |
| Owner access | SSH as `hcwadmin` with the one pinned key, through **Azure Arc SSH** (#953; [ADR 0032](../decisions/0032-learner-labs-platform.md), amendment of 2026-10-16): `scripts/lab/Connect-Lab.ps1 -Arc` writes a `ProxyCommand` that fetches fresh relay credentials on every connection; `infra/lab-hybrid.tf` declares the Arc machine's connectivity endpoint with one SSH service configuration, port 22; the `arc` role turns the agent's incoming connections on for port 22 alone, extension allowlist unchanged. Arc SSH is a transport in front of sshd's key check, not a login. Port 22 is closed to the internet at ufw while Arc SSH is ready (#953 stage 3), and `alert-lab-ssh-login` pages any login that did not come through Arc. Break-glass is hPanel's **Web Console**, a console login that needs neither sshd, Arc nor port 22 ([runbook](../runbooks/labs-host.md), "When Arc SSH is down") | Arc SSH live since 2026-10-17; port 22 closed by the first `bootstrap.sh` run after #953 stage 3 merges and its `hcw-azure` run applies |
| Owner | Workload owner | — |

## Applied state

Merged is not applied. A change to `lab-host/` reaches the host when the
owner runs `bootstrap.sh`, which checks out `origin/main` and runs the
playbook. A change to a Coder template reaches Coder in that same run
while the host's rotation credential is seeded and Coder accepts it: the
`coder` role publishes every template whose files changed with it, so
nothing follows the run
([runbook](../runbooks/labs-host.md#after-a-merge-the-playbook-then-the-template-at-once)).
Without a working credential (a rebuilt host, or one revoked after a leak)
the role skips the publish and says to seed again, and "Publishing the
template" in `lab-host/README.md` is the fallback until it is.
Nothing does either on a schedule (#950).

The site watches the gap rather than closing it (#1009). The playbook's last
task records the commit the host converged from in
`/etc/hcw/applied-commit.json`, the agent sends it on every heartbeat, and
`checkAgentHealth` reads `main`'s commits under `lab-host/` and `vps-agent/`
from GitHub's public API once an hour. The Health Hub's **Lab host runs
main** probe turns critical when one of those commits has waited more than a
day unapplied, and the Labs **Agents** tab shows each host's commit and that
verdict. **Coder template published** turns critical when the template Coder
serves is not the one in the commit the host converged from, from the two
digests the host's daily Coder upkeep report carries. Both raise; neither
runs anything. The nightly check-mode run and the worktree-based `--check`
that #950 also asks for are not part of this.

The read-only review of 2026-10-08 (#1009) found the host last converged
around 2026-10-07T04:33Z, with the agent last restarted at 04:33:04Z. These
changes merged after that and were not on it:

| Change | Merged (UTC) | On the host |
| --- | --- | --- |
| LAB-6: guest configuration off on the Arc agent (#984) | 2026-10-07 06:21 | Not yet. Arc still reported `guestConfigurationEnabled: "true"` |
| LAB-3: the lab supply chain, including the held-package timer (#986) | 2026-10-07 06:40 | Not yet |
| Lab image digests (#989) | 2026-10-07 07:16 | Not yet |
| LAB-5: the agent behind its own Docker proxy and in no docker group, user-namespace remapping on the host daemon, Coder's workspaces on a rootless daemon (#987) | 2026-10-07 07:26 | Not yet |
| Lab images published to Docker Hub only (#1002), and the digests that followed (#1003) | 2026-10-08 05:53 and 06:24 | Not yet. The run that applies them publishes the template in the same run (the coder role, with the host's rotation credential) |
| ADR 0035: the `addons` role and the migration add-on's row, the per-name direct-visit redirect in the Caddyfile, and the add-on checks in `privilege_checks` | Not merged yet (the Phase 6 website pull request) | Not yet. The row's `image_digest` is written in at PR time from the add-on's `v0.3.0` publish, and the owner seeds `vault_addon_migration_turnstile_secret` before the run ([runbook](../runbooks/labs-host.md), "Tool add-ons") |

Each row below that describes one of these says when it merged and that it
is not yet on the host. When the owner's run has applied them, this section
records the date of that run and the commit it checked out, and those rows
lose the note.

## What runs on it

| Component | Role | How it runs |
| --- | --- | --- |
| Caddy | TLS termination and reverse proxy for the lab names; the only thing listening on 80 and 443. A build that includes the `caddy-dns/cloudflare` module, because the stock package and the official image do not and DNS-01 needs it. It also enforces [panes only](#panes-only) | Host-native systemd service; pinned version and SHA256 in `lab-host/ansible/group_vars` |
| Coder (Community edition) | Browser labs; learner sign-in by GitHub OAuth; Docker-based workspaces from the `lab-image/` images | Docker Compose, behind Caddy |
| PostgreSQL (Coder's database) | Coder's metadata: users, templates, workspace records. Listens on the Compose network only, never on the host | Docker Compose, a named volume |
| Docker socket proxy (`coder-docker-proxy`) | The one Compose service that holds a Docker socket, read-only, and with LAB-5 it is the sandbox daemon's (below), never the host's (merged 2026-10-07 in #987, not yet on the host: [Applied state](#applied-state)); the Coder server reaches Docker through it over a control network the two alone share, and gets only the API sections the proxy allows (containers, images, networks, volumes, lifecycle), never exec, build, swarm or system. The proxy reads paths, not bodies, so a privileged create still succeeds, and lands on the rootless sandbox daemon as an unprivileged user (LAB-5) | Docker Compose, control network only, no published port, `--userns=host` to open the sandbox daemon's socket |
| Sandbox Docker daemon (`coder_sandbox`) | A second, **rootless** Docker daemon, run by the unprivileged system user `hcw-coder-docker`; every Coder workspace runs on it, so a workspace escape or a privileged container a compromised Coder server asks for is that user's, never root's (LAB-5, merged 2026-10-07 in #987, not yet on the host: [Applied state](#applied-state)). The cpu, memory and pids controllers are delegated to it, so the template's limits hold | systemd user unit `hcw-coder-docker` kept up by lingering; socket `/run/hcw-coder-docker/docker.sock`; data under `/var/lib/hcw-coder-docker` |
| `vps-agent` | Pull-based lab job runner (`vps-agent/`); dials out to the Functions API, runs each job in `docker run --network none`. With LAB-5 its user is in no docker group (merged 2026-10-07 in #987, not yet on the host: [Applied state](#applied-state)): the CLI it spawns reaches the host daemon through `hcw-labs-agent-docker-proxy`, which passes the calls a job makes and refuses any create that asks for privilege, a host namespace, a device, a mount or a bind beyond the job's own directory | Host-native systemd service `hcw-labs-agent`, user `hcw-labs-agent`, `/opt/hcw-labs-agent`; the proxy is one container on no network, with a Unix socket only the agent's group may open |
| node-exporter | Host metrics for the lab status page; listens on localhost only | Host-native systemd service |
| Azure Connected Machine agent and Azure Monitor Agent | Arc onboarding as `arcs-lab-hybrid-prod-cus-01`; heartbeat, `auth`/`authpriv` syslog, the `daemon`/`syslog`/`kern`/`cron`/`user` facilities at Warning and above, and four host counters (CPU, memory, root disk used and free), by the data collection rule `dcr-lab-hybrid-prod-cus` | Host services. The Connected Machine agent is installed and connected by the Ansible `arc` role, switched on by the host's arc fact; the Azure Monitor Agent is an Arc extension added after onboarding. Both are started by the owner's `scripts/lab/Register-LabArc.ps1 -Connect` ([runbook](../runbooks/labs-host.md), "Arc onboarding", step 4) |
| Coder workspaces and lab job containers | Transient. Workspaces carry Coder's `com.coder.resource=true` label and stop after an hour; job containers carry the `hcw.lab-job` label and live for one job. With LAB-5 (merged 2026-10-07 in #987, not yet on the host: [Applied state](#applied-state)) every container on the host daemon runs with user-namespace remapping (its root is an unprivileged uid on the host), and workspaces run on the sandbox daemon. Every template lets a learner have one workspace starting or running at a time, refusing a second start at plan, and gives the Azure, AWS and Google Cloud CLIs a 64 MiB tmpfs for their sign-ins, so none is written to the workspace's volume and each ends when the workspace stops (#954, owner decision 2026-10-16; reaches Coder when the run after the merge publishes the templates) | Job containers: the host daemon, started by `vps-agent` through its proxy. Workspaces: the sandbox daemon, started by Coder through its proxy |
| Tool add-ons (`hcw-addon-<id>`) | Independently built tools the site shows in a pane at `/tools/<id>` ([ADR 0035](../decisions/0035-addon-pane-model.md); [AddOn integration standard](../standards/addon-integration-standard.md)): the first was `hcw-addon-migration`, the Azure migration assessment, at `migration.lab.hybridcloudworks.com`; the network assessment and the cloud assessment followed on 2026-10-12 ([#1089](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1089)), and Cloud Crawler is not on the host yet. Each takes an uploaded export, holds the assessment in memory for at most two hours, reaches no cloud by design, and gates uploads with its own human-verification widget whose secret is in the host's Ansible vault (`vault_addon_<id>_turnstile_secret`). Merged in the ADR 0035 pull request, not yet on the host: [Applied state](#applied-state) | One hardened container per row of `addons[]` in `group_vars`, run directly by the `addons` role (no Compose): `docker.io/hybridcloudworks/hcw-addon-<id>` by digest, read-only root, every capability dropped, no volume, no socket, under the user-namespace remap; `127.0.0.1:<port>` only (migration 18081, network assessment 18082, cloud assessment 18083), behind Caddy on `<id>.lab` |
| Portainer Business Edition | The owner's view of the host's Docker: containers, images, volumes, logs. Holds the Docker socket (with `--userns=host`, which the socket needs under the remap), so it is root on the host; it sees the host daemon, not the sandbox daemon the workspaces run on; reachable only through an SSH tunnel. Off until the owner turns it on (owner decision 2026-09-26) | One container, `portainer`, with a named volume; HTTPS on `127.0.0.1:9443` only, no Caddy route |
| HashiCorp Vault | Secrets for the lab host only, never production HybridCloudWorks secrets (those stay in Key Vault `kv-site-prod-cus-01`). Initialised by the owner over SSH. Since 2026-09-29 it unseals itself at every start with the key `vault-seal` in the lab-only Key Vault `kv-labhybrid-prod-cus-01`, as the Arc machine's identity (#726; ADR 0032, amendment of 2026-09-29, accepted and live that day). The five Shamir keys are recovery keys. On since 2026-09-26 (#729; owner decision that day) | Host-native systemd service `vault`, user `vault`, raft storage in `/var/lib/vault`; `127.0.0.1:8200` and `127.0.0.1:8201` only. With auto-unseal, the unit also joins the `himds` group and reaches Key Vault over HTTPS |

Nothing else. A container that is neither a named service above nor carries
one of the two labels is a finding, and the validation list in ADR 0032 checks
`docker ps` that way, by name and label rather than by count, on each of the
two daemons: the host's (`sudo docker ps`) and the sandbox's (`sudo docker
-H unix:///run/hcw-coder-docker/docker.sock ps`). The named services gained
`hcw-addon-<id>`, one per enabled `addons[]` row, by reference to
[ADR 0035](../decisions/0035-addon-pane-model.md) decision 8, which amends
ADR 0032's "Compose is for Coder only" line with single containers the
`addons` role runs directly ([REVIEW REQUIRED]: the owner confirms that
amendment).

`bootstrap.sh` enforces the "nothing else" on the way in: its first run on a
host refuses, before it changes anything, when the host already runs a
container, a self-hosted runner, Kubernetes, anything under `/opt` or a
listener this repository did not put there, and names a reinstall as the way
on ([runbook](../runbooks/labs-host.md), "The first-run host check").

## Exposure

Inbound: **80 and 443 only.** 80 exists to answer ACME challenges and
redirect to 443. SSH arrives through Azure Arc SSH, which opens no inbound
port: the Arc agent holds an outbound relay connection, and the relay hands
each session to sshd on the loopback, port 22 alone ([Summary](#summary),
"Owner access"). sshd lets in `hcwadmin` alone, by the owner's pinned key
only (#953). Port 22 has been closed to the internet at ufw since #953 stage
3, once Arc SSH and hPanel's Web Console had both been used (2026-10-17).
sshd also listens on the loopback alone (#1257), so ufw is not the only
layer. The hardening role does both only while Arc SSH is ready (its Arc
gate), so a rebuilt host answers on 22 until it is onboarded to Arc again.
Everything else is outbound:

- `vps-agent` polls the Functions API over 443 with its own Entra certificate;
- the Arc and Azure Monitor agents call Azure over 443, the Arc agent's
  relay for Arc SSH included;
- Coder reaches GitHub for OAuth over 443;
- Docker pulls digest-pinned images over 443: from Docker Hub as `main`
  holds it (#1002, merged 2026-10-08), and from GHCR until the owner's next
  playbook run applies that, publishing the template as it goes
  ([Applied state](#applied-state)).

No inbound port is opened for the site, for Azure or for lab jobs. The site's
servers reach the host in one direction only, through a server-side status
proxy in the Function App that reads the `CODER-URL` and `CODER-STATUS-TOKEN`
secrets from Key Vault through its `CODER_URL` and `CODER_STATUS_TOKEN`
settings. Whether Coder answers comes from its unauthenticated
`/api/v2/buildinfo`, and that alone opens the site's panes; the token adds
only the labs card's templates and running count. A visitor's browser
reaches the lab only inside the site's pages, as described under
[panes only](#panes-only).

On the host's loopback, and nowhere else: node-exporter (9100), Coder (7080,
behind Caddy), the tool add-ons (18081 for `hcw-addon-migration`, 18082 for the network
assessment and 18083 for the cloud assessment, all behind Caddy; none is
assigned to Cloud Crawler yet), Portainer
(9443) and Vault (8200, and raft's 8201 once unsealed). Docker's iptables
rules for a published port come before ufw's, so the three published through
Docker name `127.0.0.1` in the publish itself, and the Portainer and addons
roles refuse any other address. The owner reaches Portainer
through an SSH tunnel and Vault through the CLI over SSH; neither has a Caddy
route or a public name.

Workspace egress is limited to what the labs need, and host-local and
private destinations are refused (`host_firewall` role, #954 and #958; owner
decision 2026-10-16; merged in its pull request, on the host from the next
`bootstrap.sh` run: [Applied state](#applied-state)). Everything the sandbox
daemon's user sends, the workspaces included, may reach DNS on
systemd-resolved's stub, TCP 443 on the host's own addresses (Coder and the
guided labs, through Caddy) and TCP 80 and 443 on public addresses, and
nothing else; containers on the host daemon's bridges may open only TCP 80
and 443 to the host; and the host's own new connections to Coder's internal
network are refused (Coder reaches it across its own bridge). The rules are
the host's own chains, jumped to ahead of ufw's and loaded at boot before
Docker and the sandbox daemon, which does not start without them; a failed
load is reported like any watched unit's. ufw's reload and Docker's restart
leave them in place, and the add-ons' `DOCKER-USER` rules are separate
([runbook](../runbooks/labs-host.md#host-firewall-for-the-sandbox-and-bridges)).

### Panes only

**Owner decision 2026-09-28:** "The lab should only be accessible through
'panes' from my site, lock to that." A direct visit goes to the labs page.
Caddy enforces this for every name it serves (`lab`, every `*.lab`,
`coder.lab` and `*.coder.lab`) and on every response, including the 404 for
a name nothing claims. It sits in the site block ahead of every route, so a
route added later is covered without doing anything
(`lab-host/ansible/roles/caddy/templates/Caddyfile.j2`, `lab_panes_only`).

| Rule | What Caddy does |
| --- | --- |
| Only the site may frame the lab | Every response carries `Content-Security-Policy: frame-ancestors 'self' https://hybridcloudworks.com https://www.hybridcloudworks.com`. `www` is listed because it serves the site with a 200 rather than redirecting to the apex (checked 2026-09-28). `'self'` is for code-server, whose webviews are iframes of its own origin. It admits no other site, because the browser checks every ancestor up to the top window. There is no `X-Frame-Options`, because it cannot name an allowed origin |
| No direct browsing | A request with `Sec-Fetch-Dest: document`, a top-level navigation, gets `302` to `https://hybridcloudworks.com/education/labs`. So does a request with `Sec-Fetch-Mode: navigate` and no `Sec-Fetch-Dest`, which is a navigation from a browser that sends fetch metadata without the destination. Since [ADR 0035](../decisions/0035-addon-pane-model.md) the target is a Caddy variable the snippet sets for every name and a route may set again for its own: a visit to an add-on's name (`migration.lab`) goes to that add-on's page on the site, `https://hybridcloudworks.com/tools/migration`. The ordering this relies on is checked with `caddy adapt` in CI (`lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh`) |
| Everything else passes | `iframe` (the panes); `empty` (fetch, XHR and WebSockets from a page in a pane, such as Coder's API calls); subresources; and requests with no fetch metadata at all: Coder's workspace agents and CLI, and the Function App's status proxy (Node's `fetch` sends `Sec-Fetch-Mode: cors` and no destination) |

What keeps working, and why:

- **Certificates.** Caddy obtains them by DNS-01, so no challenge request
  arrives over HTTP, and Caddy would answer one before any route in any
  case.
- **Caddy's admin API and metrics** listen on a Unix socket,
  `/run/caddy/admin.sock`, that only the `caddy` user and root can open, not
  on TCP and not on the lab names (#958). Caddy serves HTTP/1.1 and HTTP/2
  only; HTTP/3 is off, so nothing listens on UDP 443.
- **The lab agent** dials out to the Functions API and receives nothing
  inbound. Nothing else on the host takes a connection through Caddy apart
  from Coder and the tool add-ons, and Coder's own clients send no fetch
  metadata.
- **The tool add-ons** ([ADR 0035](../decisions/0035-addon-pane-model.md))
  are framed by the site's `/tools/<id>` pages the same way, from their own
  one-label names. Each add-on sends its own `frame-ancestors` from env, set
  by the `addons` role to the same list Caddy sends, so the two policies the
  browser enforces agree; nothing of an add-on is let through at the top
  level, and a stopped container answers 503 with the site's own sentence,
  `This tool isn't available right now.`
- **Coder** (on since 2026-09-28, for members of the `HybridCloudWorks`
  GitHub organisation only; since 2026-10-16 for members of its
  `lab-learners` team only, with sign-ups off, so the owner creates each
  learner's account: #954, `lab-host/README.md`, "Who signs in"). Its route removes Coder's
  default `frame-ancestors 'self'`, because the browser enforces every
  policy it receives and that one would keep Coder out of the panes. It
  lets Coder's GitHub sign-in callback through at the top level, because
  GitHub cannot be framed. That path only redirects, and the redirect that
  ends sign-in lands on the labs page. Anything Coder opens in a new tab or
  window, such as a workspace app, is a top-level visit and lands on the
  labs page, so a pane has to show it instead.
- **The lab launcher** (2026-09-28) is how a pane shows code-server. Coder's
  dashboard opens it in a new window or tab, so the site's panes load a
  small static page on Coder's own name instead,
  `https://coder.lab.hybridcloudworks.com/_hcw/lab/?lab=<id>`
  (`lab-host/coder/launcher/`), which Caddy serves from disk before any
  request reaches Coder. With the learner's session it reads their
  workspace for that lab (GET only, same origin), shows Coder's own create
  or workspace page in a frame of its own when the learner has to confirm
  or press Start, and once code-server is healthy replaces itself with
  code-server's own name, which it checks is exactly the name Coder builds
  for that workspace and the signed-in learner.
  code-server stays on its own origin. The launcher's route adds its own
  policy beside `frame-ancestors`: `default-src 'none'`, scripts, styles,
  fetches, images and frames from `coder.lab` only, `base-uri 'none'`,
  `form-action 'none'`, and `Cache-Control: no-store`. It has no top-level
  exemption, so a direct visit to it goes to the labs page like any other.

Limits, stated so they are not mistaken for more:

- **This is a browsing rule, not access control.** Any script can send
  `Sec-Fetch-Dest: iframe`. Coder's GitHub sign-in is the access control
  for anything that matters.
- **A browser too old to send fetch metadata** (Safari before 16.4) cannot
  be told apart from the platform's own clients, so its top-level visits
  pass. `frame-ancestors` still applies to it.
- **The site's own side is separate.** The site's
  `frontend/staticwebapp.config.json` decides what its pages may frame
  (`frame-src`), and since #751 it admits exactly Coder's name and its
  workspace apps' wildcard. Each lab card opens the lab's page on the site,
  `/education/labs/<id>`, which frames the lab launcher in a pane, hears its
  state through `postMessage` (only from Coder's origin and the pane's own
  window), and opens GitHub sign-in at the callback path above in a tab of
  its own (`frontend/src/pages/shared/LabPanePage.jsx`;
  [ADR 0032, amendment "Coder in the site's panes"](../decisions/0032-learner-labs-platform.md#amendment-2026-09-28-coder-in-the-sites-panes)).

The lab side is in `lab-host/` and is applied by the next `bootstrap.sh`
run on the host. It reverses ADR 0032's "never embeds Coder" (decision 4)
on the lab side.

## Backup posture

**Rebuildable, no data of record.** The host holds nothing that cannot be
recreated from the repository: Terraform provisions it, Ansible configures it,
and every image it runs is pinned by digest in the repository. Two kinds of
image are pinned in two places: the learner and job toolchain (`hcw-lab`,
`hcw-lab-runner`) is built and published from `lab-image/` and pinned in the
Coder template and `vps-agent/lib/capabilities.js`; the infrastructure
services Coder and PostgreSQL run their upstream images, pinned by digest in
the Compose file under `lab-host/`. Caddy, `vps-agent` and node-exporter are
host-native, installed by Ansible at versions pinned with checksums in
`lab-host/`.
Lab job records live in Cosmos DB, not on the host. Coder workspaces are
learner scratch space with no retention promise.

Coder's PostgreSQL is the one stateful service, and it is treated as
**rebuildable metadata, not data of record**: learners are GitHub OAuth users
and reappear on next sign-in, templates are pushed again from
`lab-host/coder/templates/`, and workspace records describe containers that
stop after an hour. Losing it costs a re-push and a re-sign-in. The Ansible
`coder` role runs a nightly `pg_dump` into a host directory that keeps seven
days, so an operator error can be undone without a rebuild, and since LAB-9
(#955; ADR 0032, amendment of 2026-10-14) the `backups` role uploads each
dump as it is written to the `host-backups` container of
`stlabhybridprodcus01` (`infra/lab-hybrid-backups.tf`), as the Arc machine's
identity: an immutable, geo-redundant copy off the VPS, which is what a
rebuild restores from. A compromised or broken host is still destroyed and
re-applied; the restore is what the rebuild ends with. If the host ever
acquires data of record, that is a revisit trigger in ADR 0032.

Vault's raft store is snapshotted nightly by the same role (`vault operator
raft snapshot save`, with a token the owner seeds once) and uploaded beside
the dumps; a snapshot is encrypted under the seal key in Key Vault, so the
blob alone opens nothing. Portainer's volume is not backed up: it holds
settings that are re-entered by hand. Vault holds lab-host secrets only,
each of which its issuer can issue again, so it holds no data of record;
storing in it anything that exists nowhere else would be the revisit trigger
above.

## Identities the host holds

| Identity | Where it lives | Scope | Status |
| --- | --- | --- | --- |
| Owner SSH public key | `hcwadmin`'s `~/.ssh/authorized_keys`, written on every `bootstrap.sh` run from `hardening_admin_authorized_keys` in `lab-host/ansible/group_vars/all.yml` and nothing else; root's `authorized_keys` is kept empty. hPanel installs a key for root only on a reinstall, for the first run | Shell access to the host as `hcwadmin`, the only account sshd lets in (`AllowUsers hcwadmin`, `AuthenticationMethods publickey`); root login is off, and break-glass is meant to be hPanel's Web Console with root's password; whether that console goes through sshd is unverified (Hostinger says it works like an SSH connection), so the owner checks it before and after the first run with #953 (runbook, "The first `bootstrap.sh` run with #953"). `hcwadmin` has passwordless sudo, an accepted risk (`roles/hardening/README.md`) | pinned (#953, owner decision 2026-10-16): one ED25519 key, the owner's workstation key `SHA256:VTyaLLQLfYwi38RP1mHDD6Vtu0eSQsa4EPsNJTrdgG8`; the role stops on an empty list or one without the key of the most recent SSH login in the journal. Before #953's first run: two keys in `hcwadmin`'s and root's files, read 2026-10-16, the second of which made no login in 14 days |
| `vps-agent` Entra confidential client (certificate) | Private key generated on the host, `/etc/hcw/labs-agent.pem`, owner `root`, group `hcw-labs-agent`, mode `0640`, so the non-root service reads it and nothing else does; only the public certificate goes to the app registration | The `LabAgent` app role on the Functions API — five endpoints (the fourth, since 2026-10-08, hands over a renewed Coder status token the API verifies before storing; the fifth, since 2026-10-19, carries the host's own Portainer reading for the Health Hub, #1282), no database or Key Vault access | live: certificate issued 2026-09-26, expires 2028-09-25 (730 days, LAB-11 #957); the agent heartbeats (Heartbeat 2026-10-14) |
| Arc machine identity | System-assigned by Azure at onboarding, held by the Connected Machine agent; processes in the `himds` group can request its tokens | Whatever roles `infra/` grants it: from #726, Key Vault Crypto Service Encryption User (read, wrap and unwrap) on the one key `vault-seal` in `kv-labhybrid-prod-cus-01`, which Vault uses to unseal itself once the owner turns auto-unseal on; and, from LAB-9 (#955), Storage Blob Data Contributor on the one container `host-backups` in `stlabhybridprodcus01`, which the host's backups are uploaded to; nothing else beyond the data collection rule | live: Vault reports seal type `azurekeyvault`, unsealed, and the lab vault's audit shows the wrap and unwrap calls; the first backup blob was written as this identity on 2026-10-14 (#955) |
| Coder GitHub OAuth app secret | Coder's Docker Compose environment | Learner sign-in to Coder; nothing on the site | live: Coder has answered on its public name since 2026-09-28 |
| Coder status token | Issued by Coder; the value is held in Key Vault `kv-site-prod-cus-01` as the secret `CODER-STATUS-TOKEN` (read by the Function App setting `CODER_STATUS_TOKEN`), not on the host | Read-only Coder API for the site's status proxy: scoped `template:read` and `workspace:read`, for a Coder user of its own, `hcw-status`, that holds Template Admin so the running count covers every learner (`lab-host/README.md`, "The status token for the site"). It adds the labs card's templates and running count only; the panes open without it | live: renewed by `hcw-coder-automation.timer` on the host (#1035), seen running 2026-10-14 |
| Caddy ACME account | Caddy's data volume | Issuance and renewal of the one certificate covering `lab`, `*.lab` and `*.coder.lab` | live: renewal information refreshed 2026-10-14, no errors in 30 days of the Caddy journal |
| Caddy DNS-01 token (`CLOUDFLARE_API_TOKEN` in `/etc/caddy/env`, owner `root`, group `caddy`, mode `0640`, written by Ansible from Vault; the `caddy` systemd unit runs as the non-root `caddy` user and reads it through `EnvironmentFile`) | On the host, because renewals happen there | DNS edit and zone read on the dedicated lab zone `hybridcloudinsights.com`, which `_acme-challenge.lab` and `_acme-challenge.coder.lab` are delegated to, and nothing on the production zone | live, in the lasting form since 2026-10-18 (#948, #1279): scoped to the lab zone alone, IP-filtered to the host, ending 2027-10-17; the first certificate through the delegation was issued that day at 21:04Z, and the earlier production-zone token (interim ADR 0032 recorded, owner 2026-10-07) is revoked |
| Portainer administrator and Business Edition licence key | Created and entered by the owner in Portainer's UI; the password is in the owner's password manager, and Portainer keeps its own copy in its volume. Neither is in the repository or Ansible Vault | Full control of the host's Docker daemon, through the loopback only | planned |
| Portainer access token for the host's check (`hcw-portainer-write`) | `/etc/hcw/portainer/api-token`, `root:root` `0600` in a root `0700` directory, written by Ansible from the vault key `vault_portainer_api_token` and read by `hcw-portainer-check.service` through `LoadCredential`; never in the repository, a log or on a command line | The check's `GET` reads of Portainer's API on the loopback every 15 minutes (version, edition, licence, the `local` environment, container states, images with updates), reported as counts and states to the Health Hub's **Portainer** card. It is the owner's own administrator token (owner decision 2026-10-19, #1282; a read-only Portainer user was declined), so it could do anything the owner can in Portainer, and the check is held to `GET` by its test; root-only and credential-fed for that reason | live: the key was seeded by the owner on 2026-10-19, #1282 merged the same day, and the `bootstrap.sh` run of 07:13–07:17Z wrote the file (07:16Z) and made the first read before it ended, whose journal line was `Portainer 2.45.2 EE up; environment local up with 8 containers (8 running, 0 unhealthy, 0 restarting, 0 exited); 8 images checked, 0 outdated; reported to the site`; the timer reads every 15 minutes since |
| HashiCorp Vault unseal keys (five, three to unseal) and initial root token | The owner's password manager only, printed once by `vault operator init`. Never on the host, in the repository, in a log or in Ansible Vault | Unsealing and administering the lab host's Vault; after the move to auto-unseal they are recovery keys, which authorise `generate-root`, a rekey or a migration back and can no longer unseal | planned |
| Vault listener certificate | Generated on the host, `/etc/vault.d/tls/`, key `root:vault` `0640` | TLS for `127.0.0.1:8200`; trusted by the CLI through `VAULT_CACERT` | planned |
| Vault snapshot token | `/etc/hcw/backups/vault-token`, `root:root` `0600`, written by the owner's one-time `hcw-vault-backup-seed` from the owner's Vault token on stdin; never in the repository, a log or Ansible Vault | A periodic orphan token under the policy `hcw-raft-snapshot`: read `sys/storage/raft/snapshot` and renew, look up and revoke itself, nothing else; renewed nightly by `hcw-vault-backup.service` (`lab-host/ansible/roles/backups/README.md`) | planned |

Identities that are **not** on the host, by design: the Hostinger API token and
the Terraform-side Cloudflare API token (HCP Terraform workspace variables in
`hcw-lab`; the Caddy token above is a different, narrower token), the Arc
onboarding service principal credential (Ansible Vault, used once at onboarding
and not persisted), and any Cosmos DB key (the runner has never held one — see
the header comment of `vps-agent/index.js`).

## Run the toolchain locally

The same image the host runs jobs in is the image a lab page tells a learner
to pull: `docker.io/hybridcloudworks/hcw-lab` carries terraform, kubeconform,
helm, ansible-core, the Azure CLI, kubectl and git, plus a Terraform provider
mirror and the vendored Azure Verified Modules, so `terraform init` works in
it with no network. Pull it, then run it with the current directory mounted
at `/workspace`; both commands drop into `bash` there as `nobody`. The
repository is public, so the pull needs no sign-in.

PowerShell:

```powershell
$d = docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'; $d; docker pull "hybridcloudworks/hcw-lab@$d"
```

```powershell
docker run --rm -it -v "${PWD}:/workspace" "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
d=$(docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'); echo "$d"; docker pull "hybridcloudworks/hcw-lab@$d"
```

```bash
docker run --rm -it -v "$PWD:/workspace" "hybridcloudworks/hcw-lab@$d"
```

A successful run prints a `nobody@<container id>:/workspace$` prompt, and
`terraform version` there reports the version pinned in
[`lab-image/versions.env`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/versions.env).
`lab-image/README.md` in the repository has the digest-pinned form, what
works offline, and the smoke test.

## Related

- [ADR 0032](../decisions/0032-learner-labs-platform.md): the decisions this
  page records the shape of
- [ADR 0035](../decisions/0035-addon-pane-model.md): the tool add-ons the host
  runs beside Coder, and the [App-to-AddOn program](app-to-addon/README.md)
  they come from
- [Target architecture §5.3](architecture.md#53-labs-flow): the labs flow
- [Labs host Arc onboarding](../runbooks/labs-host.md): the owner procedure
  that makes the hybrid control plane row real, and how to disconnect
- [Required inputs §4.7](../standards/required-inputs.md#47-vps-agent-hostinger-env-never-committed):
  the inputs the host and its workspace need, with live status
- [Cost analysis](cost-analysis.md): Hostinger is tracked outside Azure
