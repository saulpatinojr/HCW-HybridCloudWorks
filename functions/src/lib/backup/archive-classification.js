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
 *   archive-changed  the container is kept, but not whole. Either only the
 *                    fields on a short list are kept from each record (an
 *                    allow-list: a field nobody listed is dropped, so a new
 *                    or forgotten field can never carry a secret in), or the
 *                    named records are left out, or both.
 *   leave-out        nothing from the container is kept; `reason` says why.
 *
 * A container that is kept can also have a `recordRule`: a rule that leaves
 * single records out (an interview that is not public, every earlier version
 * of an interview, an `admin_config` document that is a key record or
 * short-lived state).
 *
 * THE ONE FUNCTION THAT DECIDES A RECORD is `archiveRecord`. Both the dry-run
 * report (archive-report.js) and the archive job (archive-job.js) go
 * through it, so what the report counts is what the job will do.
 *
 * FAIL CLOSED. A container this file does not name, a container no code
 * names any more (nobody can say what is in it), an `admin_config` or
 * `admin_settings` document whose id it does not name, a field that is on no
 * keep list, and a version of a content item that is not in the same backup
 * are all left out. Nothing reaches the archive because a rule forgot it.
 *
 * THE OWNER'S RULE (2026-11-24): a secret, token or key is never archived,
 * and nothing about another person is archived unless an agreement covers
 * it. So wherever a container can hold either, this file says what is KEPT,
 * never what is removed.
 *
 * THE OWNER'S EXCEPTION TO IT (also 2026-11-24, after the first dry run):
 * 21 containers left over from the earlier site are kept whole although no
 * code can say what they hold, and some of them hold other people's email
 * addresses and may hold old keys. The comment above them in ARCHIVE_AS_IS
 * says what was known and who chose. Everything else follows the rule.
 */
import { createHash } from 'node:crypto';

import { STRIPPED_FIELDS } from '../developer-api/proposal-cycle.js';
import { isPublicDocument } from '../public-reads.js';
import {
  adminConfigDecision,
  adminSettingsDecision,
  ADMIN_CONFIG_KEEP,
  ADMIN_CONFIG_LEAVE_OUT,
  ADMIN_SETTINGS_KEEP,
  ADMIN_SETTINGS_LEAVE_OUT,
  leaveOutReason,
} from './archive-classification-admin.js';
import {
  addressWithoutSecrets,
  keep,
  KINDS,
  looksSensitive,
  SENSITIVE_EXACT_NAMES,
  SENSITIVE_NAME_TESTS,
  SENSITIVE_NAME_WORDS,
  withoutSensitiveKeys,
} from './archive-classification-fields.js';
import { DECISIONS, freeze, REASONS } from './archive-classification-reasons.js';

// The rules live in four files: this one (which containers, and one record),
// archive-classification-reasons.js (the decisions and reasons),
// archive-classification-fields.js (field names and how a kept field is
// copied) and archive-classification-admin.js (the admin_config and
// admin_settings documents). Everything the other three export that callers
// used from here before is exported from here still.
export { DECISIONS, REASONS } from './archive-classification-reasons.js';
export {
  addressWithoutSecrets,
  looksSensitive,
  SENSITIVE_EXACT_NAMES,
  SENSITIVE_NAME_WORDS,
} from './archive-classification-fields.js';
export {
  adminConfigDecision,
  adminSettingsDecision,
  ADMIN_CONFIG_KEEP,
  ADMIN_CONFIG_LEAVE_OUT,
  ADMIN_SETTINGS_KEEP,
  ADMIN_SETTINGS_LEAVE_OUT,
  archiveDocumentLabel,
  OTHER_DOCUMENT,
} from './archive-classification-admin.js';

/**
 * Archived as they are. Every container here is one the code under
 * `functions/src` reads or writes today, so its fields are known (the test
 * beside this file checks that), except the ones the owner answered for by
 * name (KEPT_ON_THE_OWNERS_WORD, below). `content` and `content_versions`
 * also carry a record rule, below.
 */
export const ARCHIVE_AS_IS = freeze([
  'content',
  'content_versions',
  'blogs',
  'certifications',
  'certEvents',
  'speakerevents',
  'podcasts',
  'episodes',
  // Owner's answer to question 5 of ADR 0046 (2026-11-24): "MINE". Only the
  // owner's voice is on these recordings, so both are archived as they are.
  // No code names `plaud_ingest` today; it is kept on the owner's word, and
  // the dry run reports its field names like every other container's.
  'recordings',
  'plaud_ingest',
  'newsletters',
  'listen_and_learn',
  'listen_and_learn_episodes',
  'podcast_transcripts',
  'designs',
  'frameworks',
  'social_posts',
  'prompt_keyword_synonyms',
  'prompt_keyword_augmentations',
  'image_prompts',
  'image_prompts_sets',
  'image_prompt_sets',
  'image_prompt_sets_prompts',
  'image_prompt_pages',
  'generated_content_images',
  'curated_article_images',
  'brain_records',
  'ambassador',
  'system',
  'ai_usage',
  'telegram_bot_activity',
  'workflow_alerts',
  'workflow_digests',
  // ── Kept by the owner's decision of 2026-11-24, after the first dry run ──
  // "Everything the dry run listed stays in the archive"
  // (https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811#issuecomment-7144574612).
  // No code under functions/src or frontend/src names any of the 21 below,
  // so nothing in this repository says what their records hold. They are
  // left over from the earlier site. Until that decision they were left out
  // as "not classified yet"; the owner read the dry run's record counts,
  // field names and flagged names, and chose to keep all of them, whole.
  //
  // Three of the five tool_* containers hold the EMAIL ADDRESS and the
  // SESSION ID of whoever used the tool. By the field names the first dry
  // run showed (names only, never a value):
  //   tool_workspaces            ownerEmail
  //   tool_assessment_sessions   ownerEmail, requestedByEmail, ownerUid
  //   tool_architecture_plans    requestedByEmail, ownerUid, sessionId
  // (`ownerUid` is the id of the person's account.) The other two,
  // tool_migration_workspaces and tool_exports, held no record that day.
  // An email address is another person's contact detail, with no agreement
  // recorded for keeping it. The session pointed that out and recommended
  // leaving those three out; the owner chose to keep them, on the grounds
  // that the archive is private and readable by the owner only. This is an
  // exception to the rule at the top of this file, made by the owner, and
  // an erasure request from someone who used those tools means rewriting
  // each year's archive that holds them (ADR 0046 section 5).
  'tool_workspaces',
  'tool_migration_workspaces',
  'tool_assessment_sessions',
  'tool_architecture_plans',
  'tool_exports',
  // Settings of the earlier site. The dry run's report showed their field
  // names; `config_providers` and `config_settings` may hold keys typed
  // into the earlier site. Kept whole by the same decision.
  'config',
  'config_providers',
  'config_settings',
  'config_tags',
  'site_settings',
  // Content of the earlier site.
  'content_templates',
  'youtubevideos',
  'roadmap_items',
  'wiki_pages',
  'pillar_details',
  'pillar_items',
  'prompts',
  'character_profiles',
  'character_modules',
  'character_images',
  'character_tag_adjectives',
]);

/**
 * The 21 containers the owner chose to keep on 2026-11-24 although no code
 * names them (the comment above them in ARCHIVE_AS_IS says how and why).
 */
export const KEPT_BY_THE_OWNERS_DECISION = freeze([
  'tool_workspaces',
  'tool_migration_workspaces',
  'tool_assessment_sessions',
  'tool_architecture_plans',
  'tool_exports',
  'config',
  'config_providers',
  'config_settings',
  'config_tags',
  'site_settings',
  'content_templates',
  'youtubevideos',
  'roadmap_items',
  'wiki_pages',
  'pillar_details',
  'pillar_items',
  'prompts',
  'character_profiles',
  'character_modules',
  'character_images',
  'character_tag_adjectives',
]);

/**
 * Kept on the owner's word although no code names it: `plaud_ingest`
 * (question 5 of ADR 0046: "MINE"), and the 21 above. These are the only
 * containers archived as they are without the code being able to say what
 * they hold; the test beside this file holds the list to exactly these.
 */
export const KEPT_ON_THE_OWNERS_WORD = freeze(['plaud_ingest', ...KEPT_BY_THE_OWNERS_DECISION]);

/**
 * The owner's decision of 2026-11-24 about the dry run's flagged names:
 * "everything the dry run listed stays". The first dry run flagged ten
 * containers an archive keeps for a field named like a secret or someone's
 * contact details (for example `email` and `emailVerified` on `blogs`,
 * `certifications` and `speakerevents`, and `requestHash` on
 * `brain_records`). The owner chose to keep those containers as they are,
 * and to keep the 21 that were waiting.
 *
 * WHAT THIS IS NOT. Nobody went through the names one by one, so this is
 * not a list of reviewed names like SENSITIVE_KEPT_ON_PURPOSE below. It is a
 * decision per container. The dry run still lists every such name with its
 * place and the kind of value it holds; the card shows them under "the owner
 * chose to keep these" instead of asking the owner the same question again.
 * A container that is not on this list is still shown in red.
 *
 * It changes nothing about what is kept: the containers with a keep list
 * (`mcp_servers`, `ai_providers`, `admin_config`) still drop every field and
 * document they dropped before. "Stays" meant "as the dry run showed it".
 */
export const OWNER_ACCEPTED = Object.freeze({
  date: '2026-11-24',
  record: 'https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1811#issuecomment-7144574612',
  containers: freeze([
    // The ten the first dry run flagged.
    'admin_config',
    'ai_providers',
    'ai_usage',
    'blogs',
    'brain_records',
    'certifications',
    'content',
    'mcp_servers',
    'speakerevents',
    'system',
    // The 21 that were waiting.
    ...KEPT_BY_THE_OWNERS_DECISION,
  ]),
});

/** The date of the owner's decision to keep this container as the dry run showed it, or null. */
export const ownerAcceptedOn = (container) => (OWNER_ACCEPTED.containers.includes(container) ? OWNER_ACCEPTED.date : null);

// ── Keep lists: what is kept from a record, field by field ─────────────────
// (Each field's kind, and how it is copied, is in archive-classification-fields.js.)

/**
 * An outside tool server (`mcp_servers`). The writer
 * (admin-integrations/config-collections.js MCP_SERVER_FIELDS) also accepts
 * `headers` (free-form, so it can hold `Authorization: Bearer ...`),
 * `oauthToken` and `oauthRefreshToken`, and the sign-in flow adds `oauth`,
 * `oauthClient`, `oauthClientSecret` and `oauthPending`. None of those is
 * here, so none is kept, and neither is a field added later. `status`,
 * `lastError` and `lastTestedAt` are left behind too: the last test's result
 * means nothing later, and the error is a sentence the far end chose.
 */
export const MCP_SERVER_KEEP = Object.freeze({
  ...keep('scalar', ['id', 'name', 'transport', 'enabled', 'order', 'authType', 'description', 'notes', 'createdAt', 'updatedAt']),
  apiKeyEnvVar: 'name',
  url: 'address',
  allowedTools: 'strings',
  tools: 'tools',
});

/**
 * An AI provider card (`ai_providers`): the fields today's writer accepts
 * (config-collections.js AI_PROVIDER_FIELDS), without the last test's result
 * (`status`, `lastError`, `lastTestedAt`). A card carried over from the
 * earlier site could still hold an old `apiKey`; it is on no list, so it is
 * dropped.
 */
export const AI_PROVIDER_KEEP = Object.freeze({
  ...keep('scalar', ['id', 'name', 'enabled', 'order', 'model', 'defaultModel', 'apiVersion', 'temperature', 'maxTokens', 'timeoutMs', 'description', 'notes', 'createdAt', 'updatedAt']),
  apiKeyEnvVar: 'name',
  baseUrl: 'address',
  models: 'strings',
});

/**
 * `developer_events` holds two kinds of record (developer-api/cfs.js), told
 * apart by `docType`. Each has its own keep list; a record of any other kind
 * is left out.
 *
 * A CALL for speakers also carries the organizer's name, the id of the
 * organizer's key and the id of whoever last changed it (`organizerName`,
 * `organizerKeyId`, `updatedBy`). A PROPOSAL also carries the speaker's name,
 * email and bio, the organizer's review note and who reviewed it
 * (`speakerName`, `speakerEmail`, `speakerBio`, `reviewNote`, `reviewedBy`).
 * None of those is on a list. The owner's answer to question 2 of ADR 0046 is
 * "STRIP": the talk and the decision are kept, the people are not, for every
 * proposal, accepted or not, and whether or not the live yearly clean-up
 * (proposal-cycle.js) is switched on.
 *
 * Kept on purpose, and free text someone typed: a call's `title` and
 * `description` (the organizer's) and a proposal's `title` and `abstract`
 * (the speaker's). They are the talk itself.
 */
export const DEVELOPER_EVENT_KEEP = Object.freeze({
  'cfs-call': Object.freeze(
    keep('scalar', ['id', 'eventId', 'docType', 'status', 'title', 'description', 'closesAt', 'openedAt', 'closedAt', 'createdAt', 'updatedAt'])
  ),
  'cfs-submission': Object.freeze(
    keep('scalar', ['id', 'eventId', 'docType', 'status', 'title', 'abstract', 'format', 'level', 'submittedAt', 'reviewedAt', 'strippedAt', 'strippedReason'])
  ),
});

/** A talk proposal's personal fields, as the live yearly clean-up names them. None may be on a keep list (the test checks). */
export const PROPOSAL_PERSONAL_FIELDS = STRIPPED_FIELDS;

/**
 * The Doc Vault's kinds of item that are content (doc-vault/model.js
 * DOC_TYPES): a document, and an earlier version of one. Its third kind is
 * the salt, a random secret that new document ids are made from; it is not
 * on this list, and neither is a kind added later. The values are written
 * here, not imported: nothing outside the Doc Vault loads its code (its
 * no-leak test). The test beside this file holds them to the model.
 */
export const DOC_VAULT_KEPT_TYPES = Object.freeze(['document', 'version']);
export const DOC_VAULT_SALT_ID = 'vault-id-salt';

/**
 * The names the dry-run report may print for a field that was taken out.
 * Every name here is written in this repository's own code, so printing it
 * shows nothing about a record. A removed field with any other name is
 * counted under OTHER_REMOVED, because with a keep list the name of a
 * dropped field is whatever the record happened to hold, and that can be an
 * id.
 */
export const OTHER_REMOVED = '(other fields)';
export const NAMED_REMOVALS = Object.freeze([
  ...PROPOSAL_PERSONAL_FIELDS,
  'reviewedBy',
  'organizerName',
  'organizerKeyId',
  'updatedBy',
  'oauthToken',
  'oauthRefreshToken',
  'oauthClientSecret',
  'oauthPending',
  'oauth',
  'oauthClient',
  'headers',
  'apiKey',
  'status',
  'lastError',
  'lastTestedAt',
]);
/** Printed when part of a kept field was cut: a web address's query string, or a nested key that looks sensitive. */
export const PART_REMOVED = '(part of a kept field)';

/**
 * Kept, but not whole. `keeps` are the only fields kept from a record (null:
 * every field); `records` says in words which whole records are left out
 * (the rule itself is in `archiveRecord`).
 */
export const ARCHIVE_CHANGED = Object.freeze({
  developer_events: Object.freeze({
    keeps: Object.freeze([...new Set(Object.values(DEVELOPER_EVENT_KEEP).flatMap((list) => Object.keys(list)))].sort()),
    records: 'a record that is neither a call for speakers nor a talk proposal',
    why: 'A speaker typed their details to be considered for one event, and an organizer’s name is theirs; nothing records an agreement to keep either for good.',
  }),
  mcp_servers: Object.freeze({
    keeps: Object.freeze(Object.keys(MCP_SERVER_KEEP).sort()),
    records: null,
    why: 'Sign-in tokens, a client secret and free-form request headers for outside tool servers. Only the listed fields are kept; a web address loses its query string.',
  }),
  ai_providers: Object.freeze({
    keeps: Object.freeze(Object.keys(AI_PROVIDER_KEEP).sort()),
    records: null,
    why: 'A card carried over from the earlier site could hold an old key. Only the fields today’s writer accepts are kept.',
  }),
  doc_vault: Object.freeze({
    keeps: null,
    records: `everything that is not a document or an earlier version of one, which today is the one item ${DOC_VAULT_SALT_ID} (a random secret that new document ids are made from)`,
    why: 'The salt is a secret. Documents and their earlier versions read back without it.',
  }),
  admin_config: Object.freeze({
    keeps: null,
    records:
      'every developer key record and the agent key record (key hashes, organizers’ details), short-lived state (leases, probe results, caches, queues), and any document id this file does not name',
    why: 'Key records hold a hash of each key; state documents mean nothing later.',
  }),
  admin_settings: Object.freeze({
    keeps: null,
    records:
      'the record of who first set the site up (an administrator’s id), test results, the fetched model list, the last run of each news source, and any document id this file does not name',
    why: 'One container many features keep a settings document in. Only the ids that are settings are kept.',
  }),
});

/** Left out whole, with the reason. */
export const LEFT_OUT = Object.freeze({
  // Who may sign in, and with which role. Not content, and a years-old access
  // list must never be put back.
  admins: REASONS.accessList,
  // The same kind of list for machines: which lab agent id is bound to which
  // service principal (labs/agent-registry.js), with the id of the admin who
  // registered it and the machine's host name.
  lab_agents: REASONS.accessList,
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
  // A CONTAINER NOBODY HAS DECIDED ABOUT GOES HERE, with
  // `REASONS.unclassified`. That is the waiting list (ADR 0046, rule 4): it
  // is left out of every archive, and the dry run reads it and shows its
  // record count, field names and flagged names so the owner can decide.
  // The list is empty since 2026-11-24, when the owner chose to keep the 21
  // that were on it (KEPT_BY_THE_OWNERS_DECISION, above). A container added
  // to infra/cosmos-containers.json fails the test beside this file until
  // it is named somewhere in this file; when nobody can say what it holds,
  // this is the place:
  //   some_new_container: REASONS.unclassified,
});

/** The containers the owner still has to classify, sorted. Empty since 2026-11-24. */
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
 * @returns {{ decision: ArchiveDecision, reason: string|null, keeps: readonly string[]|null, records: string|null, recordRule: string|null }|null}
 */
export function archiveDecisionFor(container) {
  if (ARCHIVE_AS_IS.includes(container)) {
    return {
      decision: DECISIONS.archive,
      reason: null,
      keeps: null,
      records: null,
      recordRule: RECORD_RULES[container] || null,
    };
  }
  if (Object.hasOwn(ARCHIVE_CHANGED, container)) {
    const spec = ARCHIVE_CHANGED[container];
    return {
      decision: DECISIONS.changed,
      reason: null,
      keeps: spec.keeps,
      records: spec.records,
      recordRule: null,
    };
  }
  if (Object.hasOwn(LEFT_OUT, container)) {
    return {
      decision: DECISIONS.leaveOut,
      reason: LEFT_OUT[container],
      keeps: null,
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
 * left out of `content`.
 *
 * STRICTER THAN THE ADR'S WORDS, TWICE, ON PURPOSE.
 *
 * 1. ADR 0046 says "an interview that was never published is left out". An
 *    interview that was published and then taken down (for example because
 *    the guest asked) was once published, so those words would keep it for
 *    good. This rule leaves it out. The next year's archive is a complete
 *    picture, so one that is public again by then is in that one.
 *
 * 2. NO earlier version of an interview is kept, public or not. The editor
 *    saves a version on every save, so a public interview's history holds
 *    the drafts from before it was published: words the guest never saw go
 *    out, which their agreement does not cover. A version row does not say
 *    whether it was ever the public one, so all of them stay out and the
 *    public record in `content` is the archive's copy. Whether to keep them
 *    is an open question for the owner in ADR 0046; until it is answered
 *    this is the safe side.
 */
const RECORD_RULES = Object.freeze({
  content: 'an interview that is not public in the backup is left out',
  content_versions:
    'a version is kept only when its content item is in the same backup and is not an interview; no earlier version of an interview is kept',
});

/** True for a document of the interview type, however its type is cased (interviews/tombstone.js). */
const isInterview = (doc) => String(doc?.type || '').toLowerCase() === 'interview';

/**
 * What the `content_versions` rule needs to know about `content`, built by
 * reading the backup's `content` file once: every content id, and the ids of
 * the interviews. Ids only, so memory stays small.
 */
export function createContentIndex() {
  const present = new Set();
  const interviews = new Set();
  const withheld = new Set();
  return {
    /** Note one `content` record. */
    add(doc) {
      const id = typeof doc?.id === 'string' ? doc.id : null;
      if (!id) return;
      present.add(id);
      if (!isInterview(doc)) return;
      interviews.add(id);
      if (!isPublicDocument(doc)) withheld.add(id);
    },
    has: (id) => present.has(id),
    /** An interview, public or not: none of its earlier versions is kept. */
    isInterview: (id) => interviews.has(id),
    /** An interview that is left out of `content` itself. */
    isWithheld: (id) => withheld.has(id),
    get size() {
      return present.size;
    },
    get interviewCount() {
      return interviews.size;
    },
    get withheldCount() {
      return withheld.size;
    },
  };
}

// ── For the dry-run report: names kept on purpose ────────────────────────────

/**
 * Field names that LOOK like a secret (`looksSensitive`) and are kept on
 * purpose, with the reason. The dry-run report shows each as "kept on
 * purpose" instead of flagging it red. This list changes nothing about what
 * is kept; it only explains it. Add a name here only with a reason the code
 * shows; a name that is merely probably harmless is the owner's to decide
 * from the report.
 *
 * Only a top-level field of the named container counts.
 */
export const SENSITIVE_KEPT_ON_PURPOSE = Object.freeze({
  // The keep list copies this field with the kind `name` (KINDS.name): it is
  // kept only when it is shaped like the NAME of an app setting
  // (SOME_SETTING_NAME), which says where a key is read from and is never
  // the key. Anything else in the field is dropped. The test beside this
  // file holds both keep lists to that kind.
  mcp_servers: Object.freeze({
    apiKeyEnvVar: 'the name of the setting a key is read from, never the key itself; anything not shaped like a setting’s name is dropped',
  }),
  ai_providers: Object.freeze({
    apiKeyEnvVar: 'the name of the setting a key is read from, never the key itself; anything not shaped like a setting’s name is dropped',
  }),
});

// ── One record ───────────────────────────────────────────────────────────────

const left = (reason) => ({ keep: false, doc: null, removed: [], reason });

/**
 * A copy of `doc` holding only the fields on `list`, each copied the way its
 * kind says. `removed` names what was left behind: a name from
 * NAMED_REMOVALS as it is, any other name as OTHER_REMOVED (the name of a
 * dropped field can be anything, an id included), and PART_REMOVED when a
 * kept field lost a part.
 */
function keepOnly(doc, list) {
  const copy = {};
  const removed = new Set();
  for (const [field, value] of Object.entries(doc)) {
    // The database's own bookkeeping fields (_ts, _etag, _rid, ...) are not content.
    if (field.startsWith('_')) continue;
    const kind = Object.hasOwn(list, field) ? list[field] : null;
    const kept = kind ? KINDS[kind](value) : undefined;
    if (kept === undefined) {
      removed.add(NAMED_REMOVALS.includes(field) ? field : OTHER_REMOVED);
      continue;
    }
    copy[field] = kept;
    if (JSON.stringify(kept) !== JSON.stringify(value)) removed.add(PART_REMOVED);
  }
  return { keep: true, doc: copy, removed: [...removed].sort(), reason: null };
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
 *   `removed` is the names of the fields taken out (never a value, and never
 *   a name this file does not itself write: see NAMED_REMOVALS); `reason`
 *   says why a record was left out
 */
export function archiveRecord(container, doc, ctx = {}) {
  const decision = archiveDecisionFor(container);
  if (!decision) return left(REASONS.unclassified);
  if (decision.decision === DECISIONS.leaveOut) return left(decision.reason);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return left(REASONS.unlisted);
  const check = Object.hasOwn(RECORD_CHECKS, container) ? RECORD_CHECKS[container] : null;
  return (check && check(doc, ctx)) || { keep: true, doc, removed: [], reason: null };
}

/**
 * The containers whose records are looked at one by one, after the
 * container itself is known to be kept. Each check returns the answer for
 * the record, or null when the record is kept whole.
 */
const RECORD_CHECKS = Object.freeze({
  content: (doc) => (isInterview(doc) && !isPublicDocument(doc) ? left(REASONS.promise) : null),
  content_versions: (doc, ctx) => versionCheck(doc, ctx.contentIndex),
  // An allow-list of kinds, and the salt's id as a second check.
  doc_vault: (doc) =>
    !DOC_VAULT_KEPT_TYPES.includes(doc.docType) || doc.id === DOC_VAULT_SALT_ID ? left(REASONS.secret) : null,
  admin_config: (doc) => {
    const verdict = adminConfigDecision(doc.id);
    return verdict.keep ? null : left(verdict.reason);
  },
  admin_settings: (doc) => {
    const verdict = adminSettingsDecision(doc.id);
    if (!verdict.keep) return left(verdict.reason);
    return verdict.fields ? keepOnly(doc, verdict.fields) : null;
  },
  developer_events: (doc) => {
    const list = Object.hasOwn(DEVELOPER_EVENT_KEEP, doc.docType) ? DEVELOPER_EVENT_KEEP[doc.docType] : null;
    return list ? keepOnly(doc, list) : left(REASONS.unlisted);
  },
  mcp_servers: (doc) => keepOnly(doc, MCP_SERVER_KEEP),
  ai_providers: (doc) => keepOnly(doc, AI_PROVIDER_KEEP),
});

/** One `content_versions` record: kept only when its content item is in the same backup and is not an interview. */
function versionCheck(doc, index) {
  const parent = typeof doc.contentId === 'string' ? doc.contentId : '';
  if (!index || !parent || !index.has(parent)) return left(REASONS.orphan);
  // Every earlier version of an interview, public or not: see RECORD_RULES.
  return index.isInterview(parent) ? left(REASONS.promise) : null;
}

// ── A fingerprint of the rules ──────────────────────────────────────────────

let fingerprint = null;

/**
 * A sha256 over everything that decides what an archive holds: every list in
 * this file that `archivePlan` and `archiveRecord` read, and the text of the
 * functions that apply them. It changes whenever a container moves between
 * lists, a keep list changes, or the code that copies a record changes.
 *
 * WHY. An archive takes hours or days to write, and a dry-run report is read
 * days after it was made. Both write down this fingerprint. A file written,
 * or a report made, under other rules than today's is then recognised and
 * not trusted: the file is written again and the report is made again
 * (archive-job.js, archive-report.js `reportGate`). Without it, a container
 * that was moved to "left out" while a run was unfinished would still be
 * named by that run's manifest.
 *
 * It holds no record and no value: only the lists and code of this file and
 * the three archive-classification-*.js files beside it.
 *
 * @returns {string} lower-case hex
 */
export function classificationFingerprint() {
  if (fingerprint) return fingerprint;
  const text = (fn) => String(fn);
  const rules = {
    asIs: ARCHIVE_AS_IS,
    changed: ARCHIVE_CHANGED,
    leftOut: LEFT_OUT,
    recordRules: RECORD_RULES,
    keep: { MCP_SERVER_KEEP, AI_PROVIDER_KEEP, DEVELOPER_EVENT_KEEP, DOC_VAULT_KEPT_TYPES, DOC_VAULT_SALT_ID },
    adminConfig: { keep: ADMIN_CONFIG_KEEP, leaveOut: ADMIN_CONFIG_LEAVE_OUT },
    adminSettings: { keep: ADMIN_SETTINGS_KEEP, leaveOut: ADMIN_SETTINGS_LEAVE_OUT },
    sensitive: { SENSITIVE_NAME_WORDS, SENSITIVE_EXACT_NAMES },
    code: [
      text(archiveRecord),
      ...Object.entries(RECORD_CHECKS).map(([container, check]) => `${container}:${text(check)}`),
      text(versionCheck),
      text(left),
      text(keepOnly),
      text(adminConfigDecision),
      text(adminSettingsDecision),
      text(leaveOutReason),
      text(withoutSensitiveKeys),
      text(addressWithoutSecrets),
      text(looksSensitive),
      ...SENSITIVE_NAME_TESTS.map(text),
      text(isInterview),
      text(isPublicDocument),
      text(createContentIndex),
      ...Object.entries(KINDS).map(([kind, copy]) => `${kind}:${text(copy)}`),
    ],
  };
  fingerprint = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
  return fingerprint;
}
