# Agent Content API: connect Koda, check it, rotate and revoke

Koda is the owner's content agent, run by the Muse service. It drafts and
reviews posts for the series by calling the site's Agent Content API with one
key. This page is how to make that key, connect Muse, prove it works, and take
it away again. The reasons behind the design are in
[ADR 0037](../decisions/0037-agent-content-api.md).

Everything here happens on the AI Engine's **Koda** tab:
<https://hybridcloudworks.com/admin/ai-engine?tab=koda>. You need the
`super_admin` role to make, change or revoke the key; an editor can see the
tab but the buttons say they are not theirs.

What the key can do, in plain words: everything the Drafts page can do (list,
read, create, edit, send to review, pull back, delete a draft) and read the
published articles the public site shows. It cannot publish, unpublish, change
a setting, read a secret or touch anything live. Each of those five things is a
switch on the tab, so any of them can be turned off without touching the key.

Until a key exists, every call to the API is refused and nothing is on.

## 1. Make the key and connect Muse

1. Open <https://hybridcloudworks.com/admin/ai-engine?tab=koda>. The first
   card says **No key yet**.
2. Press **Generate key**. An amber box appears with the key, beginning
   `hcwk_`. This is the only time it is shown. Press **Copy key**.
3. In Muse, add a custom connector. The **Connect Muse to the site** card on
   the tab lists every value the form asks for; the ones that matter are:
   - Provider host: `api-azure.hybridcloudworks.com`
   - Base URL: `https://api-azure.hybridcloudworks.com/api/agent-content/v1`
   - Authentication: API key, sent in the `Authorization` header as `Bearer`
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
audit log.

## 5. Revoke the key

1. Press **Revoke key** and confirm. Koda's next request is refused with
   `401`. Nothing Koda already wrote is changed; its drafts stay on the
   Drafts page.
2. To reconnect later, press **Generate key** and follow part 1 again.

## 6. Where to look when something is wrong

- **The Drafts page** (<https://hybridcloudworks.com/admin/drafts>): drafts
  Koda wrote show `koda (agent)` as their author.
- **Refused calls:** every call that presented a site key (one starting
  `hcwk_`) and was refused is a row in the `admin_audit_logs` container with
  `kind: "agent-content-denial"` and a `reason` (`no-key`, `wrong-key`,
  `revoked-key`, `capability-off`, `rate-limited`). A call with no key, or
  with some other bearer value, is refused without a row, so internet
  scanners do not fill the log. The key itself is never in a row.
- **Key events:** rows with `action` `agent_content_key_generated`,
  `agent_content_key_rotated`, `agent_content_capabilities_changed` or
  `agent_content_key_revoked`, each with the key's first characters and who
  did it.
- **The contract:** every route and what it answers is in
  `.azure/api-surface.json`, sections `agentContentApi` and
  `adminAgentContent`.

## What the API expects from Koda, in brief

- Drafts are addressed by `id`, not slug. `GET drafts` returns the list with
  each draft's `id` and `etag`; `GET drafts/{id}` returns the body.
- Every change (`PUT`, `DELETE`, `send-to-review`, `back-to-drafts`) carries
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
- A key whose **Read drafts** switch is off still gets the outcome, id and
  etag of its own writes, but `draft.fields` (the text) is replaced by
  `bodyWithheld: true`.
- The body is at most 256 KB. Errors are `{ "ok": false, "code", "error" }`.
- `GET published` and `GET published/{slugOrId}` answer exactly as the public
  site's own reads do.
