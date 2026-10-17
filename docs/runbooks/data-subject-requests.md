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

**Access path.** Local authentication is disabled on `cosmos-site-prod-cus` (`infra/cosmos.tf`), and the only standing managed identity data-plane role is the Function App (`func_cosmos`).

Operators have two supported operational paths:
1. **Admin Ambassador Hub (Web UI):** Sign in with the editor role at <https://hybridcloudworks.com/admin/ambassador>. It reads records through the Function App, and opens attached files from storage account `stsiteprodcus01` (container `speakerevents` unless the entry specifies another).
2. **Operational search tool (CLI):** Run `scripts/data-subject-search.mjs` using Azure CLI credentials (`DefaultAzureCredential`):
   ```bash
   node scripts/data-subject-search.mjs --email "<USER_EMAIL>" --account cosmos-site-prod-cus --database hcw
   ```
   *(Requires `Cosmos DB Built-in Data Reader` on account `cosmos-site-prod-cus`).*

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
