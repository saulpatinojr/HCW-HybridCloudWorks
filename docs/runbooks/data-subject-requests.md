# Data-subject request runbook (Access, Export, and Erasure)

**What this is for:** executing data subject requests under GDPR (Articles 15, 17, 20) and CCPA/CPRA across the HybridCloudWorks estate.

**Scope:** personal data held in production databases (Cosmos DB), external delivery providers (Resend), and immutable backup archives (Azure Blob Storage).

---

## 1. Inventory of personal data stores

Personal data is collected across three functional areas:

| Store / Service | Container / Resource | Stored Fields | Retention / Minimization |
| --- | --- | --- | --- |
| **Mailing list & newsletter** | Resend API & Audience Segments | Email address, subscription date, delivery status, consent source | Contact stored in Resend until unsubscribed or deleted. Audit consent in `admin_audit_logs` carries masked email only (`a***@example.com`). Unconfirmed signups are never persisted in Cosmos or Resend: they are issued as an HMAC-signed token with a 48h TTL directly to the subscriber's email (`functions/src/lib/newsletter/handlers.js`). If unconfirmed, they lapse with zero data retained on the estate. |
| **Ambassador hub** | Cosmos DB container `ambassador` (`cosmos-site-prod-cus` / `hcw`) | The owner's own Ambassador hub: programs, the owner's applications to them, and their evidence (`functions/src/lib/ambassador/validate.js`). No field is dedicated to third-party personal data, but editor-gated free-text fields (`notes`, `responses`, `customValues`, `reviewerFeedback`, `statusNote`, `description`) hold whatever an editor types, and `files` and `images` reference attachments: an external URL, or a private blob path in storage account `stsiteprodcus01` (container `speakerevents` by default) | Kept until the owner deletes them. No container TTL (#1234 set one in error; it was removed by #1238 before any apply). A request searches the text fields and opens every referenced file and image (Step 2 of sections 3 and 4). |
| **Public submissions** | Cosmos DB container `content` (`storageCollection == 'content'`) | Title, summary, content, cloudProvider, tags, language | Codebase audit (#1237) confirms public submissions (`functions/src/lib/submissions.js`) are completely anonymous. No submitter or author email address is accepted, ingested, or stored (`submitterEmail` and `authorEmail` do not exist). |
| **Disaster recovery backups** | Azure Blob Storage container `cosmos-export` on account `stsiteprodcus01` (`rg-stor-site-prod-cus`) | Point-in-time snapshot gzip NDJSON of Cosmos containers | Retained for exactly 35 days under immutable storage lifecycle management policy `expire-cosmos-export` (ADR 0028). Purged automatically upon lifecycle expiry. |
| **Interview recordings** | Azure Blob Storage container `interviews-audio` on account `stsiteprodcus01` (`rg-stor-site-prod-cus`), prefix `audio/`; transcripts beside it under `transcripts/` | A guest's voice recording (`audio/<interviewId>.<ext>`) and the transcripts made from it (`transcripts/<interviewId>/v<n>.json`); the interview document in Cosmos `content` holds the guest's name, role, bio, consent record and the recording's path, size and hash, never the audio | Recordings and their previous versions are deleted by lifecycle rule `expire-interview-audio` after `interview_audio_retention_days` (365 by default, set in the HCP Terraform workspace; ADR 0040, [#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565)), then restorable for 7 more days by the account's soft delete. Transcripts are kept until the interview is deleted from the admin. Private container: no public URL, no player, written and read by the Function App identity only. A request deletes the recording with the admin page's "Delete recording" button, or the whole interview (document, recording and transcripts) with the delete route. |

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

### Step 4: Immutable backup lifecycle disclosure
Under GDPR Article 17(3)(b) and EDPB guidelines, data in immutable disaster-recovery backups cannot and should not be modified in place.
- Inform the data subject: "Your live database records and mailing list subscriptions have been permanently erased. Data in disaster-recovery backups is held in write-once encrypted snapshots in Azure Blob Storage (`stsiteprodcus01/cosmos-export`) and will be automatically purged upon expiration of the 35-day backup retention window."

### Step 5: Interview recordings (`interviews-audio`)

A guest's recording is a blob in the private `interviews-audio` container; the interview document in Cosmos `content` points at it (`provenance.audio.path`, and any earlier paths under `provenance.audio.superseded`). The admin page's "Delete recording" button and the interview-aware delete route arrive with the content-type slice of [#1565](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1565); until they do, erase by hand:

1. Read the paths from the document (`GET /api/cms/content/{id}` as an editor, with the interview's id): `provenance.audio.path` and every entry of `provenance.audio.superseded`. Note the interview id.
2. The storage account refuses requests from outside the Function App's subnet, so the delete is run from a workstation added to its firewall for the minutes it takes. Add the workstation (PowerShell; `$ip` is the workstation's public IPv4 address, read from `https://api.ipify.org`):

   ```powershell
   $ip = (Invoke-RestMethod https://api.ipify.org).Trim()
   az storage account network-rule add --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --ip-address $ip -o none
   ```

3. Delete each path read in step 1, including its versions (`--delete-snapshots include` removes snapshots; versions are removed by deleting the current blob when versioning keeps them only until the `expire-interview-audio` rule's days have passed, so delete them by name as well when the listing shows any):

   ```powershell
   az storage blob delete --account-name stsiteprodcus01 --auth-mode login -c interviews-audio -n "audio/<interviewId>/<uploadId>.mp3" --delete-snapshots include -o none
   az storage blob list --account-name stsiteprodcus01 --auth-mode login -c interviews-audio --prefix "audio/<interviewId>/" --include v -o table
   ```

   The listing should show no current blob under the interview's folder; versions it still lists are deleted with `az storage blob delete ... --version-id <id>` for each, which the Function App identity's Storage Blob Data Owner grant also allows the delete helper to do once it exists.
4. Remove the workstation again (same `$ip`):

   ```powershell
   az storage account network-rule remove --account-name stsiteprodcus01 -g rg-stor-site-prod-cus --ip-address $ip -o none
   ```

5. Clear the pointer on the document so nothing references a deleted blob: `POST /api/updateContentItem` as an editor with the body `{ "contentId": "<interviewId>", "updates": { "provenance": { "source": "upload", "audio": {} } } }` (the recording's path, size, hash and `superseded` list all go; `provenance` is written whole, so repeat any other `provenance` fields the document carried).
6. Tell the data subject: the recording is removed from live storage; the account's soft delete keeps a deleted blob restorable for 7 days, after which it is unrecoverable, and the transcripts (`transcripts/<interviewId>/`) are deleted the same way when the request covers them.

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
