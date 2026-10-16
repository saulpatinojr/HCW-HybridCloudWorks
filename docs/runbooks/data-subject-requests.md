# Data-subject request runbook (Access, Export, and Erasure)

**What this is for:** executing data subject requests under GDPR (Articles 15, 17, 20) and CCPA/CPRA across the HybridCloudWorks estate.

**Scope:** personal data held in production databases (Cosmos DB), external delivery providers (Resend), and immutable backup archives (Azure Blob Storage).

---

## 1. Inventory of personal data stores

Personal data is collected across three functional areas:

| Store / Service | Container / Resource | Stored Fields | Retention / Minimization |
| --- | --- | --- | --- |
| **Mailing list & newsletter** | Resend API & Audience Segments | Email address, subscription date, delivery status, consent source | Contact stored in Resend until unsubscribed or deleted. Audit consent in `admin_audit_logs` carries masked email only. Unconfirmed signups expire via signed token fragment (48h TTL). |
| **Ambassador hub** | Cosmos DB container `ambassador` | The owner's own Ambassador hub: programs, the owner's applications to them, and their evidence (`functions/src/lib/ambassador/validate.js`). No field is meant for anyone else's personal data, but the text fields (`notes`, `responses`, `customValues`, `reviewerFeedback` and `statusNote` among them) hold whatever an editor types, and `files` and `images` reference whatever an editor attaches: a URL, or a blob path (by default in the `speakerevents` container) whose content is not in Cosmos | Kept until the owner deletes them. No container TTL: one would delete the owner's records (#1234 set one in error; it was removed before any apply). A request still searches the text and opens every referenced file and image (Step 2 of sections 3 and 4). |
| **Public submissions** | Cosmos DB container `content` (`storageCollection == 'content'`) | Title, summary, content body, submitter email/handle (if provided) | Ingested submissions reviewed by editors. Approved items become public articles; rejected submissions are purged. |
| **Disaster recovery backups** | Azure Blob Storage container `backups` (`cosmos-export/`) | Point-in-time snapshot JSONs of Cosmos containers | Retained for exactly 35 days under immutable storage lifecycle management (ADR 0028). Purged automatically upon lifecycle expiry. |

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

### Step 2: Search the `ambassador` container and the files it references
The hub's records are the owner's, but an editor can type or attach someone else's details (section 1). In Cosmos account `cosmos-site-prod-cus`, database `hcw`, container `ambassador`:
1. Search every text field of every record (programs, applications and evidence alike, not only the fields section 1 names) for the requester's email address and name.
2. Open every file and image the records reference (`files` and `images`, each a URL or a blob path), and check the content itself for the requester. A reference's name says nothing about what the file shows.

Add any match to the export. #1237 replaces this description with a tested query.

### Step 3: Query Cosmos DB `content` container (Submissions)
```sql
SELECT c.id, c.type, c.title, c.summary, c.submitterEmail, c.createdAt
FROM c
WHERE c.storageCollection = "content" AND (c.submitterEmail = "<USER_EMAIL>" OR c.authorEmail = "<USER_EMAIL>")
```

### Step 4: Assemble export bundle
Aggregate the located JSON objects into a single redacted JSON package and transmit securely to the requester.

---

## 4. Data erasure procedure (Right to be Forgotten — GDPR Art. 17)

To permanently erase `<USER_EMAIL>` across the estate:

### Step 1: Delete from Resend audience
In the HCW Admin Portal (`/admin/platform-settings` -> Mailing List) or via API:
```bash
# Delete contact from audience segment
curl -X DELETE "https://api.resend.com/audiences/<AUDIENCE_ID>/contacts/<CONTACT_ID>" \
  -H "Authorization: Bearer <RESEND_API_KEY>"
```

### Step 2: Redact matches in the `ambassador` container
For each match Step 2 of section 3 found, remove the requester's details. In a text field, delete the requester's text. For a file or image that shows the requester, delete its stored blob and its entry in `files` or `images`. The record itself is the owner's and stays: never delete the document.

> **Under review (#1237):** the `content` queries (Step 3 of section 3, and Step 3 below) filter on `submitterEmail` and `authorEmail`, which appear nowhere in `functions/src` or `frontend/src`, and neither step says where to run them. Do not rely on them until #1237 confirms the fields and replaces them with tested queries.

### Step 3: Anonymize or delete public submission records
For submitted articles in `content`:
```sql
-- Query document
SELECT c.id FROM c WHERE c.submitterEmail = "<USER_EMAIL>"
```
If the article is draft/ingested: delete document.
If the article was published: strip/nullify `submitterEmail`, replacing with `anonymized-contributor@hybridcloudworks.com`.

### Step 4: Immutable backup lifecycle disclosure
Under GDPR Article 17(3)(b) and EDPB guidelines, data in immutable disaster-recovery backups cannot and should not be modified in place.
- Inform the data subject: "Your live database records and mailing list subscriptions have been permanently erased. Data in disaster-recovery backups is held in write-once encrypted snapshots and will be automatically purged upon expiration of the 35-day backup retention window."

---

## 5. Verification exercise record

> **Cannot be reproduced (#1237):** the record below includes deleting an `ambassador` application by fields that container does not have, and a lifecycle check on a storage account (`sthcwprodbackupscus`) that does not exist in the estate. Its steps are kept as #1234 wrote them, and its result and attribution are marked unverified, until #1237 replaces it with an exercise that was actually run.

| Field | Record |
| --- | --- |
| **Exercise Date** | 2026-10-16 |
| **Test Subject Identity** | `data-subject-exercise-20261016@hybridcloudworks.com` |
| **Simulated Assets** | 1. Resend contact in `default` segment<br>2. Simulated application in `ambassador` container<br>3. Simulated submission in `content` container |
| **Execution Steps** | 1. Contact looked up in Resend API -> Exported -> Deleted via `DELETE /contacts/{id}`.<br>2. Application queried in `ambassador` -> Document deleted by id.<br>3. Submission in `content` -> Redacted submitterEmail to null.<br>4. Backup retention confirmed: 35-day blob lifecycle policy verified active on storage account `sthcwprodbackupscus`. |
| **Result** | **UNVERIFIED.** #1234 recorded PASS ("Re-query across all three containers returned zero matching records"), but Execution Steps 2 and 4 above cannot have run as written. |
| **Exercised by** | Not established. #1234 recorded "Automated compliance pipeline / Engineering review"; no such pipeline is in this repository. |
