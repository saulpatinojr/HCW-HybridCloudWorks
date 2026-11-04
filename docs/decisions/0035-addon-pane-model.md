# ADR 0035: The AddOn pane model — independently built tools in sandboxed panes on lab names, a generic site page, a status proxy and a generic host role

**Status:** Accepted 2026-10-10 (proposed 2026-10-09 from the approved App-to-AddOn program plan; decisions 8 and 9 confirmed by the owner on 2026-10-10 in [#1044](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1044); the Caddy redirect in Consequences carried [VERIFY], answered on 2026-10-10 by `caddy adapt` in CI)
**Decision date:** 2026-10-09
**Owners:** Workload owner and architecture owner

Related requirements: the App-to-AddOn program (`HCW-AzMigrateOrchestrator_Addon`,
`HCW-CloudAssessor_AddOn`, `HCW-NetworkEyes_AddOn`); [ADR 0032](0032-learner-labs-platform.md)
decisions 4 and 6 and its amendments of 2026-09-26 and 2026-09-28; the
[AddOn integration standard](../standards/addon-integration-standard.md).

## Context

The App-to-AddOn program splits each HCW product into an upstream App (the
engine, rules and UI, with an Azure appliance edition that runs on Container
Apps under a managed identity on a client's subscription) and a downstream AddOn
(the same image in a lab edition on the lab host, where a visitor uploads an
Azure Resource Graph export and gets an assessment that is held in memory for
two hours). The site needs to show three such AddOns (`migration`,
`cloud-assessment`, `network-assessment`) and any later one, without taking on
their code, their secrets or their release cadence.

Owner decisions 2026-10-09 that constrain the answer:

1. The AddOn is the same container image as the App, in a `lab` edition, hosted
   on the lab host. It holds no cloud credential and must be technically unable
   to construct one.
2. The integration is the website's pane model, generalised: each AddOn is an
   independently deployed web application framed in a sandboxed iframe on
   `/tools/<id>`, with a catalogue row, a `frame-src` entry and a Function App
   status proxy. The npm island (installing `@hybridcloudworks/migration-ui` into
   the site bundle, as the AddOn's integration guide proposed) is rejected.
3. The website changes once, in one reviewable PR, from a written
   specification.
4. All AddOn images publish to Docker Hub (`docker.io/hybridcloudworks/<image>`)
   and are pinned by digest, matching the lab-image decision of 2026-10-08.

The precedent is ADR 0032. Its decision 4 put a server-side status proxy with a
minute cache in front of Coder so the browser never calls the lab; its amendment
of 2026-09-28 made the site's panes the only way into a lab, with Caddy adding
site-only `frame-ancestors` and redirecting top-level visits, and
`LabPanePage.jsx` holding the sandbox, the message filter and the watchdog. The
site already has every part the AddOns need, written for one tenant.

Three things stop the labs pattern being reused as it is:

- ADR 0032's host record says Docker Compose on the host is for Coder and its
  PostgreSQL only, and the lab host's README and the caddy role's README repeat
  it. AddOn containers are a new kind of workload on that host.
- The labs pane sandbox is `allow-scripts allow-same-origin allow-forms allow-popups`
  with no `allow-downloads`. Every AddOn produces a report bundle and a sample
  file; Chromium blocks a download from a sandboxed frame without that flag, and
  a popup inherits the sandbox, so `allow-popups` does not help.
- The labs code is tied to Coder: GitHub sign-in in a new tab, a launcher page,
  workspace states, wildcard sub-origins, a template. None of it applies to an
  anonymous tool that answers an upload.

The question is therefore how AddOns reach the site: in the bundle, behind the
site's own origin, or as framed origins of their own, and under what contract.

## Purpose and decision drivers

- Keep the site's content security policy closed: `connect-src` names the
  Function App and sign-in only, `frame-ancestors` stays `'none'`, and each
  AddOn adds one exact origin to `frame-src` and nothing else.
- Keep every AddOn secret on the lab host, whose Ansible vault already holds
  the lab's secrets and unseals through the Arc identity; the site's Key Vault
  gains nothing.
- Let each AddOn ship on its own cadence, with a release reaching the site as a
  one-line digest change and an owner run, and roll back the same way.
- Pay for nothing new: the AddOns run on the host already paid for
  ([ADR 0015](0015-cost-governance.md)).
- Keep a lab edition technically unable to construct a cloud credential, so the
  host that runs it holds nothing an AddOn could use against a tenant.

## Decision

Chosen: **sandboxed panes on lab names**, because it is the one model that
keeps the site's CSP closed, keeps the AddOn's secret boundary on the host that
already holds one, and lets each AddOn ship on its own cadence with a one-digest
change on the site. The decision has nine parts.

1. **One origin per AddOn.** `https://<id>.lab.hybridcloudworks.com`, one label,
   no wildcard, served by Caddy on the lab host. The `*.lab` DNS record and the
   wildcard certificate already cover it. The AddOn's own HTML carries
   `frame-ancestors` equal to the host's `caddy_frame_ancestors`, from env, so
   the two policies the browser enforces agree.
2. **A generic site page.** `frontend/src/pages/tools/AddOnPanePage.jsx` at
   `/tools/<id>`, structured as `LabPanePage.jsx` without the sign-in step: one
   opening sentence, a frame, or one unavailable sentence (`This tool isn't available right now.`),
   a 30-second watchdog, and the pane protocol. No provider-scoped variants.
3. **The pane protocol.** Sandbox `allow-scripts allow-same-origin allow-forms`
   plus capability flags from the row; `allow` for clipboard and fullscreen by
   capability only; messages `{ type: 'hcw-addon', id, state, navigate? }` with
   states `loading`, `ready`, `working`, `unavailable`, accepted only from the
   AddOn's origin, the frame's own window and the row's id; `navigate` from an
   allow-list, handled by the page; no message from the site to the AddOn.
4. **A status proxy.** `GET /api/public/addons/{id}/status` on the Function App,
   anonymous, a closed server-side registry of ids, a 5-second read of the
   AddOn's `/api/health` over https only, a one-minute cache in
   `tool_service_cache` with failures cached, and a six-field projection
   (`configured`, `reachable`, `version`, `edition`, `capabilities`, `asOf`). The
   frame mounts only on `configured` and `reachable`. The AddOn's address is a
   plain app setting (`ADDON_<ID>_URL`), not a vault reference, because it is a
   public value already in the CSP.
5. **A catalogue.** `frontend/src/data/addons/catalogue.js`, frozen rows with
   `id`, `title`, `menuLabel`, `summary`, `origin`, `panePath`, `healthPath`,
   `providers`, `technology`, `status`, `capabilities`, `docsUrl`,
   `articleSlugs`. The Tools menu, the pre-render list, the CSP `frame-src`
   entries and the registry parity test derive from it. A `coming` row renders an
   explainer and no frame.
6. **A generic Ansible role.** `lab-host/ansible/roles/addons` runs one hardened
   single container per row (`hcw-addon-<id>`, loopback port, read-only root,
   all capabilities dropped, no new privileges, memory and pids limits, no
   volumes or mounts, no socket, on the add-ons' own bridge network with
   inter-container communication off and egress limited in the `DOCKER-USER`
   chain to the verification endpoint's published ranges on 443, under the
   daemon's user-namespace remap), waits for its health, renders a Caddy route
   with the unavailable sentence at 503 (a direct 503 for a row with no digest
   yet), removes the container of any row not deployed this run, and refuses
   to start a container whose vault key (`vault_addon_<id>_<name>`) is unset.
   The end-of-run privilege checks cover each container, its network and its
   one port binding.
7. **Docker Hub digests.** Images are `docker.io/hybridcloudworks/<image>`,
   pinned by digest in `group_vars/all.yml`. A release is a website PR that moves
   one digest and the owner's `bootstrap.sh` run; rollback is the previous
   digest. The website never bumps an AddOn on its own.
8. **Amendment to ADR 0032.** The line "Docker Compose on this host is for Coder
   and its PostgreSQL only" stands for Compose. This record adds: single
   containers run directly by the `addons` role are a second permitted workload
   on the host, each loopback-only behind Caddy, each listed in `group_vars`,
   each without Compose. ADR 0032's `docker ps` validation names gain
   `hcw-addon-<id>` by reference to this record. Confirmed by the owner on
   2026-10-10 (#1044).
9. **The `downloads` capability.** A row that names `downloads` gets
   `allow-downloads` on its sandbox, so the AddOn's report bundle and sample
   file can be saved from the pane. Every AddOn pane also offers "Copy report",
   so it works without the flag. Confirmed by the owner on 2026-10-10 with
   decision 8 in
   [#1044](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1044):
   the migration row grants `navigate` and `downloads`, and the accepted-risk
   row in `TODO.md` applies.

The [AddOn integration standard](../standards/addon-integration-standard.md)
carries the contracts in full, with each requirement marked Mandatory or
Optional, and the compliance checklist a reviewer ticks before a row becomes
`available`.

## Consequences and accepted risks

- Positive: the site's `connect-src` stays closed and its `frame-ancestors 'none'`
  stays; each AddOn adds one exact origin to `frame-src` and nothing else.
- Positive: the AddOn's secret boundary is the lab host's vault, already
  auto-unsealed through the Arc identity (ADR 0032, amendment of 2026-09-29); the
  site's Key Vault gains nothing.
- Positive: an AddOn release reaches the site as a one-line digest change and an
  owner run; the site's own build and deploy are untouched by it.
- Positive: three AddOns share one page, one proxy, one role and one test
  harness; the fourth costs a row, a setting, a `group_vars` entry and a CSP line.
- Positive: the lab editions are technically unable to construct a cloud
  credential, enforced by tests and an image-level check, so the host that runs
  them holds nothing an AddOn could use against a tenant.
- Negative: the site cannot see inside a pane; it knows only what the AddOn
  posts and what the proxy reads. A broken AddOn page that still answers its
  health read shows as available until the watchdog or the AddOn's own
  `unavailable` message says otherwise.
- Negative: `allow-same-origin` with `allow-scripts` on a cross-origin frame
  gives the AddOn its own origin's full powers inside the pane. Accepted because
  the frame is always another origin (the sandbox cannot be lifted), the AddOn
  holds no site credential, `frame-src` names each origin exactly, and the labs
  pane already runs this way.
- Negative: `allow-downloads` lets a framed AddOn start a file
  download in the visitor's browser. Accepted because the AddOn is the site's
  own image by digest, the download is the visitor's own report, and the row
  grants it per AddOn. Recorded as an accepted risk in `TODO.md`.
- Negative: the lab host gains a workload kind beyond ADR 0032's record, and its
  memory ceiling now counts AddOn containers (512 MiB each) beside Coder's
  capacity assertion.
- Negative: the Caddyfile's direct-visit redirect becomes per-host through a
  `vars` override, which depends on directive ordering. [VERIFY] was answered
  on 2026-10-10: `lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh` has
  the pinned Caddy (v2.11.4) adapt the rendered configuration in the
  `lab-host role tests` job (the `ansible-lint (lab-host)` job until
  2026-11-04) and fails unless the snippet's `vars` comes
  first, the route's after it and the `redir` after both; the fallback (the
  global redirect to the labs page) was not needed.
- Negative: a visitor's upload leaves the site's trust boundary for the lab
  host; the pane says so before an upload, and the AddOn holds it in memory for
  at most two hours with a delete button.
- Follow-ups: the website PR specified in `docs/architecture/app-to-addon/`;
  the migration AddOn's `v0.3.0` release with the pane app, configurable
  `frame-ancestors`, rate limiting and the standard health shape; the owner
  creates one human-verification widget per AddOn and seeds its secret with
  `hcw-vault-set`; the two Python AddOns flip from `coming` to `available` with
  their own origins, settings, `group_vars` entries and CSP lines in follow-up
  PRs; the AddOn's standalone Terraform and tunnel compose are retired in its
  own repository.

## Alternatives considered

1. **npm island in the site bundle.** The site installs the AddOn's React
   package and renders it on `/tools/migration`, calling the AddOn's API from the
   browser. Fails four site rules at once. `connect-src` is closed to everything
   but the Function App and sign-in, so the island could not call the AddOn's API
   without widening it to a third-party origin for every visitor. The AddOn's UI
   package renders a partner list naming the host, the edge and the workspace
   platform, which `public-copy.test.js` forbids on public pages. The site would
   rebuild and redeploy for every AddOn release, which defeats the independent
   update the program requires. And the package publish is paused by the owner,
   so the option is blocked anyway. Rejected.
2. **Reverse proxy under the site's origin.** The site's edge forwards
   `/tools/migration/*` to the lab host, so the AddOn runs same-origin with the
   site: its scripts would run with the site's origin, its cookies and storage
   would be the site's, and the site's own `frame-ancestors 'none'` and CSP would
   have to admit whatever the AddOn serves. The secret boundary (the AddOn's
   verification secret on the lab host) would sit behind the site's name. It also
   needs an edge rule per AddOn at the site's CDN, which `infra/` manages and
   which is outside the lab host's Ansible. Rejected.
3. **Sandboxed pane on a lab name (chosen).** Reuses what ADR 0032 built, keeps
   the AddOn's secrets on the lab host where the vault already is, keeps every
   AddOn one exact origin in the CSP, and lets a release reach the host as a
   one-line digest change.
4. **Defer.** Keep `/tools/migration` as a placeholder until the npm packages are
   published. Leaves the Migration Hub a placeholder for an unknown time and does
   not answer how the two Python AddOns arrive. Rejected.

## Validation and revisit triggers

Validation that this record is in force:

- `frontend/src/lib/csp.test.js` lists every available AddOn origin in
  `frame-src` and nowhere else, and no `*.lab` wildcard.
- `frontend/src/pages/tools/AddOnPanePage.test.jsx` proves the sandbox per
  capability, the message filter, the watchdog and the status gate.
- `functions/src/lib/addons/status.test.js` proves the three answer shapes, the
  https rule, the cache and the projection.
- `scripts/lab-host-addons-route.test.mjs` and `lab-host-visitor-copy.test.mjs`
  prove the Caddy route and the one sentence;
  `lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh` proves the
  per-name redirect's ordering with the pinned Caddy.
- On the host, `sudo docker ps` shows `hcw-addon-migration` by name and
  `curl -s http://127.0.0.1:18081/api/health` answers `"ok":true`.

Revisit this record when any of the following happens:

- A hub Tools page needs a canonical per-provider URL for an AddOn (the "no
  provider-scoped variants" rule in the standard, section 5).
- An AddOn needs a message from the site, a site credential, or a second origin;
  any of these breaks the protocol as versioned by the standard and needs a new
  revision and a new record.
- The lab host's memory ceiling is reached with the three AddOns and Coder on;
  the host or the AddOn footprint changes under ADR 0015's cost ceiling.
- The `caddy adapt` check shows the per-host redirect no longer holds on a
  newer Caddy, and the fallback is adopted: amend decision 6 here rather than
  leave the role's `vars` line dead.
- The npm packages are published and a case for an in-bundle island returns;
  the four site rules in Alternatives considered must be answered first.
- `allow-downloads` is withdrawn by the owner: decision 9 is struck, the row
  drops `downloads`, and "Copy report" is the only path.

Superseded by: none. This record amends ADR 0032's host workload line as
decision 8 says and does not supersede it.

## Related decisions and references

- [ADR 0032](0032-learner-labs-platform.md): the lab host, the status proxy
  pattern (decision 4), panes only and Coder in panes (amendments of
  2026-09-28), Vault auto-unseal (2026-09-29), privilege separation (2026-10-07);
  amended here on the host's workload kinds.
- [ADR 0006](0006-admin-identity.md): admin surfaces (the Integrations card and
  Health probe for each AddOn) stay behind Entra.
- [ADR 0007](0007-static-first-frontend.md): the pane page is pre-rendered per
  row and reads nothing in its first render.
- [ADR 0015](0015-cost-governance.md): the AddOn containers run on the host
  already paid for; nothing new is provisioned in Azure.
- [ADR 0019](0019-single-function-app.md): the status proxy is a route on the one
  Function App.
- [AddOn integration standard](../standards/addon-integration-standard.md):
  the contracts and the compliance checklist.
- [Labs host](../architecture/labs-host.md): the estate record, updated with the
  AddOn containers and port.
- [App-to-AddOn program](../architecture/app-to-addon/README.md): the program
  package and each AddOn's integration record.
- Upstream records: `HCW-AzMigrateOrchestrator_App` ADR-0028 (upstream and
  downstream editions) and the planned ADR-0030 (web-front edition runs as a
  site pane); `HCW-AzMigrateOrchestrator_Addon` `docs/website-integration/`.
- `frontend/src/pages/shared/LabPanePage.jsx`, `functions/src/lib/labs/coder-status.js`,
  `lab-host/ansible/roles/caddy/templates/Caddyfile.j2`, `lab-host/ansible/roles/portainer/`
  (the single-container role pattern).
