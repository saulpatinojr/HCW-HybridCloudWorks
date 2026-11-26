# Agent Content API: connect Koda, check it, rotate and revoke

Koda is the owner's content agent, run by the Muse service. It drafts and
reviews posts for the series by calling the site's Agent Content API with one
key. This page is how to make that key, connect Muse, prove it works, and take
it away again. The reasons behind the design are in
[ADR 0037](../decisions/0037-agent-content-api.md).

Everything here happens on the Agents page's **Koda** tab:
<https://hybridcloudworks.com/admin/agents?tab=koda>. (Until 2026-11-26 the
key tabs were on the AI Engine page; the old links still land here.) You need the
`super_admin` role to make, change or revoke the key; an editor can see the
tab but the buttons say they are not theirs.

What the key can do, in plain words: everything the Drafts page can do (list,
read, create, edit, send to review, pull back a draft) and read the
published articles the public site shows. It cannot publish, unpublish, change
a setting, read a secret or touch anything live. Each of those four groups is a
switch on the tab, so any of them can be turned off without touching the key.

Until a key exists, every call to the API is refused and nothing is on.

## 1. Make the key and connect Muse

1. Open <https://hybridcloudworks.com/admin/agents?tab=koda>. The first
   card says **No key yet**.
2. Press **Generate key**. An amber box appears with the key, beginning
   `hcwk_`. This is the only time it is shown. Press **Copy key**.
3. In Muse, add a custom connector. There is no public address for that
   form: Muse opens it from its own custom-connector flow, which generates a
   connect link for you (the proposal of 2026-10-31 describes it that way),
   so start it from inside Muse. The **Connect Muse to the site** card on the
   tab lists every value the form asks for; the ones that matter are:
   - Provider host: `api-azure.hybridcloudworks.com`
   - Base URL: `https://api-azure.hybridcloudworks.com/api/agent-content/v1`
   - Authentication: API key. The site reads it from the `Authorization`
     header as `Bearer <key>` or as the bare key, or from an `X-API-Key`
     (or `X-Agent-Key`) header, so whichever shape the connector form
     offers works. It never reads a key from the address.
4. Paste the key into Muse's secure field. Never paste it into chat, a note
   or a ticket.
5. Back on the tab, press **I have pasted it, hide the key**. The box closes
   and the key cannot be shown again.
6. Let Muse make its first call, `GET …/agent-content/v1/status`. A good
   answer is `200` with `"agent": "koda"` and a `capabilities` list.
   - `401` means the key was pasted wrong or has been revoked. Rotate it
     (part 3) and paste the new one.
   - `403` means the switch for that call is off on the tab.
   - `429` means more than 120 calls in a minute; the answer carries a
     `Retry-After` header with the seconds to wait.
7. The `200` answer in step 6 is the proof the connection works end-to-end.
   The card's **Last used** is a best-effort stamp, written at most once
   every five minutes, and the tab does not refresh itself: reload the page
   a few minutes after the call to see it move.

If Muse will not accept `api-azure.hybridcloudworks.com` as the host and
insists on `hybridcloudworks.com`, stop here and say so: the API does not
answer on the apex host today, and putting it there is a Cloudflare change
recorded as an open point in the ADR, not a setting on this tab.

## 2. Check it from your own machine (optional)

These prove the same thing without Muse. All are **PowerShell**; open a new
PowerShell window for them and close it when you are done, because a
plaintext string in a running shell cannot be reliably wiped. The first line
asks for the key and keeps it out of your shell history; it is never printed,
and the unmanaged copy it decodes from is zeroed and freed straight away.

```powershell
$key = Read-Host 'Paste the Koda key' -AsSecureString; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($key); try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($ptr) }
```

```powershell
Invoke-RestMethod -Uri 'https://api-azure.hybridcloudworks.com/api/agent-content/v1/status' -Headers @{ Authorization = "Bearer $plain" } | ConvertTo-Json -Depth 4
```

A good result prints `ok: True`, `agent: koda`, the capabilities that are on,
and the limits. Then, with no key at all:

```powershell
try { Invoke-RestMethod -Uri 'https://api-azure.hybridcloudworks.com/api/agent-content/v1/status' } catch { $_.Exception.Response.StatusCode.value__ }
```

A good result prints `401`. Anything else means the API is not guarding the
route, which would be a defect to raise at once.

When you are done, drop the variables and close the window:

```powershell
Remove-Variable plain, key, ptr
```

## 3. Rotate the key

Rotate when Muse's handling of the key is in doubt, when someone who could
see the screen during step 2 of part 1 should not have, or on the schedule in
the [credential rotation schedule](../security/credential-rotation-schedule.md).

1. On the tab, press **Rotate key** and confirm. A new key is shown once; the
   old one stops working on its very next request. Copy the new key.
2. In Muse, open the connector and replace the key in its secure field.
3. Press **I have pasted it, hide the key** on the tab.
4. Have Muse call `status` again; **Last used** moves. Until it does, Koda is
   getting `401` and is not working.

Rotating keeps the switches as they were and the record of who first made
the key.

## 4. Switch off part of what Koda may do

On the **What Koda may do** card, turn a switch off. The change applies to
Koda's next call: any endpoint in that group answers `403` with a sentence
naming the switch. Turn it back on the same way. Both are written to the
audit log. The first four switches are the agent API's own; the five below
them (Pipeline, Enhanced, Second Brain, Spotlight, Platform) are the admin
sections of part 7, and turning one off closes every admin route under it.
The image upload route is listed under Pipeline and Spotlight both, but which
switch opens it depends on the storage container asked for: article images
(`content`, `blogs`, `covers`) follow Pipeline, certification and speaker-event
images follow Spotlight, and any other container answers `403`. There is no
delete switch: the key has no delete route at all.

The [Health page](https://hybridcloudworks.com/admin/health) shows the same key
on its **Content agent (Koda)** card: whether a key exists and is active, when
it was last used and rotated, which switches are off, and the refusals of the
last day by reason. That count is of logged refusals only: the content-free
audit rows the API writes when a call presented a value shaped like a site key
and was refused. A call with no key, or with a value of another shape, is
refused without a row (see "Refused calls" below), so a zero on the card does
not mean no call was refused. The card says when it could not look (the key record or the audit
rows could not be read) instead of showing "none" or a zero. The **Content
agent** probe on its Checks tab gives the same verdict, and the five-minute
pulse records it. The card counts refusals through the two fields the audit
container indexes (`action` and `timestamp`, written on every denial row since
this card existed), so refusals logged before that change are not in its
count; the rows themselves are unchanged and still carry `kind` and `at`.

## 5. Revoke the key

1. Press **Revoke key** and confirm. Koda's next request is refused with
   `401`. Nothing Koda already wrote is changed; its drafts stay on the
   Drafts page.
2. To reconnect later, press **Generate key** and follow part 1 again.

## 6. Where to look when something is wrong

- **The Drafts page** (<https://hybridcloudworks.com/admin/drafts>): drafts
  Koda wrote show `koda (agent)` as their author.
- **Refused calls:** every call that presented a value shaped like a site
  key (`hcwk_` followed by 40 to 64 letters, digits, `-` or `_`) and was
  refused is a row in the `admin_audit_logs` container with
  `kind: "agent-content-denial"` (also written as `action`, the field the
  container indexes, with the time as both `at` and `timestamp`) and a
  `reason` (`no-key`, `wrong-key`,
  `revoked-key`, `capability-off`, `rate-limited`). A call with no key, or
  with a value of any other shape in those headers (`hcwk_bad` included), is
  refused without a row, so internet scanners do not fill the log. The key
  itself is never in a row. Many 401s with no rows means the site never saw a
  value shaped like a key: the connector sends it somewhere the site does not
  read (the address, or a header other than `Authorization`, `X-API-Key` and
  `X-Agent-Key`), or the value in the header is not the whole key (cut short,
  or wrapped in quotes), or a non-empty `Authorization` holds something else
  (a stale token, for example), which is read instead of a good `X-API-Key`
  beside it. Check the header name and the value before moving or rotating
  the key. Part 2's command sends the value you paste at its prompt as
  `Authorization: Bearer`, so a `200` there proves that pasted value is the
  current key. It does not prove Muse holds the same value or sends it the
  same way, so compare Muse's header name and value with it next; the
  command cannot show what Muse sent.
- **Key events:** rows with `action` `agent_content_key_generated`,
  `agent_content_key_rotated`, `agent_content_capabilities_changed` or
  `agent_content_key_revoked`, each with the key's first characters and who
  did it.
- **The contract:** every route and what it answers is in
  `.azure/api-surface.json`, sections `agentContentApi` and
  `adminAgentContent`.

## 7. What Koda may do in the admin

Since 2026-11-01 ([ADR 0038](../decisions/0038-koda-admin-access.md)) the same
key also works on the admin routes under `/api/` that the five section
switches open. Koda calls them exactly as the admin pages do, with the key in
place of a sign-in, and the site treats it as `koda (agent)` with an editor's
rights (a publisher's in the Doc Vault, and as you in the Second Brain). The
rules that hold on every one of them:

- **Nothing can be deleted.** A `DELETE` is refused everywhere (the agent
  API's own draft delete is gone too), and the routes that delete or trash by
  `POST` are not open.
- **Nothing can be published, scheduled or unpublished.** Those routes are not
  open, nor are the routes that unpublish as a side effect (request
  inspection, reset review state, the Listen & Learn episode review). The
  routes that could reach publishing through their body are limited: a status
  change may go to `approved`, `editing`, `forge_ready` or `rejected`; a job
  may be `forge-article`, `forge-from-url`, `batch-inspect`,
  `sync-blog-source` or `generate-listen-and-learn`; a new content item may
  not be created already `published` (or one of the older `published_blog`,
  `published_news`, `published_both` spellings) or `archived`; a book or
  chapter may be restored but not archived.
- **No secret or credential can be read, and no setting can be changed**
  (settings are read-only: where the editor needs them, and Platform
  Settings since 2026-11-10), and no section the owner did not name is open:
  Forge Studio, AI Engine, Image Prompts, the Amplify section, admins and the
  lab agent registry answer `403`.
- **Every refusal is logged**: an `admin_audit_logs` row of kind
  `agent-content-denial` with `surface: "admin"`, the method, the route as
  the list spells it (`cms/drafts/{id}`, never the id itself; `unlisted` for
  a route not on the list) and a reason (`route-not-allowed`, `section-off`,
  `role`, `body-not-allowed`, `body-unreadable`, `user-only-route`, or the
  key's own `wrong-key`, `revoked-key`, `rate-limited`), never the key or
  the body.

The full list, as the API reports it, is on the tab under **What Koda may do
in the admin** and in `GET …/agent-content/v1/status` as `adminAccess`. In
short, by switch:

| Switch | Pages | Koda may | Koda may not |
|---|---|---|---|
| Pipeline | New Content, Drafts, Review Queue, Editor, Live Pages | List and read content, versions and drafts; create and edit drafts and articles; save the editor; reorder images; move content between review states; generate article drafts, hero and preview images and captions; enqueue the producing jobs and read job state; read the queue, publish board, decision centre and dashboard; read settings, taxonomy and the image gallery; upload images | Publish, schedule, unpublish, set a slug, rehost images, delete anything |
| Enhanced | Listen & Learn, Labs, Frameworks, Coder Corner, Blogs | Read, create and edit Listen & Learn books and chapters, estimate and regenerate, restore an archived book or chapter; read the lab estate, a lab job, the starts and the Coder automation; read, create and edit blog sources (Frameworks and Coder Corner are content, so the Pipeline rows cover them) | Archive or delete books, chapters or versions; publish or withdraw an episode; launch or cancel lab jobs; change lab agents; read the Coder token; delete a blog |
| Second Brain | Second Brain | Read status, notes, history, graph and context; search and ask; create and edit notes and collections; draft from a note, acting as you | Reindex; the desktop sync routes |
| Spotlight | Speaking, Certifications, Ambassador, Doc Vault | Read talks and upsert one; read, create and edit certifications; read, create and edit applications and evidence, import evidence, read sources, files, programs and readiness; in the Doc Vault read, create, upload, edit, untrash and restore a version | Delete a talk, a certification, an application, evidence or a document; create or edit a program |
| Platform | Health, Integrations, Cost, Search Console, Platform Settings, and the alerting around them | Read the health probe results and the ops snapshot (which carries the workflow alerts, the digest and the AI readiness, as the Telegram bot's `/status`, `/alerts`, `/digest` and `/ai` do); read the alerts sent to your phone (`cms/alerts/recent`) and the calendar alerts; acknowledge, resolve or reopen a workflow alert (the bot's `/ack` and `/resolve`); read job states and the review queue (the bot's `/queue`); read the integration status and the StreamYard status and run a connection test; read the Cost page; read Search Console and queue a run; read Platform Settings and their history | Change a probe result, an integration setting, the cost ledger or any Platform Setting; send an alert to your phone again; read secrets or credentials; delete anything |

The Platform row was widened on 2026-11-10 at the owner's request ("make
sure Koda has access to this and any alerting, all platform items, the
Telegram bot queue"). Pipeline also gained one job type for the same reason:
`fetch-rss-feeds`, the bot's `/rss`. What the bot can do and Koda cannot is
`/approve`, which publishes. The decision and its limits are in
[ADR 0038](../decisions/0038-koda-admin-access.md), amendment of 2026-11-10.

To take a section away, turn its switch off on the tab; to give Koda a route
that is not listed, or to let it publish, change the table in
`functions/src/lib/agent-content/admin-access.js` through a pull request.

## 8. Claude Publisher's key: a second agent key

The site can hold more than one agent key. Each has its own record (one
`admin_config` document holding a hash of the key, never the key), its own
switches, its own tab on the Agents page, its own limit of 120 calls a minute
and its own audit rows. The list of keys is
[`functions/src/lib/agent-content/agent-keys.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/agent-content/agent-keys.js).
Koda's key is the first and works exactly as the parts above say.

The second key is **Claude Publisher**'s (shown as "Claude" until
2026-11-26; its id is still `claude`). Claude Publisher is a draft creator: it writes and edits
drafts on the Drafts page through the agent API. It cannot publish, schedule
or delete, whatever its switches say, because no route it can reach does.

Its tab is <https://hybridcloudworks.com/admin/agents?tab=claude>. It is the
same tab as Koda's, over Claude's own record, so parts 1, 3, 4 and 5 work the
same way there, with these differences:

- **No key exists until you make one.** The tab says **No key yet** until you
  press **Generate key**.
- **Only the draft switches start on.** A new Claude key starts with
  **Read drafts** (`drafts.read`) and **Create and edit drafts**
  (`drafts.write`) on, and every other switch off: sending to review, the
  published reads and all five admin sections. That is all the agent API's
  draft routes need (`GET` and `POST drafts`, `POST drafts/from-markdown`,
  `GET` and `PUT drafts/{id}`). The **Pipeline** admin switch is left off on
  purpose: it opens the admin routes of the whole Pipeline, including moving
  content between review states and starting jobs, which a draft creator
  does not need. Turn on more only if Claude needs it.
- **Where the key goes.** The key is shown once. Copy it and paste it into the
  secure field Claude asks for; never into chat. The site keeps only its hash.
- **The first test call** is the same `GET …/agent-content/v1/status`; a good
  answer has `"agent": "claude"`.
- **Drafts Claude writes** carry `claude (agent)` as their author.

A refusal of a key that matched no record (a wrong, revoked or missing key)
cannot say which key it was meant to be, so its audit row names the first
key, `koda`, as it always has; once a key matches, its rows name it. A key
that matched two records at once is refused the same way, with the reason
`ambiguous-key`; it should never happen, because every key is 32 random
bytes.

The [Health page](https://hybridcloudworks.com/admin/health) shows one
**Content agent** card per key, each with that key's own state, switches and
refusals of the last day. Refusals of a key that matched no record count on
Koda's card, for the reason above.

The admin route behind both tabs is `/api/cms/agent-content/key`; Claude's tab
adds `?agent=claude`, and any agent id that is not on the list is refused with
`400`. The roles are the same for every key: an editor reads, a super_admin
makes, switches, rotates and revokes.

Each key has its own row on the
[Credentials tab](https://hybridcloudworks.com/admin/integrations?tab=credentials)
(`agent-key-koda`, `agent-key-claude`) with the 180-day reminder, and its own
box on the **Agent keys** card under
[Integrations → Services → Site platform](https://hybridcloudworks.com/admin/integrations?tab=services&group=platform).

## 9. Claude Network Guy's key: a third agent key

The third key is **Claude Network Guy**'s (id `claude-network`). It
administers the site's Cloudflare zone through the Cloudflare admin routes
(`/api/cms/cloudflare/`), not the Drafts routes. Its tab is
<https://hybridcloudworks.com/admin/agents?tab=claude-network>, the same tab
as the others over its own record, so parts 1, 3, 4 and 5 work the same way
there.

- **Only reading starts on.** A new key has **Cloudflare: read** on and
  every other switch off. Each kind of change is its own switch: **change
  zone settings and purge the cache**, **add and edit DNS records**, and
  **edit rules**. Turn on only what a task needs.
- **What it can never do, whatever its switches say:** delete anything,
  remove a rule from a phase (it may add and change rules only), change the
  site's own address (the apex and `www`), or change a DNS record or rule
  phase Terraform manages. The list and the reasons are in the
  [Cloudflare admin runbook](cloudflare-admin.md#what-is-refused-and-why).
- **Every change it makes** writes an audit row and sends a Telegram message
  naming the setting, record or rule phase.
- **The first test call** is `GET …/api/cms/cloudflare/status`; a good
  answer has `"configured": true` once the site's Cloudflare token is set.
- **The four Cloudflare switches start off for Koda and Claude Publisher
  too.** They are on the shared list, so they appear on every key's tab, but
  a key whose record never stored them reads them as off. Koda's key, which
  used to read any unstored switch as on, now starts with the nine switches
  that existed before (ADR 0047).

Making the site's Cloudflare token and giving the key to a Claude session
are in the [Cloudflare admin runbook](cloudflare-admin.md), parts 2 and 3.

## What the API expects from Koda, in brief

- Drafts are addressed by `id`, not slug. `GET drafts` returns the list with
  each draft's `id` and `etag`; `GET drafts/{id}` returns the body.
- Every draft answer, in the list and alone, carries two links: `editUrl`,
  the Drafts page with that draft open
  (`https://hybridcloudworks.com/admin/drafts?draft=<id>`, for the owner or an
  admin, signed in), and `previewUrl`, the public preview page with a signed
  token that expires after 72 hours and shows the draft as the public page
  would. `previewUrl` is `null` while the site's preview secret is not
  seeded, and `null` on every answer to a key whose **Read drafts** switch is
  off, because whoever holds the link can read the body. Koda can hand either
  to the owner without any further call.
- Every change (`PUT`, `send-to-review`, `back-to-drafts`) carries
  the `etag` of the version Koda last read. A stale one answers
  `412 CONFLICT`: read again, then retry.
- A new draft is `POST drafts` with `{ "fields": { title, subtitle, date,
  track, part, tags, reading, body, kind, ideaOrigin } }` (title and body
  required), or `POST drafts/from-markdown` with `{ "markdown": "<the whole
  file, front matter included>" }` in the blog template's format. The
  markdown route is the safe way to create and the safe one to retry: a
  title already in Drafts or In Review answers `200` with
  `code: "ALREADY_IMPORTED"` and the existing `contentId`; a title already
  published answers `200` with `code: "PUBLISHED_ELSEWHERE"` and
  `existingId`; neither writes a second draft. `POST drafts` makes a new id
  every time, so a lost answer and a retry there would make two drafts.
- A key whose **Read drafts** switch is off still gets its answers, but
  wherever one would carry the draft as the page sees it (`draft` with
  `fields`), the text is replaced by `bodyWithheld: true` and the summary
  (id, title, stage, etag, allowed actions) stays. The markdown route's
  answers are the same for every key: a created markdown draft answers `201`
  with `contentId` and a `draft` summary that includes its `etag` (keep it;
  it is the version token for the next change); the skipped answers,
  `200 ALREADY_IMPORTED` with `contentId` and `200 PUBLISHED_ELSEWHERE` with
  `existingId`, carry no etag.
- The body is at most 256 KB. Errors are `{ "ok": false, "code", "error" }`.
- `GET published` and `GET published/{slugOrId}` answer exactly as the public
  site's own reads do.
