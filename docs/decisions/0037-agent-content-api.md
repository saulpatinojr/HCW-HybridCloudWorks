# ADR 0037: Koda reaches the site through an Agent Content API with one hashed key, scoped to the Drafts stage and the published reads, switched from a Koda tab on the AI Engine

**Status:** Accepted 2026-10-31 by the owner as architecture owner (the proposal was the owner's; the deviations below are recorded here for the owner to confirm or reverse)
**Decision date:** 2026-10-31
**Owners:** Workload owner and architecture owner

Related: issue [#1477](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1477)
(the owner's proposal "Hybrid Cloud Works — Agent Content API (v1 Proposal)" of
2026-10-31, with the deviations and the open point listed for the owner); the Drafts stage
([`functions/src/lib/cms/drafts.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/cms/drafts.js),
owner request 2026-10-03); [ADR 0033](0033-contentforge-alignment.md) (the
content pipeline this joins);
the lab agent's guard
([`require-agent.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/auth/require-agent.js)),
the pattern of a separate guard per machine caller that this follows.

## Context

The owner's content program (the Azure architecture series, the AWS Kiro
series, the AWS Transform series) is to be drafted and reviewed with help from
Koda, the owner's agent in the Muse service. Koda needs to read what the site
has published and to create and edit drafts. Publishing must stay a human act
in the site's own screens.

Muse reaches an outside site through a "custom connector", and that connector
fixes how it signs in: one secret, sent as `Authorization: Bearer`, to one
host registered when the connector is set up. It cannot run an OAuth flow,
cannot sign requests and cannot send a second header. So the choice is an API
key or no connection.

Everything else that calls this API by machine signs in with Entra: the lab
agent with an App Role and a registry record
([`require-agent.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/auth/require-agent.js)),
and the private notes sync with a delegated scope of its own.
The two exceptions are webhooks whose senders also cannot do better (Telegram,
StreamYard), each compared in constant time against a configured secret. An
API key for Koda is a third exception of that kind, and the decision is how to
keep it as narrow as those.

The owner also asked for a section of the admin just for Koda, in the AI area,
with access to "everything possible".

## Purpose and decision drivers

- **A key held by a third-party service must not become admin access
  (security).** If Muse leaks the key, the blast radius is the Drafts stage,
  which holds unpublished text and nothing a visitor can see.
- **Publishing stays human (the owner's rule; security).** No automated path
  may make an authoritative write. The site already enforces this for drafts;
  the API must not add a way round it.
- **Reuse, do not reimplement (reliability).** The Drafts routes already carry
  the field allow-list, the size caps, the etag protection, the title dedup,
  the refusals for anything live and the audit rows. A second implementation
  would drift from the first.
- **Revocation must be immediate (security, operations).** The proposal asks
  for it; the lab agent guard sets the precedent of no cache in front of a
  registry read.
- **The owner must not have to run anything (operations).** The key is made,
  shown once, switched and revoked in the admin; no Terraform, no Key Vault
  step, no app setting.

## Decision

1. **A new base path, `/api/agent-content/v1/`, not the proposal's
   `/api/agent/v1/`.** `/api/agent/*` is the lab agent's namespace
   ([`lab-agent-http.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/lab-agent-http.js));
   putting a second caller under it would make the two indistinguishable in
   logs, in the route inventory and in the firewall's eyes.
2. **One key, kept as a SHA-256 hash in one `admin_config` document
   (`agent_content_key:koda`).** The key starts with `hcwk_` and carries 32
   random bytes. The site shows it once, on the Koda tab, right after
   Generate, and never again; it stores the hash, the first characters as a
   hint, who made it and when, when it was last used, the capability
   switches and any revocation
   ([`keys.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/feat/agent-content-api-koda/functions/src/lib/agent-content/keys.js)
   on the branch `feat/agent-content-api-koda` until it merges). No Key Vault
   secret and no app setting: the key is consumed by Muse, not by the app, so
   there is nothing for the app to read, and a Cosmos record is what makes
   revocation immediate.
3. **A fourth guard, disjoint from the other three**
   ([`guard.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/feat/agent-content-api-koda/functions/src/lib/agent-content/guard.js)).
   Three gates in order: the bearer value is shaped like a site key (a random
   token is refused before any read); its hash matches the record, which is
   not revoked, compared in constant time and never cached; the key is under
   120 calls a minute, counted with the public submission routes'
   compare-and-increment counter under a key that names the minute. Then the
   route's capability must be on. 401 for a missing, wrong or revoked key
   (one sentence for all three), 403 for a capability that is off, 429 with
   `Retry-After` for the limit; every refusal of a presented value is an
   `admin_audit_logs` row without the key (a request with no Authorization
   header is refused without a row, as the admin guard does, so anonymous
   probes do not fill the log). An admin token is refused here, and the key is refused by
   `requireRole`, so neither can cross into the other's routes. The
   route-inventory test knows the guard by name.
4. **The routes are the Drafts routes and the public reads, reached through
   the key.** `createDraftsHandlers` is created with the key guard standing
   in for the role guard, one handler set per capability, so a draft Koda
   writes is written exactly as one typed on the Drafts page: `drafting`,
   `Live: false`, the eight editor fields and the two taxonomy ids only, the
   256 KB body cap, the etag on every change, the title dedup, the same
   refusals for anything live, the same audit rows, with `koda (agent)` as
   `createdBy` and `updatedBy`, `draftOrigin: 'agent'` (a new value, forced by
   the handlers and never taken from a request body) and `ai-recommendation`
   as the idea origin when Koda names none. The published reads are
   `GET /api/public/content` and `GET /api/public/content/{slugOrId}`
   behind the `published.read` capability, so Muse needs one host and one
   base path. There is no publish, unpublish, slug, workflow, settings or
   secrets route for the key to call; that is what "the API can never
   publish" means here.
5. **Five capabilities, each a switch on the Koda tab, all on for a new
   key:** read drafts, create and edit drafts, send to review and back,
   delete drafts, read published posts. A capability is a route group the
   handlers wire by name; adding one is a code change. This is the answer to
   "access to everything possible": everything the Drafts stage and the
   public site offer, each part switchable, and nothing that the owner's own
   rules keep human.
6. **A Koda tab on the AI Engine page** (`/admin/ai-engine?tab=koda`,
   [`KodaTab.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/feat/agent-content-api-koda/frontend/src/components/admin/ai-engine/KodaTab.jsx)):
   the key's state, Generate or Rotate and Revoke (super_admin, each behind a
   confirmation), the one-time reveal with Copy, the capability switches
   (super_admin), every non-secret value the Muse connector form asks for,
   and the endpoint list grouped by capability. An editor sees the state and
   is told which controls need super_admin before any round trip.
7. **Where the proposal's shape is not followed, the site's existing contract
   is.** Drafts are addressed by id, not slug (a draft has no slug by design:
   drafts.js explains why a slug on a draft would push a published article
   onto a suffix). Every change carries the `etag` of the version read and a
   stale one is `412 CONFLICT`, which is stronger than the proposal's
   `Idempotency-Key`; the markdown route is idempotent by title
   (`200 ALREADY_IMPORTED`), which covers the retry case. Errors use the
   site's envelope, `{ ok: false, code, error }`. The series calendar fields
   (`series`, `target_month`) have no column in the content model; the
   template's `track`, `part`, `date` and `tags` carry the same information
   and Koda sets them. `created_via` is `draftOrigin: 'agent'` plus the
   author fields and audit rows. These are recorded so the connector is
   written to the API that exists, not to the proposal.

## Consequences and accepted risks

- Until a key is generated on the tab, every `/api/agent-content/v1/*` route
  answers 401 and reads one document. Nothing is on by default.
- **Accepted risk: a static secret held by a third party.** Mitigated by the
  scope (the Drafts stage and public reads only), the per-minute limit, the
  immediate revoke, the audit row on every refused key and the hint that lets the
  owner tell which key Muse holds. The owner rotates it on the tab whenever
  Muse's handling of it is in doubt, and the credential rotation schedule in
  [`docs/security/credential-rotation-schedule.md`](../security/credential-rotation-schedule.md)
  should gain a row for it.
- **Accepted risk: the plaintext crosses the browser once.** The Generate
  answer carries it to the super_admin's screen, in component state, until
  dismissed or the tab is left. It is not written to storage, the console, a
  toast or an audit row. The alternative, a key the owner never sees, cannot
  be pasted into Muse.
- **Open point for the owner: the host Muse registers.** The API lives on
  `api-azure.hybridcloudworks.com`, not on `hybridcloudworks.com`; the site's
  pages call it cross-origin and there is no proxy in front of it on the apex
  host. The connector should register `api-azure.hybridcloudworks.com`. If
  Muse insists on the apex host, a Cloudflare route that forwards
  `hybridcloudworks.com/api/agent-content/*` to the Function App host is the
  change, and it is not made here.
- Koda's drafts appear on the Drafts page as any other draft, with
  `koda (agent)` as the author. A per-origin filter on that page would help
  once Koda writes many; not built here.
- The per-minute counter writes one `submission_quota` document per active
  minute; the container's two-hour TTL removes them.

## Alternatives considered

- **An Entra client-credentials token for Muse.** The right answer for any
  caller that can do it; Muse's connector cannot. Revisit if Muse adds OAuth
  to its connectors.
- **A Key Vault secret seeded from the Keys tab.** That tab never reveals a
  value, by design, because the app consumes those secrets itself; this key
  is consumed by Muse and must be shown once. Also, a vault-backed app setting
  is read at worker start, so revocation would wait for a recycle.
- **A separate REST surface shaped exactly as the proposal (slugs, series,
  `Idempotency-Key`).** A second implementation of the Drafts stage, with its
  own refusals to keep in step. Rejected for drift; the proposal's intent is
  met by the existing routes.
- **Granting the key `/api/cms/*` at editor.** "Everything" in the literal
  sense: it would also let a leaked key approve, schedule and publish through
  the pipeline's own routes, which the proposal and the owner's standing rules
  both forbid.

## Validation and revisit triggers

- Validation: the functions suite (the four new test files under
  `functions/src/lib/agent-content/`, the route inventory, the API contract,
  the function inventory and the Drafts handler tests) and the frontend suite
  (the tab, its view and client, and the AI Engine shell). Production
  validation is the runbook's acceptance list, run once the key is made.
- Revisit when Muse's connector can sign in another way; when a second agent
  needs a key (a second record and tab, or a registry); when Koda needs a
  capability this list lacks (a code change and an entry here); or when the
  key is suspected leaked (rotate on the tab, then read the audit rows of
  kind `agent-content-denial`).

## Related decisions and references

- [ADR 0033](0033-contentforge-alignment.md) (the content pipeline)
- Runbook: [Agent Content API: connect Koda, rotate and revoke](../runbooks/agent-content-api.md)
- The contract: `.azure/api-surface.json`, sections `agentContentApi` and `adminAgentContent`
