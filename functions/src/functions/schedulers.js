/**
 * schedulers.js — the timer triggers replacing Firebase Cloud Scheduler
 * (Migration-Plan §4.2, T-323).
 *
 * **Each timer has its own flag.** A timer runs when the master switch
 * `FEATURE_FLAG_SCHEDULERS` is not explicitly "false" AND its own
 * `FEATURE_FLAG_<NAME>` is "true". Timers fire on schedule regardless — the
 * flags make them safe no-ops — and every flag is "false" in
 * `infra/functionapp.tf` (generated from `local.timer_flags`, so a timer is
 * armed by adding its suffix to the `enabled_timers` workspace variable)
 * until that timer has been observed firing at the intended time (§6 step 7).
 *
 * **Every hour below is a UTC hour.** Owner decision 2026-09-07 (#416): all
 * times in this app are UTC. The Function App sets no `WEBSITE_TIME_ZONE`, so
 * NCRONTAB gets the platform default — infra/functionapp.tf carries the
 * citation and says why the setting was removed rather than set to "UTC", and
 * `timer-schedules-utc.test.js` fails if either half drifts. Until that
 * decision the app clock was `America/Chicago` and a bare hour here meant
 * Central; Migration-Plan §4.2 has the ported table and the note recording
 * which instants moved.
 *
 * One timer from the upstream sixteen is not here:
 * `refreshToolServiceCacheScheduled`, demoted with Cloud Tools (T-322) and
 * returned as `refreshToolServiceCache` in cloud-tools-jobs.js (#613), where
 * it enqueues the refresh as a platform job rather than running it inline.
 * Two delete blobs — `cleanupTempStorage`, `cleanupUnusedCertImages` — and
 * both are dry-run until their own `*_DELETE=true` setting (T-302).
 *
 * Every handler builds its dependencies per invocation, not at module load:
 * this file is imported by index.js on every cold start, including for
 * anonymous GETs that never run a timer.
 */
import { app } from '@azure/functions';
import * as store from '../lib/cosmos-client.js';
import * as blobStorage from '../lib/blob-storage.js';
import { createPublishHandlers } from '../lib/cms/publish.js';
import { createDefaultInlineImageRehoster } from '../lib/cms/inline-images-default.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createScheduledPublisher } from '../lib/scheduled-publish.js';
import { createSnapshotPublishHandlers } from '../lib/snapshots-publish.js';
import { createReviewerDigest } from '../lib/timers/reviewer-digest.js';
import { createContentCleanup } from '../lib/timers/content-cleanup.js';
import { createPublishingWatchdog } from '../lib/timers/publishing-watchdog.js';
import { createLinkCheck } from '../lib/timers/link-check.js';
import { createCertReverify } from '../lib/timers/cert-reverify.js';
import { createCertImageCleanup } from '../lib/timers/cert-image-cleanup.js';
import { createSkillsHubScrape } from '../lib/timers/skills-hub.js';
import { createMcpTokenRefresh } from '../lib/timers/mcp-token-refresh.js';
import { createAgentHealthCheck } from '../lib/timers/agent-health.js';
import { createDeliveryMonitorWatch } from '../lib/timers/delivery-monitor-watch.js';
import { createMainHistoryReader } from '../lib/labs/drift.js';
import { createCoderStatusHandlers } from '../lib/labs/coder-status.js';
import { createTempStorageCleanup } from '../lib/timers/temp-storage.js';
import { createForgeScheduled } from '../lib/timers/forge-scheduled.js';
import { findDuplicateContent, buildDedupFields } from '../lib/cms/content-dedup.js';
import { createPublerClient, createPublerReconcile } from '../lib/timers/publer-sync.js';
import { recordKeyVerdict } from '../lib/key-verdict.js';
import { createBlogListingsScrape } from '../lib/timers/blog-listings.js';
import { createPodcastIngest, createPodcastParser } from '../lib/timers/podcasts.js';
import { createNewsletterAutoBuild } from '../lib/timers/newsletter-autobuild.js';
import { createReminderCheck } from '../lib/timers/reminders.js';
import { syncCredentialReminders } from '../lib/credentials/reminders.js';
import { createNotifier } from '../lib/notify.js';
import { logDisabledSkip, timerEnabled } from '../lib/timers/flag-gate.js';

/**
 * Register a flag-gated timer. `run(context)` returns a small summary that is
 * logged; a thrown error is logged and rethrown so the host records the
 * failure. The gate and the once-per-process skip log are
 * lib/timers/flag-gate.js, shared with the pricing refresh timer.
 */
function timer(name, flag, schedule, run) {
  app.timer(name, {
    schedule,
    handler: async (_timer, context) => {
      if (!timerEnabled(flag)) {
        logDisabledSkip(context, name);
        return;
      }
      const result = await run(context);
      if (result !== undefined) context.log(`[${name}] ${JSON.stringify(result)}`);
    },
  });
}

const storage = () => ({ listBlobs: blobStorage.listBlobs, deleteBlob: blobStorage.deleteBlob });

// ── Ingestion and drafting ───────────────────────────────────────────────────

timer('syncRssFeeds', 'SYNC_RSS_FEEDS', '0 0 */2 * * *', async (context) => {
  // Site-Main: `every 2 hours`. Same ingest as the fetch-rss-feeds job.
  const { runRssIngest } = await import('./rss-jobs.js');
  const results = await runRssIngest(context);
  return {
    processed: results.processed,
    newContent: results.newContent,
    errors: results.errors.length,
  };
});

timer('fetchPodcastFeeds', 'FETCH_PODCAST_FEEDS', '0 30 */2 * * *', async (context) =>
  // Site-Main: `every 2 hours`, offset from syncRssFeeds. Feed list comes
  // from admin_config/podcast_feeds at run time (#348).
  createPodcastIngest({ store, parser: await createPodcastParser(), log: context }).run()
);

timer('fetchBlogListings', 'FETCH_BLOG_LISTINGS', '0 15 */6 * * *', (context) =>
  // Site-Main: `every 6 hours`. Skips itself while FIRECRAWL_API_KEY is a stub.
  createBlogListingsScrape({
    store,
    dedup: { findDuplicateContent, buildDedupFields },
    log: context,
  }).run()
);

timer('forgeScheduled', 'FORGE_SCHEDULED', '0 30 3 * * *', async (context) => {
  // Site-Main: `every 24 hours`. Off twice over: this flag and the Auto-Forge
  // toggle in Forge Memory (admin_config/forge_prompts.autoForge).
  const [{ defaultForgeConfig }, { createDrafter }, { createGrader }, { createForge }, ai] =
    await Promise.all([
      // The process-wide loader, NOT a private instance: a Forge Studio edit
      // clears the cache this timer reads (forge-config-default.js, #239).
      import('../lib/content/forge-config-default.js'),
      import('../lib/content/drafting.js'),
      import('../lib/content/forge-grader.js'),
      import('../lib/content/forge.js'),
      import('../lib/ai/router.js'),
    ]);
  const config = defaultForgeConfig;
  const forge = createForge({
    store,
    config,
    drafter: createDrafter({ store, ai }),
    grader: createGrader({ ai }),
    log: context,
  });
  return createForgeScheduled({ store, config, forge, log: context }).run();
});

// ── Publishing ───────────────────────────────────────────────────────────────

timer('publishScheduledContent', 'PUBLISH_SCHEDULED_CONTENT', '0 */15 * * * *', async (context) => {
  const publish = createPublishHandlers({
    guard: getDefaultGuard(),
    store,
    inlineImages: createDefaultInlineImageRehoster(context),
    log: context,
  });
  await createScheduledPublisher({ store, publish }).runScheduledPublish(context);
});

timer('monitorPublishingPipeline', 'MONITOR_PUBLISHING_PIPELINE', '0 0 */6 * * *', (context) =>
  createPublishingWatchdog({ store, log: context }).run()
);

timer('generateReviewerDigest', 'GENERATE_REVIEWER_DIGEST', '0 0 7 * * *', (context) =>
  createReviewerDigest({ store, log: context }).run()
);

timer('checkLiveLinks', 'CHECK_LIVE_LINKS', '0 0 6 * * 1', (context) =>
  createLinkCheck({ store, log: context }).run()
);

timer('buildWeeklyNewsletter', 'BUILD_WEEKLY_NEWSLETTER', '0 0 13 * * 1', async (context) => {
  // #504: Monday 13:00 UTC — 08:00 CDT / 07:00 CST — so the draft is waiting
  // well before the default Tuesday 09:00 Central send. Builds the last seven
  // days into Drafts and pings Telegram with the link. NEVER SENDS: approval
  // stays a manual press on the Drafts tab. Same builder wiring as the
  // build-newsletter-issue job (forge-jobs.js).
  const [{ createIssueBuilder }, { createDrafter }, ai] = await Promise.all([
    import('../lib/newsletter/issue.js'),
    import('../lib/content/drafting.js'),
    import('../lib/ai/router.js'),
  ]);
  return createNewsletterAutoBuild({
    builder: createIssueBuilder({ store, drafter: createDrafter({ store, ai }), log: context }),
    notifier: createNotifier({ store, log: context }),
    log: context,
  }).run();
});

// ── Retirement ───────────────────────────────────────────────────────────────

timer('cleanupRejectedContent', 'CLEANUP_REJECTED_CONTENT', '0 0 4 * * *', (context) =>
  createContentCleanup({ store, log: context }).softDeleteRejected({
    olderThanHours: 24,
    limit: 500,
  })
);

timer('cleanupSoftDeletedContent', 'CLEANUP_SOFT_DELETED_CONTENT', '0 0 */4 * * *', (context) =>
  // 7-day grace window from softDeletedAt; with the 24 h above, an accidental
  // rejection is recoverable for ~8 days. Dry-run until CONTENT_HARD_DELETE=true
  // (T-302), and a mark with no recorded origin is never deleted.
  createContentCleanup({ store, log: context }).hardDeleteSoftDeleted({
    olderThanHours: 24 * 7,
    limit: 200,
  })
);

timer('cleanupTempStorage', 'CLEANUP_TEMP_STORAGE', '0 0 0 * * *', (context) =>
  // T-302: prefix + age, dry-run until TEMP_STORAGE_CLEANUP_DELETE=true.
  createTempStorageCleanup({ storage: storage(), log: context }).run()
);

timer('cleanupUnusedCertImages', 'CLEANUP_UNUSED_CERT_IMAGES', '0 0 5 * * *', (context) =>
  // Dry-run until CERT_IMAGE_CLEANUP_DELETE=true.
  createCertImageCleanup({ store, storage: storage(), log: context }).run()
);

// ── Certifications ───────────────────────────────────────────────────────────

timer('reVerifyCertifications', 'REVERIFY_CERTIFICATIONS', '0 0 0 * * 0', (context) => {
  const snapshots = createSnapshotPublishHandlers({
    guard: getDefaultGuard(),
    store,
    storage: blobStorage,
    log: context,
  });
  return createCertReverify({
    store,
    publishSnapshots: snapshots.publishSnapshots,
    log: context,
  }).run();
});

timer('scrapeSkillsHubRss', 'SCRAPE_SKILLS_HUB_RSS', '0 0 9 * * 5', async (context) => {
  // Site-Main: `every friday 09:00` UTC — the ONE upstream schedule that was
  // declared in UTC, and the one this expression must not move. It read
  // `0 0 4 * * 5` while the app clock was America/Chicago, chosen because
  // 04:00 CDT is 09:00 UTC; on a UTC clock the same four hours would have
  // silently retimed it to 04:00 UTC. 09:00 here is the upstream instant, and
  // it no longer drifts an hour across DST the way the Chicago form did.
  const { createRssParser } = await import('../lib/rss/ingest.js');
  return createSkillsHubScrape({ store, parser: await createRssParser(), log: context }).run();
});

// ── Platform ─────────────────────────────────────────────────────────────────

timer('syncSocialCalendarScheduled', 'SYNC_SOCIAL_CALENDAR', '0 */5 * * * *', (context) =>
  // Site-Main: `every 5 minutes`. D12: the live writer of social_posts — this
  // flag stays off until the cutover delta import is done (§6).
  //
  // `recordKeyVerdict` is the same process-wide writer the AI router's default
  // instance uses: a 401/403 from Publer turns PUBLER_API_KEY red on the
  // API-keys page and the run skips instead of failing (#358). The client is
  // still built per invocation; the writer dedupes successes per worker.
  createPublerReconcile({
    store,
    client: createPublerClient({ onKeyVerdict: recordKeyVerdict, log: context }),
    log: context,
  }).run()
);

timer('refreshPlaudToken', 'REFRESH_PLAUD_TOKEN', '0 0 */12 * * *', (context) =>
  // Since 2026-10-08 the MCP OAuth token refresh: Plaud's own refresh, then
  // the standard refresh grant for every server connected through OAuth
  // Connect. Name, flag and schedule unchanged so nothing needs re-arming
  // (lib/timers/mcp-token-refresh.js says why).
  createMcpTokenRefresh({ store, log: context }).run()
);

timer('checkAgentHealth', 'CHECK_AGENT_HEALTH', '0 */5 * * * *', (context) =>
  // The notifier is how the owner hears that the lab closed (LAB-2); the
  // mark itself never depends on it. The drift reader is main's lab-host/
  // and vps-agent/ history, read once an hour for the lab-drift check
  // (#1009, labs/drift.js), after the marks and messages. Last, once an
  // hour, the Coder status token is checked directly, past the labs page's
  // minute cache, for the coder-token check (labs/coder-status.js
  // checkTokenIfDue; CodeRabbit, #1056). Then, once an hour, the delivery
  // monitor's own runs are read from GitHub's public API and the owner is
  // told on Telegram when it goes red or back to green
  // (timers/delivery-monitor-watch.js; no GitHub secret, no new timer).
  createAgentHealthCheck({
    store,
    notifier: createNotifier({ store, log: context }),
    log: context,
    driftReader: createMainHistoryReader(),
    coderTokenCheck: () => createCoderStatusHandlers({ store }).checkTokenIfDue(context),
    deliveryWatch: createDeliveryMonitorWatch({
      store,
      notifier: createNotifier({ store, log: context }),
      log: context,
    }),
  }).run()
);

// The Health Hub's pulse (#1010): every check the backend can make on its
// own, recorded with checkedBy 'pulse', then its own heartbeat, so the hub can
// say when it last looked and turn Offline when it stops looking. Two minutes
// past each five-minute mark: after checkAgentHealth has marked stale agents,
// and never in the same second as the publisher or the watchdog. Reads and
// small writes only; it calls no third party (lib/health/pulse.js).
timer('healthPulse', 'HEALTH_PULSE', '0 2-59/5 * * * *', async (context) => {
  const [{ createHealthPulse }, { createOpsHealthHandlers }] = await Promise.all([
    import('../lib/health/pulse.js'),
    import('../lib/ops-health.js'),
  ]);
  // buildSnapshot is the unguarded builder the Telegram bot already uses: the
  // pulse is not a user, so it has no token for the HTTP face's role check.
  const { buildSnapshot } = createOpsHealthHandlers({ guard: null, store });
  return createHealthPulse({ store, buildSnapshot, log: context }).run();
});

// The lab canary (#1009): one real shell-echo job an hour, enqueued and
// waited for until the agent has run it end to end, recorded for the Health
// Hub's lab-canary probe, and deleted. Twenty past, clear of the five-minute
// timers' marks. A real job on the owner's host, so off until LAB_CANARY is
// in enabled_timers (lib/labs/canary.js). The Coder status token is
// checked by checkAgentHealth, above, which is armed, not by this.
timer('labCanary', 'LAB_CANARY', '0 20 */1 * * *', async (context) => {
  const { createLabCanary } = await import('../lib/labs/canary.js');
  return createLabCanary({ store, log: context }).run();
});

// ── AI ───────────────────────────────────────────────────────────────────────

// The owner's reminders sheet (Platform Settings → Reminders), said on
// Telegram ahead of each date, on the day, and weekly while overdue until
// marked done (owner request 2026-10-06). 13:00 UTC is 08:00 Central. Each
// run first syncs the credential register's rows (#1026), so a rotation
// since yesterday has moved its reminder before anything is said.
timer('sendReminders', 'SEND_REMINDERS', '0 0 13 * * *', (context) =>
  createReminderCheck({
    store,
    notifier: createNotifier({ store, log: context }),
    log: context,
    syncCredentials: (at) => syncCredentialReminders({ store, now: () => at, log: context }),
  }).run()
);

timer('probeAiProviders', 'PROBE_AI_PROVIDERS', '0 15 6 * * 1', async (context) => {
  // #701, owner decision 2026-09-29: NVIDIA is the backup for content
  // features, re-checked weekly so a feature can move back to 'first' on
  // evidence. The AI Engine's Test, run against every provider with a key;
  // the results land on the provider cards (lib/timers/ai-provider-probe.js).
  // The process-wide router, so the probe shares NVIDIA's pacing guard with
  // every other call on this instance.
  //
  // ADR 0034 slice 2 (#857): the same run then lists each keyed provider's
  // models into admin_settings/ai-model-catalog (lib/ai/model-catalog.js),
  // after the Tests so a catalogue failure cannot cost the results already
  // written. Foundry lists with the app identity's token, built the way the
  // router builds its own.
  const [ai, { createAiProviderProbe }, catalog] = await Promise.all([
    import('../lib/ai/router.js'),
    import('../lib/timers/ai-provider-probe.js'),
    import('../lib/ai/model-catalog.js'),
  ]);
  const refresh = () => {
    const ctx = catalog.createListContext();
    return catalog.refreshModelCatalog({
      store,
      // The media providers list too (ADR 0034 slice 5): keyed is enabled for them.
      providers: [...ai.availableProviders(), ...ai.availableMediaProviders()],
      listModels: (provider) => catalog.listModels(ctx, provider),
    });
  };
  return createAiProviderProbe({ store, ai, catalog: { refresh }, log: context }).run();
});
