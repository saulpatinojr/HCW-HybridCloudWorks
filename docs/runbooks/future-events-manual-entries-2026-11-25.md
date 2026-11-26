# Future Events: manual entries alongside the Community Days feed

Date: 2026-11-25
Status: Implemented 2026-11-26 (#1898)

## Context

The Speaking hub's "Future Events" tab
([#1823](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1823);
decision record [ADR 0045](../decisions/0045-community-days-events.md)) reads exactly one
route, `cms/community-days/events`, and shows the Community Days developer
API feed of events to apply to.

Manual opportunities that do not come from Community Days are recorded as
speaker events (`speakerevents`) with `status: "idea"` and a `cfpDeadline`.
For example, a made-up entry `example-conf-2027`, "Example Conf 2027"
(2027-08-02; proposals due 2026-12-14; https://example.org/cfp), would be
in `speakerevents` but never appear in Future Events, because the tab only
reads the Community Days feed.

The owner will soon be adding these manual entries from the admin pages. Manual entry is
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
  `idea`). Decided under "What was built": `idea` only; `proposed` stays
  on the Upcoming tab.
- Give manual rows the same treatment as feed rows where it makes sense:
  CFP deadline and days left, clash marks against the owner's own talks
  (applyModel rules), notes, and the estimate button. (Built without the
  estimate: see "Same row treatment" under "What was built" for why.)
- Keep the Community Days read path and its guard patterns
  ([ADR 0033](../decisions/0033-contentforge-alignment.md),
  [ADR 0045](../decisions/0045-community-days-events.md)) intact. Decide server-side merge (extend the
  `cms/community-days/events` response) vs a second client read, following
  the existing one-route pattern in `useApplyEvents.js`; document the choice.
- A manual entry that duplicates a feed event (same name) must not show
  twice. The name rule is `normalizeName` in
  [`frontend/src/lib/speakingEvents.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/lib/speakingEvents.js):
  the one `matchStoredRow` uses to pair a Sessionize event with its stored
  record (called by `mergeEvents` in `eventModel.js`), and the one the
  "you are already speaking here" rule in `applyCalendarModel.js` uses.
- Tests per repo conventions for whatever layer changes; CHANGELOG entry.

## Out of scope

- Any change to the Community Days API client, key handling, or refresh.
- Publishing anything: manual idea entries stay `display: false` on the
  public site.

## Acceptance

- The owner can add a manual opportunity from the admin UI and it appears
  in Future Events next to the Community Days rows.
- An Idea entry with a Dec 14, 2026 proposals deadline (the made-up
  `example-conf-2027` above) appears in Future Events with that deadline
  and its days left.
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

- **Which entries.** Only entries saved with the status **Idea** are listed:
  a stored row with no status is never listed, because it may be a
  Sessionize talk paired by name only, without an id. **Proposed is left out on purpose:**
  a sent proposal is already one of the owner's own talks, and the clash
  rule counts it there (`ownTalks` in `applyModel.js`); listing it here too
  would show it twice and let it clash with itself. It stays on Upcoming.
- **Only events still to come.** An Idea whose last day has passed is left
  out, even though its status still says Idea; one with no date yet stays.
- **Never a Sessionize record.** A stored row that carries a Sessionize id
  is one of the owner's Sessionize talks. While Sessionize cannot be read,
  every stored row reaches the hub's list of manual entries, and one with no
  status of its own would read as an Idea; its Edit would then open the
  manual-entry form, whose save rewrites the record's name and date. So a
  row with a Sessionize id is never listed here.
- **No doubles.** An entry with the same name as a listed or saved Community
  Days event is left out; the directory's row shows it. Names are compared
  with `normalizeName`, the same rule as "you are already speaking here".
- **Same row treatment, where it makes sense.** Dates, days left before the
  call closes, the clash words, the calendar marks, search and the Show
  filter all apply unchanged. A manual idea has no tab status, so like any
  undecided event it says what its dates would meet but never makes a clash.
  Its notes are the entry's own description. It has **no estimate**, because
  the estimate reads the directory's copy of an event's page, and the row
  says so. **Edit** opens the entry's own form (the hub's shared editor) on
  this tab, rather than this tab's status and costs, which are stored per
  directory event.
- **Adding one by hand.** **Add an event**, beside Refresh, opens the same
  form Sources → Manual Entry uses (name, date, location, event URL, CFP
  deadline, description, status and the rest), with the status **Idea** and
  **Show on site off**, so a new idea is not public until the owner ticks it.
  It saves through the existing `upsertSpeakerEvent` write and the row
  appears as soon as the hub re-reads its stored events. No new route or
  role: the same editor role as the rest of the Speaking hub.
- **Order.** Directory rows keep the server's order (soonest first); each
  manual row is slotted in before the first directory row that starts later.
- **Without the Community Days key, or when its read fails,** the tab still
  lists the owner's ideas. The "key is not set" notice and the read's error
  both name the Community Days directory, so neither says there are no
  events at all while the owner's own rows show below them.

Code, in `frontend/src/components/admin/speaking-events/`:
[`manualOpportunities.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/components/admin/speaking-events/manualOpportunities.js)
(which entries, and the order),
[`ManualRows.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/components/admin/speaking-events/ManualRows.jsx)
(the row, Edit and **Add an event**),
[`ApplyRowParts.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/components/admin/speaking-events/ApplyRowParts.jsx)
(the title line and clash words both kinds of row share) and
[`ApplyTab.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/components/admin/speaking-events/ApplyTab.jsx)
(the tab). Tests: `manualOpportunities.test.js`, `ManualRows.test.jsx` and
the "the owner's own ideas" block of `ApplyTab.test.jsx`, which also holds
the acceptance line: the made-up `example-conf-2027` entry shows
next to the directory row with "Closes Dec 14, 2026" and its days left.
