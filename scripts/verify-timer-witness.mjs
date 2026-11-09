#!/usr/bin/env node
/**
 * Read a timer's DURABLE SIDE EFFECT through the public API, and say whether it
 * is newer than a moment you name. No az, no workspace, no telemetry plane.
 *
 * Why this exists — 2026-09-03. Cutover-Runbook step 5's fourth gate reads
 * `Function.<name>` traces in AppTraces to prove a timer fired. #321 dropped
 * host.json's `Function` category to Warning to get AppTraces volume off the
 * daily cap, and those traces are Information-level: after the 17:59Z deploy
 * the host stopped writing them, and `05-verify-timer.ps1` stopped being able
 * to see any invocation at all. The #321 record believed it had preserved the
 * gate by keeping `Host.Results` — but that feeds AppRequests, which the verify
 * script's own header says has been empty for the app's whole life (T-514).
 * The cut kept the table the gate does not read and removed the one it does.
 *
 * The runbook already names the way out: "pair the telemetry with a durable
 * side effect the timer necessarily creates ... if telemetry and the witness
 * disagree, believe the witness." This reads the witness. Owner decision
 * 2026-09-03: keep the cut, make the side effect the primary evidence.
 *
 * Only timers whose side effect is PUBLICLY readable are covered, and the
 * table says which are not. A timer with no public witness is reported as
 * exactly that — exit 2, not a pass and not a fail — because "cannot evaluate"
 * and "evaluated and failed" are different findings, and this repository has
 * paid for conflating them before (check-todo-changelog-movement.mjs).
 *
 *   node scripts/verify-timer-witness.mjs --timer syncRssFeeds --since 2026-09-03T05:00:00Z
 *
 * `--since` is the moment after which you expect a fire — the apply time, or
 * the last scheduled tick. No cron parser here on purpose: the schedule is
 * something the operator already knows, and a parser is a second thing to be
 * wrong about.
 *
 * ===========================================================================
 * HOW TO PROVE THE APP CLOCK, NOW THAT NOTHING PRINTS IT
 * ===========================================================================
 * Kept here on 2026-09-08, when `scripts/cutover/05-verify-timer.ps1` was
 * retired. That script proved the clock by reading the host's own
 * `Trigger Details: ScheduleStatus: {"Last":"...+00:00"}` line out of
 * AppTraces, where the offset was the app clock stated by the platform. Since
 * #321 dropped host.json's `Function` category to Warning to stay under the
 * workspace's 0.25 GB/day cap, the host writes no such line: measured
 * 2026-09-08, 4,179 AppTraces rows in 24 hours and NOT ONE containing
 * `ScheduleStatus`. The instrument is off, and turning it back on costs the
 * cap. So the method below replaces it, and it needs no verbosity at all.
 *
 * COMPARE OBSERVED FIRING TIMES AGAINST THE SCHEDULE, AND READ THE OFFSET.
 * Pick a timer whose NCRONTAB fires at a fixed hour — not a 5-minute timer,
 * which fires at :00 :05 :10 in every zone on earth and can therefore never
 * prove anything about the clock, however many times you watch it. Take its
 * witness timestamps from this script over a window that spans several fires.
 * The gap between the scheduled hour and the observed hour IS the app clock's
 * offset from UTC.
 *
 * The worked example, which is why this paragraph is trustworthy rather than
 * plausible. `fetchPodcastFeeds` has an hour field with a step of 2 and a
 * minute field of 30 — every second hour at half past; read the literal off
 * schedulers.js, because writing an NCRONTAB step in a block comment ends the
 * comment. Its observed fires either side of #416, the change that removed
 * `WEBSITE_TIME_ZONE = America/Chicago`:
 *
 *     2026-09-07T23:30Z   odd UTC hour   ← America/Chicago (18:30 local, even)
 *     2026-09-08T01:30Z   odd UTC hour   ← America/Chicago (20:30 local, even)
 *     2026-09-08T04:30Z   even UTC hour  ← UTC, after the switch
 *
 * A step of 2 fires on EVEN hours of whatever clock the host holds. Under a
 * UTC-5 offset those even local hours land on odd UTC hours, and the parity
 * flip at 04:30Z is the switch itself, visible without a single trace row. Any
 * timer with an even-hour or fixed-hour schedule gives the same reading.
 *
 * Read the expected schedule from `functions/src/functions/schedulers.js`, and
 * note that `functions/src/functions/timer-schedules-utc.test.js` is the CI
 * guard that fails if `WEBSITE_TIME_ZONE` or `TZ` is re-introduced — so this
 * is a way to confirm the clock from outside, not the only thing standing
 * between the estate and a silent retiming.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE = 'https://api-azure.hybridcloudworks.com/api';

/** Every provider the feed route is queried for. Mirrors PROVIDER_FEEDS keys. */
export const PROVIDERS = ['azure', 'aws', 'gcp', 'github', 'terraform', 'ansible', 'vmware', 'finops', 'docker'];

/**
 * The witness table. One entry per registered timer — the test asserts this
 * set matches what schedulers.js and jobs-sweeper.js register, so a timer
 * added to the app without a row here fails CI rather than silently having
 * no gate.
 *
 * `routes`  — public paths to GET, relative to the /api base.
 * `extract` — pulls ISO timestamps out of one response body. Pure.
 * `witness` — what a fresh timestamp proves, in the operator's terms.
 * `none`    — why no public witness exists, when that is the case.
 */
export const WITNESSES = {
  syncRssFeeds: {
    routes: PROVIDERS.map((p) => `public/feed?provider=${p}`),
    extract: (body) => (body?.rssCache || []).map((d) => d.refreshedAt).filter(Boolean),
    witness: 'rss_cache.refreshedAt — every feed document is re-stamped on each run',
  },
  fetchPodcastFeeds: {
    routes: ['public/podcasts?provider=azure&limit=250'],
    extract: (body) => (body?.items || []).map((d) => d.updatedAt).filter(Boolean),
    witness: 'podcasts.updatedAt — every episode is re-upserted with now() on each run',
  },
  publishScheduledContent: {
    routes: ['public/content?limit=250'],
    extract: (body) => (body?.items || []).map((d) => d.publishedAt).filter(Boolean),
    witness:
      'content.publishedAt — only when something was actually scheduled inside the window; an empty window is not a failure',
  },
  platformJobSweeper: { none: 'requeues jobs in a private queue; nothing public changes' },
  monitorPublishingPipeline: { none: 'read-only watchdog by design; it writes nothing' },
  checkAgentHealth: { none: 'stamps lab_agents, which has no public route' },
  cleanupTempStorage: { none: 'dry-run until TEMP_STORAGE_CLEANUP_DELETE; blobs are private' },
  fetchBlogListings: { none: 'drafts content for review; drafts are not public' },
  scrapeSkillsHubRss: { none: 'drafts content for review; drafts are not public' },
  forgeScheduled: { none: 'drafts content for review; drafts are not public' },
  generateReviewerDigest: { none: 'sends mail; no document is written' },
  checkLiveLinks: { none: 'annotates content documents; the annotation is not projected publicly' },
  buildWeeklyNewsletter: { none: 'writes a draft newsletter issue and pings Telegram; drafts are not public, and it never sends' },
  reVerifyCertifications: { none: 'updates certifications; the verification field is not projected publicly' },
  cleanupUnusedCertImages: { none: 'dry-run until CERT_IMAGE_CLEANUP_DELETE; blobs are private' },
  cleanupSoftDeletedContent: { none: 'deletes soft-deleted documents, which were never public' },
  cleanupRejectedContent: { none: 'deletes rejected documents, which were never public' },
  syncSocialCalendarScheduled: { none: 'writes social_posts, which has no public route' },
  refreshPlaudToken: { none: 'rotates a secret; nothing public changes' },
  probeAiProviders: { none: 'stamps ai_providers and writes ai_usage, which have no public route' },
  sendReminders: { none: 'says reminders on Telegram and stamps admin_config/reminders, which has no public route' },
  healthPulse: { none: 'records the Health Hub probe results and its heartbeat in admin_config, which has no public route' },
  labCanary: {
    none: 'runs one lab job, deletes it, and records the run in admin_config/lab_canary, which has no public route; the labs status read it also makes is refreshed by visitors too, so it witnesses nothing',
  },
  syncSearchConsole: {
    none: 'reads Google and rewrites admin_config/search_console_snapshot, which has no public route; the admin Search Console page shows run.finishedAt',
  },
};

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { base: process.env.WITNESS_BASE_URL || DEFAULT_BASE, timer: '', since: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') args.base = argv[++i] || '';
    else if (argv[i] === '--timer') args.timer = argv[++i] || '';
    else if (argv[i] === '--since') args.since = argv[++i] || '';
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  args.base = args.base.replace(/\/+$/, '');
  return args;
}

/**
 * Decide from a list of ISO timestamps whether the witness is newer than
 * `since`. Unparseable stamps are ignored rather than treated as fresh — a
 * malformed date must never count as evidence that something ran.
 */
export function judge(timestamps, since) {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new Error(`--since is not a parseable date: ${since}`);
  const valid = timestamps.map((t) => Date.parse(t)).filter((ms) => !Number.isNaN(ms));
  if (valid.length === 0) return { count: 0, newest: null, fresh: false };
  const newestMs = Math.max(...valid);
  return { count: valid.length, newest: new Date(newestMs).toISOString(), fresh: newestMs >= sinceMs };
}

// ── the run ──────────────────────────────────────────────────────────────────

async function readWitness(base, entry) {
  const stamps = [];
  for (const route of entry.routes) {
    const res = await fetch(`${base}/${route}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${route} answered HTTP ${res.status}`);
    stamps.push(...entry.extract(await res.json()));
  }
  return stamps;
}

function usage() {
  console.log(`usage: node scripts/verify-timer-witness.mjs --timer <name> --since <ISO-8601>

  --timer   a registered timer name, e.g. syncRssFeeds
  --since   the moment after which a fire is expected, e.g. 2026-09-03T05:00:00Z
  --base    public API base (default ${DEFAULT_BASE})

exit 0  witness is newer than --since
exit 1  witness exists but is older, or the read failed
exit 2  this timer has no public witness — nothing was evaluated`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.timer || !args.since) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const entry = WITNESSES[args.timer];
  if (!entry) {
    console.error(`unknown timer '${args.timer}'. Known: ${Object.keys(WITNESSES).join(', ')}`);
    process.exit(1);
  }
  if (entry.none) {
    console.log(`NO PUBLIC WITNESS  ${args.timer}: ${entry.none}`);
    console.log('Nothing was evaluated. For this timer the remaining witness is the host trace,');
    console.log("which needs host.json 'Function.<name>' raised to Information for this one category.");
    process.exit(2);
  }
  let verdict;
  try {
    verdict = judge(await readWitness(args.base, entry), args.since);
  } catch (err) {
    console.log(`FAIL  ${args.timer}: ${err?.message || err}`);
    process.exit(1);
  }
  const label = verdict.fresh ? 'PASS' : 'FAIL';
  console.log(`${label}  ${args.timer}  witness: ${entry.witness}`);
  console.log(`      ${verdict.count} stamped document(s); newest ${verdict.newest ?? '(none)'}; since ${args.since}`);
  if (!verdict.fresh && verdict.count === 0) {
    console.log('      Nothing stamped at all — for a container written only by this timer, that means it has never run here.');
  }
  process.exit(verdict.fresh ? 0 : 1);
}

// pathToFileURL, not string concatenation: on Windows argv[1] is `C:\...`, and
// `file://C:\...` never equals import.meta.url, so the script would exit 0
// having done nothing — the worst possible failure for a gate.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
