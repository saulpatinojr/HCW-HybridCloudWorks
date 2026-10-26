/**
 * export-classification.js — which Cosmos containers the out-of-account
 * export copies, and on which runs (ADR 0028 §2, issue #231).
 *
 * The classification is CODE, not a document: the exporter reads these arrays
 * and `export-classification.test.js` holds them to `infra/cosmos-containers.json`
 * — every provisioned container appears exactly once, nothing unprovisioned
 * is listed — so a new container fails the build until someone classifies
 * it. That is the whole point of the arrangement: a container added to
 * Terraform and forgotten here is a container that is silently not backed up,
 * and "silently" is the failure mode the design exists to remove.
 *
 * The six classes are the ADR's table, verbatim. Three are exported:
 *
 *   A authored       — written by a person or a reviewed AI run; recoverable
 *                      from nowhere else.            weekly full + daily deltas
 *   B configuration  — small, and the site does not run without it.
 *                                                    weekly full + daily deltas
 *   C operational    — rows the platform writes about itself; forensics, not
 *                      needed to run.                weekly full ONLY
 *
 * and three are not:
 *
 *   regenerable      — refilled by a scheduled job or a publish.
 *   seed             — re-created by a seeding script in this repository.
 *   transient        — TTL-bounded runtime state, worthless after its window.
 *
 * Class C is full-only by owner decision (2026-09-06, #231 decision 2): the
 * audit and usage rows are worth a weekly copy for forensics and not worth a
 * daily change-feed read.
 */

/** @typedef {'authored'|'configuration'|'operational'|'regenerable'|'seed'|'transient'} ExportClass */

const freeze = (list) => Object.freeze([...list].sort());

/** Class A — weekly full + daily deltas. */
export const AUTHORED = freeze([
  'brain_records',
  'content',
  'content_versions',
  'blogs',
  'content_templates',
  'certifications',
  'certEvents',
  'speakerevents',
  // Ambassador programs, applications and evidence (ADR 0033 §4): the
  // applications are hand-written and recoverable from nowhere else.
  'ambassador',
  // The Doc Vault (owner request 2026-10-26): the owner's templates,
  // applications and letters, with their earlier versions. The site is their
  // primary home, so this is recoverable from nowhere else.
  'doc_vault',
  'podcasts',
  'episodes',
  'youtubevideos',
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
  'tool_workspaces',
  'tool_migration_workspaces',
  'tool_assessment_sessions',
  'tool_architecture_plans',
  'tool_exports',
  'mcp_servers',
  'lab_agents',
]);

/** Class B — weekly full + daily deltas. */
export const CONFIGURATION = freeze([
  'admins',
  'admin_config',
  'admin_settings',
  'site_settings',
  'system',
  'config',
  'config_providers',
  'config_settings',
  'config_tags',
  'ai_providers',
]);

/** Class C — weekly full only, no deltas. */
export const OPERATIONAL = freeze([
  'admin_audit_logs',
  'audits',
  'ai_usage',
  'telegram_bot_activity',
  'workflow_alerts',
  'workflow_digests',
  'content_stats_markers',
]);

/** Excluded — a scheduled job or a publish refills these from a class A source or the network. */
export const REGENERABLE = freeze([
  'brain_search',
  '_snapshots',
  'homepage_feeds',
  'rss_cache',
  'tool_service_cache',
  // Daily price snapshots (#613 Phase 3). Same disposition as the cache it
  // is cut from: the refresh job is its only writer and refills it going
  // forward. It is not backfilled — a lost container is a price-change feed
  // that restarts from empty, which the owner accepted over exporting 400
  // days of public list prices weekly.
  'tool_price_history',
]);

/** Excluded — a seeding script in this repository is the backup. */
export const SEED = freeze(['azure_landing_content', 'tool_service_catalog']);

/** Excluded — TTL-bounded runtime state. */
export const TRANSIENT = freeze([
  'jobs',
  'lab_jobs',
  'lab_public_quota',
  'submission_quota',
  'tool_ai_plan_quota',
  'tool_export_quota',
]);

/**
 * Every class, keyed by name, with its export rule. The exporter and the
 * contract test both read this map rather than the arrays above, so a class
 * cannot be added without deciding what happens to it on each run mode.
 *
 * @type {Readonly<Record<ExportClass, Readonly<{containers: readonly string[], full: boolean, delta: boolean}>>>}
 */
export const EXPORT_CLASSES = Object.freeze({
  authored: Object.freeze({ containers: AUTHORED, full: true, delta: true }),
  configuration: Object.freeze({ containers: CONFIGURATION, full: true, delta: true }),
  operational: Object.freeze({ containers: OPERATIONAL, full: true, delta: false }),
  regenerable: Object.freeze({ containers: REGENERABLE, full: false, delta: false }),
  seed: Object.freeze({ containers: SEED, full: false, delta: false }),
  transient: Object.freeze({ containers: TRANSIENT, full: false, delta: false }),
});

export const EXPORT_MODES = Object.freeze(['full', 'delta']);

/**
 * The class a container belongs to, or `null` when it is classified nowhere —
 * which the contract test turns into a build failure for any provisioned name.
 *
 * @param {string} container
 * @returns {ExportClass|null}
 */
export function classify(container) {
  for (const [name, spec] of Object.entries(EXPORT_CLASSES)) {
    if (spec.containers.includes(container)) return name;
  }
  return null;
}

/**
 * The containers one run exports, sorted, for a run mode.
 *
 * `full` (Sundays) is classes A + B + C: 61 containers. `delta` (every other
 * day) is A + B: 54. The scheduler enqueues exactly this list and the worker
 * that finds every one of its markers present writes the run manifest, so the
 * two halves must agree on the set — they do, because both call this.
 *
 * @param {'full'|'delta'} mode
 * @returns {string[]}
 */
export function exportPlanFor(mode) {
  if (!EXPORT_MODES.includes(mode)) {
    throw new Error(
      `exportPlanFor: mode must be one of ${EXPORT_MODES.join(', ')}, got ${JSON.stringify(mode)}`
    );
  }
  const out = [];
  for (const spec of Object.values(EXPORT_CLASSES)) {
    if (spec[mode]) out.push(...spec.containers);
  }
  return out.sort();
}

/** Every container named in any class, sorted — the set the contract test compares to the spec. */
export function classifiedContainers() {
  return Object.values(EXPORT_CLASSES)
    .flatMap((spec) => [...spec.containers])
    .sort();
}
