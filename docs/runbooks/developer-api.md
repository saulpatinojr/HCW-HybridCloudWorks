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
| `cfs:manage` | Open and close a call for speakers on the organizer's own events, list the proposals sent to it, and accept or reject them. |
| `events:read` | Nothing yet. Reserved for Phase 2 (reading the organizer's own draft events). |
| `events:write` | Nothing yet. Reserved for Phase 2 (creating events in draft). |

**No key can publish anything.** There is no route that publishes,
unpublishes or schedules an event, and no scope that would add one.
Publishing stays a human action in the admin (ADR 0042, decision 6).

Three things need no key at all, on purpose: reading published events,
finding speakers, and sending a talk proposal to an open call.

## Before the first use: the database container

Calls and proposals are stored in a new Cosmos DB container (a table in the
site's database), `developer_events`, partitioned on `/eventId` (each event's
call and proposals are kept together). It is declared in
[`infra/cosmos-containers.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/feature/developer-api-v1/infra/cosmos-containers.json)
on the `feature/developer-api-v1` branch, and Terraform creates it on the next
apply after this change merges. That apply is the owner's to run. Until the
container exists, the published-events, speakers and key routes work, and the
call-for-speakers routes answer `500`.

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

Good: `status` is `pending` and an `id` comes back. List the proposals:

```powershell
$list = Invoke-RestMethod -Uri "$base/events/$eventId/call-for-speakers/submissions" -Headers $auth; $list.submissions | Select-Object id, status, title, speakerName
```

Accept the newest one (this records a decision for the organizer and makes
nothing public):

```powershell
Invoke-RestMethod -Method Put -Uri "$base/events/$eventId/call-for-speakers/submissions/$($list.submissions[0].id)" -Headers $auth -ContentType 'application/json' -Body '{"decision":"accepted"}' | ConvertTo-Json -Depth 4
```

Close the call when done:

```powershell
Invoke-RestMethod -Method Post -Uri "$base/events/$eventId/call-for-speakers" -Headers $auth -ContentType 'application/json' -Body '{"action":"close"}' | ConvertTo-Json -Depth 4
```

When you finish, drop the variables and close the window:

```powershell
Remove-Variable plain, key, ptr, auth, list
```

## 4. Rotate a key

Rotate when the organizer's handling of the key is in doubt, or on the
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

The calls the organizer owned stay as they were (open calls still take
proposals). To stop a revoked organizer's open call taking proposals, a
super_admin closes it in Cosmos, or a new key is made for that organizer and
used to close it; a close route for the admin is a Phase 2 follow-up.

## Answers and limits

| Answer | Meaning |
| --- | --- |
| `401` | The key is missing, wrong or revoked (one sentence for all three, on purpose). |
| `403` | The key lacks the scope the route needs. On the public proposal route: the request did not come through Cloudflare. |
| `404` | No call on that event for this key, or no open call (proposal route). |
| `409` | The call or proposal changed between reading and writing (read again and retry); or `EVENT_ID_RESERVED` (the id is one of the site's own events) or `KEY_REVOKED` (rotate on a revoked key). |
| `413` | A proposal over 16 KB. |
| `429` | Over a limit; the answer has a `Retry-After` header with the seconds to wait. |

Limits: 120 keyed calls a minute per key; 5 proposals an hour from one
visitor (counted by a salted hash of their address, never the address); 100
proposals an hour per call across all visitors. Proposals are refused unless
the request came through Cloudflare, and a proposal that fills the hidden
`website` field (a trap for bots) is refused.

## Refused calls and the audit log

Every refusal of a key whose id names a real key record (wrong secret,
revoked, over the limit, or missing a scope) writes one row to the `admin_audit_logs` container
with `kind` (and `action`) `developer-api-denial`, the reason and the key's id,
never the key. A request with no key, a value of another shape, or an id that names no
key is refused without a row, so internet probes do not cost a write each.

Every keyed write writes a row too: `developer_cfs_opened`,
`developer_cfs_closed`, `developer_cfs_submission_reviewed` (with the status
only; the proposal's text and the speaker's email stay out of the audit log),
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

## Personal data

A proposal holds the speaker's name, email and bio, typed by that speaker. It
is stored in the `developer_events` container and shown only to the key that
owns the call. It is backed up with the authored data (class A in
`functions/src/lib/backup/export-classification.js`). For an access or erasure
request, search that container for the email as well as the places in the
[data-subject requests runbook](data-subject-requests.md).

## What Phase 2 adds

Not built yet, and tracked as follow-ups to ADR 0042:

- `POST /v1/events` (create an event, in draft), `PUT /v1/events/{id}/program`,
  `POST /v1/events/{id}/sponsors`, `POST /v1/events/{id}/duplicate`, and
  `GET /v1/events/{id}` (public when published, else `events:read`).
- Event records of their own in `developer_events`, so a call can only be
  opened on an event that exists and belongs to the key (today the first
  opener owns the id).
- A human screen in the admin to publish an organizer's draft event, and to
  close or delete a call on the organizer's behalf.
- Accepted speakers joining the public speakers list, if the owner wants that.
