# App-to-AddOn program

The program that splits each HCW product into an upstream **App** (the engine,
rules and UI, with an Azure appliance edition that runs on Container Apps under
a managed identity on a client's subscription) and a downstream **AddOn** (the
same image in a lab edition on the lab host, where a visitor uploads an Azure
Resource Graph export and gets an assessment held in memory for two hours), and
shows each AddOn on hybridcloudworks.com as a sandboxed pane at `/tools/<id>`.
The model is [ADR 0035](../../decisions/0035-addon-pane-model.md); the
contracts are the [AddOn integration standard](../../standards/addon-integration-standard.md).

## The four pairs

| Pair | App (upstream) | AddOn (downstream) | Site route | Row status |
| --- | --- | --- | --- | --- |
| [Migration](migration.md) | `HCW-MigrateOrchestrator_App` | `HCW-MigrateOrchestrator_AddOn`, `migration.lab.hybridcloudworks.com` | `/tools/migration` (Tools menu: Migration Hub) | `available` |
| [Network assessment](network-assessment.md) | `HCW-NetworkEyes_App` | `HCW-NetworkEyes_AddOn`, `network-assessment.lab.hybridcloudworks.com` | `/tools/network-assessment` | `available` since 2026-10-12 (#1089) |
| [Cloud assessment](cloud-assessment.md) | `HCW-CloudAssessor_App` | `HCW-CloudAssessor_AddOn`, `cloud-assessment.lab.hybridcloudworks.com` | `/tools/cloud-assessment` | `available` since 2026-10-12 (#1089) |
| [Cloud Crawler](cloud-crawler.md) | `HCW-CloudCrawler_App` | `HCW-CloudCrawler_AddOn`, `cloud-crawler.lab.hybridcloudworks.com` | `/tools/cloud-crawler` | `coming` since 2026-10-24, until the container runs on the lab host (#1357): the App released `v0.1.0` and the AddOn published `v0.2.0` (with the upload route) on 2026-10-26, and the host row (port 18084) is prepared and not yet run |

The first three were read from the live site on 2026-10-24: the status route
answered `configured: true, reachable: true` for each, with `version` 0.3.1
(migration) and 0.1.0 (the other two). Cloud Crawler's route answered
`{ "configured": false }` when read on 2026-10-26: its row has shipped, and the
Function App setting it reads is not applied yet.

### What each AddOn needs from the site's backend

The site is the integration layer, so this is the list of backend things each
pair uses. "Human verification" is the AddOn's own widget and vault key, never
the site's. Read from `lab-host/ansible/group_vars/all.yml`, the catalogue and
each pair's page on 2026-10-24.

| Pair | Human verification | Site backend the AddOn is configured to call | The site calls the AddOn |
| --- | --- | --- | --- |
| Migration | yes (`vault_addon_migration_turnstile_secret`) | none (`AMO_WORKSPACE_PROVIDER` is `disabled`) | status route reading `ADDON_MIGRATION_URL` |
| Network assessment | yes (`vault_addon_network_assessment_turnstile_secret`) | the lab host's Coder, to start a guided lab workspace (`CODER_URL`, template `na-guided-lab`) | status route reading `ADDON_NETWORK_ASSESSMENT_URL` |
| Cloud assessment | yes (`vault_addon_cloud_assessment_turnstile_secret`) | none in its `group_vars` row | status route reading `ADDON_CLOUD_ASSESSMENT_URL` |
| Cloud Crawler | yes (`vault_addon_cloud_crawler_turnstile_secret`, per the AddOn's ADR 0003; the owner states it is in the host's vault, unchecked by any session) | none; it is built never to reach Azure (its README) | status route reading `ADDON_CLOUD_CRAWLER_URL`, declared in `infra/functionapp.tf` since #1357 and not applied yet (the owner's HCP Terraform run applies it after the pull request that declares it merges); a trusted-caller path for lab chat evidence is planned and not built |

Each pair's page records what the App keeps, what the AddOn is, its origin,
port, image and status on the site, and links the refactoring pull requests
the program opened in each repository. The program's closing documents are
the [final architecture package](final-package.md) (twenty sections: the
reference model, the responsibility and dependency maps, the contract,
security, deployment, Container Apps, versioning, testing and documentation
standards, the technical-debt backlog, next actions and risks) and the
[validation report](validation-report.md) (integration, security and
deployment evidence, the compatibility matrix and the rollback procedures).

## What lands where

The website is the integration layer and changes once, in one pull request,
from the written specification (owner decision 2026-10-09). Everything an
AddOn needs on the site is derived from one catalogue row:

| Side | What | Where |
| --- | --- | --- |
| Site, data | One frozen row per AddOn: id, title, origin, pane and health paths, status, capabilities | `frontend/src/data/addons/catalogue.js` |
| Site, page | The generic pane page: status gate, sandbox and `allow` from the row's capabilities, the `hcw-addon` message filter, an allow-listed `navigate`, the 30-second watchdog, one unavailable sentence; a `coming` row renders an explainer | `frontend/src/pages/tools/AddOnPanePage.jsx`, one lazy wrapper per row in `pages/tools/` |
| Site, routing | One hand-declared route per row, the pre-render list and the Tools menu, all derived | `frontend/src/App.jsx`, `lib/routeFactory.ts`, `scripts/prerender-entry.jsx`, `components/shared/Header.jsx` |
| Site, policy | One exact origin per available row in `frame-src`; `connect-src` unchanged | `frontend/staticwebapp.config.json`, held by `lib/csp.test.js` |
| Function App | `GET /api/public/addons/{id}/status`: a closed registry of ids, a 5-second https-only read of the AddOn's `/api/health`, a one-minute cache per id, a six-field projection | `functions/src/lib/addons/`, `functions/addons-public-http.js` |
| Terraform | One plain app setting per available AddOn, `ADDON_<ID>_URL` (public, no vault) | `infra/functionapp.tf` |
| Admin | The Tool add-ons group: a service card tested through the status route, a Health probe, a directory row; the AddOn's vault key on Credentials | `components/admin/integrations/serviceRegistry.jsx`, `config/integrationsDirectory.js`, `pages/admin/health/probeGroups/enhanced.js`, `functions/src/lib/credentials/register.js` |
| Lab host | The generic `addons` Ansible role: one hardened container per `group_vars` row by digest on the loopback, a Caddy route per name with the site's sentence at 503 and a per-name direct-visit redirect, the vault key check, the end-of-run privilege checks | `lab-host/ansible/roles/addons/`, `group_vars/all.yml`, `roles/caddy/templates/Caddyfile.j2`, `roles/privilege_checks/` |
| Docs | The standard, this package, ADR 0035, the labs host record, the runbook's "Tool add-ons", the lab host README | `docs/standards/`, `docs/architecture/app-to-addon/`, `docs/decisions/`, `docs/architecture/labs-host.md`, `docs/runbooks/labs-host.md`, `lab-host/README.md` |

Nothing from an AddOn is installed into the site: no package, no secret, no
site credential. The only coupling is the image digest the host pins and the
address the status proxy reads.

## The pane, in one picture

```text
visitor's browser                       site (Static Web App)        Function App              lab host
───────────────                         ─────────────────────        ────────────              ────────
GET /tools/migration  ─────────────────▶ AddOnPanePage (pre-rendered)
                                          │ fetchAddonStatus('migration') ─▶ GET public/addons/migration/status
                                          │                                   │ ADDON_MIGRATION_URL (https only)
                                          │                                   │ GET /api/health, 5 s ───────────▶ Caddy ─▶ 127.0.0.1:18081 hcw-addon-migration
                                          │ { configured, reachable, … } ◀────┘ cached 60 s per id
                                          │ mounts <iframe sandbox="allow-scripts allow-same-origin allow-forms allow-downloads">
                                          ▼
GET https://migration.lab.hybridcloudworks.com/  (inside the pane only) ─────────────────────────────▶ Caddy: frame-ancestors = the site; 503 sentence if stopped
                                          ◀── postMessage { type: 'hcw-addon', id: 'migration', state } to the site origins only
```

The site sends the pane nothing. A top-level visit to the AddOn's name is
redirected by Caddy to the AddOn's page on the site.

## Review items the program leaves open

- Confirmed 2026-10-10: ADR 0035 decision 8 (AddOn containers beside Coder on
  the lab host, amending ADR 0032's "Compose is for Coder only" line) and
  decision 9 (`allow-downloads` on AddOn panes; the migration row now grants
  `downloads` and the accepted-risk row in `TODO.md` applies)
  ([#1044](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1044)).
- One human-verification widget per AddOn, created by the owner, and its
  secret key put in the lab host's vault with `hcw-vault-set`
  ([runbook](../../runbooks/labs-host.md), "Tool add-ons"). The `migration`
  widget (`hcw-addon-migration`) was created on 2026-10-11. Its secret key,
  `vault_addon_migration_turnstile_secret`, is set on the host and is not
  visible from this repository. It must be in place before the first
  bootstrap that deploys the row, because the `addons` role refuses to start
  the container while it is unset. Each later AddOn needs its own widget and
  key.
- The migration row's `image_digest` and `AMO_TURNSTILE_SITE_KEY` in
  `lab-host/ansible/group_vars/all.yml` were [VERIFY] and are answered,
  written in on 2026-10-11: the `v0.3.0` image index (its build-provenance
  attestation verifies against the AddOn's repository) and the widget's site
  key.
- The per-name direct-visit redirect's directive ordering was [VERIFY] and is
  answered: `caddy adapt` with the pinned Caddy runs in CI
  (`lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh`).

## Related

- [ADR 0035](../../decisions/0035-addon-pane-model.md) and
  [ADR 0032](../../decisions/0032-learner-labs-platform.md)
- [AddOn integration standard](../../standards/addon-integration-standard.md)
- [Labs host](../labs-host.md): the estate record, with the AddOn containers
  and ports
- [Required inputs §4.5 and §4.7](../../standards/required-inputs.md): the app
  setting and the vault key
