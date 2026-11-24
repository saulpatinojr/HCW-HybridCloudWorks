/**
 * archive-classification.js — what the yearly content archive keeps, changes
 * or leaves out, container by container (ADR 0046 section 2, issue #1811).
 *
 * WHAT THE ARCHIVE IS. Once a year the site keeps a long-term copy of its
 * content in the private `content-archive` blob container, made from the
 * weekly full database backup (cosmos-export.js). A copy that lasts for
 * years must hold nothing a person was promised would be deleted, and no
 * password, token or key. This file is where that is decided, in code.
 *
 * THE LIST IS CODE, NOT A DOCUMENT, for the reason export-classification.js
 * gives: the test beside this file holds it to `infra/cosmos-containers.json`
 * (the list of database containers Terraform creates), so every container is
 * named here exactly once and a new one fails the build until someone decides
 * what happens to it. A container can never be archived, or dropped, by
 * accident.
 *
 * THREE DECISIONS (ADR 0046):
 *
 *   archive          every record is kept as it is.
 *   archive-changed  the container is kept, after the named fields are taken
 *                    out of every record, or the named records are left out.
 *   leave-out        nothing from the container is kept; `reason` says why.
 *
 * A container that is kept can also have a `recordRule`: a rule that leaves
 * single records out (an interview that is not public, an `admin_config`
 * document that is a key record or short-lived state).
 *
 * THE ONE FUNCTION THAT DECIDES A RECORD is `archiveRecord`. Both the dry-run
 * report (archive-report.js) and the archive job (phase 3 of ADR 0046) go
 * through it, so what the report counts is what the job will do.
 *
 * FAIL CLOSED. A container this file does not name, an `admin_config`
 * document whose id it does not name, and a version of a content item that is
 * not in the same backup are all left out. Nothing reaches the archive
 * because a rule forgot it.
 */
import { STRIPPED_FIELDS } from '../developer-api/proposal-cycle.js';
import { isPublicDocument } from '../public-reads.js';

/** @typedef {'archive'|'archive-changed'|'leave-out'} ArchiveDecision */

/**
 * The Doc Vault's one secret item, by its id and by its type. Written here,
 * not imported: nothing outside the Doc Vault loads its code (its no-leak
 * test). The test beside this file holds both to doc-vault/model.js.
 */
export const DOC_VAULT_SALT_ID = 'vault-id-salt';
export const DOC_VAULT_SALT_TYPE = 'salt';

export const DECISIONS = Object.freeze({
  archive: 'archive',
  changed: 'archive-changed',
  leaveOut: 'leave-out',
});

/**
 * Why a container, or one record, is left out. The words are the ones the
 * report and the manifest print; none of them names a record.
 */
export const REASONS = Object.freeze({
  promise: 'promise', // someone was told it would be deleted, or agreed to less than keeping it for good
  secret: 'secret', // a password, token, key or a hash of one
  accessList: 'access-list', // who may sign in; not content
  derived: 'derived', // a job, a publish or a script in Git rebuilds it
  workingState: 'working-state', // jobs, counters, leases, caches: nothing later
  unclassified: 'unclassified', // the owner has not said yet (ADR 0046, "owner to say")
  unlisted: 'unlisted', // an admin_config document id this file does not name
  orphan: 'orphan', // a version whose content item is not in the backup
});

const freeze = (list) => Object.freeze([...list].sort());

/** Archived as they are. `content` and `content_versions` also carry a record rule, below. */
export const ARCHIVE_AS_IS = freeze([
  'content',
  'content_versions',
  'blogs',
  'content_templates',
  'certifications',
  'certEvents',
  'speakerevents',
  'podcasts',
  'episodes',
  'youtubevideos',
  // Owner's answer to question 5 of ADR 0046 (2026-11-24): "MINE". Only the
  // owner's voice is on these recordings, so both are archived as they are.
  'recordings',
  'plaud_ingest',
  'newsletters',
  'roadmap_items',
  'wiki_pages',
  'listen_and_learn',
  'listen_and_learn_episodes',
  'podcast_transcripts',
  'designs',
  'frameworks',
  'pillar_details',
  'pillar_items',
  'social_posts',
  'prompts',
  'prompt_keyword_synonyms',
  'prompt_keyword_augmentations',
  'image_prompts',
  'image_prompts_sets',
  'image_prompt_sets',
  'image_prompt_sets_prompts',
  'image_prompt_pages',
  'generated_content_images',
  'curated_article_images',
  'character_profiles',
  'character_modules',
  'character_images',
  'character_tag_adjectives',
  'brain_records',
  'ambassador',
  'lab_agents',
  'admin_settings',
  'site_settings',
  'system',
  'config',
  'config_tags',
  'ai_providers',
  'ai_usage',
  'telegram_bot_activity',
  'workflow_alerts',
  'workflow_digests',
]);

/**
 * The sign-in fields of an outside tool server (ai/mcp-oauth.js calls them
 * write-only): access token, refresh token, client secret, and the half-made
 * sign-in in flight.
 */
export const MCP_SERVER_SECRET_FIELDS = Object.freeze([
  'oauthToken',
  'oauthRefreshToken',
  'oauthClientSecret',
  'oauthPending',
]);

/**
 * A talk proposal's personal fields: the speaker's name, email and bio, and
 * the organizer's review note. The same four the live yearly clean-up
 * removes (proposal-cycle.js), taken from there so the two cannot drift.
 * The archive removes them from EVERY proposal, accepted or not (owner's
 * answer to question 2 of ADR 0046: "STRIP"), and whether or not the live
 * clean-up is switched on.
 */
export const PROPOSAL_PERSONAL_FIELDS = STRIPPED_FIELDS;

/**
 * Kept, with something taken out first. `fields` are removed from every
 * record; `records` says in words which whole records are left out (the rule
 * itself is in `archiveRecord`).
 */
export const ARCHIVE_CHANGED = Object.freeze({
  developer_events: Object.freeze({
    fields: PROPOSAL_PERSONAL_FIELDS,
    records: null,
    why: 'A speaker typed these to be considered for one event; nothing records an agreement to keep them for good.',
  }),
  mcp_servers: Object.freeze({
    fields: MCP_SERVER_SECRET_FIELDS,
    records: null,
    why: 'Sign-in tokens and a client secret for outside tool servers.',
  }),
  doc_vault: Object.freeze({
    fields: Object.freeze([]),
    records: `the one item ${DOC_VAULT_SALT_ID} (a random secret that new document ids are made from)`,
    why: 'The salt is a secret. Documents and their earlier versions read back without it.',
  }),
  admin_config: Object.freeze({
    fields: Object.freeze([]),
    records:
      'every developer key record and the agent key record (key hashes, organizers’ details), short-lived state (leases, probe results, caches, queues), and any document id this file does not name',
    why: 'Key records hold a hash of each key; state documents mean nothing later.',
  }),
});

/** Left out whole, with the reason. */
export const LEFT_OUT = Object.freeze({
  // Who may sign in, and with which role. Not content, and a years-old access
  // list must never be put back.
  admins: REASONS.accessList,
  // The database deletes each row after 90 days (default_ttl); a 90-day
  // record does not go into a permanent copy.
  admin_audit_logs: REASONS.promise,
  audits: REASONS.promise,
  // Rebuilt by a recount, a reindex, a publish or a timer.
  content_stats_markers: REASONS.workingState,
  brain_search: REASONS.derived,
  _snapshots: REASONS.derived,
  homepage_feeds: REASONS.derived,
  rss_cache: REASONS.derived,
  tool_service_cache: REASONS.derived,
  tool_price_history: REASONS.derived,
  // Written by a script in this repository; Git is the source.
  azure_landing_content: REASONS.derived,
  tool_service_catalog: REASONS.derived,
  // In flight, and deleted by the database after hours or days.
  jobs: REASONS.workingState,
  lab_jobs: REASONS.workingState,
  lab_public_quota: REASONS.workingState,
  submission_quota: REASONS.workingState,
  tool_ai_plan_quota: REASONS.workingState,
  tool_export_quota: REASONS.workingState,
  // The seven the code cannot describe (ADR 0046, rule 4): saved work and
  // settings from the earlier site. They may hold what a visitor typed, or a
  // key. Left out until the owner has read the dry-run report (record counts
  // and field NAMES only) and said what each one is.
  tool_workspaces: REASONS.unclassified,
  tool_migration_workspaces: REASONS.unclassified,
  tool_assessment_sessions: REASONS.unclassified,
  tool_architecture_plans: REASONS.unclassified,
  tool_exports: REASONS.unclassified,
  config_providers: REASONS.unclassified,
  config_settings: REASONS.unclassified,
});

/** The seven containers the owner still has to classify, sorted. */
export const UNCLASSIFIED = freeze(
  Object.entries(LEFT_OUT)
    .filter(([, reason]) => reason === REASONS.unclassified)
    .map(([name]) => name)
);

/**
 * The decision for one container, or `null` when this file does not name it
 * (the test turns that into a build failure for any provisioned container,
 * and `archiveRecord` treats it as "leave out").
 *
 * @param {string} container
 * @returns {{ decision: ArchiveDecision, reason: string|null, fields: readonly string[], records: string|null, recordRule: string|null }|null}
 */
export function archiveDecisionFor(container) {
  if (ARCHIVE_AS_IS.includes(container)) {
    return {
      decision: DECISIONS.archive,
      reason: null,
      fields: [],
      records: null,
      recordRule: RECORD_RULES[container] || null,
    };
  }
  if (Object.hasOwn(ARCHIVE_CHANGED, container)) {
    const spec = ARCHIVE_CHANGED[container];
    return {
      decision: DECISIONS.changed,
      reason: null,
      fields: spec.fields,
      records: spec.records,
      recordRule: null,
    };
  }
  if (Object.hasOwn(LEFT_OUT, container)) {
    return {
      decision: DECISIONS.leaveOut,
      reason: LEFT_OUT[container],
      fields: [],
      records: null,
      recordRule: null,
    };
  }
  return null;
}

/** Every container this file names, sorted: the set the test compares to the Terraform list. */
export function archiveClassifiedContainers() {
  return [...ARCHIVE_AS_IS, ...Object.keys(ARCHIVE_CHANGED), ...Object.keys(LEFT_OUT)].sort();
}

/** The containers a yearly archive writes a file for, sorted. */
export function archivePlan() {
  return [...ARCHIVE_AS_IS, ...Object.keys(ARCHIVE_CHANGED)].sort();
}

// ── The interview rule (ADR 0046 section 2, rule 2) ─────────────────────────

/**
 * In words, for the report and the manifest. A guest agreed to publication on
 * the site, so an interview is archived only while it is public in the backup
 * the archive is made from. A draft, and an interview taken down again, are
 * left out, in `content` and in `content_versions`.
 *
 * STRICTER THAN THE ADR'S WORDS, ON PURPOSE. ADR 0046 says "an interview that
 * was never published is left out". An interview that was published and then
 * taken down (for example because the guest asked) was once published, so
 * those words would keep it for good. This rule leaves it out. The next
 * year's archive is a complete picture, so one that is public again by then
 * is in that one.
 */
const RECORD_RULES = Object.freeze({
  content: 'an interview that is not public in the backup is left out',
  content_versions:
    'a version is kept only when its content item is in the same backup and is not an interview that was left out',
});

/** True for a document of the interview type, however its type is cased (interviews/tombstone.js). */
const isInterview = (doc) => String(doc?.type || '').toLowerCase() === 'interview';

/**
 * What the `content_versions` rule needs to know about `content`, built by
 * reading the backup's `content` file once: every content id, and the ids of
 * the interviews that are left out. Ids only, so memory stays small.
 */
export function createContentIndex() {
  const present = new Set();
  const withheld = new Set();
  return {
    /** Note one `content` record. */
    add(doc) {
      const id = typeof doc?.id === 'string' ? doc.id : null;
      if (!id) return;
      present.add(id);
      if (isInterview(doc) && !isPublicDocument(doc)) withheld.add(id);
    },
    has: (id) => present.has(id),
    isWithheld: (id) => withheld.has(id),
    get size() {
      return present.size;
    },
    get withheldCount() {
      return withheld.size;
    },
  };
}

// ── admin_config: one document at a time (ADR 0046 deferred this list here) ──

/**
 * `admin_config` is one container that about seventy features keep a
 * document in. The archive keeps the ones that are settings or the owner's
 * own writing, and leaves out key records and short-lived state. Each id (or
 * id prefix) the code under `functions/src` writes is named below, once; the
 * test beside this file reads the source and fails when it finds an id that
 * is in neither list.
 *
 * A document whose id is on no list is LEFT OUT and counted as `unlisted` in
 * the dry-run report, so a real document the code no longer names shows up as
 * a number for the owner instead of slipping into the archive.
 */
export const ADMIN_CONFIG_KEEP = Object.freeze({
  ids: freeze([
    // Platform Settings (platform-settings.js): one document per setting.
    'default_heroes',
    'social_autopost',
    'podcast_feeds',
    'podcast_voices',
    'newsletter_settings',
    'content_taxonomy',
    'reminders',
    'listen_and_learn_speech',
    // The newsletter's From address (newsletter/sender.js): the site's own.
    'newsletter_sender',
    // Folder names of the image gallery (gallery-images.js).
    'gallery_folders',
    // The writing tool's voice profile and prompts (content/forge-studio/config.js).
    'forge_profile',
    'forge_prompts',
    // Running totals of the writing tool (content/forge.js): numbers only.
    'forge_stats',
    // The owner's calendar alerts (calendar-alerts/model.js).
    'calendar_alerts',
    // The subscriptions ledger: what the owner pays (cost/ledger-store.js). The owner's own.
    'cost_ledger',
    // The date each credential was last replaced, by name only, never a value (credentials/sources.js).
    'credential_register',
  ]),
  prefixes: Object.freeze([
    // The owner's status, costs and notes on one community event (community-days/notes.js).
    'community_days_event_',
  ]),
});

/** Left out of `admin_config`, with the reason. */
export const ADMIN_CONFIG_LEAVE_OUT = Object.freeze({
  ids: Object.freeze({
    // The content agent's key record: a hash of the key (agent-content/keys.js).
    'agent_content_key:koda': REASONS.secret,
    // When each Key Vault secret was last written (admin-secrets.js): a picture of the vault on one day.
    secret_state: REASONS.workingState,
    // Coder's last answers to the status token (labs/coder-status.js).
    coder_status_token: REASONS.workingState,
    // Reports the lab host and the lab checks write about themselves.
    coder_automation: REASONS.workingState,
    lab_certificates: REASONS.workingState,
    lab_canary: REASONS.workingState,
    lab_drift: REASONS.workingState,
    host_checks: REASONS.workingState,
    swa_reset: REASONS.workingState,
    // Health results (health/probe-results.js, health/pulse.js).
    health_pulse: REASONS.workingState,
    // Copies of what an outside service answered, refilled on a timer or a press.
    community_days_cache: REASONS.derived,
    cost_snapshot: REASONS.derived,
    podbean_host_overview: REASONS.derived,
    podcast_last_sample: REASONS.derived,
    search_console_snapshot: REASONS.derived,
    streamyard_onair: REASONS.derived,
    // Leases and watches: who is running what right now.
    search_console_lease: REASONS.workingState,
    delivery_monitor_watch: REASONS.workingState,
    // The writing tool's queue of web addresses, in its earlier single-document form.
    forge_queue: REASONS.workingState,
  }),
  prefixes: Object.freeze({
    // One record per key the site issued to an organizer: the key's hash,
    // the organizer's name and a contact note (developer-api/keys.js).
    'developer_api_key:': REASONS.secret,
    // One health result per probe (health/probe-results.js).
    'health_probe_result:': REASONS.workingState,
    // Podcast host statistics, one cached document per date range (podcast/host-stats.js).
    podbean_host_stats_: REASONS.derived,
    // One queued web address each, with who added it (content/forge-studio/queue.js).
    'forge_queue_item:': REASONS.workingState,
  }),
});

/**
 * The decision for one `admin_config` document id.
 * @param {unknown} id
 * @returns {{ keep: boolean, reason: string|null }}
 */
export function adminConfigDecision(id) {
  const name = typeof id === 'string' ? id : '';
  if (!name) return { keep: false, reason: REASONS.unlisted };
  // Leave-out is read first: if an id were ever on both lists, it stays out.
  if (Object.hasOwn(ADMIN_CONFIG_LEAVE_OUT.ids, name)) {
    return { keep: false, reason: ADMIN_CONFIG_LEAVE_OUT.ids[name] };
  }
  for (const [prefix, reason] of Object.entries(ADMIN_CONFIG_LEAVE_OUT.prefixes)) {
    if (name.startsWith(prefix)) return { keep: false, reason };
  }
  if (ADMIN_CONFIG_KEEP.ids.includes(name)) return { keep: true, reason: null };
  if (ADMIN_CONFIG_KEEP.prefixes.some((prefix) => name.startsWith(prefix))) {
    return { keep: true, reason: null };
  }
  return { keep: false, reason: REASONS.unlisted };
}

// ── One record ───────────────────────────────────────────────────────────────

const left = (reason) => ({ keep: false, doc: null, removed: [], reason });

/** A copy of `doc` without `fields`, and the names of the ones that were there. */
function withoutFields(doc, fields) {
  const removed = fields.filter((field) => Object.hasOwn(doc, field));
  if (!removed.length) return { doc, removed };
  const copy = { ...doc };
  for (const field of removed) delete copy[field];
  return { doc: copy, removed };
}

/**
 * Decide one record: is it kept, and with which fields taken out.
 *
 * @param {string} container
 * @param {unknown} doc - one record as the backup holds it
 * @param {{ contentIndex?: ReturnType<typeof createContentIndex>|null }} [ctx] -
 *   `contentIndex` is required for `content_versions`; without it every
 *   version is left out
 * @returns {{ keep: boolean, doc: object|null, removed: string[], reason: string|null }}
 *   `removed` is the names of the fields taken out (never a value); `reason`
 *   says why a record was left out
 */
export function archiveRecord(container, doc, ctx = {}) {
  const decision = archiveDecisionFor(container);
  if (!decision) return left(REASONS.unclassified);
  if (decision.decision === DECISIONS.leaveOut) return left(decision.reason);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return left(REASONS.unlisted);

  switch (container) {
    case 'content':
      if (isInterview(doc) && !isPublicDocument(doc)) return left(REASONS.promise);
      break;
    case 'content_versions': {
      const index = ctx.contentIndex;
      const parent = typeof doc.contentId === 'string' ? doc.contentId : '';
      if (!index || !parent || !index.has(parent)) return left(REASONS.orphan);
      if (index.isWithheld(parent)) return left(REASONS.promise);
      break;
    }
    case 'doc_vault':
      // By id and by type: either one marks the salt item.
      if (doc.id === DOC_VAULT_SALT_ID || doc.docType === DOC_VAULT_SALT_TYPE) {
        return left(REASONS.secret);
      }
      break;
    case 'admin_config': {
      const verdict = adminConfigDecision(doc.id);
      if (!verdict.keep) return left(verdict.reason);
      break;
    }
    default:
      break;
  }

  if (decision.fields.length) {
    const result = withoutFields(doc, decision.fields);
    return { keep: true, doc: result.doc, removed: result.removed, reason: null };
  }
  return { keep: true, doc, removed: [], reason: null };
}
