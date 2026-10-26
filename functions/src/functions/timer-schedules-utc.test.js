/**
 * The app clock is UTC, and no schedule silently depends on it not being.
 *
 * Owner decision 2026-09-07 (#416): all times in this app are UTC.
 *
 * ## The failure this catches
 *
 * An NCRONTAB hour is not a time until something says which clock it is read
 * against, and that something is an app setting in a different repository
 * directory from the expression. For most of this app's life it was
 * `WEBSITE_TIME_ZONE = America/Chicago` (infra/functionapp.tf), so `0 0 3 * * *`
 * in cosmos-export.js meant 08:00 UTC in summer and 09:00 in winter — while six
 * places in the Terraform and the ADR said "03:00 UTC", including the
 * description of `alert-cosmos-export-daily`, which is the sentence that
 * arrives in the alert mail. An operator reading it at 05:00 UTC would have
 * gone looking for a run that was not due for another three hours. That is
 * issue #416, and nothing in the test suite could see it: the expression was
 * valid, the setting was valid, and only their combination was wrong.
 *
 * Re-adding the setting — or `TZ`, which does the same job — would silently
 * move every registered timer that names an hour (all but the five
 * minute-only ones) and make the same six sentences wrong again. There is
 * no plan diff that reads as "every timer moved five hours"; it reads as one
 * app setting.
 *
 * That set is what this file enforces, and it is worth splitting because
 * the two halves matter differently to an operator:
 *
 *   - **The fixed-hour and fixed-day schedules change the instant they
 *     run** — a 07:00 digest becomes a 07:00 UTC digest, five hours earlier
 *     in wall-clock terms. This is the half that shows up as "the report
 *     arrived in the middle of the night".
 *   - **The hour-interval forms change phase but not cadence.** Every two,
 *     four, six and twelve hours still fire that often; WHICH hours shifts
 *     by minus five, modulo the interval. Nothing depends on those landing
 *     on particular hours, which is why they are the quieter half — but they
 *     ARE clock-dependent, and a guard that ignored them would pass while
 *     the estate moved underneath it.
 *
 * The rest are minute-only, every two, five or fifteen minutes, and
 * cannot move in any zone. The classifier below decides which bucket each one
 * is in from its hour field rather than from a list, so this comment describes
 * the shape and does not produce the count — a count written here drifted the
 * first time a timer was added (T-722's lesson, learned again on #1302).
 *
 * (Interval expressions are spelled out in words here rather than written
 * literally: an asterisk-slash sequence inside a block comment closes it, and
 * doing that in this file breaks the parser rather than the prose.)
 *
 * ## What is asserted, and what is deliberately not
 *
 *   1. **The app clock is UTC.** `infra/*.tf` sets neither `WEBSITE_TIME_ZONE`
 *      nor `TZ`, so NCRONTAB gets the platform default, which Microsoft
 *      documents as UTC. Absence is the assertion because absence is the
 *      configuration: setting `WEBSITE_TIME_ZONE = "UTC"` would be the same
 *      clock, but it is also documented as unsupported on Flex Consumption
 *      ("can create SSL-related issues and cause metrics to stop working"),
 *      so the setting existing at all is the thing worth failing on.
 *
 *   2. **Every clock-dependent schedule is written down in UTC.** A schedule
 *      whose firing instants change when the clock changes is listed in
 *      `CLOCK_DEPENDENT` below with the UTC time it is meant to mean. The
 *      classification is COMPUTED from the expression, not typed out: adding a
 *      timer on a fixed hour, or changing one, fails here until someone writes
 *      the UTC intent next to it. A schedule that names no hour at all
 *      fires on the same instants in every whole-hour zone and is classified
 *      out — measured, so it cannot be waved through by hand.
 *
 * Not asserted: that any particular hour is the RIGHT hour. Nothing in a
 * repository can know that 03:00 is a good time to export Cosmos. What this
 * pins is that the hour written in the code is the hour that happens, which is
 * the half that was broken.
 *
 * Reads the schedules from the real `app.timer()` registrations rather than
 * from the source text, so a schedule built at runtime cannot slip past a
 * regex. Reads Terraform as text, like timer-catalogue-sync.test.js: this has
 * to fail in CI, on a checkout, with no Azure credentials and no Terraform
 * binary.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { terraformSource } from '../../test/terraform-source.js';

const INFRA = join(fileURLToPath(new URL('../../..', import.meta.url)), 'infra');

/** Registrations recorded in place of the real Functions host. */
const timerRegistrations = new Map();

vi.mock('@azure/functions', () => ({
  app: {
    http: () => {},
    timer: (name, options) => timerRegistrations.set(name, options),
    cosmosDB: () => {},
    storageQueue: () => {},
  },
  output: {
    storageQueue: (options) => ({ type: 'queue', ...options }),
  },
}));

await import('./schedulers.js');
await import('./jobs-sweeper.js');
await import('./cosmos-export.js');
await import('./cloud-tools-jobs.js');
await import('./labs-jobs.js');
await import('./ambassador-audience.js');
await import('./visitor-session-sweep.js');

/**
 * Every schedule whose firing INSTANTS depend on the app clock, and the UTC
 * time each one is meant to mean.
 *
 * `scrapeSkillsHubRss` is why this table is worth its upkeep. Its upstream
 * schedule was `every friday 09:00` in UTC, and it was ported as `0 0 4 * * 5`
 * *because* the app clock was Central and 04:00 CDT is 09:00 UTC. Moving the
 * app to UTC without touching those four hours would have moved the one job
 * whose intent was already UTC, five hours, silently. Here that shows up as a
 * mismatch against `Friday 09:00`.
 */
const CLOCK_DEPENDENT = {
  // Fixed hour, every day.
  cleanupTempStorage: { schedule: '0 0 0 * * *', utc: 'daily 00:00' },
  refreshToolServiceCache: { schedule: '0 0 2 * * *', utc: 'daily 02:00' },
  cosmosExportScheduler: { schedule: '0 0 3 * * *', utc: 'daily 03:00' },
  forgeScheduled: { schedule: '0 30 3 * * *', utc: 'daily 03:30' },
  cleanupRejectedContent: { schedule: '0 0 4 * * *', utc: 'daily 04:00' },
  cleanupUnusedCertImages: { schedule: '0 0 5 * * *', utc: 'daily 05:00' },
  generateReviewerDigest: { schedule: '0 0 7 * * *', utc: 'daily 07:00' },
  // Late enough that the day it describes is nearly over (#665).
  labsWeeklyRollup: { schedule: '0 55 23 * * *', utc: 'daily 23:55' },
  // Daily, recording each month once (#1302): after both sources have
  // settled the last day of the month just ended.
  ambassadorAudienceMonthly: { schedule: '0 45 6 * * *', utc: 'daily 06:45' },
  // Fixed hour on one weekday — the day moves too if the clock does.
  reVerifyCertifications: { schedule: '0 0 0 * * 0', utc: 'Sunday 00:00' },
  checkLiveLinks: { schedule: '0 0 6 * * 1', utc: 'Monday 06:00' },
  // #701: NVIDIA's weekly re-check, a quarter hour after the link check.
  probeAiProviders: { schedule: '0 15 6 * * 1', utc: 'Monday 06:15' },
  // 08:00 CDT / 07:00 CST: the draft waits ahead of the Tuesday 09:00 Central send.
  buildWeeklyNewsletter: { schedule: '0 0 13 * * 1', utc: 'Monday 13:00' },
  // 08:00 CDT / 07:00 CST: the owner's reminders, read with the morning's first coffee.
  sendReminders: { schedule: '0 0 13 * * *', utc: 'daily 13:00' },
  scrapeSkillsHubRss: { schedule: '0 0 9 * * 5', utc: 'Friday 09:00' },
  // Hour intervals. The cadence survives any whole-hour offset; the PHASE does
  // not, so which instants they land on is still a property of the clock.
  syncRssFeeds: { schedule: '0 0 */2 * * *', utc: 'every 2 h from 00:00' },
  fetchPodcastFeeds: { schedule: '0 30 */2 * * *', utc: 'every 2 h from 00:30' },
  cleanupSoftDeletedContent: { schedule: '0 0 */4 * * *', utc: 'every 4 h from 00:00' },
  monitorPublishingPipeline: { schedule: '0 0 */6 * * *', utc: 'every 6 h from 00:00' },
  fetchBlogListings: { schedule: '0 15 */6 * * *', utc: 'every 6 h from 00:15' },
  refreshPlaudToken: { schedule: '0 0 */12 * * *', utc: 'every 12 h from 00:00' },
  // #1009: one real lab job an hour, clear of the five-minute timers' marks.
  // `*/1`, not `*`, so the alert-timer-overdue map can read its period.
  labCanary: { schedule: '0 20 */1 * * *', utc: 'every 1 h from 00:20' },
};

/**
 * The hour field of a six-field NCRONTAB expression, or null if it is not one.
 *
 * `{second} {minute} {hour} {day} {month} {day-of-week}` — index 2.
 */
function hourField(schedule) {
  const fields = String(schedule).trim().split(/\s+/);
  return fields.length === 6 ? fields[2] : null;
}

/**
 * Does this schedule fire on different INSTANTS under a different app clock?
 *
 * Central — the clock this app used to run on — is a whole-hour offset from
 * UTC, as is every zone Azure would plausibly be set to. So a schedule that
 * says nothing about which hour it wants fires at the same absolute times in
 * any of them: a quarter-hour minute pattern is :00 :15 :30 :45 past every
 * hour, everywhere.
 * Anything that names an hour, or divides the hours into a repeating set,
 * lands on a different set of instants when the offset changes.
 */
function dependsOnAppClock(schedule) {
  const hour = hourField(schedule);
  if (hour === null) return true; // Not a shape we understand — fail loudly.
  return hour !== '*';
}

describe('timer schedules are UTC', () => {
  it('reads the Terraform module and the timer registrations at all', () => {
    // Guards the guard. An empty read on either side would make every
    // assertion below pass by inspecting nothing.
    expect(terraformSource(INFRA).length).toBeGreaterThan(1000);
    expect(timerRegistrations.size).toBe(28);
  });

  it('the app clock is UTC — no WEBSITE_TIME_ZONE or TZ app setting exists', () => {
    const source = terraformSource(INFRA);
    // Assignment form only: the word appears in prose comments explaining why
    // it is absent, and a guard that a comment can trip is a guard nobody
    // keeps. `"NAME" = ...` or `NAME = ...` at the start of a line is the
    // shape an app setting takes inside the app_settings map.
    const assignments = [...source.matchAll(/^\s*"?(WEBSITE_TIME_ZONE|TZ)"?\s*=/gm)].map(
      (m) => m[1]
    );
    expect(
      assignments,
      'infra/*.tf sets an app clock. Every NCRONTAB hour in functions/src/functions/ is ' +
        'written as a UTC hour (#416), and six places in observability.tf, variables.tf and ' +
        'ADR 0028 state times in UTC — this setting silently re-times all of them and ' +
        'nothing else in the plan says so. Microsoft also documents WEBSITE_TIME_ZONE and TZ ' +
        'as unsupported on Linux Flex Consumption, where they "can create SSL-related issues ' +
        'and cause metrics to stop working". If a display needs Central, format it at the ' +
        'point of display; do not move the app clock.'
    ).toEqual([]);
  });

  it('every clock-dependent schedule is recorded with the UTC time it means', () => {
    const dependent = [...timerRegistrations]
      .filter(([, options]) => dependsOnAppClock(options.schedule))
      .map(([name]) => name)
      .sort();

    expect(
      dependent.filter((name) => !CLOCK_DEPENDENT[name]),
      'these timers name an hour, so the app clock decides when they fire, and no UTC intent ' +
        'is recorded for them in CLOCK_DEPENDENT. Add the entry — the point is that the ' +
        'instant a schedule is meant to hit is written down somewhere a reviewer can check ' +
        'it against the expression.'
    ).toEqual([]);

    expect(
      Object.keys(CLOCK_DEPENDENT).filter((name) => !dependent.includes(name)),
      'recorded in CLOCK_DEPENDENT but no longer a clock-dependent timer — it was renamed, ' +
        'removed, or its schedule stopped naming an hour. Drop the entry.'
    ).toEqual([]);
  });

  it('each recorded schedule still matches the expression that is registered', () => {
    const drifted = [];
    for (const [name, { schedule }] of Object.entries(CLOCK_DEPENDENT)) {
      const registered = timerRegistrations.get(name)?.schedule;
      if (registered !== schedule)
        drifted.push(`${name}: recorded ${schedule}, registered ${registered}`);
    }
    expect(
      drifted,
      'a schedule changed without its recorded UTC intent changing with it. That is exactly ' +
        'the scrapeSkillsHubRss shape: 0 0 4 * * 5 meant Friday 09:00 UTC only while the app ' +
        'clock was Central, and on a UTC clock the same expression is Friday 04:00.'
    ).toEqual([]);
  });

  it('the zone-independent schedules really are minute-only', () => {
    // The other side of the classification. If this list ever grows a
    // fixed-hour timer, dependsOnAppClock() is broken rather than generous.
    const independent = [...timerRegistrations]
      .filter(([, options]) => !dependsOnAppClock(options.schedule))
      .map(([name, options]) => [name, options.schedule])
      .sort(([a], [b]) => a.localeCompare(b));

    expect(independent).toEqual([
      ['checkAgentHealth', '0 */5 * * * *'],
      ['healthPulse', '0 2-59/5 * * * *'],
      ['platformJobSweeper', '0 */15 * * * *'],
      ['publishScheduledContent', '0 */15 * * * *'],
      ['sweepVisitorSessions', '0 */2 * * * *'],
      ['syncSocialCalendarScheduled', '0 */5 * * * *'],
    ]);
  });
});
