# AddOn integration standard

Version 1.0, drafted 2026-10-09 for the App-to-AddOn program
([ADR 0035](../decisions/0035-addon-pane-model.md); the program package is
[App-to-AddOn](../architecture/app-to-addon/README.md)). Every requirement is
marked **Mandatory** or **Optional**. "Owner decision" lines record the decisions
this standard rests on. Paths are relative to the website repository unless an
AddOn repository is named.

## 1. Purpose and scope

This standard says what an independently built tool must do to appear on
hybridcloudworks.com as a pane under `/tools/<id>`, and what the website does in
return. It covers the AddOn's repository, its HTTP surface, the site's catalogue,
routing, status proxy and content security policy, the lab host's container and
reverse-proxy configuration, and the way a new AddOn release reaches the host.

Owner decision 2026-10-09: the integration model is the website's existing pane
model, generalised. Each AddOn is a separately deployed web application shown in a
sandboxed frame on a site page, with a catalogue row, a `frame-src` entry and a
server-side status proxy. The npm island (installing an AddOn's UI package into
the site bundle) is rejected.

In scope: the three program AddOns (`migration`, `cloud-assessment`,
`network-assessment`) and any later tool that follows this document. Out of
scope: the upstream Apps (their Azure appliance editions are not reached by the
site), Coder labs (ADR 0032, whose Coder-specific patterns section 19 keeps out
of this standard), and the admin portal's own integrations.

**Mandatory**: an AddOn that does not meet every Mandatory item is registered
with `status: 'coming'` and shows no frame.

## 2. Definitions

| Term | Meaning |
| --- | --- |
| App | The upstream product repository (for example `HCW-MigrateOrchestrator_App`). It owns the engine, rules and UI components and publishes them as packages or images. The site never integrates an App directly. |
| AddOn | The downstream, web-front edition of an App: a container image whose lab edition takes an uploaded export, holds nothing beyond a TTL and can reach no cloud. It is what the site frames. |
| Website | `HCW-HybridCloudWorks`: the React site on Static Web Apps, the Function App, the Terraform roots and the lab host's Ansible. It is the integration layer. |
| Pane | A sandboxed `<iframe>` on a site page that loads the AddOn's own origin. The site sees nothing inside it except the messages the AddOn posts. |
| Status proxy | `GET /api/public/addons/{id}/status` on the Function App: the one server-side read that decides whether a pane opens. |
| Edition | The string an AddOn reports in `/api/health` (`lab` for lab editions; the migration AddOn reports `demo` today, which the site treats as opaque). An appliance edition is never framed. |
| Lab host | The VPS that serves `*.lab.hybridcloudworks.com` behind Caddy, configured by `lab-host/ansible`. |
| Origin | Exactly `https://<id>.lab.hybridcloudworks.com`, one per AddOn, no sub-labels. |

## 3. Required AddOn repository structure

**Mandatory** unless marked. The language is free (TypeScript and Python are both
in use); the layout and the contracts are not.

| Path | Requirement |
| --- | --- |
| `apps/<addon>-api/` or `src/<package>/` | The HTTP server: serves `/api/*` and the built pane app from one origin. |
| `apps/lab-web/` or `web/` | The pane app the site frames, built into static files the server serves. |
| `tests/unit`, `tests/contract`, `tests/security`, `tests/e2e` | See section 15. |
| `docs/api/openapi.yaml` | Every `/api/*` path, checked two-way against the routes. |
| `docs/website-integration/` | The site route, origin, status shape, pane protocol and env table. |
| `docs/deployment/lab-host.md` | States that the website repository's `addons` role hosts it; env table; rollback by digest. |
| `docs/security/threat-model.md`, `docs/operations/runbook.md`, `VALIDATION.md`, `CHANGELOG.md` | Present and current. |
| `docs/adr/` | Copies of the upstream ADRs that shape the edition, plus the AddOn's own. |
| `infrastructure/docker/Dockerfile*` | One image per edition; non-root user; `HEALTHCHECK`; base image pinned by digest. |
| `.env.example` | Every env var with an empty or placeholder value, never a real secret. |
| `.github/workflows/ci.yml`, `publish-images.yml`, `core-update.yml` | CI, a tag-driven image publish that scans before pushing, and the upstream adoption workflow (only while an upstream App exists). |
| `repository.manifest.json` | Required files list, checked by a test. |
| Terraform for the shared host | **Must not exist**, or must be marked retired at the top of each file. The host is the website's. |

**Optional**: `samples/` with fictional data, `docs/demo/user-guide.md`,
`PROVENANCE.md` where code was ported.

## 4. Registration contract

**Mandatory.** An AddOn exists on the site when it has a row in
`frontend/src/data/addons/catalogue.js`. The row is frozen data; the page, the
Tools menu, the pre-render list and the CSP are all derived from it.

Row shape:

| Field | Rule |
| --- | --- |
| `id` | `^[a-z0-9]+(-[a-z0-9]+)*$`. Used as the path segment, the hostname label and the setting suffix. |
| `title` | Visitor copy. |
| `menuLabel` | **Optional.** Tools menu label; defaults to `title`. |
| `summary` | Visitor copy, at least 40 characters. |
| `origin` | Exactly `'https://' + id + ADDON_ORIGIN_SUFFIX`; the test enforces it. |
| `panePath` | What the frame loads on `origin`, usually `/`. |
| `healthPath` | What the proxy reads, usually `/api/health`. Informational on the site; the server registry holds the copy that is used. |
| `providers` | Non-empty subset of `VALID_PROVIDERS`; the first is the home hub. |
| `technology` | Strings for hub cards. |
| `status` | `'available'` or `'coming'`. `coming` requires `comingSince` (`YYYY-MM-DD`) and `comingReason` (visitor copy). |
| `capabilities` | Subset of `ADDON_CAPABILITIES`; what the page grants the pane (section 8). |
| `docsUrl` | An https URL. |
| `articleSlugs` | Same `{ provider, slug, title }` shape as the labs catalogue; may be empty. |

Fixed lists exported beside the rows: `ADDON_FIELDS`, `ADDON_STATUSES`,
`ADDON_PROVIDERS`, `ADDON_CAPABILITIES = ['navigate', 'downloads', 'popups', 'clipboard', 'clipboard-write', 'fullscreen']`,
`ADDON_ORIGIN_SUFFIX = '.lab.hybridcloudworks.com'`, `SITE_ORIGINS`.
Helpers: `addonById`, `availableAddons`, `addonPanePath(addon)` (returns
`/tools/<id>`), `addonPaneUrl(addon)` (returns `origin + panePath`),
`addonFrameUrl(addon, theme)` (the same with `?theme=dark` or `?theme=light`, the
address the frame is given),
`addonOrigins()` (origins of available rows, for the CSP), `addonsForProvider`.

Complete example row:

```js
{
  id: 'migration',
  title: 'Azure migration assessment',
  menuLabel: 'Migration Hub',
  summary:
    'Upload an exported inventory of your Azure estate and get a staged migration assessment, example automation and runbooks. Nothing you upload is kept beyond two hours.',
  origin: 'https://migration.lab.hybridcloudworks.com',
  panePath: '/',
  healthPath: '/api/health',
  providers: ['azure'],
  technology: ['azure-resource-mover', 'terraform'],
  status: 'available',
  capabilities: ['navigate', 'downloads'], // ADR 0035 decision 9, confirmed 2026-10-10
  docsUrl: 'https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn#readme',
  articleSlugs: [],
}
```

The visitor-copy rule from `public-copy.test.js` applies to `title`, `menuLabel`,
`summary`, `comingReason` and `articleSlugs[].title` only; `origin`, `panePath`,
`healthPath` and `docsUrl` legitimately contain `api`.

## 5. Routing contract

**Mandatory.**

- One site page per AddOn at `/tools/<id>`, rendered by the generic
  `frontend/src/pages/tools/AddOnPanePage.jsx` given `addonId` as a prop. Routes
  stay hand-declared in `App.jsx` (one `lazyPage` wrapper per row, as
  `MigrationPage.jsx` does), not a `:id` parameter, because
  `routes-are-complete.test.js` expects every absolute route to be declared and
  pre-rendered one by one.
- `staticRoutes.<camelId>` in `routeFactory.ts` names the path for links.
- `prerender-entry.jsx` derives `ADDON_ROUTES` from the catalogue; a `coming` row
  pre-renders its explainer page (title, summary, `comingReason`, a link back), which
  is a real page rather than a soft 404.
- The first render reads no storage and no clock; the status read starts in an
  effect, so the built HTML and hydration match.
- **No provider-scoped variants** (`/azure/tools/migration` is not created).
  Tools are global today: `/tools/*` outranks `/:provider`, and labs live under
  `/:provider/education/labs` only because Learn is per hub. `providers` on the
  row is metadata for hub cards. Revisit only if a hub Tools page needs a
  canonical per-provider URL.

## 6. Navigation contract

**Mandatory.** The Header's Tools menu derives its AddOn items from
`availableAddons`, each as `{ label: addon.menuLabel ?? addon.title, path: addonPanePath(addon) }`,
in the position the Migration Hub item holds today. A `coming` row is not in the
menu. `menuLabel: 'Migration Hub'` is kept on the migration row so the existing
menu expectations hold.

**Optional**: hub cards built from `addonsForProvider`.

## 7. UI and branding requirements

| Requirement | Level |
| --- | --- |
| The pane app uses the HCW theme tokens (the HSL variables `--background`, `--foreground`, `--primary`, `--muted`, `--border`, the display and mono font names) copied with provenance, and follows `prefers-color-scheme` so dark mode matches the site. | **Mandatory** |
| Status is shown in words, never by colour alone (the site's `SYSTEM_STATUS` words are the model). | **Mandatory** |
| One unavailable sentence everywhere: the site page, the AddOn's in-pane copy and the reverse proxy's 503 body all read `This tool isn't available right now.` Never a raw error, hostname or status code. | **Mandatory** |
| No vendor or tool names in anything a visitor can read, on either side of the frame: not the host, the edge, the human-verification provider, the workspace platform, nor any partner list. Say "human verification" and "expires after two hours". | **Mandatory** |
| The frame has a `title`; the toolbar's controls are keyboard reachable and focus moves into the frame on open; animation respects `prefers-reduced-motion`; the pane height is responsive (a viewport-relative height with a minimum, full-screen when the row grants `fullscreen`). | **Mandatory** |
| "Not production" labels on lab editions stay visible in the pane. | **Mandatory** |
| A "Copy report" control beside any download, so the tool works without the `downloads` capability. | **Mandatory** |

## 8. Pane protocol

**Mandatory.**

Frame: `<iframe src={addonFrameUrl(addon, theme)} title={addon.title} sandbox={sandboxFor(addon)} allow={allowFor(addon)}>`.

**The theme.** A pane on another origin cannot read the site's `dark` class, so the
site gives the frame `?theme=dark` or `?theme=light`, read from the document when the
page first renders (owner decision 2026-10-24, website issue #1353). It is read once and
not updated: changing a frame's `src` reloads it, which would drop the report the visitor
has open, so a theme toggle reaches an open pane at the next page load. An AddOn that
does not read the parameter ignores it and follows `prefers-color-scheme`. Observed in a
real browser on 2026-10-24, framed by the site: the network assessment and the cloud
assessment follow the parameter; the migration AddOn does not.

| Sandbox | When |
| --- | --- |
| `allow-scripts allow-same-origin allow-forms` | Always. `allow-same-origin` is required: without it the frame is an opaque origin, its own `fetch('/api/…')` arrives with `Origin: null`, exact-origin CORS refuses it, and the verification widget cannot bind to its hostname. The AddOn is always cross-origin to the site, so scripts plus same-origin cannot lift the sandbox. |
| `allow-downloads` | Row has `downloads`. Needed by any AddOn that saves a file (bundle zip, sample CSV). Confirmed by the owner on 2026-10-10 (ADR 0035 decision 9, section 21). |
| `allow-popups` | Row has `popups`. Discouraged; popups inherit the sandbox. |
| `allow-top-navigation` | Never. |

`allow` (Permissions Policy), each granted to the AddOn's origin only when the row
names it, otherwise the attribute is empty: `clipboard` grants `clipboard-read` and
`clipboard-write`; `clipboard-write` grants write only, which is all a "Copy report"
button needs and what a row should ask for; `fullscreen` grants `fullscreen`. The
network and cloud assessment rows hold `downloads` and `clipboard-write` (owner
decision 2026-10-24, website issue #1354).

Messages, AddOn to site, one shape:

```json
{ "type": "hcw-addon", "id": "migration", "state": "ready", "navigate": "/contact" }
```

| Rule | Detail |
| --- | --- |
| States | `loading`, `ready`, `working`, `unavailable` (`ADDON_PANE_STATES`). |
| Acceptance | The page reads a message only when `event.origin === addon.origin`, `event.source === frame.contentWindow`, `data.type === 'hcw-addon'`, `data.id === addon.id` and `data.state` is a known state. Nothing else in the message is read. |
| Target origin | The AddOn posts to each site origin it was configured with (`SITE_ORIGINS`, served to the pane by its own API), never `*`. |
| `navigate` | Read only when the row has `navigate`; must be one of `ADDON_NAVIGATION_TARGETS` (contact, landing zone, labs). The page calls the router itself. This replaces in-frame links to the site, which the site's `frame-ancestors 'none'` would block. |
| Watchdog | `ADDON_PANE_LOAD_TIMEOUT_MS = 30_000`. Any accepted message stops it; a timeout shows the unavailable section. |
| Status gate | The frame is mounted only when the status proxy answers `configured: true` and `reachable: true`. Anything else (not configured, unreachable, 404, a thrown read) shows the one sentence. |
| Pre-render safety | No `window` or storage access during the first render; the frame mounts after the status read resolves in an effect. |
| Site to AddOn | None. The AddOn must not require any message from the site, and the page sends none. |

## 9. Authentication and authorization

**Mandatory.**

- Public panes are anonymous. A visitor is never signed into an AddOn by the
  site, and the site holds no session for one.
- Admin surfaces on the site (Integrations card, Health probe) are behind Entra,
  as every admin page is (ADR 0006).
- An AddOn holds no site credential, no site token and no path into the site's
  Function App; the only direction is the proxy's read of the AddOn's health.
- Every anonymous mutating route on the AddOn is gated by a human-verification
  token (Turnstile `x-turnstile-token`, verified server side with the secret from
  the host vault). A lab edition with `REQUIRE_TURNSTILE` on and no secret refuses
  to start.
- Owner tokens (per uploaded assessment) are random, hashed at rest, compared in
  constant time, and a foreign or unknown id answers 404.

## 10. Status proxy contract

**Mandatory.**

| Item | Value |
| --- | --- |
| Route | `GET /api/public/addons/{id}/status`, anonymous, registered in `functions/src/functions/addons-public-http.js`, implemented in `functions/src/lib/addons/status.js`. |
| Registry | `functions/src/lib/addons/registry.js`: `ADDONS = Object.freeze({ migration: { setting: 'ADDON_MIGRATION_URL', healthPath: '/api/health' }, 'network-assessment': { setting: 'ADDON_NETWORK_ASSESSMENT_URL', healthPath: '/api/health' }, 'cloud-assessment': { setting: 'ADDON_CLOUD_ASSESSMENT_URL', healthPath: '/api/health' } })`. Ids are closed; an unknown id answers `404 { error: 'Unknown add-on' }` with no store read. A catalogue test asserts the registry's ids equal the catalogue's. |
| Answer 1 | `{ configured: false }` when the setting is absent, unresolved or not `https:`. No network, no store read. |
| Answer 2 | `{ configured: true, reachable: false, version: null, edition: null, capabilities: [], asOf }` (`asOf` = the ISO time of the failed read) when the health read refused, timed out, redirected or was not the documented shape. |
| Answer 3 | `{ configured: true, reachable: true, version, edition, capabilities, asOf }` from the AddOn's health body. |
| Projection | Allow-list only: `configured`, `reachable`, `version` (must match `^\d+\.\d+\.\d+`), `edition` (string, 40 characters or fewer), `capabilities` (strings, 40 characters or fewer each, at most 20), `asOf`. Nothing else from the body, and never the URL. |
| Cache | Answers 2 and 3 cached one minute in `tool_service_cache`, id `addons:<id>:status`, failures included (a failure replaces a healthy entry). `Cache-Control: public, max-age=60` when configured. |
| Timeout | 5 seconds, `redirect: 'error'`, `Accept: application/json`. |
| https only | A non-https setting is reported as not configured and logged by name, never used. |
| Frontend | `fetchAddonStatus(id)` in `frontend/src/lib/publicApi.js` through `requireConfiguredFlag`: null on 404, throw on a body without a `configured` boolean. |

## 11. AddOn-side HTTP contract

**Mandatory** unless marked.

**Health.** `GET /api/health` answers 200 JSON within one second and without any
upstream dependency:

| Field | Rule |
| --- | --- |
| `ok` | `true`; `false` with status 503 when a required dependency (rule corpus, catalogue) failed to load. |
| `id` | The catalogue id. |
| `version` | Semver of the running image. |
| `edition` | `lab` (or the AddOn's own edition string). |
| `capabilities` | Strings naming what the edition does, for example `assessments`, `sample-csv`, `bundle-download`. |
| `asOf` | ISO timestamp. |
| `azureConnectivity` | `disabled-by-design` on lab editions. |
| `turnstile` | `{ required, siteKey }` so one image serves any host. |
| `siteOrigins` | The origins the pane may post messages to, from env. |
| extras | Allowed (`rulesLoaded`, `workspace`, `limits`, `rules`, `model`); the proxy ignores them. |

**Headers on every response**: `X-Addon-Id: <id>`, `X-Addon-Version: <semver>`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`,
`Cross-Origin-Opener-Policy: same-origin`.

**Content Security Policy on HTML**: `default-src 'self'; script-src 'self' <verification script origin when enabled>; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src <verification frame origin when enabled>; frame-ancestors <FRAME_ANCESTORS>; base-uri 'none'; form-action 'self'`.
`frame-ancestors` comes from env (`<PREFIX>_FRAME_ANCESTORS`, default `'none'`);
`X-Frame-Options: DENY` is sent only when it is `'none'`. In production the value
equals the host's `caddy_frame_ancestors` so the two policies the browser
enforces agree.

**Cache-Control**: API responses `no-store`; `index.html` `no-cache`; hashed
assets `public, max-age=31536000, immutable`.

**CORS**: exact-origin allow-list from env, `OPTIONS` answers 204 or 403. The pane
is same-origin with its API, so the list may be empty in production.

**Request limits**: body cap with the socket destroyed past it; row and item caps
as the App defines (5 MB, 5,000 rows, 200 stored items for the program AddOns);
app-level rate limiting on anonymous mutating routes (token bucket per client
address, `429` with `Retry-After`); a concurrency bound on expensive work (`503`
with `Retry-After`). Client address is the socket's unless `<PREFIX>_TRUST_PROXY=1`,
in which case the first `X-Forwarded-For` value, which the host's reverse proxy
sets and nothing else can reach.

**Human verification**: required on every anonymous mutating route; the widget
renders from the public site key published by `/api/health`.

**State**: in-memory only, TTL-bound (120 minutes for the program AddOns), capped
count, explicit delete. No persistence, cookies or local storage.

**Logging**: structured, content-free (counts, ids, durations), with
secret-shaped strings redacted. Never request bodies, user file names or tokens.

**Errors**: `{ error: { code, message, details? } }`. `code` is a stable
snake_case machine code; `message` is visitor-safe (no hostnames, paths, stacks).
The generic codes are shared by every AddOn: `invalid_request` / `invalid_json`
(400), `turnstile_failed` (403), `not_found` (404), `method_not_allowed` (405),
`too_large` (413), `unsupported_media_type` (415), `too_many_rows` /
`ingestion_failed` (422), `rate_limited` (429, with `Retry-After`),
`internal_error` (500), `overloaded` and `turnstile_not_configured` (503,
`overloaded` with `Retry-After`). An AddOn may add codes of its own.

**Optional**: `GET /api/config` for public widget settings; `GET /api/sample.*`.

## 12. Configuration and secrets pattern

**Mandatory.** Naming follows [Variables and secrets](variables-and-secrets.md): app
settings `UPPER_SNAKE_CASE`, Key Vault secrets `UPPER-KEBAB-CASE` (none are needed
here), lab host vault keys `vault_<role>_<name>` (here `vault_addon_<id>_<name>`).

| Value | Store | Name |
| --- | --- | --- |
| AddOn origin, read by the status proxy | Function App plain app setting in `infra/functionapp.tf` (public value: it is already in the CSP and the frame `src`; no credential travels with it, so no vault seeding and no monitor) | `ADDON_MIGRATION_URL`, `ADDON_CLOUD_ASSESSMENT_URL`, `ADDON_NETWORK_ASSESSMENT_URL` |
| Image, tag, digest, loopback port, memory, pids | `lab-host/ansible/group_vars/all.yml` `addons[]` | per row |
| Site origins, frame-ancestors, public base URL, trust-proxy, rate limits, feature switches | `addons[].env` in `group_vars/all.yml`, rendered into the container env | `<PREFIX>_*` |
| Human-verification site key | public; `addons[].env` and published by `/api/health` | `<PREFIX>_TURNSTILE_SITE_KEY` |
| Human-verification secret, any other AddOn secret | Lab host Ansible vault, set with `hcw-vault-set`; the role refuses to start a container whose vault key is unset | `vault_addon_<id>_<name>`, for example `vault_addon_migration_turnstile_secret` |
| Nothing | Vite bundles, Git, Terraform state, the site's Key Vault | |

Unsetting the app setting closes the pane (the proxy answers `{ configured: false }`);
setting `enabled: false` on the row stops the container. Both are kill switches.

## 13. Logging and telemetry

**Optional**, off by default. An AddOn may emit counters to its own sink when
`<PREFIX>_TELEMETRY=1`; the default image env sets it to `0`. The site collects
nothing from the pane. The Function App logs the proxy's outcome by setting name,
never by value.

## 14. Error-handling requirements

**Mandatory.**

- The site page shows one of three things: the opening sentence, the frame, or
  the unavailable sentence. No other error state exists on the public page.
- The AddOn answers every failure with the error envelope and a visitor-safe
  message; its pane shows the same unavailable sentence when its own health read
  fails.
- The reverse proxy answers a stopped container with 503 and the same sentence.
- A failed status read is cached as unreachable for a minute rather than retried
  per visitor.
- A restart erases everything by design, and the pane says so before an upload.

## 15. Testing expectations

**Mandatory.**

| Side | Tests |
| --- | --- |
| AddOn | Unit: lifecycle, limits, CORS, verification path with a mocked siteverify, frame-ancestors config with and without `X-Frame-Options`, rate limit and overload, health shape, version header, cache-control per path, startup refusal without a secret. Contract: OpenAPI and routes two-way. Security: edition boundary (no cloud SDK importable, refusal under an identity endpoint), no secrets in the tree, content-free logging. End-to-end: the built pane against the real API inside a host page that applies the production sandbox and records `hcw-addon` messages; the sequence `loading`, `ready`, `working`, `ready`; the verification script stubbed. |
| Website | Catalogue test (fields, regexes, frozen rows, copy rule, registry parity). `AddOnPanePage.test.jsx` on the `LabPanePage.test.jsx` harness (service table, opening sentence, unavailable for each failure with the behind-the-site word scan, exact sandbox per capabilities, `allow`, watchdog, message acceptance, `navigate` allow-list, `coming` renders no frame and fetches nothing). `csp.test.js` parity with `addonOrigins()`. Route completeness, no duplicate routes, Header menu. Public copy with `data/addons` in its roots. Status proxy unit tests with a fake fetch. Route inventory and API contract. Registry, directory and probe parity. |
| Lab host | `ansible-lint`, `check-argument-spec-defaults.py`, `ansible-playbook --syntax-check`, visitor copy of the role's `respond` bodies (equal to the site's sentence), a route test for the rendered Caddy template, a `caddy adapt` of the rendered config in CI. |

## 16. Deployment expectations

**Mandatory.**

- Image: `docker.io/hybridcloudworks/<image>` pinned by digest in
  `group_vars/all.yml` (`image`, `image_tag` for humans, `image_digest`). Owner
  decision 2026-10-09: all AddOn images publish to Docker Hub, matching the
  website's lab-image decision of 2026-10-08.
- One generic Ansible role `addons` in the website repository, one `addons[]`
  entry per AddOn. The role asserts each port publishes on `127.0.0.1` and is
  unique, asserts each `secret_env` vault key is set when `enabled`, pulls by
  digest, and runs `docker_container` named `hcw-addon-<id>` with
  `published_ports: ["127.0.0.1:<port>:8080"]`, `read_only: true`,
  `tmpfs: ['/tmp']`, `cap_drop: ['ALL']`, `security_opts: ['no-new-privileges:true']`,
  `memory`, `pids_limit`, `restart_policy: unless-stopped`, the image's own
  `HEALTHCHECK`, `log_options` with a max size, no volumes and no mounts (compared
  strictly), no socket, on the add-ons' own bridge network (`hcw-addons`:
  inter-container communication off; egress from its subnet limited in the
  `DOCKER-USER` chain to established flows and TCP 443 to the verification
  endpoint's published ranges, everything else rejected, the rules also written
  to ufw's `after.rules` for the next boot), under the daemon's user-namespace
  remap (no `userns_mode: host`).
- The role waits for `http://127.0.0.1:<port>/api/health` to answer 200 (not in
  check mode) and removes the container when the row is not deployed this run
  (`enabled: false`, or an enabled row whose `image_digest` is empty).
- Caddy route file `20-addons.caddy` per enabled AddOn:
  `@addon_<id> host <id>.lab.hybridcloudworks.com`,
  `handle @addon_<id> { reverse_proxy 127.0.0.1:<port> }` for a deployed row and
  `handle @addon_<id> { respond "<sentence>" 503 }` for a pending one (no proxy to
  a port nothing of ours holds), `handle_errors` with the unavailable sentence at 503. `lab_panes_only` already applies to every lab
  name: site-only `frame-ancestors` and a top-level redirect. AddOns never set
  `lab_top_level_allowed`.
- Resource ceiling recorded next to the Coder capacity assertion; the end-of-run
  privilege checks cover each AddOn container (read-only root, all capabilities
  dropped, not privileged, no binds and no mounts, on the add-ons' network, exactly
  one published port on 127.0.0.1 at the row's port, remapped namespace).
- No DNS or certificate change: the `*.lab` record and the wildcard certificate
  already cover one-label names.

## 17. Versioning and compatibility

**Mandatory.**

- AddOn releases are semver tags `v*`; `publish-images.yml` scans, pushes
  `docker.io/hybridcloudworks/<image>:<version>` and prints the digest in its
  summary. The website pins that digest; the digest is the only coupling.
- The pane protocol (section 8) and the `/api/health` shape (section 11) are
  versioned by this standard. A breaking change to either needs a new revision of
  this document and a change to the row's `capabilities`.
- `capabilities` in the health body says what the running image does;
  `capabilities` on the catalogue row says what the page grants. They are
  different lists on purpose.
- The admin Integrations card reads `version` and `edition` through the proxy;
  `X-Addon-Version` is what an operator reads over SSH.

## 18. Independent update model

**Mandatory.**

1. The AddOn tags a release; its publish workflow produces a digest.
2. A website PR moves one digest (and tag) in `group_vars/all.yml`. Nothing else
   in the site changes for a compatible release.
3. The owner runs `bootstrap.sh`; the role pulls by digest and recreates the
   container.
4. Rollback is the previous digest in the same file and another run.
5. Upstream to downstream: the App releases `v*`; the AddOn's `core-update`
   workflow (or Dependabot once packages are on a registry) tests and adopts the
   release, then the AddOn releases.

The website never bumps an AddOn automatically; `scripts/lab-pins-upstream.mjs`
has no "publisher newest" to compare for these images, and the README's pin table
says so.

## 19. Edition boundary

**Mandatory.** A lab edition is technically unable to construct a cloud
credential: no cloud SDK or identity library is installed in the image; the
process refuses to start when an identity endpoint or a client-secret variable is
present in its environment; `azureConnectivity: 'disabled-by-design'` is reported.
Enforced by a security test in the repository and by an image-level check in
`publish-images.yml` (an `import` of the SDK must fail inside the built image).
The container runs on the bridge network with no route to the host's identity
endpoint and no identity mounts.

## 20. Coder-specific patterns that must not be generalised

The labs integration (ADR 0032) carries patterns that belong to a workspace
platform and not to AddOns. **Mandatory** that an AddOn uses none of them:

- GitHub sign-in in a new tab and the `labSignIn.js` storage events.
- The launcher page and its workspace states (`signed-out`, `create`, `stopped`, `starting`).
- Workspace names, template parameters and the template publish script.
- Wildcard sub-origins (`*.coder.lab…`); an AddOn has exactly one origin and no
  wildcard enters the CSP.
- `allow-popups` by default; AddOns grant it only by capability.
- The top-level exemption `lab_top_level_allowed`.
- Docker Compose; AddOns are single containers run by the role.

## 21. Human review flags

| Item | Flag | Who |
| --- | --- | --- |
| `allow-downloads` on AddOn panes (sandbox widening beyond the labs pane) | Confirmed 2026-10-10 (#1044) | Owner, as a website security decision, recorded in ADR 0035 decision 9 |
| ADR 0032 amendment: AddOn containers on the lab host beyond Coder and its database | Confirmed 2026-10-10 (#1044) | Owner, in ADR 0035 decision 8 |
| One human-verification widget per AddOn (separate site key and secret from the site's own) and its creation | [REVIEW REQUIRED] | Owner creates each widget; secret seeded with `hcw-vault-set` |
| Per-host direct-visit redirect in the Caddyfile (directive ordering) | [VERIFY] | `caddy adapt` in CI before merge |

## 22. Compliance checklist

A reviewer ticks every row for an AddOn before its row becomes `available`.

| # | Check | Section | Done |
| --- | --- | --- | --- |
| 1 | Repository has the required layout and workflows | 3 | [ ] |
| 2 | Catalogue row valid; copy rule clean; registry parity test passes | 4, 10 | [ ] |
| 3 | Route, `staticRoutes` entry, pre-render, Tools menu | 5, 6 | [ ] |
| 4 | Pane uses HCW tokens, status words, the one sentence, no vendor names, accessibility items | 7 | [ ] |
| 5 | Posts `hcw-addon` messages with the four states to the site origins only | 8 | [ ] |
| 6 | Requires no message from the site | 8 | [ ] |
| 7 | Anonymous; holds no site credential; verification on mutating routes; owner tokens hashed | 9 | [ ] |
| 8 | Health shape complete; headers; CSP with configurable `frame-ancestors`; cache rules; CORS; limits; rate limit and concurrency; error envelope; content-free logs | 11 | [ ] |
| 9 | App setting, env rows and vault key named per the pattern; `.env.example` has no values | 12 | [ ] |
| 10 | Telemetry off by default | 13 | [ ] |
| 11 | Tests on all three sides pass; e2e observed the state sequence | 15 | [ ] |
| 12 | Digest-pinned image on Docker Hub; role entry with hardening; Caddy route; health wait | 16 | [ ] |
| 13 | Semver tag and digest recorded; `capabilities` reviewed | 17 | [ ] |
| 14 | Update and rollback documented in `docs/deployment/lab-host.md` | 18 | [ ] |
| 15 | Edition boundary test and image check pass | 19 | [ ] |
| 16 | No Coder-only pattern used | 20 | [ ] |
| 17 | Every [REVIEW REQUIRED] and [VERIFY] item resolved by the owner | 21 | [ ] |
| 18 | Integration record in `docs/architecture/app-to-addon/<id>.md` and the AddOn's `docs/website-integration/` agree | 3, 18 | [ ] |
