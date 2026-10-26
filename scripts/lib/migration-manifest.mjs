/**
 * migration-manifest.mjs
 *
 * The collection contract used to generate the website's Cosmos containers.
 *
 * The one-shot import tooling that created this file has been retired. The
 * manifest remains because Terraform and the container-spec generator still
 * need one source of truth for provisioned containers, partition keys, TTLs,
 * and historical data-disposition notes.
 *
 * The inventory was originally derived from the former Firebase rules and
 * application call sites in HybridCloudWorks/Site-Main. Those source files
 * are historical inputs and are no longer part of this repository.
 *
 * Re-baselined against Site-Main 088f458 (2026-08-18, v1.7.0) on 2026-08-20.
 * Site-Main's own inventory (`npm run inventory:collections` there) lists 68
 * collections; every one is either here or deliberately not. The two it has
 * that were missing here — `azure_architectures` and `azure_frameworks`,
 * written by `scripts/seed_azure_data.js` and matched by no rule — are now
 * `probe` entries so the preflight counts them instead of failing on them.
 * The current application contract is validated by the API and Terraform
 * checks in this repository. Keep this list aligned with those consumers.
 *
 * ---------------------------------------------------------------------------
 * Dispositions
 * ---------------------------------------------------------------------------
 *   migrate   — historical source-data disposition. The default.
 *   reseed    — seed data; re-created on the far side by a seeding script, so
 *               migrating it only imports drift. Container still provisioned.
 *   regenerate— cache; a scheduled job refills it. Do not migrate.
 *   transient — in-flight job/quota records with no value after cutover.
 *   azure-only— created on Azure after cutover, with no Firestore source at
 *               all. Provisioned, never migrated: there is nothing to copy.
 *               The first was `ambassador` (ADR 0033 §4).
 *   probe     — historical declaration with no known application writer.
 *               Also: exists in Firestore with neither a rules match nor a
 *               writer at the baseline (legacy residue the 2026-08-21 preflight
 *               surfaced). Not provisioned; the owner decides from the counts.
 *               OWNER DECISION 2026-08-21 (runbook step 8): none of the fifteen
 *               probe entries migrates. The ten declared-but-unwritten ones are
 *               empty in Firestore; the five legacy ones hold seven documents
 *               between them and nothing reads them. They stay listed so the
 *               preflight gate passes for a reason rather than by omission.
 *               The preflight decides: 0 docs → drop, >0 docs → promote to
 *               `migrate` and work out where they came from before cutover.
 *
 * Provisioning and migrating are separate questions. A cache or a transient
 * job record does not get its *data* copied, but the runtime still writes to
 * it — `functions/src/functions/labs-http.js` reads and writes `lab_jobs` on
 * every request — so the container must exist. Everything except `probe` gets
 * a container; only `migrate` gets documents.
 *
 * ---------------------------------------------------------------------------
 * Partition keys
 * ---------------------------------------------------------------------------
 * Every container is partitioned on `/id` except `content_versions` and
 * `admin_config`. The
 * evidence, from the Site-Main source rather than from the shape of the target:
 *
 *   1. The query load does not group by anything. All 18 Firestore composite
 *      indexes plus every `where()` in Site-Main show `content` filtered on
 *      `contentStatus`, `Live`, `type`, `slug`, `sourceUrl`, `normalizedUrl`,
 *      `source` and `fetchedAt`. Exactly one call site filters on a provider.
 *      A `/cloudProvider` key would have been 4–5 distinct values serving well
 *      under 1% of queries, fanning out on everything else.
 *   2. The previous "natural" keys were wrong on their own merits, not merely
 *      suboptimal:
 *        - `generated_content_images./contentId` — `cms-functions.js:3139` and
 *          `:5573` write `contentId: ''` on every document, which would have
 *          put the whole container in one logical partition keyed on the empty
 *          string, converging on the 20 GB logical-partition cap.
 *        - `lab_jobs./status` — a *mutable* field. A partition key value cannot
 *          be changed in place; Cosmos requires delete-and-recreate. Job
 *          documents transition queued → running → completed. This was a latent
 *          data-loss bug.
 *        - `lab_agents./agentId` — `vps-agent/index.js:33-34` writes
 *          `id: AGENT_ID, agentId: AGENT_ID`. Identical to `/id` by construction.
 *        - `certifications./issuer`, `audits./userId` — low cardinality, and
 *          `audits` is never queried at all.
 *   3. ~1,100 small documents across every container, well under 1 GB total.
 *      RU cost for a cross-partition query is driven by the number of *physical*
 *      partitions, not logical ones, and a container does not split until ~50 GB
 *      or sustained demand above 5,000 RU/s. Every container here is one
 *      physical partition, so "cross-partition" list queries are single-backend
 *      index scans. That stays true at 10x.
 *   4. `/id` makes the 20 GB logical-partition cap structurally unreachable, and
 *      `id` stays indexed even in the opt-in index policies below, because
 *      Cosmos always indexes `id` and `_ts` under `indexingMode: consistent`.
 *
 * `functions/src/lib/cosmos-client.js:60` also defaults the partition key to the
 * document id (`container.item(id, partitionKey || id)`), which agrees with the
 * above — but note this is a weak argument on its own: there are no `readDoc()`
 * callers at all, and the only affected line today is the `deleteDoc('content')`
 * at `functions/src/functions/cms-http.js:85`.
 *
 * EXCEPTION ONE — `content_versions` is partitioned on `/contentId`:
 *
 *   Every access to version history is scoped to one parent content document —
 *   `VersionHistoryDialog.jsx:33` reads `content/{blogId}/versions`, and
 *   `cms-functions.js:2832` does `recursiveDelete(ref.collection('versions'))`,
 *   a delete-all-versions-for-one-parent cascade. A new version document is
 *   written on every content save (`cms-functions.js:1822, 3810, 3903, 4607,
 *   4874`), so this is the one container with unbounded growth. `/contentId`
 *   makes both the read and the cascade single-partition; `/id` would fan out
 *   on both, forever.
 *
 *   There is a second reason specific to flattened subcollections: document ids
 *   are unique *per logical partition*, so under `/id` they must be globally
 *   unique across the container, and two version documents under different
 *   parents that share an id collide. Under `/contentId` they land in different
 *   logical partitions and coexist. The migrator detects such collisions at
 *   export time, but that is a permanent runtime constraint, not just a
 *   migration one.
 *
 *   Atomicity, settled 2026-08-18 (owner decision, option (a) of the choice
 *   recorded in Site-Main TODO §2): the post-and-its-history all-or-nothing
 *   guarantee the Firestore transaction gave does NOT carry over — a Cosmos
 *   TransactionalBatch cannot span containers, and versions deliberately
 *   live in their own container for the reasons above. The accepted contract
 *   is SEQUENTIAL writes with the content write FIRST (see
 *   functions/src/lib/cms/content-update.js's header for the full rationale):
 *   a crash between the content write and the version upsert loses that one
 *   snapshot, and the reverse order could record history for an edit that
 *   never happened. All three writers (content-update.js,
 *   content-workflow.js, publish.js) follow this ordering today; keep any
 *   future version writer on it. Co-locating versions inside `content` to
 *   buy the batch back was considered and declined.
 *
 * EXCEPTION TWO — `admin_config` is partitioned on `/configScope`, a
 * CONSTANT (every document carries `configScope: 'admin_config'`):
 *
 *   Decided 2026-08-17 by the owner, recorded in Site-Main TODO §2: the
 *   ContentForge save writes `forge_profile` and `forge_prompts` as one
 *   all-or-nothing Firestore transaction, and a Cosmos TransactionalBatch
 *   only spans one container AND one logical partition. Under `/id` those
 *   two documents land in different partitions and the save loses its
 *   atomicity at the port. A constant key puts every `admin_config` document
 *   in one logical partition, so the forge save ports to a batch unchanged.
 *
 *   The knock-on, accepted in the same decision: everything in
 *   `admin_config` shares that single logical partition. That is fine at
 *   this container's size and nature — a handful of config documents
 *   (forge_profile, forge_prompts, forge_stats), not content — and nowhere
 *   near the 20 GB logical-partition cap.
 *
 * A partition key path is immutable once the container exists. Changing one
 * later means recreating the container and re-importing, so this needs sign-off
 * before the first Terraform apply. The full write-up — the Site-Main review
 * findings, the decision log and the runbook — lives on the
 * `Phase-4-Data-Migration` Wiki page, per the repository's documentation policy.
 */

/** Partition key path used by every container that does not override it. */
export const DEFAULT_PARTITION_KEY = '/id';

/**
 * Container TTLs, in seconds, for data that is worthless after a window.
 *
 * A container with no `default_ttl` retains everything forever, and every
 * document stays indexed. The rate-limit counters are the clearest case: a
 * one-hour tumbling window holding a hashed IP and an integer, which nothing
 * reads after the window closes. Two hours of TTL covers the window plus clock
 * skew, and lets the limiter drop its window arithmetic entirely — an expired
 * document simply is not there.
 *
 * A TTL requires `indexingMode: consistent`, which every container here uses.
 * Unlike a partition key, `default_ttl` IS mutable after creation, so these are
 * safe to tune later. They are set now because the containers do not exist yet
 * and the cost of getting it right is zero today.
 */
export const CONTAINER_TTL_SECONDS = Object.freeze({
  tool_export_quota: 7200, // 1h window + skew
  tool_ai_plan_quota: 7200,
  lab_public_quota: 7200,
  submission_quota: 7200,
  // Caches, which the scheduled refresh repopulates. Generous: the TTL is a
  // floor against unbounded growth, not the freshness mechanism — freshness is
  // cacheFreshness() and it is deliberately independent of this.
  tool_service_cache: 604800, // 7 days
  // One document per region per UTC day from the pricing refresh (#613 Phase
  // 3). 400 days: a year of history plus the slack to compare a day against
  // the same day last year, then gone. The TTL is the only reaper.
  tool_price_history: 34560000, // 400 days
  rss_cache: 604800,
  // Transient job records. Long enough to debug a failure after the weekend.
  lab_jobs: 2592000, // 30 days
  jobs: 2592000,
  // Hardened audit logs: 90 days retention floor
  admin_audit_logs: 7776000, // 90 days
  audits: 7776000, // 90 days
  // NOT `ambassador`. That container is the owner's Ambassador hub: the
  // programs, the owner's own applications to them and their evidence
  // (lib/ambassador), kept until the owner deletes them. No field is meant
  // for anyone else's personal data; what an editor types into its free-text
  // fields is found and redacted by docs/runbooks/data-subject-requests.md,
  // never expired. A container TTL expires every document not written within
  // the window, so one here would delete the owner's records. #1234 set 90 days in the belief it held applicants'
  // data; it was taken off before any apply (2026-10-16), and
  // generate-cosmos-container-spec.test.mjs refuses it.
});

/**
 * Top-level collections.
 *
 * `partitionKey` defaults to DEFAULT_PARTITION_KEY. `partitionKeyFromParent`
 * names a field the migrator populates with the parent document's id, so a
 * flattened subcollection can be partitioned by its parent.
 *
 * @type {Array<{
 *   name: string,
 *   disposition: 'migrate'|'reseed'|'regenerate'|'transient'|'probe',
 *   note?: string,
 *   partitionKey?: string,
 *   subcollections?: Array<{
 *     name: string,
 *     container: string,
 *     note?: string,
 *     parentDoc?: string,
 *     partitionKey?: string,
 *     partitionKeyFromParent?: string
 *   }>
 * }>}
 */
export const COLLECTIONS = [
  // --- Content -------------------------------------------------------------
  {
    name: 'content',
    disposition: 'migrate',
    note: 'The real one. ~947 docs. Carries the largest field payloads (contentMarkdown/contentHtml).',
    subcollections: [
      {
        name: 'versions',
        container: 'content_versions',
        // Partitioned by parent, not by /id — see the partition-key note above.
        // Every read is scoped to one content document and the delete is a
        // per-parent cascade, and this is the only container that grows without
        // bound (one document per content save).
        partitionKey: '/contentId',
        partitionKeyFromParent: 'contentId',
        note: 'Editor version history. Written server-side on every save; read by VersionHistoryDialog.jsx scoped to one parent. Not covered by an explicit rules match.',
      },
    ],
  },
  {
    name: 'blogs',
    disposition: 'migrate',
    note: 'Legacy, ~242 docs, reached only via a fallback path. Migration-Plan §3.6 decides whether this ships at all — until that decision lands, migrate it.',
  },
  { name: 'content_templates', disposition: 'migrate' },
  {
    name: 'content_stats_markers',
    disposition: 'migrate',
    note: 'Dashboard-stats trigger idempotency markers — one doc per content doc recording the position the counters were last moved to (Site-Main functions/cms/dashboard.js). Created in the 2026-08-17 trigger port, AFTER the 07f3123 review this manifest was built from; found by Site-Main scripts/inventory-collections.mjs on 2026-08-18. Migrated so the trigger stays idempotent across cutover instead of requiring an operator to remember recalculateDashboardStats.',
  },
  { name: 'certifications', disposition: 'migrate', note: '~110 docs, partly machine-generated from Microsoft Learn.' },
  { name: 'certEvents', disposition: 'migrate' },
  { name: 'speakerevents', disposition: 'migrate', note: '~18 docs.' },
  { name: 'podcasts', disposition: 'migrate' },
  { name: 'episodes', disposition: 'migrate', note: 'Top-level `episodes`. Distinct from listen_and_learn/{setId}/episodes.' },
  { name: 'youtubevideos', disposition: 'migrate' },
  { name: 'recordings', disposition: 'migrate' },
  {
    name: 'newsletters',
    disposition: 'migrate',
    note: 'Real production writer: cms-functions.js:9483 `.add()` with title/content/status/timestamps from the weekly-digest flow. Was `probe` until the source was checked.',
  },
  { name: 'roadmap_items', disposition: 'migrate' },
  { name: 'wiki_pages', disposition: 'migrate' },
  {
    name: 'listen_and_learn',
    disposition: 'migrate',
    subcollections: [
      {
        name: 'episodes',
        container: 'listen_and_learn_episodes',
        // The exam-area SLUG is the document id, scoped per set, and
        // listen-and-learn/publish.js:97-98 says so in its own comment:
        // "Regeneration is idempotent because the doc id is the area slug."
        // Sets are `${provider}_${examCode}` (publish.js:27-29), so there are
        // many, and area slugs recur across certifications constantly
        // (monitor-and-optimize, implement-workloads, …).
        partitionKey: '/setId',
        partitionKeyFromParent: 'setId',
        note: 'Ids are exam-area slugs, unique only within a set.',
      },
    ],
  },
  {
    // Azure-only, no Firestore source: written by the generate-podcast-transcript
    // job (functions/src/lib/podcast/store.js). Its own container, NOT a
    // reserved setId inside listen_and_learn_episodes — owner ruling on #435,
    // 2026-09-08: Listen & Learn is the Learn section's product and the
    // podcast is another. Ids are `article_<slug>` (and later
    // `plaud_<recordingId>`), globally unique by construction, so /id.
    name: 'podcast_transcripts',
    disposition: 'migrate',
    note: "Content transcripts: two-host scripts generated from published articles (#435) and Plaud recordings (#434), and their audio; the podcast's own product, distinct from listen_and_learn_episodes (Learn section). Azure-only, no Firestore source.",
  },

  // --- Architecture / frameworks -------------------------------------------
  { name: 'designs', disposition: 'migrate' },
  { name: 'frameworks', disposition: 'migrate' },
  { name: 'pillar_details', disposition: 'migrate' },
  { name: 'pillar_items', disposition: 'migrate' },
  {
    name: 'azure_landing_content',
    disposition: 'reseed',
    note: 'Seed data. scripts/seed_azure_data.js:139 writes one document, `main`, from a LANDING_PAGE_DATA constant held in the repo — so the source of truth is version control, not the database.',
  },
  {
    name: 'articles',
    disposition: 'probe',
    note: 'Only writer is scripts/populate-firestore.cjs:178, a seed script — likely superseded by `content`. The apparent second hit at functions/index.js:4347 is a false positive: a JSON-schema `required: [\'articles\']` field for an AI extraction tool, not a collection reference.',
  },

  // --- Identity and configuration ------------------------------------------
  {
    name: 'admins',
    disposition: 'migrate',
    note:
      'AUTHORISATION-CRITICAL. firestore.rules isAdmin() reads this collection; client access is ' +
      'explicitly denied. Losing it locks every admin out of the Azure deployment. Was absent ' +
      'from the previous COLLECTION_MAP.',
    // ---------------------------------------------------------------------
    // DECISION 2 — re-key from Firebase uid to Entra oid, BEFORE cutover
    // ---------------------------------------------------------------------
    // These documents are keyed by FIREBASE UID (admin-auth.js:219-220).
    // Nothing in the Azure runtime can resolve a Firebase uid: the role guard
    // looks up `admins/{oid}` using the Entra object id from the token
    // (functions/src/lib/auth/require-role.js). Migrating these documents
    // faithfully therefore produces a container the API cannot read — every
    // admin request 403s with "no admin record", which reads as a broken
    // deployment rather than a data problem.
    //
    // Straight migration is NOT sufficient here, and this is the one place in
    // the manifest where fidelity is the wrong goal.
    //
    // Required before cutover:
    //   1. Produce a uid -> oid mapping. The only reliable join key is the
    //      verified email: Firebase Auth's user export carries uid + email +
    //      emailVerified; Entra carries oid + mail/userPrincipalName.
    //   2. Have a human review it. This collection is the authorisation root
    //      and it is small (a handful of admins), so a reviewed, committed
    //      mapping is proportionate — do NOT trust-on-first-use by email, which
    //      would let anyone who controls a matching mailbox claim an admin row.
    //   3. Re-key on import, keeping the Firebase uid on the document as
    //      `firebaseUid` for the audit trail.
    //
    // Until that mapping exists this collection should NOT be imported to the
    // production account — an admins container keyed on uid is worse than an
    // empty one, because it looks populated.
    requiresIdentityRemap: {
      from: 'firebaseUid',
      to: 'entraOid',
      joinOn: 'verified email',
      blocks: 'cutover',
    },
  },
  {
    name: 'admin_config',
    disposition: 'migrate',
    // Constant key — see EXCEPTION TWO in the partition-key notes above. The
    // migrator stamps `configScope` on every document it copies; runtime
    // writers set it on create (cosmos-client exports the constant).
    partitionKey: '/configScope',
    partitionKeyConstant: 'admin_config',
    note: 'ContentForge config (forge_profile, forge_prompts, forge_stats). Constant partition key so the forge save stays one transactional batch — owner decision 2026-08-17; the whole container deliberately shares one logical partition.',
  },
  { name: 'admin_settings', disposition: 'migrate' },
  { name: 'site_settings', disposition: 'migrate' },
  { name: 'system', disposition: 'migrate' },
  {
    name: 'metadata',
    disposition: 'probe',
    note: 'Only writer is scripts/populate-firestore.cjs:203, a seed script. The src/ hits are false positives — an HTML preload attribute and a tab value.',
  },
  {
    name: 'users',
    disposition: 'probe',
    note: 'Has a rules match but ZERO references of any kind in Site-Main — not a collection() call, not a string literal, nothing. Nothing reads or writes it. The previous COLLECTION_MAP migrated it unconditionally. Only the preflight can say whether it holds legacy rows; if it is empty, drop it.',
  },
  {
    name: 'config',
    disposition: 'migrate',
    note:
      'TRAP: `config` holds no documents of its own. firestore.rules matches ' +
      '`config/providers/{providerId}`, `config/tags/{tagId}` and ' +
      '`config/settings/{settingId}` — the payload lives in three ' +
      'subcollections under three (possibly non-existent) parent documents. ' +
      '`firestore.collection("config").get()` returns zero docs, so the ' +
      'previous script migrated nothing here and the count check passed at 0=0.',
    subcollections: [
      { name: 'providers', container: 'config_providers', parentDoc: 'providers' },
      { name: 'tags', container: 'config_tags', parentDoc: 'tags' },
      { name: 'settings', container: 'config_settings', parentDoc: 'settings' },
    ],
  },

  // --- Audit ---------------------------------------------------------------
  { name: 'audits', disposition: 'migrate' },
  { name: 'admin_audit_logs', disposition: 'migrate' },
  { name: '_snapshots', disposition: 'migrate', note: 'Leading underscore is legal in Cosmos container names.' },

  // --- Spotlight -------------------------------------------------------------
  {
    name: 'ambassador',
    disposition: 'azure-only',
    note: 'Ambassador hub (ADR 0033 §4). One container, documents told apart by `docType`: `program` (the catalogue, seeded on first read), `application` (one pursuit of one program, private), `evidence` (a talk, cert or article linked by {sourceModule, sourceId} with a snapshot). Partitioned on /id like every other small container; every list is a docType filter over one physical partition.',
  },

  // --- Doc Vault -------------------------------------------------------------
  {
    name: 'doc_vault',
    disposition: 'azure-only',
    note: 'Doc Vault (owner request 2026-10-26): the owner\'s own templates, applications, letters and notes, admin-only (publisher), never on the public site. Its own container so that no public read, and no other feature, can reach it by naming another one. Documents told apart by `docType`: `document` (the current version) and `version` (an earlier one, id `<documentId>~v<n>`). Partitioned on /id; the text (`/body/*`) is not indexed.',
  },

  // --- Social --------------------------------------------------------------
  { name: 'social_posts', disposition: 'migrate', note: '~15 docs. 5 call sites — the only live one of the social_* set.' },
  // The remaining social_* collections have a firestore.rules match
  // (rules:105-135) but ZERO collection() call sites anywhere in Site-Main's
  // src/ or functions/. That is the definition of `probe` — provisioning and
  // migrating five containers nothing touches. The preflight decides.
  { name: 'social_workspaces', disposition: 'probe', note: 'No call sites in Site-Main; rules match only.' },
  { name: 'social_libraries', disposition: 'probe', note: 'No call sites in Site-Main; rules match only.' },
  { name: 'social_library_items', disposition: 'probe', note: 'No call sites in Site-Main; rules match only.' },
  { name: 'social_schedule_slots', disposition: 'probe', note: 'No call sites in Site-Main; rules match only.' },
  { name: 'social_analytics', disposition: 'probe', note: 'No call sites in Site-Main; rules match only.' },
  { name: 'telegram_bot_activity', disposition: 'migrate' },
  {
    name: 'plaud_ingest',
    disposition: 'migrate',
    note: 'Real production writer: cms-functions.js:8820 `admin.firestore().collection(...).add()`. Was `probe` until the source was checked.',
  },

  // --- AI / prompts / images -----------------------------------------------
  { name: 'ai_providers', disposition: 'migrate' },
  // ai_insights was here, disposition 'migrate', until 2026-09-05: the panel
  // that read it was retired (T-765, #339) and nothing ever wrote it, so the
  // owner decided to drop the container. Removing the entry removes it from
  // infra/cosmos-containers.json, and the apply that follows DESTROYS the
  // container and the documents the 2026-08-21 migration put in it.
  { name: 'ai_usage', disposition: 'migrate' },
  { name: 'mcp_servers', disposition: 'migrate' },
  { name: 'prompts', disposition: 'migrate' },
  { name: 'prompt_keyword_synonyms', disposition: 'migrate' },
  { name: 'prompt_keyword_augmentations', disposition: 'migrate' },
  {
    name: 'image_prompts',
    disposition: 'migrate',
    subcollections: [
      {
        name: 'sets',
        container: 'image_prompts_sets',
        // The set NAME is the document id, scoped per page:
        // `doc(db, 'image_prompts', pageDocId, 'sets', normalizedSetName)`
        // (useImagePrompts.js:94). The same set name recurs under many pages —
        // findLegacySetByName (useImagePrompts.js:121-175) exists precisely
        // because it does. Under /id those would overwrite each other.
        partitionKey: '/pageId',
        partitionKeyFromParent: 'pageId',
        note: 'Deliberately NOT `image_prompt_sets` — that name is already a distinct top-level collection. Ids are set names, unique only within a page.',
      },
    ],
  },
  {
    name: 'image_prompt_sets',
    disposition: 'migrate',
    subcollections: [
      {
        name: 'prompts',
        container: 'image_prompt_sets_prompts',
        // The prompt NAME is the document id, scoped per set:
        // `.collection('image_prompt_sets').doc(normalizedSetName)
        //  .collection('prompts').doc(normalizedPromptName)`
        // (cms-functions.js:5684-5688). The whole point of a set is to hold the
        // same named prompt roles — hero, cover, thumbnail — so collisions
        // across sets are the expected steady state, not an edge case.
        partitionKey: '/setName',
        partitionKeyFromParent: 'setName',
        note: 'Ids are prompt names, unique only within a set.',
      },
    ],
  },
  { name: 'image_prompt_pages', disposition: 'migrate' },
  { name: 'generated_content_images', disposition: 'migrate' },
  { name: 'curated_article_images', disposition: 'migrate' },
  { name: 'character_profiles', disposition: 'migrate' },
  { name: 'character_modules', disposition: 'migrate' },
  { name: 'character_images', disposition: 'migrate' },
  { name: 'character_tag_adjectives', disposition: 'migrate' },
  {
    name: 'homepage_feeds',
    disposition: 'regenerate',
    note: 'Derived cache, not source data. functions/index.js:1378 writes exactly one document, `latest`, holding {items, generatedAt, itemCount} assembled from the provider feeds. Rebuild it on the far side rather than importing a stale snapshot.',
  },

  // --- Workflow ------------------------------------------------------------
  { name: 'workflow_digests', disposition: 'migrate' },
  { name: 'workflow_alerts', disposition: 'migrate' },

  // --- Cloud Tools ---------------------------------------------------------
  {
    name: 'tool_service_catalog',
    disposition: 'reseed',
    note: 'Seed data (~8 docs). Re-seed on the far side rather than import drift.',
  },
  {
    name: 'tool_service_cache',
    disposition: 'regenerate',
    note: 'Cache (~8 docs). The scheduled refresh rebuilds it.',
  },
  {
    // Azure-only, no Firestore source. Written by the refresh-tool-pricing
    // job (functions/src/lib/cloud-tools/history.js, #613 Phase 3): one
    // document per region per UTC day, `history:<region>:<YYYY-MM-DD>`, read
    // back by id only — the change detection walks day ids, never queries —
    // so /id. `regenerate` because the daily refresh is its only writer and
    // refills it going forward; what it does NOT do is backfill, so a lost
    // container is a price-change feed that restarts from empty.
    name: 'tool_price_history',
    disposition: 'regenerate',
    note: 'Daily price snapshots per region (#613 Phase 3), 400-day TTL. Written by the pricing refresh; the price-change feed diffs them. Azure-only, no Firestore source.',
  },
  { name: 'tool_workspaces', disposition: 'migrate' },
  { name: 'tool_migration_workspaces', disposition: 'migrate' },
  { name: 'tool_assessment_sessions', disposition: 'migrate' },
  { name: 'tool_architecture_plans', disposition: 'migrate' },
  { name: 'tool_exports', disposition: 'migrate' },
  { name: 'tool_export_quota', disposition: 'transient', note: 'Per-user rate-limit counters. Let them reset at cutover.' },
  { name: 'tool_ai_plan_quota', disposition: 'transient', note: 'Per-user rate-limit counters. Let them reset at cutover.' },

  // --- Labs ----------------------------------------------------------------
  { name: 'lab_jobs', disposition: 'transient', note: '~11 in-flight job records. Worthless after cutover.' },
  { name: 'submission_quota', disposition: 'transient', note: 'Anonymous public-submission rate-limit counters, keyed by hashed client identity. Azure-only: no Firestore source, created by public-submissions.js.' },
  { name: 'jobs', disposition: 'transient', note: 'Azure-only: in-platform asynchronous jobs (functions/src/lib/jobs.js, T-322) — the six handlers over the 230 s HTTP cap run here. No Firestore source.' },
  { name: 'lab_public_quota', disposition: 'transient', note: 'Per-uid rate-limit counters.' },
  { name: 'lab_agents', disposition: 'migrate', note: 'Agent registrations — coordinate with vps-agent before cutover.' },

  // --- Caches --------------------------------------------------------------
  {
    name: 'rss_cache',
    disposition: 'regenerate',
    note: '~24 docs. Regenerable — let the scheduled fetch refill it.',
  },

  // --- Seeder-written, no rule, no reader found ----------------------------
  // Both are written by Site-Main `scripts/seed_azure_data.js` and appear in
  // neither firestore.rules (so default-deny to clients) nor any read path
  // found at 088f458. `azure_landing_content`, which the same seeder writes,
  // IS read and IS provisioned above. These two are probes: the preflight
  // reports a count, and that count decides drop vs promote before cutover.
  {
    name: 'azure_architectures',
    disposition: 'probe',
    note: 'Written by Site-Main scripts/seed_azure_data.js; no rules match, no reader found at 088f458. Preflight decides.',
  },
  {
    name: 'azure_frameworks',
    disposition: 'probe',
    note: 'Written by Site-Main scripts/seed_azure_data.js; no rules match, no reader found at 088f458. Preflight decides.',
  },

  // ── Surfaced by the first preflight against live Firestore, 2026-08-21 ───
  // Run 32435842524 found these five exist with documents but had no manifest
  // entry. None has a firestore.rules match at 088f458. Listed so the gate
  // passes for a reason rather than by omission; every one is the owner's call
  // at runbook step 8, and `probe` keeps them out of the container spec.
  {
    name: '_rowy_',
    disposition: 'probe',
    note: '3 docs + populated `schema` and `users` subcollections. Metadata of Rowy, the Firestore admin GUI (its three service accounts still exist in the GCP project). No Site-Main reference of any kind. Expect: drop.',
  },
  {
    name: 'admin_audit_log',
    disposition: 'probe',
    note: '1 doc. The SINGULAR name — Site-Main FINDING-07 renamed the writer to `admin_audit_logs` because the singular had no rules entry; this is the document written before that fix. Expect: drop (the plural holds 2,921).',
  },
  {
    name: 'dashboard_stats',
    disposition: 'probe',
    note: '1 doc, `dashboard_stats/v1`, derived counters written by Site-Main cms/dashboard.js from the maintainDashboardStats trigger. The Azure port already keeps this document as `system/dashboard_stats_v1` (functions/src/lib/admin-snapshots.js) and the ported trigger recomputes it — so: no container, regenerate on the far side. Expect: drop from the manifest once the trigger port lands.',
  },
  {
    name: 'drafts',
    disposition: 'probe',
    note: '1 doc. Site-Main uses "drafts" only as an EditorListPage scope key, never as a collection. Expect: drop.',
  },
  {
    name: 'summaries',
    disposition: 'probe',
    note: '1 doc. No Site-Main reference of any kind. Expect: drop.',
  },
];

/** Dispositions that result in documents being copied. */
export const MIGRATED_DISPOSITIONS = new Set(['migrate']);

/**
 * Dispositions that need a Cosmos container provisioned.
 *
 * Everything except `probe`: a cache or a quota counter carries no data across
 * the migration, but the runtime writes to it from the first request onwards.
 * `probe` collections stay unprovisioned until the preflight confirms they
 * exist and hold something.
 */
export const PROVISIONED_DISPOSITIONS = new Set([
  'migrate',
  'reseed',
  'regenerate',
  'transient',
  'azure-only',
]);

/**
 * Flatten the manifest into one entry per Cosmos container.
 *
 * Subcollections become their own containers. Firestore's implicit-parent
 * behaviour means a subcollection can hold documents while its parent document
 * does not exist, so subcollections are enumerated with a collection-group
 * query rather than by walking parents.
 *
 * @param {{ includeNonMigrated?: boolean }} [options]
 * @returns {Array<{
 *   container: string,
 *   sourcePath: string,
 *   collectionId: string,
 *   isSubcollection: boolean,
 *   parent: string|null,
 *   disposition: string,
 *   partitionKey: string,
 *   partitionKeyFromParent: string|null,
 *   partitionKeyConstant: string|null,
 *   note?: string
 * }>}
 */
export function flattenManifest({ includeNonMigrated = false } = {}) {
  const out = [];

  for (const entry of COLLECTIONS) {
    const keep = includeNonMigrated || MIGRATED_DISPOSITIONS.has(entry.disposition);

    if (keep) {
      out.push({
        container: entry.name,
        sourcePath: entry.name,
        collectionId: entry.name,
        isSubcollection: false,
        parent: null,
        disposition: entry.disposition,
        partitionKey: entry.partitionKey ?? DEFAULT_PARTITION_KEY,
        partitionKeyFromParent: null,
        partitionKeyConstant: entry.partitionKeyConstant ?? null,
        note: entry.note,
      });
    }

    for (const sub of entry.subcollections ?? []) {
      if (!keep) continue;
      out.push({
        container: sub.container,
        sourcePath: sub.parentDoc
          ? `${entry.name}/${sub.parentDoc}/${sub.name}`
          : `${entry.name}/{parentId}/${sub.name}`,
        collectionId: sub.name,
        isSubcollection: true,
        parent: entry.name,
        parentDoc: sub.parentDoc ?? null,
        disposition: entry.disposition,
        partitionKey: sub.partitionKey ?? DEFAULT_PARTITION_KEY,
        partitionKeyFromParent: sub.partitionKeyFromParent ?? null,
        partitionKeyConstant: null,
        note: sub.note,
      });
    }
  }

  return out;
}

/**
 * The container list Terraform should provision, sorted for a stable diff.
 * `infra/main.tf` reads the same list; keep them in step.
 *
 * @returns {string[]}
 */
export function provisionedContainers() {
  const names = new Set();

  for (const entry of COLLECTIONS) {
    if (!PROVISIONED_DISPOSITIONS.has(entry.disposition)) continue;
    names.add(entry.name);
    for (const sub of entry.subcollections ?? []) names.add(sub.container);
  }

  return [...names].sort();
}

/** Every collection id the source is expected to contain, for preflight diffing. */
export function knownCollectionIds() {
  const ids = new Set();
  for (const entry of COLLECTIONS) {
    ids.add(entry.name);
    for (const sub of entry.subcollections ?? []) ids.add(sub.name);
  }
  return ids;
}

/** Look up a manifest entry by top-level collection name. */
export function findCollection(name) {
  return COLLECTIONS.find((c) => c.name === name) ?? null;
}
