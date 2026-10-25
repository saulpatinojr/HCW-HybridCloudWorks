# HCW App-to-AddOn Architecture — Final Architecture Package

Program: HCW App-to-AddOn Architecture and Refactoring Initiative. Date: 2026-10-10.
Scope: three App/AddOn pairs (Azure Migrate Orchestrator, Cloud Assessor, NetworkEyes) and the HCW website.
Branch in every repository: `work/fervent-gauss-kbdr3h`. Markers: `[VERIFY]` = claim to verify, `[REVIEW REQUIRED]` = owner or legal decision.

## 1. Executive summary

The website gained one integration model for every external tool: an **AddOn** is an independently built, independently
deployed container that the site frames in a sandboxed pane at `/tools/<id>`, registers in one catalogue row, allows in one
Content Security Policy entry, and watches through one anonymous status proxy. The model generalizes the pane the site
already used for its learner labs (ADR 0032), so no new hosting, DNS, certificate or identity surface was created: the AddOn
containers run beside the lab platform on the lab host, each on a loopback port behind the existing panes-only edge.

Three Apps stay independent products. Each received a `REFACTOR_APP.md` (22 sections) describing the changes that let it
publish a reusable core and run as an Azure appliance (Container Apps, user-assigned managed identity, Reader on a client
scope, anonymous live results). Nothing else in an App repository changed.

Three AddOns now exist on the same contract: the Azure Migrate Orchestrator AddOn was refactored to the pane model
(v0.3.0, PR #4); the Cloud Assessor AddOn was built from scratch (0.1.0) around an engine seed that moves upstream; the
NetworkEyes AddOn was built from scratch (0.1.0) around engine modules ported with provenance from the archived App.
Both new AddOns are Azure-only, upload-only (Resource Graph export), stateless beyond an in-memory TTL, and technically
unable to construct an Azure credential (import-time guard plus a boundary test and an image-level check).

What remains is owner work: create the base branches of the two new AddOn repositories, create the Docker Hub OIDC
connections and verification widgets, pin the first published image digests, and merge the PRs in the order given in
section 18.

## 2. Current-state architecture (as found, 2026-10-09)

| Repository | Found | Consequence |
|---|---|---|
| HCW-HybridCloudWorks | React 19 / Vite / Azure Functions / SWA / Cosmos / Key Vault; Coder labs framed in a sandboxed pane (`LabPanePage.jsx`), catalogue-driven, status proxied by a Function App route; `/tools/migration` was a "coming soon" page | The pane model is the only proven external integration and became the standard |
| HCW-AzMigrateOrchestrator_App | Mature TS product; publishes `@hybridcloudworks/migration-core` and `migration-ui` (npm publish paused); ADR-0028 upstream/downstream split | Reusable through packages; UI component needs five props for pane use |
| HCW-AzMigrateOrchestrator_Addon | Working CSV lab API; docs described an npm React island (blocked) and stale iframe options; no app-level rate limit; static page could not pass verification | Refactor to the pane model, keep the API |
| HCW-CloudAssessor_App | Documentation only (README/TODO/REVIEW/CHANGELOG); no code; R-001..R-008 blockers | The AddOn carries the first working engine; the App adopts it upstream |
| HCW-CloudAssessor_AddOn | Empty repository | Built from scratch |
| HCW-NetworkEyes_App | Archived pointer; code at `5d3b914` (Python scanner, two rule engines, Next.js web, FastAPI, AWS parts); live code in `Work-Cloud_Network_Core` (out of scope) | Plan written here from history, addressed to the Core; AddOn ports ~1,100 lines with provenance |
| HCW-NetworkEyes_AddOn | Empty repository | Built from scratch |

Cross-cutting findings: no shared contract for health, errors or pane messages; no shared registry convention; AzMigrate's
image went to GHCR while the website pins Docker Hub digests; the website's `public-copy` test bans vendor names, which the
AddOn panes had to honour.

## 3. Final target architecture

```
visitor ──► hybridcloudworks.com (SWA, React)
              /tools/<id>  AddOnPanePage ── sandboxed iframe ──► https://<id>.lab.hybridcloudworks.com (Caddy, panes-only)
              GET /api/public/addons/<id>/status ──► Function App status proxy ──► <AddOn>/api/health
                                                                               127.0.0.1:1808x ──► hcw-addon-<id> container
                                                                                                    (lab edition, no Azure identity)
client (clones App repo) ──► Azure Container Apps appliance (UAMI Reader on scope) ──► Resource Graph / Cost Management
```

- **Lab edition** (AddOn): upload-only, in-memory TTL store, human verification on uploads, owner tokens, token-bucket rate
  limit, concurrency bound, no persistence, no Azure SDK importable. Same image as the appliance where the App is Python
  (`EDITION` build argument asserted); Azure Migrate keeps separate lab and appliance images (ADR-0028).
- **Appliance edition** (App): Container Apps, one replica (`min 1 / max 1`), UAMI with Reader (+ Cost Management Reader
  for Cloud Assessor), scope allow-list enforced before any query, no upload route (`405 edition_readonly`), timer-driven
  refresh with cached results, anonymous visitors see live results for that scope.
- **Website**: catalogue, pane page, status proxy, CSP entry, Ansible `addons` role, Caddy route, admin registries, docs.

## 4. HCW App-to-AddOn reference model

1. **Classify reuse** for every App module: directly reusable / reusable after isolation / through an API / shared contract /
   AddOn-specific reimplementation / not appropriate. Record the classification in the pair assessment and in
   `REFACTOR_APP.md` section "Reuse classification".
2. **Split by edition, not by repository fork**: the App publishes a core (npm package or Python wheel) and ships an appliance
   edition; the AddOn consumes the core at an exact version and ships the lab edition. Where the App is not ready, the AddOn
   carries an engine seed (Cloud Assessor) or a ported copy with provenance (NetworkEyes) that the App adopts verbatim, after
   which the AddOn deletes its copy through its `core-update` workflow.
3. **Write `REFACTOR_APP.md`** in the App (22 fixed headings) instead of touching App code during the program.
4. **Implement the AddOn** on the skeleton convention (section 8) and the contract (section 7).
5. **Register on the website**: one catalogue row, one page, one CSP entry, one proxy registry entry, one Ansible list entry.
6. **Validate**: contract tests in the AddOn, parity tests on the website, e2e of the framed pane, CI image checks.
7. **Release**: semver tag → image digest on Docker Hub → website `group_vars` pin → Ansible run.

## 5. Repository responsibility model

| Concern | App repository | AddOn repository | Website repository |
|---|---|---|---|
| Engine, rules, model | Owns (publishes) | Consumes at exact version (interim: seed/port) | — |
| Appliance edition (Azure identity) | Owns | Never (boundary test) | — |
| Lab edition (upload, pane) | — | Owns | — |
| Pane page, catalogue, CSP, status proxy | — | Documents the contract | Owns |
| Hosting of the AddOn container | — | Dockerfile, publish workflow | Ansible role, digest pin, Caddy route |
| Secrets | Key Vault / UAMI | None at rest; verification secret from the host vault | Host vault, Key Vault refs |
| ADRs | Canonical log (shared numbering) | Copies relevant ADRs + AddOn-local ADRs | Site ADRs (0035) |
| Changes during this program | `REFACTOR_APP.md` only | Full | One PR (Phase 6) |

## 6. Dependency map

| From | To | Kind | Pinned by |
|---|---|---|---|
| AzMigrate AddOn | AzMigrate App `dist-packages` | interim `file:` link, `APP_REF` tag | `core-update.yml` |
| Cloud Assessor App (future) | Cloud Assessor AddOn `packages/cloud-assessor-core` | adopts verbatim, then publishes wheel | `core-update.yml` in the AddOn |
| NetworkEyes AddOn | `Work-Cloud_Network_Core` (future `cna-azure-network-engine`) | ported copy with provenance until published | `core-update.yml`, `PROVENANCE.md` |
| Website | each AddOn's `/api/health` | HTTP, anonymous, 5 s | status proxy |
| Website lab host | Docker Hub image | digest | `lab-host/ansible/group_vars/all.yml` |
| Every AddOn | Cloudflare Turnstile siteverify | HTTPS, 5 s timeout, fail closed | env (`<P>_TURNSTILE_*`) |
| Every AddOn | nothing in Azure | forbidden | edition guard + boundary test + image check |

No AddOn depends on another AddOn. No App depends on an AddOn (Cloud Assessor's adoption is a copy, not an import).

## 7. API and data contract standards

Frozen in section 11 of the [AddOn integration standard](../../standards/addon-integration-standard.md):

- `GET /api/health` → flat `{ ok, id, version, edition, capabilities[], asOf, siteOrigins[], turnstile: { required, siteKey|null }, azureConnectivity, …extras }`.
- Headers on every response: `X-Addon-Id`, `X-Addon-Version`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`; CSP with `frame-ancestors` from env, `base-uri 'none'`, `form-action 'self'`; `X-Frame-Options: DENY` only for `'none'`.
- Errors: `{ error: { code, message, details? } }`; shared codes `invalid_request`, `invalid_json`, `turnstile_failed`, `not_found`, `method_not_allowed`, `too_large`, `unsupported_media_type`, `too_many_rows`, `ingestion_failed`, `rate_limited`, `internal_error`, `overloaded`, `turnstile_not_configured`.
- Pane protocol: `{ type: 'hcw-addon', id, state, navigate? }`, states `loading|ready|working|unavailable`, posted on transitions only to each origin in `siteOrigins`; the site filters by origin, source, type, id and state; 30 s watchdog; one unavailable sentence.
- Status proxy projection: `{ configured, reachable, version, edition, capabilities, asOf }`.
- Upload inputs: Azure Resource Graph export (`arg-json` array or `az graph query` envelope; `arg-csv` from Resource Graph Explorer); 5 MB / 5,000 rows / 200 stored items / 120 min TTL.
- Evidence states on every conclusion: `observed | unknown | not-applicable`.

## 8. AddOn project template recommendations

Skeleton used by both Python AddOns (AddOn ADR-0002 in each; a future `hcw-addon-kit` would absorb it):

```
pyproject.toml (uv, exact pins)  .python-version  ruff.toml  Makefile  .env.example
src/<package>/{edition,config,store,errors,app,__main__}.py
src/<package>/security/{turnstile,headers,cors,limits,ratelimit,logging}.py
src/<package>/routes/{health,config,catalog|rules,assessments,static}.py
web/{index.html,app.js,styles.css,theme.css}          # vanilla pane, HCW tokens, hcw-addon bridge
packages/<engine>/ or ported modules + PROVENANCE.md   # what moves upstream
samples/  tests/{unit,contract,security,e2e,end_to_end}  docs/{adr,api,demo,deployment,operations,security,website-integration}
infrastructure/docker/Dockerfile  .github/workflows/{ci,security,publish-images,core-update}.yml
```
TypeScript AddOns follow the same tree with `apps/lab-api` and `apps/lab-web`. Governance files (README, CLAUDE.md, AGENTS.md,
LICENSE, NOTICE, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG, VALIDATION, `repository.manifest.json`) are mandatory.

## 9. Security standard

- Lab edition cannot reach Azure: import-time guard refuses `azure*`/`msal`/`boto3` and the identity endpoints
  (`IDENTITY_ENDPOINT`, `MSI_ENDPOINT`, `AZURE_CLIENT_SECRET`, `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_TENANT_ID`); a security test
  proves it; CI runs `import azure` inside the image and requires failure.
- Human verification fail-closed on every anonymous upload (503 `turnstile_not_configured` unless the explicit dev flag);
  hostname-bound; the pane owns the widget; siteverify timeout 5 s.
- Owner tokens (hashed) scope read/delete to the uploader; in-memory only; TTL sweep; no persistence; content-free logs.
- Rate limit (token bucket per client address, proxy-aware only with `<P>_TRUST_PROXY=1`) and concurrency bound.
- Containers: digest-pinned base, non-root uid, read-only root, `cap_drop ALL`, `no-new-privileges`, 512m / 256 pids, loopback
  port only; Caddy panes-only edge (frame-ancestors site origins, top-level redirect).
- Website side: sandbox `allow-scripts allow-same-origin allow-forms` (+`allow-downloads` by capability `[REVIEW REQUIRED]`),
  message filtering, navigate allow-list, CSP `frame-src` per origin, status proxy projection allow-list.
- Supply chain: SHA-pinned actions, Dependabot, gitleaks, dependency review, CodeQL, Trivy before push, Docker Hub by OIDC
  (no registry secrets), hash-locked Python dependencies.
- Appliance (App side, in `REFACTOR_APP.md`): UAMI only (`ManagedIdentityCredential(client_id=…)`), no client secrets,
  scope allow-list, least-privilege roles, bearer-protected internal routes, exception redaction.

## 10. Deployment standard

- Image: `docker.io/hybridcloudworks/img-<short name>-lab-addon`, tags `v<semver>` and digest; published by `publish-images.yml` on `v*`
  tags through the Docker OIDC connection (`vars.DOCKERHUB_ENABLED`, `vars.DOCKERHUB_CONNECTION`).
- Host: website `lab-host/ansible/roles/addons` pulls by digest, runs one hardened `docker_container` per AddOn
  (`hcw-addon-<id>`, port 18081/18082/18083 on 127.0.0.1), waits on `/api/health`, writes the Caddy route, reloads Caddy.
- Config: public values in `group_vars/all.yml` `addons[].env`; secrets as `vault_addon_<id>_<name>` in the host vault.
- Rollback: change the digest in `group_vars`, re-run the playbook; the previous image stays cached; no data to migrate.
- Website: `ADDON_<ID>_URL` plain Function App setting (Terraform), catalogue row status `available` once the image is pinned.

## 11. Container Apps guidance

Container Apps fits the **appliance** edition, not the lab edition: one Consumption app, `min_replicas 1 / max_replicas 1`
(scale-to-zero loses the in-memory snapshot and cold starts a timer refresh) `[VERIFY cost]`, UAMI with Reader on the
allow-listed scopes, ingress external with anonymous read routes only, no upload route, Log Analytics for logs, a budget.
Terraform roots are specified in each `REFACTOR_APP.md` (`infrastructure/terraform/appliance-azure`). The lab edition stays
on the lab host because it needs no Azure identity and the panes-only edge already exists (AddOn ADR-0003).

## 12. Versioning and compatibility policy

- Semver tags `v*` in every repository; the image digest is the deployable unit; `/api/health.version` reports the tag.
- Contract versions: health envelope and pane protocol are versioned by the standard document; additive fields only; a
  breaking change needs a new `type` (`hcw-addon-2`) and a site release that accepts both.
- Core adoption: AddOn pins the App core at an exact version (`APP_REF` or wheel pin); `core-update.yml` tests each release
  before opening the bump PR.
- Compatibility matrix is kept in the website package (`docs/architecture/app-to-addon/README.md`) and updated per release.

## 13. Independent update workflow

1. App releases `vX.Y.Z` (core package + appliance image).
2. AddOn `core-update.yml` sees the tag, runs the AddOn suite against it, opens a PR bumping the pin.
3. AddOn releases `vA.B.C`; `publish-images.yml` pushes the image and prints the digest.
4. Owner reads the digest (`docker buildx imagetools inspect docker.io/hybridcloudworks/img-<short name>-lab-addon:vA.B.C`), pastes it into
   the website `group_vars`, opens the website PR; Ansible run deploys; status proxy shows the new version within a minute.
5. Neither step requires a change in the other two repositories unless the contract changed (section 12).

## 14. Testing standard

| Layer | AddOn | Website |
|---|---|---|
| Unit | engine, ingestion, rules/catalog, store, security helpers (≥85% coverage gate on Python AddOns) | catalogue, page, registry, status proxy |
| Contract | OpenAPI ↔ routes two-way; health envelope schema; error envelope; headers | parity: catalogue ids = registry ids; CSP = `addonOrigins()`; route inventory; API surface |
| Security | edition boundary (no Azure importable, env refusal); no secrets in tree; content-free logs; verification fail-closed | public copy (no vendor names); CSP; sandbox attributes |
| e2e | Playwright: host page framing the pane with the production sandbox; message sequence `loading→ready→working→ready`; headers; 403 without token | pane page test harness |
| Image | CI: build, Trivy, `import azure` must fail, healthcheck | Ansible lint, argument-spec defaults, syntax check, Caddy adapt `[VERIFY]` |

## 15. Documentation standard

Every AddOn: `docs/website-integration/integration-guide.md`, `docs/api/openapi.yaml`, `docs/deployment/lab-host.md` (+
`appliance.md` where the App exists), `docs/operations/runbook.md`, `docs/security/threat-model.md`, `docs/demo/user-guide.md`
with owner-pasteable export commands in bash and PowerShell, `docs/adr/` (local ADRs + copies of shared ones), `VALIDATION.md`
listing every limitation and every check not run. Website: `docs/standards/addon-integration-standard.md`,
`docs/architecture/app-to-addon/*`, ADR 0035, labs-host runbook sections. Every `[VERIFY]`/`[REVIEW REQUIRED]` marker stays
in place until resolved.

## 16. Operational support model

- **Signals**: website Integrations/Health rows read the status proxy; the proxy caches one minute and never forwards raw
  errors; AddOn logs are JSON lines on stderr (`docker logs hcw-addon-<id>`), content-free.
- **Runbooks**: each AddOn's `docs/operations/runbook.md` (restart, rollback by digest, abuse tuning, verification outage);
  website `docs/architecture/labs-host.md` "Tool add-ons".
- **On unavailability** the pane shows the one sentence; the catalogue row can be flipped to `coming` with a reason.
- **Ownership**: the owner runs Ansible and Terraform by hand (no automation applies to production); sessions prepare PRs.

## 17. Technical debt backlog

| Item | Where | Priority |
|---|---|---|
| Interim pane shims (hidden partner panel, `confirm()` bypass) until App v0.3.0 ships the five props | AzMigrate AddOn | High |
| Engine seed duplicated until the Cloud Assessor App adopts and publishes it | Cloud Assessor AddOn/App | High |
| Ported NetworkEyes engine until `cna-azure-network-engine` is published by the Core | NetworkEyes AddOn / Core | High |
| `hcw-addon-kit` (shared skeleton as a library) | both Python AddOns | Medium |
| Retired Terraform/reverse-proxy/vps docs to delete | AzMigrate AddOn | Low |
| `copilot-setup-steps.yml` fails in the AzMigrate AddOn repository (pre-existing) | AzMigrate AddOn | Low |
| npm publishing of the migration packages (paused) → replace `file:` links | AzMigrate App/AddOn | Medium |
| Per-host Caddy redirect verified by `caddy adapt` in CI; global redirect kept until then | Website | Low |
| Non-modal deletion confirmation in `MigrationExplorer` | AzMigrate App (REFACTOR_APP follow-up) | Low |

## 18. Recommended next actions (owner, in order)

1. Create `main` in `HCW-CloudAssessor_AddOn` and `HCW-NetworkEyes_AddOn` so the two AddOn PRs can be opened (the work
   branches are pushed).
2. Review and merge the three `REFACTOR_APP.md` PRs (#15, #5, #179), then AzMigrate AddOn #4, then the two new AddOn PRs,
   then the website PR.
3. Create the Docker OIDC connection and set `DOCKERHUB_ENABLED`/`DOCKERHUB_CONNECTION` in each AddOn repository; tag
   `v0.3.0` / `v0.1.0` / `v0.1.0`; read the digests.
4. Create three Turnstile widgets (hostnames `migration|cloud-assessment|network-assessment.lab.hybridcloudworks.com`), put
   the secrets in the host vault as `vault_addon_<id>_turnstile_secret`, the site keys in `group_vars`.
5. Paste the digests into `group_vars`, run the lab-host playbook, apply the Terraform `ADDON_MIGRATION_URL` setting, flip the
   two `coming` catalogue rows to `available`.
6. Resolve every `[VERIFY]` (learn URLs, base-image digests, uv version, Caddy adapt) and `[REVIEW REQUIRED]` (MIT
   relicensing of ported NetworkEyes code, attribution text, `allow-downloads`).
7. Execute the `REFACTOR_APP.md` plans in the Apps, starting with AzMigrate v0.3.0 (unblocks the shims).

## 19. Remaining risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| NetworkEyes relicensing of ported code refused | Medium | AddOn must reimplement ~1,100 lines | Provenance headers make removal mechanical; rules are data |
| Docker Hub OIDC connection unavailable | Low | Images cannot publish | Workflow is gated; manual `docker push` runbook step |
| Pane message protocol drift between repositories | Low | Pane shows unavailable | Contract tests on both sides; `type` versioning |
| In-memory store lost on restart | By design | Visitors re-upload | Documented; TTL 120 min |
| Turnstile outage | Low | Uploads blocked (fail closed) | Documented; dev flag exists only outside production |
| Lab host single VPS | Medium | All AddOns down together | Same posture as the labs; rollback by digest |

## 20. Final validation results

The full tables are in the [validation report](validation-report.md). Summary at program close (2026-10-10):

| Repository | Head | Local checks | CI / review state |
|---|---|---|---|
| HCW-AzMigrateOrchestrator_App | PR #15 | REFACTOR_APP.md only (766 lines) | checks green; Copilot rounds 1 and 2 worked, 0 open threads |
| HCW-CloudAssessor_App | PR #5 | REFACTOR_APP.md only (689 lines) | checks green; Copilot rounds 1 and 2 worked, 0 open threads |
| HCW-NetworkEyes_App | PR #179 | REFACTOR_APP.md only (843 lines) | checks green; Copilot rounds 1 and 2 worked, 0 open threads |
| HCW-AzMigrateOrchestrator_Addon | PR #4 (e1eda58) | 26 unit tests, 5 e2e in CI | all checks green; Copilot rounds 1 and 2 worked, CodeQL alert closed, 0 open threads |
| HCW-CloudAssessor_AddOn | 1d09717 (no PR: no base branch) | ruff clean, 154 tests, 98% coverage, catalog check | CI runs on the branch; image jobs CI-only |
| HCW-NetworkEyes_AddOn | 14f454b (no PR: no base branch) | ruff clean, 223 tests, 98.08% coverage, rules-doc in sync, pip-audit clean, 4 e2e | CI runs on the branch; image jobs CI-only |
| HCW-HybridCloudWorks | PR #1043 | frontend 4,510 tests, functions 5,480, scripts 997, ansible-lint, syntax, argument-spec, caddy adapt, mkdocs strict | CI in progress at close; two CodeQL alerts fixed; CodeRabbit and Copilot reviews pending |

Checkpoint 7 verification: every required deliverable exists (sections 1 to 19 here, the standard, three REFACTOR_APP.md files, three AddOns, the website PR, the validation report); each App has a complete 22-section REFACTOR_APP.md; each AddOn matches its approved scope (Azure-only, upload-only, lab edition); the architecture is consistent across pairs (section 7 contract, verified by the 5D pass); future conversions follow section 4; App independence holds (App repositories differ from `main` by one file each); AddOn deployment independence holds (digest per AddOn, role per row, no AddOn-to-AddOn dependency); no undocumented architectural dependency remains (section 6); incomplete work is listed and prioritized in sections 17 and 18.
