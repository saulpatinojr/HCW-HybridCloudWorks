# Azure Functions review — `functions/`

Single Azure Functions app (ADR-0019), Flex Consumption, Node 24 (the newest
line Flex supports as GA, 26 being preview only; `scripts/version-floors.json`
holds it there), ESM
(`"type": "module"`), programming model v4 (`@azure/functions`). Handlers
live in `functions/src/functions/`, shared logic in `functions/src/lib/`
(with `auth/`, `http/`, `cms/`, `content/`, `integrations/`, `timers/`,
`triggers/` subtrees). Data plane: Cosmos DB and Blob Storage via managed
identity (`@azure/identity`) — no connection strings. Tests are Vitest,
co-located as `*.test.js`.

## What to check in the diff

### Route and contract integrity
- Every HTTP handler must be registered through
  `functions/src/functions/index.js` and reflected in
  `route-inventory.test.js`; public-facing shapes are pinned by
  `api-contract.test.js`. A new/renamed route without matching test updates
  will fail CI — and if the tests *were* edited, verify the change is an
  intentional contract change, not a test bent to fit a bug.
- Frontend callers and `scripts/smoke-deployed.mjs` depend on these
  contracts; breaking a public read shape breaks pre-rendered pages.

### AuthN/AuthZ — the highest-stakes check here
- Admin/CMS endpoints (`admin-*`, `cms-http`, `publish-http`,
  `content-workflow-http`, `forge-*`, etc.) must validate the Entra bearer
  token using the existing `src/lib/auth` helpers (`jsonwebtoken` +
  `jwks-rsa`) and enforce roles server-side. A handler that trusts a client
  claim, skips validation on one method, or checks roles only in the
  frontend is a blocking finding.
- Public endpoints (`public-*`) must stay anonymous-safe: no secrets in
  responses, no unbounded queries, and Cosmos reads scoped to published
  content only.
- `lab-agent-http.js` authenticates the pull-based VPS agent — changes there
  affect a credentialed machine channel; review token handling and
  capability scoping (`vps-agent/lib/capabilities.js`) together.

### Data and jobs
- Cosmos access goes through `src/lib/cosmos-client.js` (including if-match
  concurrency handling — see `cosmos-client.ifmatch.test.js`). Direct
  `@azure/cosmos` container wiring in a handler bypasses that and is a flag.
- Container/partition changes must match `infra/cosmos-containers.json` and
  the generated spec (`scripts/generate-cosmos-container-spec.mjs --check`).
- Queue workers, change-feed handlers (`change-feed.js`), and timers
  (`schedulers.js`, `timers/`) must be idempotent — they redeliver. Check
  failure paths notify via `job-failure-notify.js` patterns rather than
  swallowing errors.
- HTML from feeds/integrations is sanitized via `src/lib/sanitize-html.js`
  before storage or serving; `cheerio`/`turndown` output is not trusted raw.

### Configuration and secrets
- Secrets come from Key Vault references / app settings, never literals —
  `app-settings-secrets.test.js` and the unresolved-secrets monitor
  (`scripts/check-unresolved-secrets.mjs`) both police this; keep new
  settings consistent with `infra/functionapp.tf`.
- `host.json` is pinned by `functions/test/host-json.test.js`; changes to
  concurrency/extension settings need that test updated deliberately.
- Telemetry (App Insights) must stay content-free: correlation IDs, not
  document IDs, paths, or payloads.

## Verification commands

Run from `functions/`:

```bash
npm test        # vitest run — includes route-inventory, api-contract, host-json
```

If the diff adds a route the frontend calls, also run the frontend
validators (see `frontend.md`). Deployment is only via the
`deploy-functions.yml` workflow — a diff that adds any other deploy path is
a finding.
