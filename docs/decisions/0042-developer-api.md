# ADR 0042: A public Developer API v1 for events and call for speakers, keyed per organizer

**Status:** Proposed
**Decision date:** 2026-11-20
**Owners:** Workload owner and architecture owner

## Context

The owner runs community events and speaks at them. Organizers need to manage
future events and calls for speakers (CfS) from code, the way the Community
Days developer API lets organizers build, run and publish events with the same
tools the site uses (developers.communitydays.org; announcement shared by the
owner 2026-11-20). Today the site has no organizer-facing API and no
call-for-speakers concept at all: a repository search finds no CfS record, and
speaking data lives in speaker events fed by Sessionize
(`functions/src/lib/admin-identity/speaker-events.js`,
`frontend/src/components/widgets/sessionizeFeed.js`).

The site already has the pattern for a machine API: ADR 0037 (Agent Content
API — one hashed key, a separate guard per machine caller, keys made, rotated
and revoked in the admin) and the admin role guard (ADR 0038). This decision
applies that pattern to a second machine caller: event organizers.

## Purpose and decision drivers

- **Organizers must be able to run events from code (operations).** Create
  events, build the program, manage sponsors, duplicate last year's event,
  find speakers.
- **CfS must be a first-class flow (operations).** Open a call, take public
  talk proposals, review them.
- **Publishing stays human (the owner's rule; security, ADR 0037).** An API key
  must never publish an event, unpublish one, or make a proposal public on its
  own. Writes create drafts; publishing happens in the site's own screens.
- **Reuse, do not reimplement (reliability).** Speakers come from the existing
  speaker-events / Sessionize data. Keys follow the ADR 0037 guard pattern.
  The API lives in the single Function App (ADR 0019) on Cosmos serverless
  (ADR 0003), inside the existing functions boundaries (ADR 0004).
- **Keys must be narrow and revocable (security).** Per-organizer keys, scoped,
  revocation immediate, no cache in front of the registry read.
- **The public surface stays public (operations).** Reading published events,
  finding speakers, and submitting a CfS proposal need no key. Everything that
  changes state needs one.

## Decision

1. **A new base path, `/api/developer/v1/`, not an extension of
   `/api/agent-content/v1/`.** One namespace per machine caller: `/api/agent/*`
   is the lab agent's, `/api/agent-content/v1/` is Koda's, `/api/developer/v1/`
   is organizers'.
2. **Auth: per-organizer API keys, following ADR 0037.** Keys carry a distinct
   prefix (`hcdk_`) so they cannot be mistaken for agent keys, are stored
   hashed, and are sent as `Authorization: Bearer`, also accepted as a bare key
   or an `X-API-Key` header, never from the address. The guard is a separate
   guard per machine caller, following
   `functions/src/lib/auth/require-agent.js`. Keys are made, rotated and
   revoked in the admin; scopes are `events:read`, `events:write` and
   `cfs:manage`; revocation is immediate. Rate limits apply per key.
3. **Endpoints, v1:**

   | Method | Path | Who | What |
   | --- | --- | --- | --- |
   | GET | `/v1/published-events` | public | Find every published event (filters: from/to, q) |
   | GET | `/v1/events/{id}` | public if published, else key | One event |
   | GET | `/v1/speakers?q=` | public | Find speakers, from speaker-events / Sessionize data |
   | POST | `/v1/events` | key, `events:write` | Create an event, in draft |
   | PUT | `/v1/events/{id}/program` | key, `events:write` | Build the schedule (sessions) |
   | POST | `/v1/events/{id}/sponsors` | key, `events:write` | Manage sponsors |
   | POST | `/v1/events/{id}/duplicate` | key, `events:write` | Copy a past event into a new draft |
   | POST | `/v1/events/{id}/call-for-speakers` | key, `cfs:manage` | Open or close a call |
   | POST | `/v1/events/{id}/call-for-speakers/submissions` | public, rate-limited | Submit a talk proposal |
   | GET | `/v1/events/{id}/call-for-speakers/submissions` | key, `cfs:manage` | List proposals for review |
   | PUT | `/v1/events/{id}/call-for-speakers/submissions/{submissionId}` | key, `cfs:manage` | Accept or reject a proposal |
   | DELETE | `/v1/events/{id}/call-for-speakers/submissions/{submissionId}` | key, `cfs:manage` | Delete a proposal (added by #1777, see "Changes after Phase 1") |
4. **Delivery in two phases.** Phase 1: keys + guard + published-events +
   speakers + the CfS flow (open, submit, list, review). Phase 2: the event
   management writes (create, program, sponsors, duplicate). Phase 1 is the
   public surface plus organizer review; Phase 2 is the poster's write surface.
5. **Implementation shape.** A new `functions/src/functions/developer-api-http.js`
   entry with `functions/src/lib/developer-api/` (handlers, guard, keys),
   registered in the route inventory, vitest coverage, a runbook at
   `docs/runbooks/developer-api.md`, audit rows for writes, and the same
   field allow-lists, size caps and refusal shapes the existing admin routes
   use. New Cosmos data (events, program, sponsors, submissions) follows the
   repo's Cosmos patterns. Also add the 0042 row to the register in
   `docs/decisions/index.md`.
6. **No endpoint publishes, unpublishes, or schedules an event live.** Draft
   to published happens in the admin, by a human.

## Consequences and accepted risks

- **A new public surface.** The public CfS submit endpoint needs rate limiting
  and abuse controls; spam proposals are the known risk, mitigated by per-IP
  and per-call limits rather than by requiring a key.
- **Organizers call from a server, never from a browser on their own site
  (added in the pre-merge review of #1754).** The API refuses, with `403`, a
  browser request whose `Origin` (the site the page came from) is not this
  site's own; that is the site-wide rule in `functions/src/lib/auth/cors.js`
  and this decision does not widen it. So an organizer's "submit a talk" form
  posts to the organizer's own server, which sends the proposal on. Accepted:
  an organizer needs a server; a static page alone cannot use the API.
- **The key that owns a call is not counted per visitor on that call (same
  review).** A relaying server sends every proposal from one address, and the
  per-IP limit of 5 an hour would hold a whole event to 5. A proposal sent
  with the key that opened the call, holding `cfs:manage`, skips the per-IP
  limit only; the per-call limit (100 an hour), the per-key limit, the size
  cap, the origin check and the open-call check still apply. A request with
  no key is handled as before, and a key that does not own the call gets
  nothing. Accepted: a leaked key, or an organizer's form with no limit of
  its own, can put up to 100 proposals an hour on that organizer's own call.
  It reaches no other call, and rotating or revoking the key stops it.
- **Key leak blast radius is one organizer's own events.** A leaked key cannot
  publish, cannot reach settings or secrets, and cannot touch another
  organizer's data.
- **New Cosmos data (events, program, sponsors, submissions).** Small volume
  on serverless; cost follows ADR 0003.
- **Two-phase delivery.** The poster-style writes land in Phase 2, not Phase 1;
  the PR that implements this ADR delivers Phase 1 and records Phase 2 as
  follow-ups.

## Changes after Phase 1 (#1777)

The review before Phase 1 merged left seven gaps on
[#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777).
Four are closed by these changes, which stay inside the decision above: no
new container, setting or secret, and still no route that publishes.

- **A proposal can be deleted.** A proposal holds a speaker's name, email and
  bio, and a speaker may ask for it to be erased. The organizer who owns the
  call deletes one with `DELETE .../submissions/{submissionId}` (`cfs:manage`;
  another organizer's event is the same `404` as no call). The owner deletes
  one on any call from the admin, where a search by the speaker's email
  address answers the proposals' ids, events, statuses and dates only
  (`POST cms/developer-api/proposal-search` and
  `DELETE cms/developer-api/proposals/{submissionId}`, both super_admin). The
  address travels in the request body, never in a URL. Every delete is under
  the version that was read, is safe to repeat, and writes an audit row with
  the status and no personal data. **Still open, the owner's decision:** how
  long a proposal is kept after its call closes. Nothing expires today.
- **A call takes proposals only while its key works.** Before a proposal is
  counted against a call or stored, the record of the key that owns the call
  is read, and a revoked or missing key is answered the same `404` as a
  closed call. The other design, closing a key's open calls when it is
  revoked, was rejected: finding the calls needs a query across every event,
  and between the revoke and the last close (or for good, if a close fails) a
  proposal could still land. Checking on each proposal has no such moment and
  no second write to fail. It costs one small extra read per proposal, after
  the per-visitor limit, so a caller over that limit never reaches it; the
  organizer's own relay skips it because its key was just checked. Accepted:
  the call's record still says `open` after a revoke, and no key can list or
  hand over what it already holds (Phase 2).
- **The proposal list is paged.** `GET .../submissions` takes `limit` (1 to
  500, 500 when left out, so an existing caller sees what it saw before) and
  `cursor`, and answers `nextCursor`, which is null on the last page. The
  cursor wraps the database's own continuation value with the status filter
  it was made for; a cursor that is malformed, was made for another filter or
  is no longer recognised is a `400`, never a `500`. The value inside a
  cursor must be printable ASCII (letters, digits, punctuation and spaces):
  it is sent back to the database in a request header, and a line break or
  other character there would be refused by the runtime with an error that
  is not a `400`.
- **Refusals that cost nothing to repeat are capped.** A wrong secret under a
  real key id, a revoked key and a key over its limit each wrote an audit row
  per request, with no limit, and a key id is not secret. They are now
  counted per key id per minute and write at most 10 rows a minute; past that
  the answer is unchanged (so it does not say whether the id is real) and no
  row is written. The right key never reaches that counter, so an organizer
  cannot be locked out by someone else's wrong keys. Accepted: each refusal
  still costs the read of the key record and a counter check, so this bounds
  the audit log, not the request count; a bound on requests would have to
  count every caller before the key is read, which Phase 1 does not do. The
  Koda key's guard (ADR 0037) has the same gap and is not changed here.
  Accepted too: the three kinds of refusal share the one counter, so ten
  wrong keys sent under a known id use up that minute's rows, and a revoked
  key or a key over its limit in the same minute gets no row of its own. So
  that this is visible, the first refusal past the cap writes one row,
  `developer_api_refusal_cap_reached`, with the key id only; after it the
  minute is silent.
- **Timing is not equalised.** A missing, wrong or revoked key gets the same
  status and the same sentence, so the answer itself does not say whether a
  key id exists. A refusal on a real id also waits for its counter and its
  audit row, so it takes longer than one on an id that names nothing, and a
  caller who measures response times could tell the two apart. Accepted: a
  key id is 64 random bits and is not treated as a secret.

Left as they were, on purpose:

- **Ids of unpublished site events are not reserved.** Accepted in the
  runbook's "Accepted risks in Phase 1"; Phase 2's event records settle it.
- **This ADR's status.** Whether it moves from Proposed to Accepted is the
  owner's decision.
- **The credential register.** Neither site-issued key (Koda's `hcwk_`, the
  organizers' `hcdk_`) has a row in
  `functions/src/lib/credentials/register.js`, so neither gets a reminder at
  180 days. They do not fit the register as it is: a row is one named
  credential in a store the register knows, with one date, and the register
  has no store for "issued by this site, hash in `admin_config`" and no live
  source that reads a key record's own rotation date. Organizer keys are also
  many, each with its own date. Whether to extend the register (a new store
  and a source for Koda's key; a per-key reminder for organizers) is the
  owner's decision on #1777.

## Alternatives considered

- **Extend the agent-content API for organizers.** Rejected: different caller,
  different trust. One namespace per machine caller is ADR 0037's own
  reasoning, and the agent key's blast radius must not grow.
- **OAuth / Entra for organizers.** Rejected for v1: organizers are
  individuals with keys, the same as the agent key. Entra stays for staff and
  the lab agent. Revisit if organizers need delegated login.
- **Sessionize only, no own CfS.** Rejected: Sessionize holds the owner's
  talks, not an organizer's call for speakers or event management.
- **Proposals by form only, no public submit endpoint.** Rejected: the API is
  the point. Public submit is rate-limited instead.

## Validation and revisit triggers

- Phase 1 is done when: a key issued in the admin reads published events and
  speakers, opens a call, takes a public proposal, and lists it for review;
  revoking the key blocks it immediately; tests are green; the runbook is
  written.
- Revisit if: a key leaks with a wider blast radius than its scope; CfS spam
  overwhelms review; organizers need delegated login (then OAuth).

## Related decisions and references

- ADR 0037 (Agent Content API — the key and guard pattern this follows),
  ADR 0038 (admin role guard), ADR 0033 (content pipeline), ADR 0003 (Cosmos
  serverless), ADR 0019 (single Function App), ADR 0004 (functions
  boundaries).
- Community Days developer API (developers.communitydays.org) — the model for
  the endpoint shape; announcement shared by the owner 2026-11-20.
- Speaker events: `functions/src/lib/admin-identity/speaker-events.js`;
  Sessionize feed: `frontend/src/components/widgets/sessionizeFeed.js`.
