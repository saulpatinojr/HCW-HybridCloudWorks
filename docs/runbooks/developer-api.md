# Developer API: organizer keys, calls for speakers, rotate and revoke

The Developer API lets an event organizer run parts of their event from their
own code: read the site's published events, find speakers, open a call for
speakers (CfS: the period when people send talk ideas for an event), take
talk proposals and decide on them. This page is how to give an organizer a
key, prove it works, and take it away again. The reasons behind the design
are in [ADR 0042](../decisions/0042-developer-api.md).

This is Phase 1. The event-management writes (create an event, build its
program, sponsors, copy a past event) are Phase 2 and are not built yet; see
"What Phase 2 adds" at the end.

## What a key can and cannot do

Each organizer gets their **own** key. It starts with `hcdk_`, so it can never
be confused with Koda's key (`hcwk_`, see the
[Agent Content API runbook](agent-content-api.md)). The site keeps only a
fingerprint of it (a SHA-256 hash), so a lost key cannot be shown again; it is
rotated instead.

A key carries one or more **scopes** (switches for what it may do):

| Scope | What it opens today |
| --- | --- |
| `cfs:manage` | Open and close a call for speakers on the organizer's own events, list the proposals sent to it, accept or reject them, and delete one. |
| `events:read` | Nothing yet. Reserved for Phase 2 (reading the organizer's own draft events). |
| `events:write` | Nothing yet. Reserved for Phase 2 (creating events in draft). |

**No key can publish anything.** There is no route that publishes,
unpublishes or schedules an event, and no scope that would add one.
Publishing stays a human action in the admin (ADR 0042, decision 6).

Three things need no key at all, on purpose: reading published events,
finding speakers, and sending a talk proposal to an open call.

## How an organizer connects: from their server, not from a browser

An organizer's code calls the API **from their own server**. A web page on
the organizer's site cannot call it straight from a visitor's browser, and
that is on purpose.

- **Why a browser on another site is refused.** A browser tells the API which
  site the page came from (the `Origin` header). The API answers `403` to any
  `Origin` that is not this site's own (`https://hybridcloudworks.com` and
  `https://www.hybridcloudworks.com`), on every route, the public ones
  included. The list is in
  [`functions/src/lib/auth/cors.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/auth/cors.js)
  and is not widened for organizers: opening it to sites the owner does not
  run would let any page on those sites call the API from a visitor's
  browser. MDN explains the browser rule behind this under
  [Cross-Origin Resource Sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).
  A call from a server sends no `Origin` and is let through to the checks
  below.
- **What the organizer builds.** Their "submit a talk" form posts to their own
  server, and that server sends the proposal on to
  `POST /api/developer/v1/events/{eventId}/call-for-speakers/submissions`
  **with the organizer's key** in the `Authorization: Bearer` header. Part 3
  below has the exact calls.
- **Why the key matters on that call.** Without a key, the API counts
  proposals per visitor address, 5 an hour. Every proposal relayed by the
  organizer's server arrives from that one server's address, so without the
  key a whole event would be held to 5 proposals an hour. A request that
  carries the key that **owns** the call (the key that opened it, with
  `cfs:manage`) is not counted per visitor. It is still held to everything
  else: 100 proposals an hour per call, 120 calls a minute per key, the 16 KB
  size cap, the bot trap, and the call being open.
- **What the key does not buy.** A working key that does not own the call, or
  has no `cfs:manage`, is counted per visitor like anyone else. A key that is
  wrong or revoked gets `401`, so a server holding a dead key finds out
  instead of quietly being limited.
- **The organizer's side of the bargain.** With the key, the organizer's
  server is what stands between the internet and their call, so stopping
  floods from their own form (a limit per visitor, a CAPTCHA) is theirs to
  do. The key must stay on the server and never be put in a web page.

The two public reads (`published-events` and `speakers`) work the same way:
from a server, with or without a key.

## Before the first use: the database container

Calls and proposals are stored in a new Cosmos DB container (a table in the
site's database), `developer_events`, partitioned on `/eventId` (each event's
call and proposals are kept together). It is declared in
[`infra/cosmos-containers.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/cosmos-containers.json),
and Terraform creates it on the next apply. That apply is the owner's to run.
Until the container exists, the published-events, speakers and key routes
work, and the call-for-speakers routes answer `500`.

The plan for that apply should show one thing to add for this feature,
`azurerm_cosmosdb_sql_container.hcw["developer_events"]`. The plan check (the
script that reads each Terraform plan and names anything it was not told to
expect) has that create declared in
[`scripts/assert-expected-plan.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/assert-expected-plan.mjs),
so it reads as expected and not as drift.

To check whether it exists yet (read-only; **PowerShell**):

```powershell
az cosmosdb sql container show -a cosmos-site-prod-cus -g rg-db-site-prod-cus --subscription sub-app-site-prod-cus -d hcw -n developer_events -o json | ConvertFrom-Json | Select-Object name
```

A good result prints `developer_events`. "NotFound" means the apply has not
run yet. The account, group and subscription names are the ones
`infra/variables.tf` and `infra/main.tf` set and the
[deployment runbook](deployment-runbook.md) uses; they were not read from the
live estate when this page was written.

## 1. Make a key for an organizer

You need the `super_admin` role. An editor can see the list but not change it.

1. Open the AI Engine's **Developer API** tab:
   <https://hybridcloudworks.com/admin/ai-engine?tab=developer-api>.
2. On the **Make a key for an organizer** card, fill in the organizer's name
   (it is what the audit log and the list show), optionally a contact (an
   email or a line of text, seen only in the admin), and switch on the
   scopes. For Phase 1 that is `cfs:manage`.
3. Press **Make key**. A box shows the key, starting `hcdk_`. This is the
   only time it is shown. Press **Copy key**.
4. Give it to the organizer through a private channel (a password manager
   share, for example). Never paste it into chat, an email thread, a ticket or
   an issue.
5. Press **I have handed it over, hide the key**. It cannot be shown again.

The same thing through the API is
`POST /api/cms/developer-api/keys` with
`{ "organizerName": "...", "scopes": ["cfs:manage"] }`, signed in as a
super_admin; the tab is that call.

## 2. Check the key works (optional)

These are **PowerShell**. Open a new window for them and close it when you are
done, because a key held as plain text in a running shell cannot be reliably
wiped. The first line asks for the key without echoing it or saving it in your
history.

```powershell
$key = Read-Host 'Paste the organizer key' -AsSecureString; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($key); try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
```

```powershell
Invoke-RestMethod -Uri 'https://api-azure.hybridcloudworks.com/api/developer/v1/status' -Headers @{ Authorization = "Bearer $plain" } | ConvertTo-Json -Depth 4
```

A good result prints `ok: True`, the organizer's name, the scopes and the
limits. With no key, the same address must answer `401`:

```powershell
try { Invoke-RestMethod -Uri 'https://api-azure.hybridcloudworks.com/api/developer/v1/status' } catch { $_.Exception.Response.StatusCode.value__ }
```

Anything other than `401` there means the route is not guarded, which is a
defect to raise at once.

## 3. The call-for-speakers flow, end to end

This is the Phase 1 acceptance test from ADR 0042, and what an organizer's
code does. Same PowerShell window as part 2. The first line asks for the event
id the organizer chose: 3 to 80 lower-case letters, digits or hyphens, for
example `cloud-day-2027`.

```powershell
$eventId = Read-Host 'Event id'; $base = 'https://api-azure.hybridcloudworks.com/api/developer/v1'; $auth = @{ Authorization = "Bearer $plain" }
```

Open a call (the key needs `cfs:manage`). The first key to open a call on an
event id owns that id; any other key gets `404` on it. The ids of the site's
own published events are refused with `409` `EVENT_ID_RESERVED`, so nobody
can collect proposals under one of the owner's events.

```powershell
Invoke-RestMethod -Method Post -Uri "$base/events/$eventId/call-for-speakers" -Headers $auth -ContentType 'application/json' -Body '{"action":"open","title":"Call for speakers"}' | ConvertTo-Json -Depth 4
```

Good: `call.status` is `open` and `call.acceptingProposals` is `True`.
Opening an open call again changes only the fields you send; send
`"closesAt": null` (or `"title": null`) to clear one. Once `closesAt` has
passed, `status` still reads `open` (it is what the organizer set) but
`acceptingProposals` reads `False` and proposals are refused. Send a test
proposal, with no key, as a
speaker would:

```powershell
Invoke-RestMethod -Method Post -Uri "$base/events/$eventId/call-for-speakers/submissions" -ContentType 'application/json' -Body '{"speakerName":"Test Speaker","speakerEmail":"test@example.com","title":"Test talk","abstract":"A test proposal."}' | ConvertTo-Json
```

Good: `status` is `pending` and an `id` comes back. Then send one the way the
organizer's server does, with the key (see "How an organizer connects" above;
this one is not counted against the 5 an hour per visitor):

```powershell
Invoke-RestMethod -Method Post -Uri "$base/events/$eventId/call-for-speakers/submissions" -Headers $auth -ContentType 'application/json' -Body '{"speakerName":"Relay Speaker","speakerEmail":"relay@example.com","title":"Relayed talk","abstract":"A proposal sent on by the organizer server."}' | ConvertTo-Json
```

Good: the same answer, `status` `pending` and an `id`. List the proposals:

```powershell
$list = Invoke-RestMethod -Uri "$base/events/$eventId/call-for-speakers/submissions" -Headers $auth; $list.submissions | Select-Object id, status, title, speakerName
```

The list comes newest first, up to 500 in one answer. A call with more is read
a page at a time: each answer has a `nextCursor` (a marker for where the next
page starts), which is empty on the last page. This line asks for one proposal
per page and shows whether there is more:

```powershell
$page = Invoke-RestMethod -Uri "$base/events/$eventId/call-for-speakers/submissions?limit=1" -Headers $auth; $page | Select-Object count, nextCursor
```

Good: `count` is `1`, and `nextCursor` is a long run of letters because the
second test proposal is still to come. This line reads that next page:

```powershell
$page = Invoke-RestMethod -Uri "$base/events/$eventId/call-for-speakers/submissions?limit=1&cursor=$($page.nextCursor)" -Headers $auth; $page | Select-Object count, nextCursor
```

Good: `count` is `1`, and `nextCursor` is empty because that was the last
page. (The database may now and then hand back one more cursor that leads to
an empty page, `count` `0`; that also means the end.) If you see `400`
instead, the cursor was changed or used with a different
`status` filter; start again without `cursor`.

Accept the newest one (this records a decision for the organizer and makes
nothing public):

```powershell
Invoke-RestMethod -Method Put -Uri "$base/events/$eventId/call-for-speakers/submissions/$($list.submissions[0].id)" -Headers $auth -ContentType 'application/json' -Body '{"decision":"accepted"}' | ConvertTo-Json -Depth 4
```

Delete the other test proposal. **This cannot be undone**: the proposal, with
the speaker's name, email and bio, is removed from the database.

```powershell
Invoke-RestMethod -Method Delete -Uri "$base/events/$eventId/call-for-speakers/submissions/$($list.submissions[1].id)" -Headers $auth | ConvertTo-Json
```

Good: `"ok": true` and `"deleted": true`. Running the same line again answers
`"deleted": false`, which means it was already gone; that is not an error.

Close the call when done:

```powershell
Invoke-RestMethod -Method Post -Uri "$base/events/$eventId/call-for-speakers" -Headers $auth -ContentType 'application/json' -Body '{"action":"close"}' | ConvertTo-Json -Depth 4
```

When you finish, drop the variables and close the window:

```powershell
Remove-Variable plain, key, ptr, auth, list, page
```

## 4. Rotate a key

Rotate when the organizer's handling of the key is in doubt, or every 180 days per the
[credential rotation schedule](../security/credential-rotation-schedule.md).

1. On the tab, press **Rotate key** on the organizer's row and confirm. A new key
   is shown once; the old one stops working on its very next request.
2. Hand the new key over as in part 1, step 4.
3. Hide it.

Rotating keeps the organizer, the scopes, and the calls they own (ownership is
by the key's id, which does not change).

## 5. Change what a key may do

On the organizer's row, change the scopes and save. The change applies to the
key's next call: a route whose scope was removed answers `403` with a sentence
naming the scope. The change is written to the audit log.

## 6. Revoke a key

Press **Revoke key** on the organizer's row and confirm. The stored fingerprint is
deleted, and the key's next request is refused with `401`. There is no cache in
front of the check, so "next request" means the very next one. The row stays
in the list, marked revoked, with who revoked it and when.

A revoked key cannot be rotated back to life (the API answers `409`
`KEY_REVOKED`). To give the organizer access again, press **Make a new key**
on the revoked row: it makes a new key, with a new id, for the same name,
contact and scopes. The new key does not own the old key's calls.

**Revoking a key also stops its calls taking proposals, at once.** A call
belongs to the key that opened it. Each time a proposal arrives, the API checks
that the call's key still works, and when it does not, the proposal is refused
with the same `404` as a closed call. There is nothing to close by hand. The
proposals already sent stay stored, and so does the call's record (it still
says `open`, but nothing can be sent to it).

Nobody holds a key that can list or review those stored proposals any more,
because the new key does not own the old key's calls. If a speaker asks for
theirs to be deleted, use "Delete a speaker's proposals" below, which does not
need the organizer's key. Handing an old call over to a new key is not built;
it is a Phase 2 follow-up.

## Answers and limits

| Answer | Meaning |
| --- | --- |
| `401` | The key is missing, wrong or revoked (one sentence for all three, on purpose). On the public proposal route a key is optional, but one that is sent and is wrong or revoked is still answered `401`. |
| `403` | The key lacks the scope the route needs. On any route: the call came from a browser on another site (see "How an organizer connects"). On the public proposal route: the request did not come through Cloudflare. |
| `400` | Something in the request is not valid; the answer's `error` sentence says what. On the list: a `limit` that is not 1 to 500, or a `cursor` that was changed, was made for a different `status` filter, or is too old. |
| `404` | No call on that event for this key, or no open call (proposal route). A call whose key was revoked answers this too. |
| `409` | The call or proposal changed between reading and writing (read again and retry); or `EVENT_ID_RESERVED` (the id is one of the site's own events) or `KEY_REVOKED` (rotate on a revoked key). |
| `413` | A proposal over 16 KB. Refused from the size the request declares where it declares one, before the body is read, and measured again once read. |
| `429` | Over a limit; the answer has a `Retry-After` header with the seconds to wait. |

Limits: 120 keyed calls a minute per key; 5 proposals an hour from one
visitor (counted by a salted hash of their address, never the address); 100
proposals an hour per call across all visitors. The per-visitor limit is not
applied to a proposal sent with the key that owns the call (the organizer's
server relaying its own form); every other limit still is. Proposals are
refused unless the request came through Cloudflare, and a proposal that fills
the hidden `website` field (a trap for bots) is refused. One list answer
carries at most 500 proposals; `limit` asks for fewer and `nextCursor` reads
on (part 3).

## Refused calls and the audit log

Every refusal of a key whose id names a real key record (wrong secret,
revoked, over the limit, or missing a scope) writes one row to the `admin_audit_logs` container
with `kind` (and `action`) `developer-api-denial`, the reason and the key's id,
never the key. A request with no key, a value of another shape, or an id that names no
key is refused without a row, so internet probes do not cost a write each.

Refusals for a wrong secret, a revoked key or a key over its limit are capped
at **10 rows a minute for each key id**. A key's id is the first part of the
key and is not secret, so without the cap anyone who had seen one could fill
the audit log by sending wrong keys. Past the cap the request is still
refused, with the same answer, and no row is written until the next minute,
with one exception: the first refusal past the cap writes a single row with
`kind` (and `action`) `developer_api_refusal_cap_reached` and the key's id.
So ten `developer-api-denial` rows for one key in the same minute, followed
by that row, means "ten or more", and the refusals after the tenth could be
of any of the three kinds: someone sending wrong keys under a known id can
use up the minute's rows, and a revoked key or a key over its limit in the
same minute then leaves no row of its own. The `developer_api_refusal_cap_reached`
row is how you know that happened. The organizer's own working key is not
slowed by this.

Every keyed write writes a row too: `developer_cfs_opened`,
`developer_cfs_closed`, `developer_cfs_submission_reviewed` and
`developer_cfs_submission_deleted` (with the status only; the proposal's text
and the speaker's email stay out of the audit log), `developer_cfs_submission_erased`
when the owner deletes one from the admin (the event and the status only),
`developer_cfs_proposal_search` when the owner searches for a speaker's
proposals from the admin (the number found and whether the list was cut
short; never the address searched for, see
[Delete a speaker's proposals](#delete-a-speakers-proposals-an-erasure-request)),
and for keys `developer_api_key_generated`, `_rotated`, `_changed`, `_revoked`
(with the key's hint, never its value).

## If spam proposals arrive

1. Close the call (part 3, the last command). Proposals stop at once.
2. If the spam came through one organizer's key being misused, revoke it
   (part 6).
3. Raise an issue with the time window so the limits can be reviewed (ADR
   0042's "revisit if CfS spam overwhelms review").

## Accepted risks in Phase 1

- **The first key to open a call on an id owns it.** One organizer can take an
  id another meant to use. Organizers are people the owner gave a key to, and
  the loser simply picks another id. Phase 2 ties a call to an event record
  the key made.
- **The per-call cap can be filled.** 100 proposals an hour per call is
  shared by every visitor, so about twenty different addresses could fill it
  and hold the call shut for the rest of the hour. ADR 0042 accepts spam as
  a risk; if it happens, see "If spam proposals arrive" above.
- **No browser on another site can call the API.** An organizer cannot put a
  form on their site that posts straight to the API; they need a server of
  their own to send proposals on. That is more work for the organizer, and
  it is accepted so the list of sites allowed to call the API from a browser
  stays the site's own two addresses ("How an organizer connects" above).
- **The owning key takes the per-visitor limit off its own call.** A leaked
  key, or an organizer's form with no limit of its own, can put up to 100
  proposals an hour on that organizer's call, where a keyless sender is held
  to 5. It reaches no other call, the per-call cap still holds, and rotating
  or revoking the key (parts 4 and 6) ends it on the next request.

- **A refusal takes longer when the key id is real.** A wrong, missing or
  revoked key gets the same `401` and the same sentence, so the answer itself
  does not say whether a key id exists. The time it takes is not made equal:
  a refusal on a real id also waits for its counter and its audit row. So
  someone measuring response times could tell a real id from a made-up one.
  That is accepted: a key id is 64 random bits, cannot be guessed in
  practice, and is not treated as a secret (it is the first part of the key
  and is written to the audit log).
- **One caller can use up a key id's audit rows for the minute.** See
  "Refused calls and the audit log" above: past ten refusals a minute only
  the single "cap reached" row is written.

## Personal data

A proposal holds the speaker's name, email and bio, typed by that speaker. It
is stored in the `developer_events` container and shown only to the key that
owns the call. It is backed up with the authored data (class A in
`functions/src/lib/backup/export-classification.js`).

An accepted proposal is kept until someone deletes it. A proposal that was
not accepted is cleaned up after its yearly cycle, once that clean-up is
switched on (the next section).

## The yearly clean-up of proposals

Owner decision 2026-11-24, on
[#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777):
"the yearly cycle ends in December... If a proposal is not accepted, strip
it," with "the previous year an extra month to complete applications".

**Status: switched on.** The owner armed it on 2026-11-25, on
[#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777),
without waiting for the first dry-run count. The reason given: proposals were
added to the site only days earlier, so every call closes in 2026 or later,
no cycle is over before 1 February 2027, and nothing is due until then. The
switch is live once the owner has confirmed the Terraform run for the arming
pull request. The steps under "Switching it on" below are kept for the
record and for switching it off and on again. One thing that reasoning does
not cover: a call whose close day was typed as a date in 2025 or earlier is
already past its clean-up day, and its proposals that were not accepted are
stripped at the first run.

**The rule.**

- The cycle is the calendar year. A year's clean-up is due on **1 February of
  the next year**: the year ends on 31 December and January is left alone.
  Times are UTC.
- A proposal belongs to the year its call closed in (the day the organizer
  closed it, or the call's deadline once that has passed). While a call is
  still open, none of its proposals is touched, however old: they wait until
  the call closes or its deadline passes, so a proposal still being judged
  keeps its speaker's details. (A call with no close day that is no longer
  open goes by the year each proposal was sent in.) To let an open-ended
  call's proposals be cleaned up, close the call.
- When the clean-up is due, a proposal that was **not accepted** (status
  `pending` or `rejected`; one nobody reviewed counts) is **stripped**: the
  speaker's name, email and bio and the organizer's review note are removed
  for good. The talk's title, abstract, format, level, status and dates
  stay, and the record gets a `strippedAt` date.
- An **accepted** proposal is never stripped. It keeps the speaker's details
  until the organizer or the owner deletes it (the section after this one).
- A stripped proposal still shows in the organizer's list, with `null` in the
  four removed fields and the date in `strippedAt`. Its decision can no
  longer be changed (`409`, code `PROPOSAL_STRIPPED`); it can be deleted.
- The **Erase a speaker's proposals** card no longer finds a stripped
  proposal, because the address is not on it any more. That is correct:
  nothing of the speaker is left on it to erase.

**How it runs.** It is the second step of the daily clean-up timer
`cleanupRejectedContent` (04:00 UTC), which is already on. The code is
[`proposal-strip.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/timers/proposal-strip.js).
It takes effect at the first run of the
[Deploy Functions workflow](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-functions.yml)
after the merge.

**It ships switched off (a dry run).** A dry run counts what it would strip
and changes nothing. Each day it writes one row to the audit log (the
`admin_audit_logs` container), with the action
`cron_stripped_unaccepted_proposals` and these numbers and no names,
addresses or ids. The newest row is what the card **Yearly clean-up of
proposals** shows on
<https://hybridcloudworks.com/admin/ai-engine?tab=developer-api>:

| Field | Meaning |
| --- | --- |
| `dryRun` | `true` while switched off |
| `cycleYear` | The newest year whose clean-up is due |
| `callsExamined` | How many calls for speakers were read |
| `eligibleCount` | How many proposals are due to be stripped |
| `strippedCount` | How many were stripped (always 0 in a dry run) |
| `skippedCount` | Found due, then deleted or accepted before the write |
| `racedCount`, `failedCount` | Changed twice during the write, or the write failed; tried again the next day |
| `hasMore` | `true` when a later run has work left (one run strips at most 500) |

### Switch the clean-up on

**Step 3 starts something that cannot be undone.** Once it is on, the next
04:00 UTC run removes the speaker's name, email and bio and the review note
from every proposal that is due. The database's own backup can bring a record
back for 30 days; after that nothing can.

1. Read a dry-run count. Open
   <https://hybridcloudworks.com/admin/ai-engine?tab=developer-api> and
   scroll to the card **Yearly clean-up of proposals**. You should see
   "Switched off (dry run)" and a sentence such as "The last run, (date),
   changed nothing. Switched on, it would have stripped 0 proposals for
   cycles up to 2025." If it says "No run recorded yet" a day after the
   functions were deployed, the timer is not running: say so on
   [#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777)
   and stop.
2. Decide whether that number is what you expect. Before 1 February 2027 it
   should be `0` unless a call closed in 2025 or earlier, because the 2026
   cycle is not over yet.
3. Reply **"arm the proposal clean-up"** on
   [#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777).
   A session then opens a one-line pull request that changes
   `"PROPOSAL_STRIP_ENABLED" = "false"` to `"true"` in
   [`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf)
   and merges it.
4. Confirm the Terraform run that merge starts, in the
   [`hcw-azure` workspace](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs).
   You should see one change: the Function App's setting
   `PROPOSAL_STRIP_ENABLED` going from `false` to `true`. If the plan shows
   anything else, do not confirm it; say what it shows on the issue.
5. The day after, open the same card again. It should say "Switched on" and
   that the last run stripped the number of proposals you read in step 1 (or
   500, with "There is more to do", if there were more).

**To switch it off again**, the same pull request in reverse (`"true"` back
to `"false"`) and its Terraform run. That stops further stripping; it does
not bring back what was already removed.

## Delete a speaker's proposals (an erasure request)

An erasure request is a person asking for their personal data to be deleted,
which privacy law (GDPR Article 17, for example) gives them the right to do.
For a speaker, that means every talk proposal sent from their email address.
The other places a person's data can be are in the
[data-subject requests runbook](data-subject-requests.md); this section covers
proposals only. Check the request really comes from that address first (that
runbook, section 2).

There are two ways. Use the first unless the organizer is doing it themselves.

### From the admin (the owner, any organizer's call)

**Step 3 cannot be undone.** A deleted proposal is gone from the database and
from the organizer's list.

1. Open the Developer API tab:
   <https://hybridcloudworks.com/admin/ai-engine?tab=developer-api>. Scroll to
   the last card, **Erase a speaker's proposals**. You need the super_admin
   role; without it the buttons are greyed out and say so.
2. Type the speaker's email address and press **Find proposals**. You should
   see one line per proposal, with the event's id, its status and the date it
   was sent, or "No proposals are stored for that address." If you see a red
   sentence instead, it says what is wrong with the address.
3. Press **Delete** on a line, then **Delete proposal** in the box that asks
   you to confirm. You should see a "Proposal deleted" note and the line
   disappears. Repeat for each line. If you see "Nothing was deleted", press
   **Find proposals** again and retry; the proposal changed while it was
   being deleted. If the note says the record "is malformed: it has no event
   id", the row was edited by hand in the database and cannot be deleted
   from this page: it has to be removed by hand in the `developer_events`
   container (the route answers `409` with the code `MALFORMED_RECORD`).
4. Press **Find proposals** once more. You should see "No proposals are
   stored for that address." That is the proof the request is done.

Each delete writes one row to the audit log, `developer_cfs_submission_erased`,
with the proposal's id, the event's id and its status. The speaker's address
and what they wrote are not in the row.

Each search writes one row too, `developer_cfs_proposal_search` (owner
decision 2026-11-23), so there is a record of who looked a person up. The row
says who searched (the signed-in admin, as on every admin row), when, how many
proposals were found (`details.count`) and whether the list was cut short at
200 (`details.truncated`). It does not hold the address that was searched for,
any part of it or a hash of it (a hash is a scrambled form of a value, and one
made from an email address can be guessed back), and it does not hold the
proposals' ids. So the audit log can show that a search happened, not whom it
was for; keep the speaker's request itself as the record of that. A search
that is refused before it runs (no super_admin role, or an address that is not
an email address) writes no row. If the row cannot be written, the search
still answers and the function log gets the line
`[developer-api] audit row developer_cfs_proposal_search failed`; the same is
true of every row in this section.

### With the organizer's key (their own call only)

The organizer who owns the call can delete a proposal from their own code.
This is the same PowerShell window as part 3, with `$base`, `$auth` and
`$eventId` already set. The first line asks for the speaker's address and
lists their proposals on this event; the second deletes them. **The second
line cannot be undone.**

```powershell
$speaker = (Read-Host 'Speaker email').Trim().ToLower(); $mine = (Invoke-RestMethod -Uri "$base/events/$eventId/call-for-speakers/submissions" -Headers $auth).submissions | Where-Object { $_.speakerEmail -eq $speaker }; $mine | Select-Object id, status, title
```

```powershell
$mine | ForEach-Object { Invoke-RestMethod -Method Delete -Uri "$base/events/$eventId/call-for-speakers/submissions/$($_.id)" -Headers $auth } | Select-Object id, deleted
```

Good: one line per proposal with `deleted` `True`. Running the first line
again should then list nothing. `deleted` `False` means that proposal was
already gone. A `404` means the key does not own a call on that event. On a
call with more than 500 proposals the first line reads only the newest 500;
use the admin card instead, which searches every call.

Each delete writes one audit row, `developer_cfs_submission_deleted`, with the
status only.

### What a delete does not reach

The backups. The nightly copy of the database is kept for 35 days and the
database's own backup for 30; neither is edited, and the proposal leaves each
when that copy expires. The same is true of a proposal the yearly clean-up
stripped: the copies hold it unstripped until they expire. The data-subject requests
runbook has the sentence to tell the speaker
([step 4 there](data-subject-requests.md#step-4-immutable-backup-lifecycle-disclosure)).

## What Phase 2 adds

Not built yet, and tracked as follow-ups to ADR 0042:

- `POST /v1/events` (create an event, in draft), `PUT /v1/events/{id}/program`,
  `POST /v1/events/{id}/sponsors`, `POST /v1/events/{id}/duplicate`, and
  `GET /v1/events/{id}` (public when published, else `events:read`).
- Event records of their own in `developer_events`, so a call can only be
  opened on an event that exists and belongs to the key (today the first
  opener owns the id).
- A human screen in the admin to publish an organizer's draft event, and to
  close, delete or hand over a call on the organizer's behalf. (Since #1777 a
  revoked key's call already takes no proposals, and the owner can delete a
  speaker's proposals from the admin.)
- Accepted speakers joining the public speakers list, if the owner wants that.
