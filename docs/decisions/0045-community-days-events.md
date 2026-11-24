# ADR 0045: The Speaking hub lists events to apply to from Community Days, read-only, with an on-demand acceptance estimate

**Status:** Accepted (owner request of 2026-11-24 on
[#1823](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1823);
the three defaults in that issue's design note are built as recommended, and
the owner changes one by saying so there)
**Decision date:** 2026-11-24
**Owners:** Workload owner and architecture owner

## Context

The owner speaks at community conferences and wanted one page that lists
events currently taking talk proposals, with a rough chance of acceptance,
the place, the dates on a small calendar that shows clashes with talks
already sent or accepted, costs and notes.

[Community Days](https://www.communitydays.org) is a public directory of such
events and has an API (a set of web addresses a program can call), described
in two public files: an
[OpenAPI description](https://api.communitydays.org/v1/openapi-events.json)
and a [field list](https://api.communitydays.org/v1/fields.md). The API signs
callers in with one kind of credential: a key sent as a Bearer header.

Three facts about that API shape this decision:

- **The key is not read-only.** The same key can create, change and delete
  the key owner's events, speaker profile and organization. The documentation
  shows no narrower key.
- It offers nothing about the chance of acceptance and nothing about travel
  cost. Those have to come from the owner or from the site.
- API access must be approved by the vendor first, the documentation states
  no price and no request limit, and it says a key can expire but not when.

The Speaking hub already has a tab called **Upcoming**, which means the
owner's own sessions.

## Purpose and decision drivers

- Give the owner the list without giving the site, or anyone who breaks into
  it, a way to change the owner's events (Security).
- Spend nothing on a model unless the owner asks (Cost Optimization).
- Keep working when the vendor is slow, limits requests, or has not approved
  access yet (Reliability).
- Add no new database container and one Terraform line (Operational
  Excellence).

## Decision

1. **A new tab on the Speaking hub, "Future Events"** (`?tab=apply`),
   named apart from Upcoming. The browser calls the site's own API only.
2. **The server makes two calls to Community Days, both `GET`, and nothing
   else:** `/published-events?call_for_speakers=true` and `/profile/talks`.
   The host is written in one source file of constants
   (`functions/src/lib/community-days/api.js`), every request goes through
   one function that sends `GET` and refuses any other path
   (`client.js`), and `only-read-calls.test.js` reads the source and fails if
   another method, path or caller appears. Redirects are refused, so the key
   is never sent on to another address.
3. **The key is a Key Vault secret**, `COMMUNITY-DAYS-API-KEY`, referenced by
   one new app setting and pasted by the owner on the Keys tab. It never
   reaches a browser, a log or an answer. A stored secret is used because the
   vendor offers no keyless sign-in.
4. **Everything works without the key.** The tab says the key is not set and
   calls nothing; the card's Test says "No key yet".
5. **The site keeps its own copy of the list** in one `admin_config`
   document, read again when it is six hours old or on Refresh (at most once
   a minute), never within five minutes of a failed read, and never before a
   "too many requests" answer's wait has passed. The whole filtered list is
   read each time. The API's `updated_since` is not used: an event leaves an
   "open now" list when its closing day passes, without being edited, so a
   "what changed" answer cannot say which events dropped out.
6. **The owner's record is one small `admin_config` document per event**,
   keyed by the API's event id: a status, three cost figures with no
   currency, notes, the saved estimate, and a small copy of the event so the
   record still means something after the event leaves the list. Each write
   is made under the version (ETag) it was decided from; a lost race is a 409
   and the page reads again.
7. **The acceptance estimate is made only when its button is pressed**, one
   event per press, through the site's existing model router under a new
   feature switch (`speakingEstimate`). No provider or key is added. The
   event's text goes inside a prompt fence as data, with every run of three
   or more angle brackets in it cut to two so it cannot write a fence marker
   (the shared helper alone could be made to build one; changed after an
   independent review of the pull request); the answer is checked,
   held to 0 to 100, cut to three plain-text reasons, and labelled a rough
   estimate wherever it shows.
8. **The owner's talk topics come from data the site already has**: Speaking
   hub topics and session titles, the speaker profile's bio, and the talk
   titles Community Days lists. No new setting.
9. **Days are compared as calendar days** in each event's own local time. A
   clash is two things the owner cares about on one day: the owner's own
   sent or accepted talks, and events the owner marked Interested, Applied or
   Accepted. An event with no status never makes a clash (its row says in
   plain words what its dates would meet, and it is a faint mark on the
   calendar); events marked Not going or Declined, and cancelled and
   postponed events, clash with nothing and are left off the calendar. The
   first version flagged any listed event against a talk, which with
   hundreds of listed events marked almost every busy day (changed after an
   independent review of the pull request).

## Consequences and accepted risks

- **The key in the vault can do more than the site does.** Someone who
  obtained it could change or delete the owner's events at the vendor. This
  is accepted because the vendor offers nothing narrower; it is reduced by
  Key Vault storage, server-only use, the read-only test, a 180-day rotation
  reminder, and a runbook that says to delete the old key the day it is
  replaced.
- **The estimate is a guess.** It knows only the event's public page and the
  owner's topics. It is useful for sorting; the page says it is not a
  measurement.
- **The event's page is third-party text in a prompt.** The fence, the
  length cut and the output check keep a hostile page from changing the
  instructions or the stored result beyond a number between 0 and 100.
- **Several assumptions about the API are untested** until the owner has a
  key; the runbook lists them.
- **The owner's own talks carry one day each**, so a clash with a multi-day
  commitment the hub stores as a single day can be missed.
- **One Terraform change**: one added app setting on the Function App.
  Applying it before the secret exists is safe.
- A read of the list is at most seven requests; a vendor that became slow
  could make the tab's first load take up to a minute.

## Alternatives considered

- **Call Community Days from the browser.** Refused: the key would reach the
  browser, and this key can change the owner's events.
- **Fixed rules for the estimate** (topic words, place, past acceptances).
  Not chosen: the site has no history of acceptances at these events, and
  word matching on a page of prose would look more exact than it is. A model
  call on demand was the issue's recommendation.
- **Estimate every event automatically on refresh.** Refused: it spends
  money without a click, on events the owner may never look at.
- **A new database container for the notes.** Not needed: the documents are
  few and small, and `admin_config` already holds the other admin pages'
  owner-entered data (the Cost page's ledger, ADR 0039) with the same
  version-guarded writes.
- **One document holding every note.** Not chosen: a per-event document
  keeps a save on one event from conflicting with a save on another.
- **The API's `updated_since` for the cache.** See decision 5.
- **Storing the notes on `speakerevents`.** Refused: that container is
  published to the public site, and these are other people's events the
  owner has not committed to.

## Validation and revisit triggers

Validated by the tests beside each module (the client's allowed calls, the
cache's timing, the notes' guarded writes, the estimate's fence and output
check, the page's clash rules as pure functions) and, once the owner has a
key, by the card's Test and one Refresh.

Revisit when: the vendor offers a read-only key (switch to it); the vendor
publishes a price or a request limit; an assumption in the runbook proves
wrong; the owner wants the estimate based on recorded outcomes; or the hub
starts storing a range of days for the owner's own talks.

## Related decisions and references

- [ADR 0033](0033-contentforge-alignment.md): the admin hubs' shared read and
  write guards the tab follows.
- [ADR 0034](0034-ai-model-selection.md): the task registry the estimate's
  feature switch joins.
- [ADR 0039](0039-cost-page.md): owner-entered data in `admin_config`.
- [Runbook](../runbooks/community-days-events.md): what the tab shows, the
  key, and each error.
- The API's [OpenAPI description](https://api.communitydays.org/v1/openapi-events.json)
  and [field list](https://api.communitydays.org/v1/fields.md), read
  2026-11-24.
