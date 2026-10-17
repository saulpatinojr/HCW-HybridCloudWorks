# ADR 0032: The learner labs platform — a Terraform-managed Hostinger host under Azure Arc, Docker only, Coder as the learner boundary, and public submission locked to the site's pane

**Status:** Accepted 2026-09-27 (owner: "all have been approved to move forward"); amended 2026-09-26 and 2026-09-28; amendment of 2026-09-29 (Vault auto-unseal, #726) accepted by the owner and live on the host the same day; [amendment of 2026-10-14](#amendment-2026-10-14-off-host-backups-and-a-rehearsed-rebuild-lab-9) (off-host backups, LAB-9, #955) chosen by the owner that day. Decision 6 was revised on 2026-09-28: public submission is open, only from the Landing Zone Builder's pane on the site, locked by the request's origin and a Cloudflare Turnstile token, within decision 6's original bounds, which are unchanged. Also on 2026-09-28 the site began embedding Coder, in a pane on each lab's page, which decision 4 had ruled out and the alternatives had rejected ([amendment of that date](#amendment-2026-09-28-coder-in-the-sites-panes), #750 and #751).
**Decision date:** 2026-09-25
**Owners:** Workload owner and architecture owner

## Context

The estate has a Hostinger VPS that nothing manages. `vps-agent/` is a
pull-based Node job runner that dials out to the Functions API, claims a job,
runs it in `docker run --network none` against a digest-pinned image, and posts
the result back. It is admin-only: `enqueueLabJob` in `functions/src/lib/labs.js`
requires the `editor` role, and the public submission path the source
repository had (`submitPublicLabJob`) was deliberately not ported. No host is
provisioned ([Required inputs §4.7](../standards/required-inputs.md#47-vps-agent-hostinger-env-never-committed)),
and until this record [the target architecture](../architecture/architecture.md)
§5.3 described a browser-submitted labs flow that does not exist.

Owner direction 2026-09-24: the VPS is an empty host, any OS. Rather than a
Kubernetes lab, make it the **on-premises half of a real hybrid estate** —
provisioned by Terraform, configured by Ansible, onboarded to Azure Arc so it
appears in the same tenant as the production Azure estate, monitored by the
existing Log Analytics workspace, and shown live on a public page. It then
hosts browser labs (Coder) and the existing `vps-agent`. Every step is a pull
request a follower can read and repeat for a few dollars a month.

Four epics build on this record: the lab host itself (#656), the Landing Zone
Builder (#657), the `hcw-lab` image and Docker sandbox (#658), and browser labs
on Coder (#659). Each of their sub-issues assumes the decisions below, so they
are recorded once, here, before any of them is implemented.

## Purpose and decision drivers

- **Blast radius.** A lab experiment must never be able to touch production
  Azure state, production secrets, or the site's sign-in. The host is
  third-party, reachable from the internet, and will run learner-supplied code.
- **Cost, against the USD 150/month ceiling of [ADR 0015](0015-cost-governance.md).**
  Hostinger is billed outside Azure ([cost analysis](../architecture/cost-analysis.md)).
  The Azure side must add nothing with a standing charge that the estate cannot
  already absorb.
- **Teachability.** The point of the host is that a follower can repeat it. A
  design that needs a Kubernetes distribution, a VPN gateway or a paid Defender
  plan is one fewer people will reproduce.
- **Supply chain.** Learner-facing images are pulled implicitly by `docker run`,
  before `--network none` takes effect. Whatever runs on the host must be pinned
  by digest, built from this repository, and reviewed like any other change
  (the rule `vps-agent/lib/capabilities.js` already enforces).
- **Security and operational excellence.** Least privilege on every identity
  the host holds; outbound-only where a protocol allows it; the existing
  alerting fabric ([ADR 0022](0022-alerting-fabric.md)) rather than a second one.

## Decision

1. **The VPS is Terraform-managed through the `hostinger/hostinger` provider
   (v0.1.22, January 2026) in its own HCP Terraform workspace.** Organisation
   `hcw`, workspace `hcw-lab`, VCS-driven from this repository with working
   directory `infra-lab/`, auto-apply off. The `hostinger_api_token` and
   `cloudflare_api_token` it needs are workspace variables, never repository
   values. Lab state and `hcw-azure` state never meet: nothing in `infra-lab/`
   reads `hcw-azure` outputs, and nothing in `infra/` reads `hcw-lab`.
2. **Ubuntu 26.04 LTS, and Docker Engine is the only runtime on the host.**
   (Owner decision 2026-09-26: the VPS was reinstalled with 26.04 LTS, the latest LTS, and stays on it; this line read 24.04 LTS until then.) No
   Kubernetes of any size (owner decision 2026-09-24; the earlier k3s idea is
   dropped). Coder and its PostgreSQL run as containers under Docker Compose.
   (Owner decision 2026-09-26: Coder's database stays this PostgreSQL container on the host, not Coder's built-in PostgreSQL or Azure Database for PostgreSQL Flexible Server B1ms, about $14 a month in compute; `lab-host/ansible/roles/coder/README.md`, "Where it runs", records both.)
   Caddy runs host-native from a pinned build that includes the
   `caddy-dns/cloudflare` module, because neither the stock package nor the
   official image carries it and DNS-01 needs it; its version and checksum
   are pinned in `lab-host/`. `vps-agent` runs host-native as a systemd
   service, because it drives the `docker` CLI itself and a container that
   drives the host daemon is no more contained than a service that does; its
   certificate at `/etc/hcw/labs-agent.pem` is `root:hcw-labs-agent` `0640`,
   readable by the service user and by nothing else. node-exporter is a
   host-native service too; the Arc agent runs as a host service because that
   is how Azure ships it.
3. **Azure Arc-enabled servers is the hybrid control plane.** Microsoft Learn
   lists Ubuntu 26.04 on x86-64 as a supported Arc-enabled servers operating
   system, and Ubuntu 26.04 LTS as supported by the Azure Monitor Agent (both
   read 2026-09-26). The host is
   onboarded as an Arc machine in a new resource group,
   `rg-lab-hybrid-prod-cus`, in the application subscription. Onboarding uses a
   service principal holding only **Azure Connected Machine Onboarding** on
   that resource group; its credential lives in Ansible Vault and never in the
   repository or on the host after onboarding. An Azure Monitor Agent data
   collection rule sends **heartbeat and `auth`/`authpriv` syslog only** into
   the existing Log Analytics workspace in `rg-mgmt-plat-prod-cus` (Management
   subscription). Machine configuration policy is **audit only** (and, since
   the amendment of 2026-10-07 under Consequences, has no agent to run it:
   guest configuration is off on the host). Defender for
   Servers stays **off** for cost. Arc itself is free. The public lab page
   reads the host's Arc state through the Function App, never from the
   browser: the Function App's existing managed identity is granted
   **Reader on `rg-lab-hybrid-prod-cus` only** (an `azurerm_role_assignment`
   in `infra/`, #664) and queries Azure Resource Graph for the
   `microsoft.hybridcompute/machines` row (status, last heartbeat, agent
   version) and its policy compliance; the result is cached for a minute in
   `tool_service_cache` and answers `{ configured: false }` when the resource
   group does not exist, so the card shows an explicit absent state rather
   than a fabricated one. No new credential is involved; the role assignment
   is the whole grant.
4. **Coder (Community edition) is the learner identity boundary.** It runs
   from Docker Compose on the host with Docker-based workspaces, and learners
   sign in to it with **GitHub OAuth**, and only members of a GitHub
   organisation the owner names may sign in: `CODER_OAUTH2_GITHUB_ALLOWED_ORGS`
   is a required setting, not an option, because an absent or empty value
   lets any GitHub account consume the public VPS. It is therefore never
   empty while Coder runs, and the Ansible role refuses to render an empty
   value. The **kill switch is an explicit stop, not an emptied list**:
   `CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS=false` closes the door to new learners
   while existing ones keep working, and stopping the `coder` Compose
   service closes it to everyone (Caddy then answers 503 for the Coder
   names). (Owner decision 2026-10-16, #954: only the `lab-learners` team of
   that organisation signs in, `CODER_OAUTH2_GITHUB_ALLOWED_TEAMS`, and
   `CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS=false` is now the normal setting rather
   than a switch: no sign-in creates an account, and the owner creates each
   learner's account before their first sign-in. Shutting one learner out is
   taking them out of the team and suspending their Coder account; stopping
   the `coder` service is still the switch for everyone, and an emptied list
   is still neither. [Labs host runbook, "Coder sign-in: adding and removing
   a learner"](../runbooks/labs-host.md#coder-sign-in-adding-and-removing-a-learner).)
   Two things on the host may drive the
   Docker daemon, and nothing else (a third, Portainer, owner-only and on the
   loopback, since the amendment of 2026-09-26 below): the Coder **server** container, which has
   the socket mounted because that is how Coder's documented Docker install
   creates workspaces, and `vps-agent`, which runs **host-native** as the
   `hcw-labs-agent` systemd service with its user in the `docker` group,
   because its runner executes the `docker` CLI
   (`vps-agent/lib/docker-runner.js`). A workspace never receives the socket,
   a privileged flag or a host path, and the template test in #679 asserts
   that. The privilege boundary this leaves is recorded under consequences.
   (Since the [amendment of 2026-10-07](#amendment-2026-10-07-container-runtime-privilege-separation-lab-5),
   LAB-5: the agent is in no `docker` group and reaches Docker through its
   own allowlisting proxy, the daemon remaps user namespaces, and the Coder
   server reaches a separate rootless daemon where every workspace runs.)
   The site never signs learners in and never embeds Coder:
   `frontend/staticwebapp.config.json` keeps `frame-src` at `'self'` plus the
   Entra sign-in origin and a closed `connect-src`. The site links out to
   `lab.hybridcloudworks.com` and shows lab status through a server-side proxy
   in the Function App, whose app settings `CODER_URL` and `CODER_STATUS_TOKEN`
   are Key Vault references to the secrets `CODER-URL` and
   `CODER-STATUS-TOKEN` in `kv-site-prod-cus-01` (vault names are hyphenated;
   the naming table in
   [Variables and secrets](../standards/variables-and-secrets.md) applies).
   (Owner decision 2026-09-28: the lab is reached only through panes on the site, which reverses "never embeds Coder" above and the iframe alternative rejected below; the lab side is recorded in [Labs host, "Panes only"](../architecture/labs-host.md#panes-only), and the site side in the [amendment of that date](#amendment-2026-09-28-coder-in-the-sites-panes). `frame-src` now admits Coder's two names; `connect-src` stays closed and the status proxy is unchanged.)
5. **One toolchain, published as digest-pinned images from a new `lab-image/`
   directory.** The images go to GHCR (and to Docker Hub once an organisation
   exists there) and are the single toolchain for the lab pages, the Coder
   template and `vps-agent`. They carry a Terraform provider **filesystem
   mirror** and the Azure Verified Modules the Landing Zone Builder emits,
   **vendored** at pinned versions under `/opt/avm/<module>@<version>`, so
   `terraform init` succeeds under `--network none`: `init` downloads both
   providers and registry `module` sources, and a mirror alone still fails on
   the modules. Today the `terraform-validate` capability in
   `vps-agent/lib/capabilities.js` runs `terraform init -backend=false` inside
   a network-less container, so it can pass only for HCL that declares neither
   a provider nor a registry module; the mirror plus the vendored modules is
   what makes a real landing-zone configuration validatable. The learner's
   files are never changed for this: the builder's download and the submitted
   payload keep registry `source` and `version` lines, so the zip initialises
   anywhere with network, and the `terraform-validate` capability's fixed
   command is to rewrite those sources to the vendored paths on its own tmpfs
   copy inside the job before `init`. That rewrite does not exist yet: today
   `vps-agent/lib/capabilities.js` copies `main.tf` alone and runs `init`, so
   on the runner image it validates HCL whose providers are mirrored and
   whose modules are absent or fully vendored. #675 lands the rewrite, the
   multi-file payload and the transitive vendoring that `avm-ptn-alz` and the
   connectivity module need (measured in #686: one and thirteen registry
   child modules respectively); until then the full landing-zone output is
   not validatable offline and this record does not claim it is. These
   images are the learner and job toolchain only. The host's
   infrastructure services Coder and PostgreSQL run their upstream images,
   pinned by digest in the Compose file; Caddy, `vps-agent` and node-exporter
   are host-native, installed by Ansible at pinned versions with checksums.
6. **Anonymous public lab submission stays Gated.** Accepting this ADR does not
   open it. When a later revision does, the bounds are these and no wider:
   only the `terraform-validate` job type; a 64 KB payload; 2 submissions an
   hour per client and 50 a day globally; refused outright while more than 20
   jobs are queued; jobs written with `public: true` and a 1-day TTL. Until
   then, submission is `enqueueLabJob` from `/admin/labs` under the `editor`
   role, exactly as the code stands.
   (Revised 2026-09-28, owner decision; [the amendment of that date](#amendment-2026-09-28-decision-6-revised-open-only-from-the-sites-pane)
   below. The Gate is replaced by a lock to the Landing Zone Builder's pane
   on the site, the request's origin and a Cloudflare Turnstile token, and
   every bound in this paragraph stands as written. `enqueueLabJob` under the
   `editor` role is unchanged beside it.)

## Amendment 2026-09-26: a clean reinstall; Portainer and Vault on the host, loopback-only

**Context.** The owner's first `bootstrap.sh` run on the VPS failed at the
agent's checkout, because `/opt/hcw-labs-agent` held a July install of the
old agent. The host ran Ubuntu 26.04 but had never been reinstalled, which
the note under decision 2 assumed it had. It ran two self-hosted
GitHub Actions runners, Portainer EE 2.39.4, an nginx site on port 80, k3s,
Vault 1.17.5 and that agent. Before failing, the run upgraded Docker from
29.6.0 to 29.8.1 and restarted it, which killed a running Dependabot job,
enabled ufw and wrote the sshd hardening. Nothing was deleted.

**Owner decision 2026-09-26.** Reinstall the VPS clean. Nothing on it was
production, so nothing is exported. Portainer and Vault are part of the
clean deployment.

1. **`bootstrap.sh` refuses a host it was not prepared for.** On a host it
   has never accepted, it looks for other workloads before it changes
   anything: any Docker container, an installed `actions.runner.*` unit,
   Kubernetes units or directories, a foreign checkout at the repository or
   agent path, anything else under `/opt`, and a TCP listener other than
   sshd's and systemd-resolved's. It refuses with what it found, and names a
   reinstall or `HCW_ADOPT_NONEMPTY_HOST=1` as the two ways on. The first run
   that passes writes `/etc/hcw/bootstrap-host-accepted`, and later runs skip
   the check. Each check would have caught the host above.
2. **Portainer Business Edition, loopback only.** The `portainer` role runs
   Portainer BE 2.45.1 (LTS) by index digest, with a named volume and the
   Docker socket, published on `127.0.0.1:9443` and nowhere else, with plain
   HTTP off and no Caddy route. The owner reaches it through an SSH tunnel.
   It runs under Portainer's 3 Nodes Free licence (internal business use, one
   server instance, up to three nodes; this is one of each). The licence key
   and the administrator are entered in its UI and are in neither the
   repository nor the Ansible vault. Off until `portainer_enabled` is true.
   **This amends decision 4's "two things on the host may drive the Docker
   daemon".** Portainer is a third, and holding the socket makes it root on
   the host. That is bounded by who can reach it: only someone with an SSH
   login, which already carries `sudo`, so it adds no one who is not already
   root. A workspace or job container cannot reach it either: it listens on
   the host's loopback, and neither has host networking.
3. **HashiCorp Vault, loopback only, for lab-host secrets only.** The
   `vault` role runs Vault 2.1.1 host-native under systemd as the `vault`
   user, with integrated (raft) storage in `/var/lib/vault`, the API on
   `127.0.0.1:8200` and raft's cluster port on `127.0.0.1:8201`, and TLS from
   a certificate generated on the host. The download is checked against
   HashiCorp's GPG signature on the release's SHA256SUMS. The role never
   initialises or unseals Vault. `vault operator init` and every unseal are
   owner steps over SSH, and the unseal keys and root token go to the owner's
   password manager, never to the repository, a log or the Ansible vault. Off
   until `vault_enabled` is true.
   **The boundary.** This host runs untrusted learner workloads, and a
   workspace escape is root, which can read an unsealed Vault's memory. So
   this Vault holds lab-host secrets only and never a production
   HybridCloudWorks secret. Those stay in Azure Key Vault
   `kv-site-prod-cus-01`, which nothing on the host can read. It holds nothing
   that exists nowhere else, so the host still holds no data of record.
   **Follow-up, not built:** auto-unseal with an Azure Key Vault key, through
   the Arc machine's managed identity, would end the owner step after every
   restart. It must use a lab-only key vault and a grant on one key, never
   `kv-site-prod-cus-01`. That is
   [#726](https://github.com/HybridCloudWorks/HCW-HybridCloudWorks/issues/726),
   P3 on the board.
   (Accepted and live on the host 2026-09-29: the
   [amendment of that date](#amendment-2026-09-29-vault-auto-unseal-through-the-arc-identity).)

Consequences of this amendment:

- **Vault is sealed after every restart and every reboot**, including the
  unattended-upgrades reboot at 04:30, until the owner enters three of the
  five unseal keys. Anything on the host that reads from Vault must tolerate
  a sealed Vault. (Superseded 2026-09-29 by #726: the host now auto-unseals,
  so a restart comes back unsealed while Key Vault answers. The amendment of
  that date.)
- **The inbound policy is unchanged.** Both new services listen on the
  loopback, and nothing listens on a public address but sshd on 22 and Caddy
  on 80 and 443. Because Docker's rules for a published port come before
  ufw's, the `portainer` role refuses any publish address but `127.0.0.1`.
- **Portainer's licence is renewed yearly** at no cost while the use stays
  within three nodes. Its terms forbid using it "to provide services to third
  parties". Portainer is the owner's tool here and learners never reach it.
  If that changes, the Community Edition image is the same release with no
  key.

## Amendment 2026-09-28: decision 6 revised, open only from the site's pane

**Context.** #672 built the anonymous path behind decision 6's bounds and
left it closed (`LABS_PUBLIC_SUBMISSION_ENABLED` unset). The lab agent
`vps-hostinger-01` is registered and heartbeating, so the only thing between
the Landing Zone Builder's "Validate on the lab" and a real job was this
decision. The consequences below named the question the revision had to
answer: which client identifier the rate limits count.

**Owner decision 2026-09-28.** "The lab should only be accessible through
'panes' from my site, lock to that." Of the shapes put to the owner, the one
chosen is **the site's origin plus Cloudflare Turnstile**. The same decision
has a lab-host half, recorded under decision 4 and in
[Labs host, "Panes only"](../architecture/labs-host.md#panes-only) (#750):
Caddy lets only the site frame the lab and turns a direct visit away. This
amendment is the API half, for the one public route that queues work.

1. **Public submission is open, and only from the builder's pane on the
   site.** Decision 6's Gate is replaced by a lock, and nothing else about
   the decision moves: `terraform-validate` only, 64 KB, 2 an hour per
   client, 50 a day globally, refused while more than 20 jobs are queued,
   `public: true` with a 1-day TTL, and refused outright while no agent
   registered for the type has heartbeated. The lock is checked before any
   of those, and before any store read or counter moves, so a refused request
   costs the store nothing and spends no one's quota
   (`functions/src/lib/labs/public-lock.js`, `public-submit.js`).
2. **The origin.** A `POST /api/public/labs/submit` is refused
   `403 ORIGIN_NOT_ALLOWED` unless its `Origin` is exactly
   `https://hybridcloudworks.com` or `https://www.hybridcloudworks.com`, the
   production origins of the CORS allowlist (`functions/src/lib/auth/cors.js`),
   both of which serve the site. A missing Origin is refused, and so are the
   Static Web App's preview hostname and localhost, which CORS admits for
   other reasons. On its own this stops browsers on other sites and nothing
   else, because a script can send any header.
3. **A Cloudflare Turnstile token.** The builder renders a Turnstile widget
   (Managed mode, shown only when Cloudflare wants the visitor to act) once
   the lab is open, and sends its token with the submission. The Function App
   verifies it with Cloudflare's siteverify, passing the secret key and the
   client address `client-identity.js` trusts, and accepts only
   `success: true` for one of the site's two hostnames and the action
   `lab-validate`. Tokens are single use and live five minutes, so a replay
   fails at siteverify. Siteverify out of reach, or refusing the secret, is
   `503 TURNSTILE_UNAVAILABLE`, never a pass. Because the per-client quota
   needs the store and so comes after the lock, an in-memory limit per
   Function App instance allows one client ten checks in ten minutes and
   answers the next `429 TURNSTILE_RATE_LIMITED`, so junk tokens cannot drive
   a siteverify call per request (security review of this change). The two
   reads, the status and one job's output, stay anonymous and are not locked
   to the origin: they queue nothing, and a job is readable only by the
   random id its submission returned, for a day.
4. **The client identifier is the one #738 already uses.** The per-client
   bound counts the Cloudflare-verified, salted hash of `CF-Connecting-IP`,
   trusted only on a request carrying the origin secret, the identity every
   anonymous route shares. Turnstile is what makes that count mean a person
   at a browser rather than a script rotating addresses.
5. **Three switches, each failing closed.** `labs_public_submission_enabled`
   (default `true`, the owner's decision in code, reviewed in the pull request
   and read in the plan) sets `LABS_PUBLIC_SUBMISSION_ENABLED`; the Key Vault
   secret `TURNSTILE-SECRET-KEY`, read through the `TURNSTILE_SECRET_KEY`
   reference, must resolve; and an agent must be online. The status read says
   which is missing: `PUBLIC_SUBMISSION_CLOSED`, `TURNSTILE_NOT_CONFIGURED` or
   `LAB_AGENT_OFFLINE`. A build of the site without the public site key
   `VITE_TURNSTILE_SITE_KEY` keeps the button disabled and says so. Setting
   the variable to `false` in the `hcw-azure` workspace is the one-step kill
   switch.
6. **The widget is created in the Cloudflare dashboard, not by Terraform.**
   The pinned provider has `cloudflare_turnstile_widget`, whose `secret` is a
   read-only attribute: managing it would put the secret key in HCP Terraform
   state, which [Variables and secrets](../standards/variables-and-secrets.md)
   forbids, and it needs an account id and an account-level Turnstile
   permission the zone-scoped `cloudflare_api_token` does not carry. The site
   key goes to the repository variable, the secret key to Key Vault through
   the API-keys page, as every other secret does. `infra/frontend.tf` records
   this beside the Cloudflare resources, and a test fails if the resource
   appears.

Consequences of this amendment:

- **The CSP grants `https://challenges.cloudflare.com` in `script-src` and
  `frame-src`, site-wide, and nowhere else.** Static Web Apps sends one
  policy for every page, so the grant is not scoped to the builder; the
  script is. Only the builder loads it, and only while the lab is open, so
  every other page makes no request to Cloudflare. `connect-src` is
  unchanged. `frontend/src/lib/csp.test.js` holds exactly this.
- **Cloudflare sees the builder's visitors.** Turnstile runs Cloudflare's
  browser challenge on the page and receives the visitor's address from
  siteverify. The site already sits behind Cloudflare's proxy, so no new
  party receives the address, but the challenge is new processing, so the
  site's privacy policy (`frontend/public/privacy-policy.html`) says so and
  links Cloudflare's Turnstile Privacy Addendum.
- **Turnstile raises the cost of automation; it does not end it.** A person
  can solve challenges for someone else. The bounds are what cap the
  damage: 2 an hour per verified address and 50 a day in total, against a
  `terraform-validate` job with no network, and decision 6 needs no change
  for that reason. The same bounds give one denial of service: about 50
  bought tokens from 25 addresses can use up the day's global cap and pause
  the button for everyone until midnight UTC. That costs availability, not
  data, and a per-network sub-cap is the answer if it is seen (revisit
  triggers).
- **One more owner-held secret, one more public value.** The secret key
  lives in Key Vault only and rotates by creating a new one in the dashboard
  and pasting it on the API-keys page. The site key rotates with it and needs
  a frontend deploy.
- **This amendment answers the client-identifier question that the
  "public path stays closed" consequence below left for the revision.**

## Amendment 2026-09-28: Coder in the site's panes

**Context.** Decision 4 said the site never embeds Coder, and "Embedding
Coder in the site" is listed below as a rejected alternative. The owner's
decision of 2026-09-28, "The lab should only be accessible through 'panes'
from my site, lock to that", reverses both. #750 applied the lab-host half:
Caddy answers every top-level visit to a lab name, Coder's included, with a
302 to `/education/labs`, and lets only the site frame the lab
([Labs host, "Panes only"](../architecture/labs-host.md#panes-only)). From
then on the site's "Open in Coder" links led straight back to the labs page.
This amendment is the site half (#751).

**Owner decision 2026-09-28.** Embedding Coder in the site, rejected when
this record was accepted, is now the chosen approach: a learner reaches Coder
only in a pane on the site.

1. **Each lab has a page that holds its pane.** `/education/labs/<id>`
   (`frontend/src/pages/shared/LabPanePage.jsx`) frames the lab's workspace
   deep link, `/templates/hcw-lab/workspace?mode=auto&param.lab=<id>`, and
   the cards on `/education/labs` link there. Its toolbar makes the pane
   itself full screen and goes back to the labs page. Nothing on the site
   links to Coder at the top level.
2. **`frame-src` gains exactly Coder's two names**,
   `https://coder.lab.hybridcloudworks.com` and
   `https://*.coder.lab.hybridcloudworks.com` (the workspace apps, where
   code-server runs). `connect-src` is unchanged. The rejected alternative
   assumed the site would have to open it, and it does not, because the site
   still reads Coder's status through the Function App (decision 4).
   `frontend/src/lib/csp.test.js` holds both.
3. **The frame gets what code-server needs and nothing more:**
   `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`, and
   `allow` for clipboard read, clipboard write and fullscreen, granted to
   those two origins by name. Scripts plus same-origin would let a frame of
   the page's own origin lift its sandbox; the pane is always another
   origin. There is no top-navigation flag, so the pane cannot navigate the
   site, and `frame-src` stops it navigating anywhere but Coder's names.
4. **GitHub sign-in runs in a tab of its own.** GitHub refuses to be
   framed. The pane page's "Sign in with GitHub" opens, in a new tab, the
   one Coder path #750 lets through at the top level,
   `/api/v2/users/oauth2/github/callback`. Coder v2.37.3 starts sign-in
   there when the request carries no `code`: it sets its state cookie and
   redirects to GitHub. After GitHub, Coder sets its session and redirects
   to a path of its own; that is a top-level visit, which #750 sends to
   `/education/labs`, and that page sends the tab on to the lab's pane. The
   first tab hears of it through a `storage` event and reloads its pane. The
   site holds no credential: it records in localStorage only that a sign-in
   was started and that one finished. The session is Coder's cookie on its
   own name, which reaches the pane because the site and the lab are one
   site (the same registrable domain), so it is not a third-party cookie.
   The page comment in `LabPanePage.jsx` has every step and its source.
5. **The pane opens only when the status read says Coder is reachable.** A
   frame from another origin cannot tell the page what it shows, so the page
   asks `GET /api/public/labs/coder-status`. Anything but configured and
   reachable, or a frame that has not loaded in 30 seconds, shows "Lab
   workspaces aren't available right now." and never the error.

Consequences of this amendment:

- **Two trust boundaries share a browser window, not an origin.** The frame
  is sandboxed and cross-origin, and Coder's GitHub sign-in stays the access
  control; #750's lock is a browsing rule.
- **The pane depends on the status read.** Until `CODER_URL` and
  `CODER_STATUS_TOKEN` resolve in the Function App, every pane says the
  workspaces are unavailable, even when Coder is up.
- **A workspace app that Coder opens in a new window or tab leaves the
  pane.** Found while building #751, from Coder v2.37.3's dashboard source:
  an app opens with `window.open` when its `open_in` is `slim-window`, the
  code-server module's default, or in a new tab when it is `tab`. Both are
  top-level visits, which #750 sends to the labs page. So in the pane a
  learner can sign in and create the workspace, and code-server's button
  opens nothing they can use. Opening code-server inside the pane is a
  lab-host change and is not made here (revisit triggers).
- **The site cannot tell whether a visitor is signed in**, because it cannot
  read the pane. The page shows the sign-in step until this browser has come
  back from one (for Coder's default 24-hour session), offers "I've already
  signed in", and keeps the sign-in button on the toolbar for an expired
  session. A visitor GitHub signs in but Coder refuses (outside the
  organisation) also lands back on the pane, which shows Coder's sign-in
  page again.

**Note, 2026-09-28: the lab launcher closes the code-server blocker.** The
third consequence above, code-server opening nothing a learner can use, is
resolved without loosening #750's lock. The pane now loads a small static
page on Coder's own name, `https://coder.lab.hybridcloudworks.com/_hcw/lab/?lab=<id>`
(`lab-host/coder/launcher/`, served by Caddy with a strict policy of its
own, `Cache-Control: no-store` and no top-level exemption, so a direct
visit still goes to `/education/labs`). With the learner's own Coder
session, GET only and same origin, it reads their workspace for that lab,
named from a fixed map the site's catalogue shares (`lab-lzb`, `lab-tfv`,
`lab-asc`). It shows Coder's own create page, with Coder's consent dialog,
or Coder's own workspace page, where Start is, in a frame of its own when
the learner must act. When the build is running, the agent ready and
code-server healthy, it checks that code-server's `subdomain_name` is
exactly the name Coder builds for that workspace and the signed-in
learner, and replaces itself with that name under a fixed suffix. code-server stays on its own
origin, and path apps stay off (`CODER_DISABLE_PATH_APPS`, #760).
`frame-src`, the sandbox and `allow` are unchanged. The launcher posts its
state to the site, which accepts it only from Coder's origin and the pane's
own window, and shows it on the toolbar. On the same day the pane stopped
depending on the status token: point 5's status read now says configured
with `CODER_URL` alone and reachable from Coder's unauthenticated
`/api/v2/buildinfo`, and the token adds only the card's templates and
running count, so the second consequence above no longer holds. Rejected on
the way (research against Coder v2.37.3): POSTs with a scraped CSRF token
(undocumented, and it skips Coder's consent), a launcher served as a path
app (a workspace's JavaScript on the dashboard's origin), rewriting Coder's
HTML in Caddy, and exempting same-site top-level visits (which would end
panes-only).

## Amendment 2026-09-29: Vault auto-unseal through the Arc identity

**Status: accepted by the owner on 2026-09-29, and live on the host.** The
owner accepted the trade stated below, the switch file was written, and the
owner ran the migration with three of the five keys. A restart then came back
unsealed with no keys typed: `vault status` read `Seal Type azurekeyvault`,
`Recovery Seal Type shamir` and `Sealed false`, and the journal said
`unsealed with stored key`. The five Shamir keys are now recovery keys. The
cold copy taken before the switch is `/root/vault-before-726.tgz` on the
host. As built, it takes effect on a host only when the owner writes
`/etc/ansible/facts.d/hcw_vault_seal.fact` there and runs the migration in
the [Labs host runbook](../runbooks/labs-host.md#hashicorp-vault-moving-to-auto-unseal),
and doing that is the acceptance of the trade stated below. Until then Vault
stays on the five Shamir keys, exactly as the amendment of 2026-09-26 left it.

**Context.** That amendment's item 3 leaves Vault sealed after every restart,
the 04:30 unattended-upgrades reboot included, until the owner enters three
keys, and names #726 as the way out. #726 asked first whether Vault's
`azurekeyvault` seal can sign in through the Arc agent's local identity
endpoint, or only through Azure VM IMDS, a client secret or workload
identity. Only the first keeps a secret off the host, and without it this
record would not take auto-unseal.

**The answer**, read against the source of the pinned release, Vault 2.1.1.
`go version -m` on the signature-checked binary lists exactly the module
versions below.

1. The seal (`go-kms-wrapping/wrappers/azurekeyvault` v2.0.14) signs in with
   a client secret only when `tenant_id`, `client_id` and `client_secret` are
   all set, and otherwise calls `azidentity.NewDefaultAzureCredential`.
   Verified in source.
2. That chain (`azidentity` v1.13.1) includes `ManagedIdentityCredential`,
   which hands managed identity to MSAL for Go v1.6.0. MSAL recognises an
   Arc machine from `IDENTITY_ENDPOINT` and `IMDS_ENDPOINT`, or from
   `/opt/azcmagent/bin/himds` existing, and runs the agent's challenge flow:
   a 401 naming a `.key` file in `/var/opt/azcmagent/tokens`, then the same
   request carrying that file's contents. The chain can be pinned to managed
   identity with `AZURE_TOKEN_CREDENTIALS=ManagedIdentityCredential`.
   Verified in source.
3. Microsoft documents the rest of the host side: the agent sets both
   variables in `/lib/systemd/system.conf.d/azcmagent.conf`, its daemon is
   `himdsd.service`, and "On Linux, you must be a member of the `himds`
   group" to read the challenge file. Verified on Microsoft Learn.
4. Arc has a system-assigned identity only. MSAL refuses a user-assigned one
   there ("Azure Arc doesn't support user-assigned managed identities"), and
   the seal turns a `client_id` into exactly that request, so the stanza
   carries none. Verified in source.
5. HashiCorp's seal page describes managed identity only "if Vault is hosted
   on Azure" and does not mention Arc. The path is supported by the code, not
   documented by HashiCorp: a Vault upgrade is a reason to read this again
   (revisit triggers).
6. End to end, in a container: the real 2.1.1 binary, running as `vault` with
   only the `himds` group added by its unit, answered the challenge of a
   stand-in for the agent, received a token, read the key from a stand-in for
   Key Vault, wrapped and unwrapped with it, migrated from Shamir and came
   back unsealed after a restart. That the real agent and Key Vault behave as
   the stand-ins do, which follow Microsoft's documented flow, is inferred;
   the owner's migration on the host is its proof.

**Decision, accepted 2026-09-29.**

1. **A lab-only vault, the Key Vault `kv-labhybrid-prod-cus-01`** in
   `rg-lab-hybrid-prod-cus` (`infra/lab-hybrid.tf`). Standard tier, RBAC
   authorisation, purge protection, `prevent_destroy`, and AuditEvent to the
   Management workspace. The name drops a hyphen because the pattern's
   `kv-lab-hybrid-prod-cus-01` is 25 characters and Key Vault allows 24.
2. **One key, `vault-seal`**: RSA 3072, software-protected, allowed
   `wrapKey` and `unwrapKey` only, with `prevent_destroy`. It is created
   through Resource Manager, which needs only
   `Microsoft.KeyVault/vaults/keys/write` (Contributor has it), so the
   Terraform run identity holds no data-plane role on any vault.
3. **The Arc identity's only grant: Key Vault Crypto Service Encryption User
   on that key**, whose data actions are read, wrap and unwrap, and nothing
   on the vault or anywhere else. Terraform reads the Arc machine's principal
   at plan time and plans no grant while the machine does not exist, so a
   rebuilt host's new identity gets the grant at the next apply and the old
   one loses it.
4. **On the host, opt-in per installation.** The `vault` role adds a
   `seal "azurekeyvault"` stanza with no `client_id` and no secret, and the
   unit pins the credential chain to managed identity, joins `himds`, starts
   after the agent and retries every 30 seconds without a limit. The role
   reads the key as the Arc identity before it writes the stanza, and refuses
   to write a configuration without it while Vault's data is under it.
5. **Cost.** No monthly charge for a Standard vault or a software key; RSA
   3072 is an advanced key type at $0.15 per 10,000 operations (Azure Retail
   Prices API, Central US, read 2026-09-29). Vault's seal health check wraps
   and unwraps every 10 minutes while unsealed, about 8,800 operations a
   month, so about **$0.13 a month**. AuditEvent adds about 300 rows a day
   to the Management workspace, under a megabyte (estimated, not measured),
   inside its free 5 GB a month and well under 1% of its 0.25 GB daily cap.

**The trade, which is the owner's to accept.** With Shamir, root on this
host, which a workspace escape can reach, cannot unseal Vault: the root key
is split across keys only the owner holds. **With auto-unseal, root on the
host together with the Arc identity can.** Root can restart Vault and it
comes back unsealed, and a copy of the disk taken off the host, which holds
the agent's identity key as well as Vault's storage (the agent keeps that key
on the host unless the machine uses a TPM key store), can be unsealed for as
long as that identity keeps its grant. With Shamir, the same copy stays
sealed. What root gains that it does not already have is therefore narrow:
root can already read an unsealed Vault's memory, which the amendment of
2026-09-26 accepted, and Vault is unsealed nearly all the time. The
difference is the sealed window after a restart, and a disk copied away. The
boundary that makes this acceptable is unchanged: Vault holds lab-host
secrets only, never a production secret and nothing that exists nowhere
else, and the Arc identity reaches one key and nothing else. The detection
is the vault's audit log, where every unwrap carries the caller's IP
address. The revocation is removing the grant, or disconnecting the machine,
which deletes the identity. The price in availability is that Vault needs
Entra ID, Key Vault and the agent to start, and the recovery keys cannot
stand in for them, so an outage leaves Vault down until they answer, and a
deleted key would lose the Vault for good.

**Alternatives considered.**

- **A service principal and a client secret on the host.** Rejected: a
  stored secret root can read, and one more thing to rotate. It is what #726
  was opened to avoid.
- **Workload identity federation.** There is no token issuer on the host to
  federate, and Arc's identity is already the host's own credential.
- **Key Vault Crypto User, or a grant on the vault.** Rejected as wider than
  what Vault calls: Crypto User adds sign, verify, encrypt, decrypt, update
  and backup, and a vault-scope grant reaches any key added later.
- **An IP rule on the vault's firewall.** Not now. The host's address belongs
  to the `hcw-lab` workspace, which `infra/` never reads (decision 1), and a
  rule that drifted from it would leave Vault unable to unseal. Revisit
  trigger below.
- **A Premium vault and an HSM-backed key.** A monthly charge per key for a
  Vault that holds only secrets their issuers can issue again.
- **Keep Shamir.** The default, and what the host runs until the owner writes
  the fact.

**Consequences of this amendment, once the owner accepts it:**

- A restart, including the 04:30 reboot, comes back `Sealed false` with no
  owner step, and the five keys become recovery keys: still needed for
  `generate-root`, a rekey and a migration back, never again for an unseal.
- Every `hcw-azure` plan reads the Arc machine, and tolerates its absence.
- A rebuilt host starts without the seal, whatever the repository says; the
  owner writes the fact again after the next apply has moved the grant.
- Once the seal is on, `bootstrap.sh` must never run at a commit older than
  #726, whose role would write a configuration without it.

## Amendment 2026-10-07: container-runtime privilege separation (LAB-5)

**Status: decided 2026-10-07 under the estate review's finding LAB-5
(#951), and in effect on the host from the first `bootstrap.sh` run after
the merge, which the owner makes.** The evidence the review asks for is the
owner's to collect on the host
([Labs host runbook](../runbooks/labs-host.md#container-runtime-privilege-separation-lab-5)).

**Context.** Decision 4 accepted that Docker daemon access is root on the
host, and the consequences bullet below names the two holders and the
revisit trigger: "moving workspaces and jobs to a rootless or separate
daemon". The estate review of 2026-10-06 rated that High (LAB-5). #900 put a
path allowlist in front of the Coder server and tightened the agent's unit,
and left three things open: the agent's user was still in the `docker`
group; no container ran in a user namespace, so a container escape was root
on the host; and a compromised Coder server could still create a privileged
container through an allowed endpoint, because the proxy reads paths, not
bodies.

**Decision.**

1. **The agent leaves the docker group and reaches the host daemon through
   its own socket proxy.** `hcw-labs-agent-docker-proxy` is HAProxy 3.4.6
   (the newest LTS line) from Docker's official image, pinned by digest,
   with its configuration in this repository
   (`lab-host/ansible/roles/labs_agent/templates/docker-proxy.haproxy.cfg.j2`).
   It listens on a Unix socket owned `root:hcw-labs-agent` with mode 0660,
   in a container with no network, a read-only root filesystem and every
   capability dropped, and the unit's `DOCKER_HOST` names it. Its allowlist
   is the exact calls `docker run --rm` and `docker rm -f` make for a job,
   read from Docker CLI 29.8.1, the host's pin, against a recording daemon
   (`scripts/fixtures/docker-cli-agent-requests.json`): ping, a create named
   `labjob-<12 hex>`, attach, wait and start by container id, and a forced
   remove of a `labjob-` name. No pull (`lab_images` pulls as root first),
   no exec, inspect, list, volume, network, image or system call.

   A path allowlist does not read bodies, and the create body is where a
   privileged container is asked for. So the proxy reads that body too and
   refuses a create that carries privileged mode, a host or shared
   namespace, the opt-out of the daemon's user namespaces (`UsernsMode`), an
   added capability, a device, a mount, a bind other than the job's own
   staging directory read-only, unmasked kernel paths, a security option
   other than `no-new-privileges`, a network other than `none`, a sysctl,
   another runtime or log driver, or an image that is not a digest. These
   are deny-anywhere regular expressions, and that is sound only because of
   two facts the proxy also enforces: the agent's bodies are ASCII JSON with
   no backslash in them (the CLI escapes nothing in them), and with any
   other byte and every backslash refused, a key cannot be spelled through
   a JSON escape or a character Go's decoder folds to ASCII (`ſ` to `s`,
   `K` to `k`). A rule that matches a key anywhere then matches it wherever
   Docker would read it, in any case and however often it is repeated.
   `scripts/lab-host-docker-proxy.test.mjs` evaluates the file's own rules
   against every recorded request, against creates that would turn a job
   container into a way out, and against calls a job never makes; CI parses
   the rendered file with `haproxy -c` at the pinned image.

   Why a proxy and not a rootless daemon for the agent, which the review
   also offered: the job containers stay on the host daemon, which item 2
   puts in a user namespace anyway, so a rootless daemon for the agent would
   add a third daemon and image store to contain what the remap already
   contains, while the proxy also takes away everything a job does not
   need. And the agent's unit has `ProtectHome=true`, which hides
   `/run/user`, where a rootless daemon's socket lives.

2. **User namespaces on the host daemon.** `/etc/docker/daemon.json` sets
   `userns-remap: default`: every container's root is the first id of the
   `dockremap` user's subordinate range on the host, and its uid N that id
   plus N. The job containers, Coder's server and PostgreSQL run that way.
   It needs the containerd image store off, because that store "is not
   available when using user namespace remapping"
   ([Docker](https://docs.docker.com/engine/storage/containerd/), read
   2026-10-07; moby#47377), so the daemon goes back to the overlay2 graph
   driver, and `docker info` reports `name=userns` in its security options.

   Three of this host's own containers opt out with `--userns=host`, and
   nothing else can: the two socket proxies and Portainer, which must open
   a Docker socket that a remapped root cannot. The Caddy builder also runs
   that way, once, to write the binary into a root-owned directory. None is
   created through a proxy: they are created by root (Ansible and Compose), and the agent's
   proxy refuses any create that sets `UsernsMode`. Coder's server never
   reaches this daemon at all (item 3).

   Turning the remap on gives the daemon a new data root and hides the old
   one. So the run that switches stops every running container first,
   restarts the daemon before any later role creates a container, and
   copies two volumes into the new root once: Coder's PostgreSQL cluster
   (shifted into the remapped range) and Portainer's database (as it is,
   since Portainer runs with `--userns=host`). The old root is only read,
   and `-e docker_userns_remap=false` is the way back through the same
   stop-and-restart. `lab-host/ansible/roles/docker/tests/hcw-docker-volume-carry.test.sh`
   runs the copy as it ships against a tree shaped like PostgreSQL's.

3. **Coder's server reaches a separate, rootless daemon, never the host's.**
   The `coder_sandbox` role runs `dockerd-rootless.sh` (from
   `docker-ce-rootless-extras`, the same build and pin as `docker-ce`) as
   the unprivileged system user `hcw-coder-docker`, from a systemd user
   unit kept up by lingering, with its own subordinate id range and the cpu,
   memory and pids controllers delegated so the template's limits hold.
   `coder-docker-proxy` mounts that daemon's socket directory instead of the
   host's socket, and every workspace runs there. The proxy still reads
   paths only. What changed is what it reaches: a privileged container with
   `/` bound, asked for by a compromised server or a bad template, is
   privileged inside `hcw-coder-docker`'s user namespace, and `/` is what
   that user may see. `docker info` on that daemon reports `name=rootless`,
   which is user namespaces by construction, the daemon's own included.

   The review offered an authorisation plugin instead. It was the weaker
   choice here, for four reasons. A plugin sits in the host daemon and
   cannot tell Coder's requests from root's own, and root's own include the
   containers that must bind a socket, so its policy would have to trust a
   caller marker. A policy that denies by field is only as good as its list
   and has to parse JSON exactly as Docker does. A plugin that is down stops
   the daemon answering anyone. And the published managed plugin,
   `openpolicyagent/opa-docker-authz-v2`, was last pushed at 0.9 in January
   2024, behind its source releases (0.11 on 2026-10-06). A rootless daemon
   needs no policy, comes from a repository and pin the host already trusts,
   and is verified by one line of `docker info`.

**What this does not do.**

- **It does not make the regular expressions a parser.** They cannot
  require a setting to be present: a regular expression cannot tell
  `HostConfig` from an unknown key that Docker ignores. So network `none`,
  the read-only root, `cap-drop ALL` and uid 65534 remain the runner's own
  contract, asserted by `vps-agent/lib/docker-runner.test.js`, and with the
  remap they are containment of a job, not of the host. A future CLI that
  escapes a character in a body would be refused rather than passed; the
  fixture test and the end-of-run check fail first.
- **It does not separate jobs from the host daemon's other containers by
  id.** Attach, wait and start take any 64-hex container id, because the
  CLI uses the id the create returned. A compromised agent could start a
  stopped container of the host's own or read the output of a running one;
  it cannot inspect one (no environment), exec into one, or create one
  outside the rules.
- **It does not isolate learners from Coder's server.** Coder can still do
  anything on the sandbox daemon to any workspace, as before; the change is
  that it cannot do anything as root on the host.
- **It does not stop a kernel exploit.** A process that escapes a remapped
  or rootless container is an unprivileged uid that still shares the
  kernel. Unprivileged user namespaces stay restricted by Ubuntu's AppArmor
  for everything but `rootlesskit`.
- **Portainer is still root.** It holds the host's socket by design, for the
  owner only, on the loopback (amendment of 2026-09-26).

**Consequences of this amendment.**

- Two daemons and two image stores. `lab_images` plans each: the job images
  on the host daemon, the workspace image (about 484 MB) on the sandbox's.
  Portainer sees the host daemon only.
- On the run that turns it on, running jobs fail, workspaces stop, every
  image is pulled again, and a workspace starts again with an empty home
  volume, because its old volume belongs to the host daemon's old data root
  (kept on disk, served by nothing).
- `bootstrap.sh` checks all of it at the end of every run (`privilege_checks`):
  the agent in no docker group, `name=userns`, the agent proxy's socket and
  container, one job run as the agent user through the proxy while
  `docker ps` and a privileged `docker run` are refused, Coder's proxy
  carrying the Compose file's policy with the sandbox socket as its one
  mount, and `name=rootless` behind it.
- The cpu, cpuset and io controllers are delegated to every user manager on
  the host, not only `hcw-coder-docker`'s. That widens what a logged-in user
  may limit for their own processes and nothing else.

**Alternatives considered, for this amendment.**

- **Rootless Docker for the agent's jobs.** Rejected for the reasons in
  item 1: the remap already contains the jobs, and the proxy narrows the
  agent further than any daemon would.
- **An authorisation plugin on the host daemon** for the agent and Coder
  both. Rejected for the reasons in item 3.
- **A second rootful daemon for Coder.** Rejected: a privileged container on
  any rootful daemon is root on the host, so it separates nothing that
  matters.
- **Rootless daemons for everything, and no remap.** Rejected: the host's
  own containers (the Coder server and PostgreSQL among them) would stay
  without a user namespace, and the review's acceptance reads `docker info`
  on the host daemon.
- **A sandboxing runtime (gVisor, Kata, Sysbox) for jobs and workspaces.**
  Not taken now: a new runtime to pin, patch and explain for one host, when
  user namespaces answer the finding. It is the next step if a kernel
  escape becomes the risk to plan for.

**Revisit when:**

- Docker's containerd image store supports `userns-remap` (moby#47377),
  which lets the host daemon go back to it;
- the docker CLI pin moves, which needs the fixture recorded again
  (`scripts/lab/capture-docker-cli-requests.mjs`; the test fails until it
  is);
- a workspace needs something a rootless daemon cannot give it (nested
  Docker, a device), which reopens item 3 and points at Sysbox;
- the agent needs a Docker call the proxy refuses, which is a change to the
  allowlist with its own recording, never a wider rule.

## Amendment 2026-10-14: off-host backups and a rehearsed rebuild (LAB-9)

Estate review 2026-10-06, finding LAB-9 (#955): the host's only backups were
seven days of Coder PostgreSQL dumps on its own disk, Vault's raft store had
none, and the reinstall runbook had never been rehearsed or timed. The
amendment of 2026-09-26 above says the host is rebuilt rather than repaired;
this one says what the rebuild restores from.

**Decision.** Owner, 2026-10-14, choosing among Azure Blob Storage written
by the Arc identity, the VPS provider's object storage, and local-only with a
rehearsal: Azure Blob Storage.

1. **Where.** One storage account in the lab's resource group,
   `rg-lab-hybrid-prod-cus` (`infra/lab-hybrid-backups.tf`): Standard GRS, so
   the copy is off the VPS and off its region; Cool tier; TLS 1.2; shared
   keys off and OAuth the default, so the only principal that can write is the
   one granted; the public endpoint reachable, for the reason the lab Key
   Vault's is — the writer is a VPS outside Azure with no private path, and
   Entra plus one container-scoped grant gate every call. One container,
   `host-backups`, under a 35-day time-based immutability policy (unlocked):
   the host can write a blob and cannot delete or overwrite one inside the
   window, so a host that is compromised, and can therefore write backups,
   cannot destroy them. Versioning and 35-day soft delete behind that.
2. **Who writes.** The Arc machine's system-assigned identity — the one Vault's
   seal signs in with — gets its second grant, Storage Blob Data Contributor
   on that container only. No credential is minted or stored on the host for
   this: it asks the Arc agent on `127.0.0.1:40342` for a token for
   `https://storage.azure.com/`, the challenge flow the vault role already
   performs for the seal key.
3. **What is shipped.** The nightly Coder dump (`coder-postgres-backup`,
   03:30 UTC) is uploaded after it is written, to `host-backups/coder/`; a
   nightly `vault operator raft snapshot save` is uploaded to
   `host-backups/vault/`. The snapshot needs a Vault token with a
   raft-snapshot policy: seeded once with `hcw-vault-backup-seed` (the
   owner's Vault token on stdin; a periodic orphan token stored root-only)
   and renewed by the unit itself, the Coder rotation credential's pattern
   (one seed, then automatic; owner instruction 2026-10-09). Both units keep
   `OnFailure=hcw-unit-failed@`, and an alert per kind fires when no blob was
   written in two days: a missing backup is a row, not a silence.
4. **Not encrypted client-side before upload.** The account is Entra-only,
   immutable, in the lab subscription, encrypted at rest with Microsoft-managed
   keys, and its logs name every caller. A client-side key would be one more
   thing a rebuild must recover before it can restore anything, which is the
   failure this amendment exists to shorten. Revisit if the Coder database
   ever holds more than lab metadata and users' OAuth links.
5. **The rebuild.** The reinstall runbook gains a restore step: a helper
   lists the container through the Arc identity, downloads the newest (or a
   named) dump and snapshot, restores the database into the fresh
   `coder-postgres` and the raft snapshot into the re-initialised Vault
   (`-force`; the seal key in Key Vault is unchanged, so the restored data
   unseals). The runbook carries a **Last rehearsed / elapsed** line; the
   rehearsal is the owner's, on a fresh VPS, and this finding's acceptance is
   that line, a dated blob in the container, and the failure row.

**Consequences.** The Arc identity holds two grants instead of one, both
scoped to a single resource. A few megabytes a night in GRS Cool storage.
`verify-alert-state.yml` picks up the two new rules from the declarations.
What this does not change: Vault still holds lab-host secrets only, and the
host is still rebuilt rather than repaired — the restore is what a rebuild
ends with, not an alternative to it.

**Validation.** (1) `infra/lab-hybrid-backups.tf` applied, the output
`lab_hybrid_backups_storage_account` naming the account. (2) After the host
pull request: a blob under `host-backups/coder/` and one under
`host-backups/vault/` dated the night after the host's run, readable in the
portal, and a delete attempt on one refused with the immutability policy
named. (3) The alert's fire test: stop the Coder backup timer for two nights
## Amendment 2026-10-17: visitor lab sessions outside the organization (#1016)

**Context.** Under Decision 4, Coder is restricted to the `HybridCloudWorks` GitHub organisation (`CODER_OAUTH2_GITHUB_ALLOWED_ORGS: [HybridCloudWorks]`), and sign-ups remain off (`CODER_OAUTH2_GITHUB_ALLOW_SIGNUPS=false`). However, visitors outside the organisation who wish to complete interactive walkthroughs without GitHub organisation membership could not access workspaces. Coder Community edition lacks enterprise per-user quotas, auto-stop enforcement, and dormancy. Opening sign-up would permit any visitor to exhaust the host's 5 workspace slots, violating Decision 4.

**Decision, accepted 2026-10-08 and 2026-10-16 (#1016).**
1. **Brokered sessions:** The site brokers ephemeral Coder workspaces on behalf of visitors. Visitors never receive persistent Coder accounts. The Function App acts as broker using a dedicated Coder broker token held in Key Vault (`CODER-BROKER-TOKEN`).
2. **Access & Verification:** Requests require the site's exact Origin and a Cloudflare Turnstile token for the `visitor-session` action (`functions/src/lib/labs/public-lock.js`).
3. **Capacity & Rate Limits:**
   - Global concurrency cap (`LABS_VISITOR_MAX_CONCURRENT`, default 2), reserving remaining slots for team members.
   - Per-client daily limit (2 sessions per client key).
   - Hard session duration: 60 minutes (`VISITOR_SESSION_DURATION_MS`).
   - Hard auto-reap: sessions past `expiresAt` are automatically reaped and deleted upon subsequent queries/requests, with an emergency shutoff switch (`LABS_VISITOR_SESSIONS_ENABLED=false`).
4. **Hygiene:** Visitor workspaces sparse-clone public repositories with no secrets mounted, respecting #954 egress isolation (LAB-8).

## Consequences and accepted risks

- **Two Terraform workspaces, two lifecycles.** A change to the lab host is a
  run in `hcw-lab` that the owner confirms in the HCP Terraform UI, the same
  way as `hcw-azure`. The isolation is the point, and it means the two can
  drift in provider versions and conventions; the
  [IaC repository standard](../standards/iac-repository-standard.md) applies to
  both.
- **No Kubernetes means no Kubernetes lab.** Followers who want AKS or k3s
  content will not get it from this host. Docker Compose is the whole
  orchestration story, and the host is rebuilt rather than repaired.
- **Arc adds an identity to the host.** The Arc agent's system-assigned
  identity can be granted Azure roles. This record grants it none beyond what
  the data collection rule needs; any grant is a change to `infra/` with its
  own review. (The amendment of 2026-09-29 made the first, in
  `infra/lab-hybrid.tf`: read, wrap and unwrap on one key in a lab-only Key
  Vault, never `kv-site-prod-cus-01`.)

  *Amendment 2026-10-07 (estate review, LAB-6; owner decision that day):*
  the Connected Machine agent is locked down on the host, by the `arc`
  role (`lab-host/ansible/roles/arc/tasks/onboard.yml`). Since #900 and
  #909, applied by `bootstrap.sh` on 2026-10-07 (`failed=0`), its extension
  allowlist admits the Azure Monitor Linux agent alone
  (`extensions.allowlist`) and incoming connections, SSH over Arc and
  Windows Admin Center, are off (`incomingconnections.enabled false`). A
  Contributor on `rg-lab-hybrid-prod-cus` can therefore no longer push an
  extension or a Run Command, which ran as root. These settings live on the
  host and cannot be changed from Azure. **Guest configuration is off as
  well** (`guestconfiguration.enabled false`, set by the same role the same
  way). The review recommended enabling it; the owner chose off. Locking the
  agent down was the point of #900, and Microsoft's guidance for a
  locked-down machine disables guest configuration so that a custom machine
  configuration policy, which runs privileged on the host, cannot change
  the agent's configuration
  ([Extensions security for Azure Arc-enabled servers](https://learn.microsoft.com/azure/azure-arc/servers/security-extensions),
  "Locked down machine best practices", read 2026-10-07). It also avoids
  the machine-configuration charge for an Arc server: the Azure Arc pricing
  page, read 2026-10-07, lists Azure Policy guest configuration at USD 6 per
  server per month (USD 0.009 per server-hour), included only with
  Defender for Servers Plan 2, which stays off. **What it costs:** the
  audit-only machine configuration in decision 3 has no agent on the host
  to run it. The `audit-linux-baseline-lab-hybrid` assignment
  (`infra/lab-hybrid.tf`, behind `lab_hybrid_policy_enabled`) cannot produce
  a compliance result for this machine while the setting is off, so the
  labs page's compliance reading would have nothing current to show.
  Whether to keep that switch, remove the assignment and the
  `Microsoft.GuestConfiguration` provider registration, or revisit this
  choice is an open owner question on #952. The evidence for all three
  settings is `sudo /opt/azcmagent/bin/azcmagent config list` on the host,
  which stays with the owner.

  *Amendment 2026-10-16 (#953, LAB-7; owner decision that day):* the owner
  reaches the host through **Azure Arc SSH**, and port 22 then closes to the
  internet. LAB-6's "incoming connections off" is **partly reversed, for
  port 22 only**, to carry it: the `arc` role sets
  `incomingconnections.enabled true` and `incomingconnections.ports 22`
  (`arc_incoming_ssh_enabled`, default true; false puts LAB-6's state back),
  and `infra/lab-hybrid.tf` declares the machine's default connectivity
  endpoint with one SSH service configuration, port 22. Windows Admin Center
  and every other port stay refused. **The extension allowlist is
  unchanged**, the Azure Monitor Linux agent alone, and the role fails
  closed if it reads back anything else after setting the incoming ports.
  Entra ID login over SSH (the `AADSSHLoginForLinux` extension) does not
  support Ubuntu 26.04, so no login extension is added: the login is the
  local user `hcwadmin` with the one pinned key, as it is directly. **Arc
  SSH is a transport in front of sshd's own key check, not a login.** The
  relay delivers a stream to sshd on the host's loopback; an identity that
  may list the endpoint's credentials (Owner or Contributor on the machine
  or its group) can open that stream, and still meets sshd asking for the
  pinned key, as a connection from the internet does today. No role is
  granted for it: the owner is Owner on the subscription. **Break-glass is
  the Hostinger web console** (hPanel's Web Console), which depends on
  neither Arc, the relay nor port 22. The order is staged: the keys,
  `AllowUsers` and `alert-lab-ssh-login` land while port 22 is open; then
  this; then the owner connects through Arc
  (`scripts/lab/Connect-Lab.ps1 -Arc`) and signs in at the web console; only
  then does a later change close port 22 and set `lab_ssh_loopback_only`,
  from which an accepted login from anywhere but loopback pages.
  ([SSH access to Azure Arc-enabled servers](https://learn.microsoft.com/azure/azure-arc/servers/ssh-arc-overview),
  read 2026-10-16.) *(2026-10-17, #953 stage 3: both preconditions were met
  that day, so port 22 closes at ufw and `lab_ssh_loopback_only` is on. The
  hardening role closes 22 only while the Arc agent is Connected with
  incoming connections on for port 22 (`hardening_ssh_arc_gate`), and leaves
  it as it is while the agent is Disconnected, because a rebuilt or reset
  host is onboarded over port 22 by `Register-LabArc.ps1`. Since #1257 sshd
  also listens on the loopback alone, and that bind follows the same gate.)*
- **Ingestion is bounded but not zero.** Heartbeat and auth syslog on one host
  are kilobytes a day against the workspace's 0.25 GB/day cap
  ([ADR 0031](0031-security-scanner-owner-decisions.md) records the headroom).
  A chatty `authpriv` source under an SSH brute-force attempt is the case to
  watch, and the daily-cap alert already exists.
- **Without Defender for Servers there is no managed EDR on the host.** The
  controls are SSH keys only, an inbound policy of 22, 80 and 443 (80 and
  443 since #953 stage 3, with SSH through Azure Arc), audit-only
  machine configuration, and the auth syslog above. This is a stated cost
  trade, revisited in the triggers below.
- **Coder is a second identity system with its own users.** Learners have a
  GitHub-backed Coder account and nothing on the site. Coder's own hardening —
  workspace resource limits, template review, upgrade cadence — belongs to
  #659 and is not covered here.
- **Two processes can drive the Docker daemon, and daemon access is root on
  the host. Accepted, with the blast radius kept small on purpose.** (Three
  once the owner turns Portainer on; the amendment of 2026-09-26 bounds the
  third by who can reach it.) The
  Coder server container holds the socket; the `hcw-labs-agent` service is in
  the `docker` group. Whoever controls either controls the daemon, every
  workspace and every job container, so `--network none` and the label
  checks protect learners and jobs from each other, not the host from those
  two. The mitigations are: the socket goes to the Coder server only, never
  to a workspace (asserted by the #679 template test); workspaces run on
  their own bridge network with no route to the Compose network; the Coder
  server runs as a non-root user; the agent runs only the fixed argv
  templates in `vps-agent/lib/capabilities.js`, never a shell string shaped
  by a payload, with the payload bind-mounted read-only, and the API
  authorises every claim against the agent's registry document; and the host
  deliberately holds no data of record and no Azure or application
  credential: only the agent's certificate, which reaches three API
  endpoints, and Caddy's DNS token, which is scoped as narrowly as Cloudflare
  allows and which, in the interim the next bullet records, can edit
  production DNS records. That token is the one production-reaching
  credential on the host, and it is why the dedicated lab zone is the
  target shape. A compromise therefore costs a rebuild, plus a check of the
  production zone's records until that zone exists, not data. Moving workspaces and
  jobs to a rootless or separate daemon is a revisit trigger, not a
  prerequisite.

  *Amendment 2026-10-06 (estate review, LAB-5):* the Coder server no longer
  holds the socket. A `coder-docker-proxy` Compose service (HAProxy, one
  allow rule per Docker API section) mounts it read-only on a control
  network the server alone shares with it, and the server reaches the
  daemon through it over `DOCKER_HOST`: containers, images, networks,
  volumes and the lifecycle verbs the provisioner uses, and nothing else —
  no exec, build, commit, swarm, system or auth. **This narrows a Coder
  compromise; it does not contain it.** The proxy inspects paths, not
  bodies, so a compromised server can still create a privileged container
  or bind the host's `/` and start it, which is root as before. Containing
  that needs a body-aware authorisation layer (a Docker authz plugin that
  rejects privileged mode, host binds, host namespaces and added
  capabilities) or a separate or rootless daemon for Coder, and that is the
  revisit trigger, now with its shape written down. `template.test.mjs`
  asserts the mount, every proxy policy key, the networks, and the absence
  of the socket and the docker group from the server. The agent keeps its
  docker group; its unit gained system-call and address-family filters and
  its `npm ci` runs with `--ignore-scripts`.

  *Amendment 2026-10-07 (LAB-5), the revisit trigger taken:* neither
  process can drive the host daemon as root any more. The agent is in no
  `docker` group and reaches the daemon through its own proxy, whose
  allowlist is the calls a job makes and whose create rules refuse the ways
  out; the daemon remaps user namespaces, so a job container's root is an
  unprivileged uid; and the Coder server's proxy holds the socket of a
  separate rootless daemon run by `hcw-coder-docker`, where every workspace
  runs. The [amendment of that date](#amendment-2026-10-07-container-runtime-privilege-separation-lab-5)
  records the choices and what they leave.
- **Cloudflare API tokens are zone-scoped, and `lab.hybridcloudworks.com` is
  a name in the production zone.** Cloudflare cannot scope a token to one
  record, so any token with DNS edit on `hybridcloudworks.com` can change the
  site's own records. Two tokens exist and neither is on the host in a form
  that reaches production DNS more than it must: the `hcw-lab` workspace
  token creates the `lab` records and lives only in HCP Terraform; Caddy's
  renewal token lives on the host in `/etc/caddy/env`, owner `root`, group
  `caddy`, mode `0640`, written from Ansible Vault and read by the non-root
  `caddy` service through its unit's `EnvironmentFile`, so the service can
  renew and nothing else on the host can read it. Caddy holds one certificate whose names are
  `lab.hybridcloudworks.com`, `*.lab.hybridcloudworks.com` and
  `*.coder.lab.hybridcloudworks.com` (Coder's workspace apps are one label
  below `coder.lab`, and a wildcard covers one label only). The chosen shape
  is **DNS-01 by CNAME delegation**: the two challenge names those SANs
  resolve to, `_acme-challenge.lab.hybridcloudworks.com` (for the apex and
  `*.lab`) and `_acme-challenge.coder.lab.hybridcloudworks.com` (for
  `*.coder.lab`), are CNAMEs into a dedicated lab zone that holds no
  production record, and Caddy's token is scoped to that zone alone. Until
  the owner has that zone (a small annual spend, tracked on #661), Caddy's
  token has DNS edit on the production zone, and that interim is an accepted
  risk recorded here rather than a surprise. *Corrected 2026-10-06 (estate
  review, LAB-1):* this bullet used to say the `hcw-azure` plan check and
  the deploy-drift monitor would show any production record the token
  altered. Neither does: the drift monitor reads GitHub only, the plan covers
  the three records Terraform manages, and the apex and `www` records are
  hand-made. The only record of a zone edit is Cloudflare's own audit log.
  Until the lab zone exists, the compensating steps are the token's
  client-IP filter and expiry in Cloudflare and an audit-log notification
  for DNS changes on the production zone, both owner steps.
- **`lab-image/` is a new supply-chain surface.** Every image it publishes
  must be digest-pinned where consumed, and the existing
  `capabilities.test.js` assertion that every capability names a digest is the
  gate. The Terraform provider mirror is a large image layer, and its pins are
  one more set to keep current.
- **The public path stays closed**, so the labs pages remain read-mostly until
  a revision of this record. That is deliberate: the rate limits above need a
  client identifier the anonymous site does not have yet, and choosing one
  (edge-hashed IP, signed cookie, or a Coder session) is the revision's job.
  (Revised 2026-09-28: the amendment of that date opens the path from the
  builder's pane and chooses the edge-hashed IP, made meaningful by a
  Turnstile token.)

## Alternatives considered

- **k3s on the host, with lab jobs as Kubernetes Jobs.** Rejected by the owner
  on 2026-09-24. It adds a control plane to run, patch and explain for one
  node, and turns "a VPS with Docker" — the thing a follower already has — into
  a distribution they must learn first. Docker's `--network none`, pids, memory
  and CPU limits already give the sandbox the isolation the runner needs.
- **A self-hosted GitHub Actions runner on the VPS**, for labs or for CI.
  Already rejected in [ADR 0025](0025-cosmos-firewall-datacenter-sentinel.md):
  this repository is public, and a self-hosted runner on a public repository
  lets a fork pull request execute code on the host.
  [ADR 0021 (number reused)](0021-container-apps-ci-runner.md) records the
  Container Apps form of the same idea and why it was dropped.
- **Managing the VPS by hand, or from Ansible alone.** Rejected. Without a
  Terraform record the host's plan, OS and DNS live in a control panel that no
  pull request can review, which is the state it was in when this record was
  written.
- **Putting the lab host in the `hcw-azure` workspace.** Rejected. It would let
  a provider error or a mistaken destroy in a lab experiment surface in the
  production run queue, and it needs the Hostinger token in the workspace that
  holds the production Azure credential.
- **Site-hosted learner sign-in** (a public Entra External ID or GitHub OAuth
  flow on the site itself). Rejected. [ADR 0006](0006-admin-identity.md) keeps
  the site's identity for administrators only, and Coder already has the
  learner sign-in the labs need.
- **Embedding Coder in the site** through an iframe. Rejected. It requires
  opening `frame-src` and `connect-src` to the lab origin, joins the two trust
  boundaries in the browser, and gives the learner a worse editor than the one
  Coder serves directly. (Chosen 2026-09-28, owner decision, #750 and #751:
  see the [amendment of that date](#amendment-2026-09-28-coder-in-the-sites-panes).
  Only `frame-src` had to open; `connect-src` did not.)
- **Defender for Servers Plan 1 on the Arc machine.** Rejected for now on
  cost (a per-server monthly charge for one host with no data of record). See
  the revisit triggers.
- **Opening public submission in this record**, with the bounds above.
  Deferred to a revision, for the client-identifier reason given under
  consequences. (The revision is the amendment of 2026-09-28.)
- **For that revision (2026-09-28), the origin alone.** Rejected: any script
  can send `Origin: https://hybridcloudworks.com`, so it locks out other
  sites' pages and nothing else.
- **For that revision, a signed session cookie from the site.** Rejected: the
  site has no anonymous session to sign, and minting one is a new token
  service to secure, rotate and explain, where Turnstile is a managed one the
  site's own proxy vendor already runs.
- **For that revision, a Coder session.** Rejected for the builder: it would
  make a learner sign in with GitHub to validate a download, and the builder
  is public by design. Coder stays the boundary for browser workspaces.
- **For that revision, the widget as `cloudflare_turnstile_widget` in
  `infra/`.** Rejected, for the state and token-scope reasons in item 6 of
  the amendment.

## Validation and revisit triggers

- **Validation:**
  - `hcw-lab` exists in the `hcw` organisation, is VCS-connected to this
    repository with working directory `infra-lab/`, has auto-apply off, and a
    plan there shows the VPS and DNS records. The `hcw-azure` workspace shows
    no change from the same commit.
  - After the owner applies, the host appears as **Connected** under Azure Arc
    > Machines in `rg-lab-hybrid-prod-cus`, and a `Heartbeat` query in the
    Management workspace returns rows for it.
  - The control plane is checked by name, not by count: `docker ps` on the
    host shows the Compose services `coder`, `coder-docker-proxy` and
    `coder-postgres` (and the
    container `portainer` while `portainer_enabled` is true, and since the
    amendment of 2026-10-07 the agent's `hcw-labs-agent-docker-proxy`), and
    `systemctl` shows `caddy`, `hcw-labs-agent` and `node-exporter` active as
    host-native units (and `vault` while `vault_enabled` is true). Every other container carries either the
    Coder workspace label (`com.coder.resource=true`) or the `hcw.lab-job`
    label the agent sets, and any container with neither is a finding. Since
    2026-10-07 workspaces are listed on the sandbox daemon
    (`docker -H unix:///run/hcw-coder-docker/docker.sock ps`) and job
    containers on the host's. The
    count is not asserted, because a running workspace or job legitimately
    adds containers. `which kubectl k3s` returns nothing.
  - `/education/labs` shows the Arc status card fed by the Function App's
    Resource Graph read under its Reader grant on `rg-lab-hybrid-prod-cus`
    (decision 3), and shows an explicit absent state, not a fabricated one,
    when the resource group is missing or the host is down.
  - `enqueueLabJob` with no `Authorization` header still answers 401, which the
    Health Hub labs probe already asserts.
  - Since the amendment of 2026-09-28: `GET /api/public/labs/submit` answers
    `open: true` while `vps-hostinger-01` heartbeats, and a `POST` to it with
    no `Origin` header answers `403 ORIGIN_NOT_ALLOWED`. The builder's
    **Validate on the lab** at `https://hybridcloudworks.com/tools/landing-zone`
    queues a job that `vps-hostinger-01` claims and completes, and the page
    shows Terraform's output.
  - Every image `lab-image/` publishes is referenced by digest in
    `vps-agent/lib/capabilities.js` and the Coder template.
  - Since the amendment "Coder in the site's panes": with Coder enabled, a
    learner opens a lab from `/education/labs`, signs in with GitHub once in
    the tab the pane opens, and comes back to the lab's page with the
    workspace in the pane; a direct visit to
    `https://coder.lab.hybridcloudworks.com` still lands on
    `/education/labs`. Since the launcher note under it: after Coder's
    **Confirm and Create**, code-server opens inside the pane, and a direct
    visit to `https://coder.lab.hybridcloudworks.com/_hcw/lab/` also lands on
    `/education/labs`.
  - Since the amendment of 2026-10-07 (LAB-5): every `bootstrap.sh` run
    ends with the `privilege_checks` role passing, and on the host
    `id hcw-labs-agent` names no `docker` group, `sudo docker info` lists
    `name=userns` among its security options, `sudo docker -H
    unix:///run/hcw-coder-docker/docker.sock info` lists `name=rootless`,
    and `coder-docker-proxy` carries every policy key of
    `lab-host/coder/docker-compose.yml` with `/run/hcw-coder-docker` as its
    one mount (the runbook's commands, with what good looks like).
  - Since the amendment of 2026-09-29, accepted and live that day: on the
    host, `sudo systemctl restart vault && sleep 5 && vault status` shows
    `Seal Type azurekeyvault` and `Sealed false`, and `az role assignment
    list` on the key `vault-seal` returns one row, Key Vault Crypto Service
    Encryption User for the Arc machine's identity (the runbook's step 2).
- **Revisit when:**
  - Vault is upgraded past 2.1.x, which is a reason to read the seal's
    credential path again: signing in through the Arc agent is supported by
    the code, not documented by HashiCorp (amendment of 2026-09-29);
  - the Key Vault audit log shows an unwrap from an address that is not the
    lab host's, which is a revocation first (remove the grant) and a review
    of the auto-unseal trade second;
  - the lab host's public address becomes something `infra/` can read, which
    reopens an IP rule on `kv-labhybrid-prod-cus-01`;
  - the owner decides to open public submission, which is a revision of §6 of
    this record and nothing else (done 2026-09-28, the amendment of that
    date);
  - the daily cap fills from a handful of verified addresses, or siteverify
    passes tokens that the job pattern says were farmed, which reopens the
    lock (Turnstile's pre-clearance or interactive mode, or a signed
    session);
  - the host gains data of record (learner work that cannot be rebuilt), which
    reopens the backup posture and Defender for Servers;
  - the auth syslog shows sustained credential attacks, which reopens Defender
    for Servers and the inbound policy;
  - a second lab host is wanted, which reopens the single-workspace and
    single-Compose assumptions;
  - code-server is to open inside the pane rather than from Coder's app
    button, which leaves it (the amendment "Coder in the site's panes";
    done 2026-09-28 by the lab launcher, the note under that amendment);
  - the `hostinger/hostinger` provider changes its `hostinger_vps` resource
    incompatibly or is abandoned.

## Related decisions and references

- [ADR 0004](0004-functions-boundaries.md): the labs Function App as a
  separate trust boundary, superseded by [ADR 0019](0019-single-function-app.md),
  which keeps the boundary as a contract inside one app
- [ADR 0006](0006-admin-identity.md): Entra ID for administrators only
- [ADR 0015](0015-cost-governance.md): the USD 150 ceiling
- [ADR 0021 (number reused)](0021-container-apps-ci-runner.md) and
  [ADR 0025](0025-cosmos-firewall-datacenter-sentinel.md): why a self-hosted
  runner is rejected in a public repository
- [ADR 0022](0022-alerting-fabric.md): the alerting the host joins
- [Target architecture §5.3](../architecture/architecture.md#53-labs-flow),
  corrected alongside this record
- [Labs host](../architecture/labs-host.md): the estate record for the host
- [ADR 0035](0035-addon-pane-model.md): the AddOn pane model, which reuses
  decision 4's status proxy and the panes-only amendment for independently
  built tools, and amends this record's "Compose is for Coder only" line by
  adding single containers run by the `addons` role as a second workload
  kind on the host (its decision 8, awaiting the owner's review)
- [Required inputs §4.7](../standards/required-inputs.md#47-vps-agent-hostinger-env-never-committed):
  the inputs this record names
- Epics: #656 (the hybrid lab host), #657 (Landing Zone Builder), #658
  (`hcw-lab` image and Docker sandbox), #659 (browser labs on Coder)
- `vps-agent/index.js`, `vps-agent/lib/capabilities.js`,
  `functions/src/lib/labs.js`, `functions/src/functions/labs-http.js`,
  `frontend/staticwebapp.config.json`
