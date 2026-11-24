# Enable and operate Second Brain

Second Brain is private and disabled by default. Its design and data boundaries
are in [the architecture record](../architecture/second-brain.md).

## Prepare the release

1. Run Functions and frontend lint/tests, frontend build and the
   `second-brain.spec.js` browser journey. Build/test `obsidian-plugin`.
2. Review the Terraform plan: it adds `brain_records` and `brain_search` with
   `/ownerId` partitioning, app settings, and the reconciliation timer's alert
   schedule. Existing content is not migrated or rewritten.
3. Deploy infrastructure and application through the usual delivery process
   with both `brain_enabled` and `brain_ai_enabled` false.

## Owner and desktop registration

Obtain the owner's existing Entra tenant and object ID through the signed-in
identity/admin registry. Do not use email as the access key or paste IDs into
this public repository. The owner must already be an active editor or higher
with the API's Admin role.

Set these Terraform inputs through the existing environment configuration:

| Input | Initial value |
| --- | --- |
| `brain_owner_oid` | The owner's Entra object ID |
| `brain_owner_tenant_id` | The existing API tenant |
| `brain_sync_client_id` | Dedicated desktop registration created below |
| `brain_enabled` | false until the sample pilot |
| `brain_ai_enabled` | false until Foundry readiness is checked |

Run `scripts/brain/configure-entra-sync.ps1` with `-ApiAppId`, `-TenantId`, and
`-OwnerOid`. Its default invocation is read-only and prints the intended
desktop manifest. After reviewing it, use `-Apply` through the normal approved
identity-change process. It preserves existing API scopes/roles/clients,
exposes only the new `brain_sync` delegated permission to this desktop client,
and refuses to repurpose a broader or credentialed registration. Record the
returned client ID as `brain_sync_client_id`.

Verify that the desktop client's required resource permissions contain only
the API's `brain_sync`, that it has no secrets, and that `access_as_admin` is
still required by existing admin routes. Record owner identity and the native
client registration in the environment's identity inventory.

## Pilot without touching the original vault

1. Enable `brain_enabled` for the configured owner. Confirm the owner sees the
   Second Brain menu, then verify a different admin and an unauthenticated
   request cannot read notes, search, graph, sync, or exports.
2. Capture synthetic sample notes and a topic/project. Save an explicit link,
   inspect backlinks and the graph, archive/restore, and save concurrently in
   two browser tabs. Confirm the second save preserves local text and returns
   a conflict instead of overwriting.
3. Press **Index creator content**. Watch its checkpoint/status on Home until
   complete. Check each source format, rename/update an article, and remove a
   sample source; search must never return removed text even before indexing
   catches up. The timer resumes an interrupted queued/running checkpoint
   every 15 minutes, and starts a new full rebuild once a day (see
   *Operations and rollback* below).
4. Use Node.js 26.10 or newer to build/test. In `obsidian-plugin`, run
   `npm ci --ignore-scripts`, `npm test`, and
   `npm run build`. Copy the contents of `dist` to
   `.obsidian/plugins/hcw-second-brain` in a separate test vault, then enable
   the plugin in Obsidian Community plugins. The packaged plugin uses
   Obsidian's desktop runtime and needs no separate Node installation.
   Keep the test vault out of Git.
   Authentication uses Obsidian's native HTTPS transport for Microsoft's
   authority; renderer `fetch` is subject to browser CORS and cannot perform
   the desktop device-code exchange.
5. Copy connection settings from Second Brain Home, sign in, and enroll only
   sample Markdown notes. Test an offline edit, a rename, concurrent edits,
   deletion/restore, and a local edit of an `HCW/Site` reference. Confirm
   recovery notes under `HCW/Conflicts` and that published content is unchanged.
6. Verify the plugin state and Markdown files contain no access/refresh token.
   The encrypted cache is under
   `%LOCALAPPDATA%/HybridCloudWorks/Obsidian/<client-id>/tokens.cache`.
   If Windows refuses the helper, keep sync disabled and investigate the
   signed-in user's policy; do not weaken policy or enable plaintext storage.
7. Check the `brainAssistant` task in AI Engine, its enabled Foundry model,
   and usage reporting. Set `brain_ai_enabled=true`. Ask a source-backed
   question and one absent from your corpus. Verify citations, the missing
   evidence state, and that answering alone creates no note/draft/publication.
8. Review an outline and create a draft twice with the same request. Verify
   one draft exists, starts in Drafts, and links back to its private provenance.
9. Restore a sample authored note and its revisions/relationships into an
   isolated environment using the existing Cosmos backup process. Rebuild the
   index there. Do not replay restored production notes into the live workspace.

## What the browser journeys prove, and what still needs the owner

The Playwright journeys in
[`frontend/e2e/second-brain.spec.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/e2e/second-brain.spec.js)
run on every pull request that touches `frontend/`, in the two `e2e (playwright, shard N/2)` jobs under the `gate` check, on a desktop and a
phone profile, against the real frontend bundle with the identity host and the
brain API answered by fixtures (made-up notes, no model). They prove the
plumbing; they cannot judge an answer's quality. Against the acceptance lines
of [#1408](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1408):

| Line | Covered by the journeys | Still the owner's, in production |
| --- | --- | --- |
| 1. Outline stays on the selected idea | The request carries the selected idea's id and the `outline` mode; the panel names the idea it starts from. | Whether the model's outline is about that idea and not an unrelated recording. |
| 2. Citations resolve; missing evidence is honest | Both citations link to their own source, and following one opens that source in the editor (defect found and fixed here); a missing-evidence item is shown as a suggestion, not a sourced claim. | Whether the citations the model chose are the right ones, and whether its gaps are real gaps. |
| 3. **Review as a new note** fills the editor and saves | The editor holds the outline with its citation links; the save sends that text with the sources as the note's links and the note shows as saved. | Nothing. |
| 4. **Create draft** with provenance; a retry makes no duplicate | The draft route of the saved note receives the reviewed title and text; a failed attempt and its retry carry the same request id, and the button is disabled once a draft exists. That request id lives in the open editor: after a reload, a reopen of the note or **Start another draft**, a new id is minted and the API will make a second draft. The API side (the same request id returns the same draft id) is unit-tested in [`functions/src/lib/brain/brain.test.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/brain/brain.test.js). | Open **Drafts** once in production and confirm the draft is there with its provenance. |
| 5. Appearance controls, two-line headings, doubled canvas, full-screen X and Escape | All of it, in the `map appearance` journey. | A look in the owner's own browser, if wanted; nothing here depends on the model. |

## If sign-in fails

From plugin 1.0.4 the **Sign in** button says which step failed and why, for
example `Sign-in failed. Step: device code request. ... (Microsoft devicecode:
HTTP 400 invalid_scope AADSTS70011 ...)`, and writes the same line to the
Obsidian developer console (**Ctrl+Shift+I**, then the **Console** tab) as
`HCW Second Brain: sign-in failed.` Tokens and device codes are never shown.
Version 1.0.3 and earlier showed one fixed sentence and logged nothing
([#1812](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1812)).
The DevTools **Network** tab is not a reliable place to look: the plugin
talks to Microsoft through Obsidian's own HTTPS request function
(`requestUrl`), not the page's `fetch`.

What each step means and what to check:

| Step in the message | What it means | Check |
| --- | --- | --- |
| `settings` | A connection value is missing or not a GUID. | Copy the four values again from Second Brain Home. |
| `token cache (read)` or `token cache folder` | The plugin could not open its cache folder or lock file. | Check 1 below. |
| `token cache (Windows encryption)` | The encryption helper `dpapi.ps1` did not run, or Windows refused to encrypt. | Checks 1 to 3 below. |
| `device code request` | Microsoft refused to issue a sign-in code; the reason is the `AADSTS` code in brackets. | Look the code up in Microsoft's [error code list](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes). This is an Entra registration matter, not a plugin one. |
| `waiting for browser sign-in` | A code was shown and the browser sign-in was refused or ran out of time. | The `AADSTS` code, as above. |

The helper is only used once a token cache file exists (to read it) or when
a token arrives (to save it), so on a first sign-in a helper problem appears
after the code dialog, not before. All lines below are PowerShell; run them
in one window, in order.

1. See whether a cache or a leftover lock file exists. A `tokens.cache.lock`
   older than a minute is removed by the plugin itself.

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\HybridCloudWorks\Obsidian" -Recurse -Force -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
   ```

   Nothing listed, or one folder named after the desktop client id with
   `tokens.cache` in it, is normal.

2. Find the vault's copy of the helper and see whether Windows marked it as
   downloaded. This reads Obsidian's own list of vaults and picks the one
   whose path contains `HCW`.

   ```powershell
   $v = (Get-Content "$env:APPDATA\obsidian\obsidian.json" -Raw | ConvertFrom-Json).vaults.PSObject.Properties.Value | Where-Object { $_.path -like '*HCW*' } | Select-Object -First 1 -ExpandProperty path; $h = Join-Path $v '.obsidian\plugins\hcw-second-brain\dpapi.ps1'; Get-Item $h -Stream * | Select-Object Stream; Get-ExecutionPolicy -List
   ```

   Good: only `:$DATA` is listed, and the effective policy (the first scope
   that is not `Undefined`, from the top) is `RemoteSigned`, `AllSigned` with
   a signed helper, or `Bypass`. A `Zone.Identifier` line means the file is
   marked as downloaded; `Unblock-File $h` removes the mark. A policy of
   `Restricted` (the Windows default for desktops) stops every script,
   including this one. The plugin does not override the policy on purpose;
   changing it is the owner's decision.

3. Run the helper the way the plugin does: encrypt a made-up value and
   decrypt it again.

   ```powershell
   $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"; $c = 'synthetic-test' | & $ps -NoProfile -NonInteractive -File $h -Mode Protect; "protect exit $LASTEXITCODE"; $c | & $ps -NoProfile -NonInteractive -File $h -Mode Unprotect; ""; "unprotect exit $LASTEXITCODE"
   ```

   Good: `protect exit 0`, then `synthetic-test`, then `unprotect exit 0`.
   Exit `3` means Windows' encryption (DPAPI) refused for this user; any
   other non-zero code means PowerShell did not run the script, and the text
   it printed says why.

## Enroll the real notes and retire private Publish

Back up the original vault. After the sample pilot passes, install the tested
plugin there and preview/select the notes to enroll. Never select the whole
vault implicitly. Existing personal notes stay in their chosen paths; notes
created in HCW download under `HCW/Notes`.

Confirm the hosted HCW workspace contains the intended notes and that only
the owner can read them. Then unpublish the private notes through Obsidian's
Publish interface, including checking the original Publish URL. A DNS change
alone does not unpublish upstream copies. Verify both the custom hostname and
original Publish address no longer serve those notes. Keep the local vault.
Subscription cancellation is a separate account action.

## Operations and rollback

- Home reports indexing status and the last reported completed plugin cycle, pending changes, and conflicts. The plugin
  reports local pending operations, the last completed cycle, and local errors.
  A failed/offline plugin cannot report fresh status to the server, so the
  hosted timestamp is not a proof that every local change has uploaded.
- Reindexing resumes a checkpoint; a completed run can be started again at
  any time with **Index creator content**. The timer makes no AI call. It
  fires every 15 minutes and does one of three things
  ([#1772](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1772)):
  it resumes an unfinished rebuild; it starts a new full rebuild when the last
  one finished 24 hours ago or more (`REBUILD_INTERVAL_MS` in
  `functions/src/lib/brain/indexing.js`); or it does nothing. So a new or
  changed site article, social post or recording can take up to a day to
  reach Second Brain search, unless the button is pressed. Notes are indexed
  when saved and are not affected. Removed text still never shows, because
  search re-reads the source.
- A rebuild that fails part-way is tried again from its saved place at the
  next firing, 15 minutes later. A rebuild still unfinished 24 hours after
  it started (`REBUILD_STALLED_MS`) is treated as stuck and started again
  from the beginning.
- **The timer has its own switch**
  ([#1822](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1822)).
  It runs only while three things hold: `brain_enabled` is `true`,
  `schedulers_master_enabled` is `true`, and `"BRAIN_INDEX_RECONCILE"` is in
  the `enabled_timers` list. All three are Terraform variables in the
  [`hcw-azure` workspace](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables).
  Terraform turns the list into the app setting
  `FEATURE_FLAG_BRAIN_INDEX_RECONCILE` (`"true"` when the name is listed,
  `"false"` when it is not).
  - *To pause the daily rebuild without switching Second Brain off:* remove
    `"BRAIN_INDEX_RECONCILE"` from `enabled_timers`, start a run from the
    [runs page](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs)
    and confirm it. The plan changes one line, the flag from `"true"` to
    `"false"`; the plan check lists it as UNEXPECTED on purpose, as it does
    for every timer being switched off. Notes, search and the **Index creator
    content** button keep working; site articles, social posts and recordings
    stop reaching the index by themselves. Put the name back the same way to
    resume.
  - *How to tell it is off:* the timer still fires every 15 minutes and
    returns at once, so the overdue-timer alert stays quiet. The first firing
    after each restart writes one Warning line,
    `[brainIndexReconcile] disabled — skipping`, and every run of
    `deploy-functions.yml` shows a warning that names the flag.
  - *On a rebuilt estate:* put `"BRAIN_INDEX_RECONCILE"` in `enabled_timers`
    before the first deploy of the functions. `deploy-functions.yml` refuses
    to deploy while the app has no `FEATURE_FLAG_BRAIN_INDEX_RECONCILE`
    setting at all, which means Terraform has not applied yet.
- On an AI failure, use notes/search normally. Answers send bounded excerpts
  to Foundry only and retain no automatic conversation history.
- Set `brain_ai_enabled=false` to stop AI alone. Set `brain_enabled=false` to
  deny the brain APIs and stop index/sync processing. Disabling the feature
  does not delete Cosmos data or local notes and does not alter site articles.
- To revoke one desktop client, clear/change `brain_sync_client_id`. Revoke the
  Entra registration/permission through the identity process when retiring it.
- Sign out in the plugin to clear its cached account tokens. Uninstalling the
  plugin leaves enrolled notes intact. Keep authored backups; the search index
  is disposable and safe to rebuild.
