# Future Events: manual entries alongside the Community Days feed

Date: 2026-11-25
Status: spec for implementation (owner request, 2026-11-25; scope updated same day)

## Context

The Speaking hub's "Future Events" tab (#1823, ADR 0045) reads exactly one
route, `cms/community-days/events`, and shows the Community Days developer
API feed of events to apply to.

Manual opportunities that do not come from Community Days are recorded as
speaker events (`speakerevents`) with `status: "idea"` and a `cfpDeadline`.
Example, created 2026-11-25: `vslive-ailive-mshq-2027` — VSLive! & AiLive!
@ Microsoft HQ 2027 (2027-08-02, Redmond, WA; proposals due 2026-12-14;
https://sessionize.com/VSLAILMSHQ27/). It is in `speakerevents` but never
appears in Future Events, because the tab only reads the Community Days feed.

The owner will soon be adding these manual entries himself. Manual entry is
therefore a first-class feature to enable now, alongside the API method —
not just a display concern for entries created through the API.

## Ask

Make manual entries first-class in the Future Events tab, alongside the
Community Days rows, so one list holds every event worth applying to:

- **Create manual entries from the admin UI.** An add/edit affordance
  (placement following existing Speaking hub patterns — in the Future
  Events tab or the hub's event editing flow) that writes through the
  existing `upsertSpeakerEvent` path: name, date, location, event URL,
  CFP deadline, description, status `idea` by default. The owner must be
  able to add an opportunity by hand without touching the API.
- **Show manual entries in the tab.** Include `speakerevents` entries whose
  status marks them as opportunities not yet decided/applied (at minimum
  `idea`; decide whether `proposed` belongs here or stays only in the
  Upcoming tab, and say why).
- Give manual rows the same treatment as feed rows where it makes sense:
  CFP deadline and days left, clash marks against the owner's own talks
  (applyModel rules), notes, and the estimate button.
- Keep the Community Days read path and its guard patterns (ADR 0033,
  ADR 0045) intact. Decide server-side merge (extend the
  `cms/community-days/events` response) vs a second client read, following
  the existing one-route pattern in `useApplyEvents.js`; document the choice.
- A manual entry that duplicates a feed event (same name) must not show
  twice; the existing "you are already speaking here" same-name rule in
  applyModel.js is the precedent.
- Tests per repo conventions for whatever layer changes; CHANGELOG entry.

## Out of scope

- Any change to the Community Days API client, key handling, or refresh.
- Publishing anything: manual idea entries stay `display: false` on the
  public site.

## Acceptance

- The owner can add a manual opportunity from the admin UI and it appears
  in Future Events next to the Community Days rows.
- The existing `vslive-ailive-mshq-2027` entry appears in Future Events
  with its Dec 14, 2026 deadline and days-left.
- Existing tab behavior (notes, estimates, refresh, clash marks) unchanged
  for feed rows; test suites green.

## What was built (2026-11-26)

**The choice: neither a server merge nor a second read.** The Speaking hub
already reads every stored speaker event once for the whole page
(`cms/speakerevents`, in `useSpeakingData.js`) and passes the tab the ones
Sessionize does not list (`rows.manualEntries`). The tab now uses that copy.
So the Community Days route (`cms/community-days/events`) and its guarded
read in `useApplyEvents.js` are unchanged (ADR 0045), no new route or second
fetch was added that would need its own generation guard (ADR 0033 §2), and
a manual entry shows the moment it is saved, because a save already re-reads
the hub's stored events. A server merge would have mixed a second store into
a route that caches and paces an outside service, for no gain.

- **Which entries.** Only status **Idea** (no status counts as Idea until
  its day passes, the hub's usual rule). **Proposed is left out on purpose:**
  a sent proposal is already one of the owner's own talks, and the clash
  rule counts it there (`ownTalks` in `applyModel.js`); listing it here too
  would show it twice and let it clash with itself. It stays on Upcoming.
- **No doubles.** An entry with the same name as a listed or saved Community
  Days event is left out; the directory's row shows it. Names are compared
  with `normalizeName`, the same rule as "you are already speaking here".
- **Same row treatment, where it makes sense.** Dates, days left before the
  call closes, the clash words, the calendar marks, search and the Show
  filter all apply unchanged. A manual idea has no tab status, so like any
  undecided event it says what its dates would meet but never makes a clash.
  Its notes are the entry's own description. It has **no estimate**, because
  the estimate reads the directory's copy of an event's page, and the row
  says so. **Edit** opens the entry's own form on the Speaking hub
  (`/admin/speaking?talk=<id>`), rather than this tab's status and costs,
  which are stored per directory event.
- **Order.** Directory rows keep the server's order (soonest first); each
  manual row is slotted in before the first directory row that starts later.
- **Without the Community Days key** the tab still lists the owner's ideas,
  under the usual "key is not set" notice.

Code: `frontend/src/components/admin/speaking-events/manualOpportunities.js`
(the rules) and `ApplyTab.jsx` (the row). Tests:
`manualOpportunities.test.js` and the "the owner's own ideas" block of
`ApplyTab.test.jsx`.
