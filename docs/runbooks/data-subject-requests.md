# Data-subject request runbook (Access, Export, and Erasure)

**What this is for:** executing data subject requests under GDPR (Articles 15, 17, 20) and CCPA/CPRA across the HybridCloudWorks estate.

**Scope:** personal data held in production databases (Cosmos DB), external delivery providers (Resend), and backup copies (the nightly export in Azure Blob Storage, and the database's own 30-day backup).

---

## 1. Inventory of personal data stores

Personal data is collected across three functional areas:

| Store / Service | Container / Resource | Stored Fields | Retention / Minimization |
| --- | --- | --- | --- |
| **Mailing list & newsletter** | Resend API & Audience Segments | Email address, subscription date, delivery status, consent source | Contact stored in Resend until unsubscribed or deleted. Audit consent in `admin_audit_logs` carries masked email only (`a***@example.com`). Unconfirmed signups are never persisted in Cosmos or Resend: they are issued as an HMAC-signed token with a 48h TTL directly to the subscriber's email (`functions/src/lib/newsletter/handlers.js`). If unconfirmed, they lapse with zero data retained on the estate. |
| **Ambassador hub** | Cosmos DB container `ambassador` (`cosmos-site-prod-cus` / `hcw`) | The owner's own Ambassador hub: programs, the owner's applications to them, and their evidence (`functions/src/lib/ambassador/validate.js`). No field is dedicated to third-party personal data, but editor-gated free-text fields (`notes`, `responses`, `customValues`, `reviewerFeedback`, `statusNote`, `description`) hold whatever an editor types, and `files` and `images` reference attachments: an external URL, or a private blob path in storage account `stsiteprodcus01` (container `speakerevents` by default) | Kept until the owner deletes them. No container TTL (#1234 set one in error; it was removed by #1238 before any apply). A request searches the text fields and opens every referenced file and image (Step 2 of sections 3 and 4). |
| **Public submissions** | Cosmos DB container `content` (`storageCollection == 'content'`) | Title, summary, content, cloudProvider, tags, language | Codebase audit (#1237) confirms public submissions (`functions/src/lib/submissions.js`) are completely anonymous. No submitter or author email address is accepted, ingested, or stored (`submitterEmail` and `authorEmail` do not exist). |
| **Call-for-speakers proposals** | Cosmos DB container `developer_events` (`cosmos-site-prod-cus` / `hcw`), partitioned on `/eventId`, rows with `docType == 'cfs-submission'` | A speaker's name, email (`speakerEmail`, stored lower-case), bio, talk title and abstract, typed by the speaker through the Developer API's public proposal route (ADR 0042, `functions/src/lib/developer-api/cfs.js`) | No container TTL. An **accepted** proposal is kept until deleted. A proposal that was **not accepted** is stripped after its yearly cycle (owner decision 2026-11-24, [#1777](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1777)): the cycle is the calendar year its call closed in, and on 1 February of the next year a daily job removes `speakerName`, `speakerEmail`, `speakerBio` and `reviewNote` for good, keeps the talk's title, abstract, status and dates, and sets `strippedAt`. That job ships switched off (it only counts) until the app setting `PROPOSAL_STRIP_ENABLED` is `true`; whether it is on, and what the last run did, is on the card **Yearly clean-up of proposals** on <https://hybridcloudworks.com/admin/ai-engine?tab=developer-api> ([developer API runbook](developer-api.md#the-yearly-clean-up-of-proposals)). A stripped proposal holds no address, so a search by email no longer finds it. Shown only to the organizer key that owns the call, never public. A request finds rows by `speakerEmail` and deletes them from the admin: the **Erase a speaker's proposals** card on <https://hybridcloudworks.com/admin/ai-engine?tab=developer-api> (super_admin), steps in the [developer API runbook](developer-api.md#delete-a-speakers-proposals-an-erasure-request). |
| **Disaster recovery backups** | Azure Blob Storage container `cosmos-export` on account `stsiteprodcus01` (`rg-stor-site-prod-cus`) | Point-in-time snapshot gzip NDJSON of Cosmos containers | Deleted after 35 days by the lifecycle rule `expire-cosmos-export` (ADR 0028). The container also has a 35-day write-once policy (a rule that stops a blob being changed or deleted before it is that old), but that policy is **unlocked** by default (`cosmos_export_immutability_locked` is `false` in `infra/variables.tf`). Unlocked, it holds against the application and ordinary users, and a subscription owner can still change or remove it, so do not describe these copies as impossible to alter unless that variable has been set to `true` in the workspace. |
| **The database's own backup** | Cosmos DB continuous backup on account `cosmos-site-prod-cus` (`backup { type = "Continuous", tier = "Continuous30Days" }` in `infra/cosmos.tf`) | Every container, as it was at any moment in the last 30 days; kept by Azure inside the account, not readable as files | Kept for 30 days and then gone; it cannot be edited or shortened for one person. A restore brings back records that were erased or stripped after the moment restored to (see "After a restore" under Step 4 of section 4). Microsoft describes it in [Continuous backup with point-in-time restore](https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction). |
| **Interview recordings** | Azure Blob Storage container `interviews-audio` on account `stsiteprodcus01` (`rg-stor-site-prod-cus`), prefix `audio/`; transcripts beside it under `transcripts/` | A guest's voice recording (`audio/<interviewId>/<uploadId>.<ext>`, one blob per upload session) and the transcripts made from it (`transcripts/<interviewId>/v<n>.json`); the interview document in Cosmos `content` holds the guest's name, role, bio, consent record and the recording's path, size and hash, never the audio | Recordings and their previous versions are deleted by lifecycle rule `expire-interview-audio` after `interview_audio_retention_days` (365 by default, set in the HCP Terraform workspace; ADR 0040, [#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565)), then restorable for 7 more days by the account's soft delete. Transcripts are kept until the interview is deleted from the admin. Private container: no public URL, no player, written and read by the Function App identity only. A request deletes the recording with the admin page's "Delete recording" button, or the whole interview (document, recording and transcripts) with the delete route. |

---

## 2. Request intake and identity verification

Before processing an export or erasure request:
1. Verify the requester owns the email address by sending a confirmation link or challenge code to that exact address.
2. Log the request ticket without storing sensitive unmasked PII in public trackers.

---

## 3. Data export procedure (Access & Portability — GDPR Art. 15, 20)

To retrieve all records associated with `<USER_EMAIL>`:

### Step 1: Query Resend mailing list
Using the admin portal or Resend API:
```bash
# Query contact details via Resend API
curl -sSf "https://api.resend.com/audiences/<AUDIENCE_ID>/contacts/<USER_EMAIL>" \
  -H "Authorization: Bearer <RESEND_API_KEY>" > resend_export.json
```

### Step 2: Search the `ambassador` container and referenced files
The hub's records are the owner's, but an editor can type or attach someone else's details (section 1). The records live in Cosmos account `cosmos-site-prod-cus`, database `hcw`, container `ambassador`.

**Access path.** Local authentication is disabled on `cosmos-site-prod-cus` (`infra/cosmos.tf`), and the only identity with a standing data-plane role is the Function App (`func_cosmos_db["hcw"]` on the `hcw` database, in `infra/cosmos.tf`; its earlier account-wide grant, `func_cosmos`, is removed by Step 2 of [#1469](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1469) and is gone from the live account once the owner has confirmed that apply and the role list on the issue shows one row).

Operators have two supported operational paths:
1. **Admin Ambassador Hub (Web UI):** Sign in with the editor role at <https://hybridcloudworks.com/admin/ambassador>. It reads records through the Function App, and opens attached files from storage account `stsiteprodcus01` (container `speakerevents` unless the entry specifies another).
2. **Operational search tool (CLI):** Run `scripts/data-subject-search.mjs` using Azure CLI credentials (`DefaultAzureCredential`):
   ```bash
   node scripts/data-subject-search.mjs --email "<USER_EMAIL>" --account cosmos-site-prod-cus --database hcw
   ```
   *(Requires `Cosmos DB Built-in Data Reader` on account `cosmos-site-prod-cus`).*

**Who has read or changed the record.** Every request on the `ambassador`,
`doc_vault` and `brain_records` containers, reads included, is kept in the Log
Analytics workspace's `CDBDataPlaneRequests` table for 90 days, with the
caller's identity (`AadPrincipalId`), address and operation. Requests on the
other containers are kept only when they write. The filter is an
ingestion-time rule in `infra/observability.tf`
(`azurerm_monitor_data_collection_rule.workspace_transforms`,
[#1530](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1530));
before it was applied the table carried every request until the workspace's
daily cap stopped collection each evening, so a day before that apply is
complete only from 08:00 UTC to about 20:30 UTC. Read it from PowerShell,
first the workspace's id (the query command takes that, not the name), then
the query:

```powershell
$w = (az monitor log-analytics workspace show -g rg-mgmt-plat-prod-cus -n log-plat-prod-cus-01 --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId
```

```powershell
az monitor log-analytics query --workspace $w --subscription sub-plat-mgmt-prod-cus --analytics-query "CDBDataPlaneRequests | where CollectionName == 'ambassador' | project TimeGenerated, OperationName, AadPrincipalId, ClientIpAddress, StatusCode" -o table
```

**Search scope:**
1. Read every text field across all programs, applications, and evidence records (`title`, `notes`, `statusNote`, `reviewerFeedback`, `responses[].text`, `customValues`, `description`).
2. Enumerate all file and image references (`files` and `images`, each holding either a private blob path or an external URL).
3. Open and inspect each referenced blob in `stsiteprodcus01` (container `speakerevents`) to check the underlying media for the requester.
4. Add any match to the export bundle.

### Step 3: Public submissions check (`content` container)
As verified in #1237, public content submissions (`functions/src/lib/submissions.js`) are anonymous and do not collect or store email addresses. No submitter records exist in `content`.

### Step 4: Assemble export bundle
Aggregate the located JSON objects, text snippets, and referenced files into a single redacted JSON package and transmit securely to the requester.

---

## 4. Data erasure procedure (Right to be Forgotten — GDPR Art. 17)

To permanently erase `<USER_EMAIL>` across the estate:

### Step 1: Delete from Resend audience
In the HCW Admin Portal (`/admin/newsletter-hub` or `/admin/platform-settings`) or via API:
```bash
# Delete contact from audience segment
curl -sSf -X DELETE "https://api.resend.com/audiences/<AUDIENCE_ID>/contacts/<CONTACT_ID>" \
  -H "Authorization: Bearer <RESEND_API_KEY>"
```

### Step 2: Redact matches in the `ambassador` container
For each match Step 2 of section 3 found, remove the requester's details. The record itself is the owner's and stays: never delete the document.
- **In a text field:** Edit the record in the Admin Ambassador Hub (<https://hybridcloudworks.com/admin/ambassador>) to delete or redact the requester's text. Hub edits go through the Function App with optimistic concurrency ETags (`functions/src/lib/ambassador/applications.js`), ensuring concurrent edits are safely coordinated.
- **A file or image stored in the estate** (a blob path):
  1. Remove its entry from `files` or `images` in the Ambassador hub.
  2. Delete the blob itself from storage account `stsiteprodcus01` (resource group `rg-stor-site-prod-cus`), in the entry's container (`speakerevents` by default) at `path`:
     ```bash
     az storage blob delete \
       --account-name stsiteprodcus01 \
       --container-name speakerevents \
       --name "<BLOB_PATH>" \
       --auth-mode login
     ```
     *(Requires `Storage Blob Data Contributor` on `stsiteprodcus01`).*
- **A file or image that is an external URL:** Remove the entry in the Ambassador hub. The external target is outside the estate and cannot be deleted by HCW; inform the requester where it is hosted so they can contact the hosting provider directly.

### Step 3: Public submissions (`content`)
Public submissions contain no submitter or author email addresses. No redaction or deletion is required.

### Step 3a: Call-for-speakers proposals (`developer_events`)
A talk proposal sent to an organizer's call for speakers holds the requester's name, email, bio, talk title and abstract. Delete every proposal sent from `<USER_EMAIL>`. **A delete cannot be undone.**
1. Open <https://hybridcloudworks.com/admin/ai-engine?tab=developer-api> (super_admin role) and scroll to the last card, **Erase a speaker's proposals**.
2. Type the requester's email address and press **Find proposals**. You should see one line per proposal (event id, status, date sent), or "No proposals are stored for that address."
3. Press **Delete** on each line and confirm. Each one shows a "Proposal deleted" note and its line disappears.
4. Press **Find proposals** again; "No proposals are stored for that address." confirms the erasure.

The full steps, the organizer's own PowerShell route, and what is written to the audit log (`developer_cfs_proposal_search` for each search, with the number found and never the address searched for, and `developer_cfs_submission_erased` for each delete, with no address and no proposal text) are in the [developer API runbook](developer-api.md#delete-a-speakers-proposals-an-erasure-request). For an **access** request (section 3) the card lists where the address has proposals but not their text; the text is read from the organizer's own list, or from the container by a database administrator.

### Step 4: Immutable backup lifecycle disclosure
Backup copies are not edited for one person: a backup that has been changed can no longer be trusted as a backup. They expire instead. There are two (section 1): the nightly export, deleted after 35 days, and the database's own continuous backup, which reaches back 30 days. The export's write-once policy is unlocked by default, so "write-once" below is true against the application and ordinary users, not against a subscription owner.
- Inform the data subject: "Your live database records and mailing list subscriptions have been permanently erased. Copies in disaster-recovery backups are not edited; they are deleted automatically, within 35 days at the latest."

**After a restore.** If the database is ever restored from either backup, the restored copy is as it was at that earlier moment: a record erased since then is back, and so are the speaker details of a proposal stripped since then. After any restore, go through the erasure requests completed since the moment restored to and repeat them. The yearly clean-up of proposals repeats itself: its next daily run strips again whatever is due, as long as it is switched on.

### Step 5: Interview recordings (`interviews-audio`)

A guest's recording is a blob in the private `interviews-audio` container, one blob per upload session under the interview's own folder (`audio/<interviewId>/<uploadId>.<ext>`); the interview document in Cosmos `content` points at the current one (`provenance.audio.path`), lists the ones it replaced (`provenance.audio.superseded`) and keeps any open upload sessions (`provenance.audio.uploads`). The admin page's "Delete recording" button and the interview-aware delete route arrive with the content-type slice of [#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565); until they do, erase by hand. The order matters, and it is the order the delete hook will use: the document is cleared and marked deleted first (the tombstone `provenance.audio.deletedAt`), which the upload routes honour (an open, a block or a completion answers 409 `INTERVIEW_DELETED`, and a completion that was already past its checks deletes the blob it committed), and only then are the blobs deleted, so a late completion can neither publish a new blob nor leave one untracked.

All lines are PowerShell. The interview's id is the document id shown in the admin Content list (and in the request); set it once and the other values are read from the estate:

```powershell
$interviewId = Read-Host "Interview id"
```

1. Stop uploads for this interview: do not open the interview form for it while the procedure runs (the site has one editor, the owner), and check that no session is open. Read the document as an editor with `GET /api/cms/content/item?contentId=<the id>` (the admin bearer token in the `Authorization` header, as every `cms` route) and note `provenance.audio.path`, every entry of `provenance.audio.superseded`, and that `provenance.audio.uploads` is absent or empty. If a session is open, wait for the upload to finish or fail (an abandoned one is harmless: step 2 ends it).
2. Clear the document first, so nothing can publish or reference a blob after this point: `POST /api/updateContentItem` as an editor with the body `{ "contentId": "<the id>", "updates": { "provenance": { "source": "upload", "audio": { "deletedAt": "<now, as 2026-11-06T12:00:00Z>" } } } }` (`provenance` is written whole, so repeat any other `provenance` fields the document carried). From now on every upload route for this interview answers 409 `INTERVIEW_DELETED`, including a new upload: the tombstone stays until the interview itself is deleted, which is what an erasure request asks for.
3. Give the workstation reach and the right to delete versions. The storage account refuses requests from outside the Function App's subnet, and deleting a blob *version* needs `deleteBlobVersion/action`, which the Storage Blob Data Contributor role lacks ([Blob versioning: authorize operations](https://learn.microsoft.com/azure/storage/blobs/versioning-overview#authorize-operations-on-blob-versions)); the Function App identity's Owner grant does not apply to a signed-in person. Both are temporary, scoped to this container, and removed in step 6:

   ```powershell
   $ip = (Invoke-RestMethod https://api.ipify.org).Trim()
   az storage account network-rule add --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --ip-address $ip -o none
   $me = (az ad signed-in-user show -o json | ConvertFrom-Json).id
   $scope = (az storage container-rm show --storage-account stsiteprodcus01 -g rg-stor-site-prod-cus -n interviews-audio -o json | ConvertFrom-Json).id
   az role assignment create --assignee-object-id $me --assignee-principal-type User --role "Storage Blob Data Owner" --scope $scope -o none
   ```

   A role assignment takes a few minutes to apply; a `403` on the next step means wait and retry, not that the grant failed.
4. Delete every blob under the interview's folder, then every version of each. With versioning on, deleting the current blob only turns it into a previous version, and `--delete-snapshots include` removes snapshots, not versions, so each listed version is deleted by its id:

   ```powershell
   az storage blob list --account-name stsiteprodcus01 --auth-mode login -c interviews-audio --prefix "audio/$interviewId/" -o json | ConvertFrom-Json | ForEach-Object { az storage blob delete --account-name stsiteprodcus01 --auth-mode login -c interviews-audio -n $_.name --delete-snapshots include -o none }
   az storage blob list --account-name stsiteprodcus01 --auth-mode login -c interviews-audio --prefix "audio/$interviewId/" --include v -o json | ConvertFrom-Json | ForEach-Object { az storage blob delete --account-name stsiteprodcus01 --auth-mode login -c interviews-audio -n $_.name --version-id $_.versionId -o none }
   az storage blob list --account-name stsiteprodcus01 --auth-mode login -c interviews-audio --prefix "audio/$interviewId/" --include v -o table
   ```

   The last line should print nothing under the interview's folder. Any row it still prints is a version the second line missed (a listing can lag a delete by a moment): run the second line again. When the request covers the transcripts too, repeat the three lines with `transcripts/$interviewId/` in place of `audio/$interviewId/`.
5. Confirm the document is clear (step 2's read again) and that `provenance.audio` holds only `deletedAt`; a completion cannot put a `path` back after step 2 (its write loses the ETag and it deletes its own blob), so a `path` here means step 2 did not land: repeat steps 2 and 4.
6. Remove the grant and the firewall allowance (same `$me`, `$scope` and `$ip`):

   ```powershell
   az role assignment delete --assignee $me --role "Storage Blob Data Owner" --scope $scope -o none
   az storage account network-rule remove --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --ip-address $ip -o none
   ```

7. Tell the data subject: the recording and its versions are removed from live storage; the account's soft delete keeps each deleted blob and version restorable for 7 days, after which it is unrecoverable.

---

## 5. Verification exercise record

| Field | Record |
| --- | --- |
| **Exercise Date** | 2026-10-17 |
| **Test Subject Identity** | `data-subject-exercise-20261017@hybridcloudworks.com` |
| **Simulated Assets** | 1. Contact lookup / deletion in Resend API<br>2. Ambassador search: text fields and attachment extraction across `cosmos-site-prod-cus/hcw/ambassador`<br>3. Public submissions: verification that `content` contains no email fields<br>4. Backup retention: 35-day lifecycle policy verified active on storage account `stsiteprodcus01` |
| **Execution Steps** | 1. Contact lookup exercised via Resend API `GET /audiences/<AUDIENCE_ID>/contacts/<USER_EMAIL>`, deletion via `DELETE /contacts/<CONTACT_ID>`.<br>2. Search procedure executed using `node scripts/data-subject-search.mjs --email "data-subject-exercise-20261017@hybridcloudworks.com" --account cosmos-site-prod-cus --database hcw`. Verified recursive text scanning (`notes`, `statusNote`, `responses`, `customValues`) and attachment enumeration across `files` and `images` (`stsiteprodcus01/speakerevents`).<br>3. Verified `functions/src/lib/submissions.js` schema: public submissions are anonymous and store no submitter email addresses.<br>4. Backup lifecycle verified via Azure CLI:<br>`az storage account management-policy show --account-name stsiteprodcus01 --resource-group rg-stor-site-prod-cus --query "policy.rules[?name=='expire-cosmos-export']"`<br>Confirming rule `expire-cosmos-export` is active with 35-day deletion on `cosmos-export/full/` and `cosmos-export/delta/`. |
| **Result** | **PASS.** Verified and reproducible against the real estate architecture, supported CLI commands, and verified account configurations. |
| **Exercised by** | Operations & Security Engineering review. |
