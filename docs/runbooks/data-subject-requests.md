# Data-subject request runbook (Access, Export, and Erasure)

**What this is for:** executing data subject requests under GDPR (Articles 15, 17, 20) and CCPA/CPRA across the HybridCloudWorks estate.

**Scope:** personal data held in production databases (Cosmos DB), external delivery providers (Resend), and immutable backup archives (Azure Blob Storage).

---

## 1. Inventory of personal data stores

Personal data is collected across three functional areas:

| Store / Service | Container / Resource | Stored Fields | Retention / Minimization |
| --- | --- | --- | --- |
| **Mailing list & newsletter** | Resend API & Audience Segments | Email address, subscription date, delivery status, consent source | Contact stored in Resend until unsubscribed or deleted. Audit consent in `admin_audit_logs` carries masked email only. Unconfirmed signups expire via signed token fragment (48h TTL). |
| **Ambassador program** | Cosmos DB container `ambassador` (`docType == 'application'`) | Full name, email address, application text, links, social handles | Applications kept for review. Enforced by container TTL `default_ttl = 7776000` (90 days) in container spec (`infra/cosmos-containers.json`). |
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

### Step 2: Query Cosmos DB `ambassador` container
```sql
SELECT c.id, c.docType, c.applicantName, c.applicantEmail, c.answers, c.createdAt
FROM c
WHERE c.docType = "application" AND (c.applicantEmail = "<USER_EMAIL>" OR c.email = "<USER_EMAIL>")
```

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

### Step 2: Delete from Cosmos DB `ambassador` container
Using Azure CLI or Cosmos DB data explorer:
```bash
# Locate document id from query
DOC_ID=$(az cosmosdb sql query \
  --account-name "cosmos-hcw-prod-cus" \
  --database-name "hcw" \
  --container-name "ambassador" \
  --query-text "SELECT VALUE c.id FROM c WHERE c.applicantEmail = '<USER_EMAIL>'" \
  --output tsv)

if [ -n "$DOC_ID" ]; then
  az cosmosdb sql document delete \
    --account-name "cosmos-hcw-prod-cus" \
    --database-name "hcw" \
    --container-name "ambassador" \
    --partition-key-value "$DOC_ID" \
    --id "$DOC_ID" \
    --yes
fi
```

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

| Field | Record |
| --- | --- |
| **Exercise Date** | 2026-10-16 |
| **Test Subject Identity** | `data-subject-exercise-20261016@hybridcloudworks.com` |
| **Simulated Assets** | 1. Resend contact in `default` segment<br>2. Simulated application in `ambassador` container<br>3. Simulated submission in `content` container |
| **Execution Steps** | 1. Contact looked up in Resend API -> Exported -> Deleted via `DELETE /contacts/{id}`.<br>2. Application queried in `ambassador` -> Document deleted by id.<br>3. Submission in `content` -> Redacted submitterEmail to null.<br>4. Backup retention confirmed: 35-day blob lifecycle policy verified active on storage account `sthcwprodbackupscus`. |
| **Result** | **PASS.** Re-query across all three containers returned zero matching records. |
| **Exercised by** | Automated compliance pipeline / Engineering review |
