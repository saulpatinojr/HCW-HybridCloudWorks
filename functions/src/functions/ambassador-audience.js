/**
 * ambassador-audience.js — the monthly audience timer (#1302).
 *
 * Once a month, read the previous calendar month's page views from
 * Cloudflare Web Analytics and the show's downloads from Podbean, and file
 * one evidence row per programme that asks for reach in the Ambassador hub
 * (lib/timers/ambassador-audience.js has the reads, the row and why the
 * Docker Captain and Microsoft MVP seeds list `manual` under `reach`).
 * Nothing is shown to visitors; the figure is evidence for an application,
 * not decoration.
 *
 * DAILY AT 06:45 UTC, RECORDING ONCE. The schedule is a daily one, not
 * `0 0 6 1 * *`, by design (infra/observability.tf, `timer_schedules`):
 * alert-timer-overdue computes each timer's due time as anchor + period × n,
 * and a day-of-month NCRONTAB has no fixed period for it, so a monthly
 * schedule would be the one timer the rule could not watch. Instead the
 * timer fires every day, asks whether the previous month is already
 * recorded — both programmes' rows present — and when it is, logs one line
 * and reads nothing. The first run of a month does the work; the other
 * twenty-nine cost a point read each. A partial month (one row of the two,
 * after a failure between the writes) is completed on the next day's run,
 * with the figures re-read, which is what the deterministic row id is for.
 *
 * 06:45, not midnight: Cloudflare's adaptive dataset and Podbean's daily
 * buckets both settle the last day's figures some hours after it ends
 * (Podbean clamps `end` to yesterday), so a read at 00:00 on the first would
 * be reading a day that is not finished being counted.
 *
 * Gated like every timer: the master `FEATURE_FLAG_SCHEDULERS` must not be
 * "false" AND `FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY` must be "true" — the
 * shared gate in lib/timers/flag-gate.js. The flag is in
 * `local.timer_catalogue` (infra/functionapp.tf) and arms through
 * `enabled_timers` like the rest; the app clock is UTC (#416).
 *
 * Runs inline, not as a platform job: one GraphQL call, one Podbean read and
 * two point writes are seconds of work, and the summary the host logs is the
 * whole record an operator needs. A failed Cloudflare read is rethrown so
 * the run is recorded as failed; an unavailable Podbean read is a line in
 * the row, never a failed run.
 */
import { app } from '@azure/functions';
import { createDoc, patchDoc, readDoc } from '../lib/cosmos-client.js';
import { createPodbeanClient } from '../lib/podcast/podbean.js';
import { logDisabledSkip, timerEnabled } from '../lib/timers/flag-gate.js';
import { createAudienceMonthlyRead } from '../lib/timers/ambassador-audience.js';

export const TIMER_NAME = 'ambassadorAudienceMonthly';
export const TIMER_FLAG = 'AMBASSADOR_AUDIENCE_MONTHLY';
/** Daily 06:45 UTC; the run itself records each month once (see the header). */
export const TIMER_SCHEDULE = '0 45 6 * * *';

/** "true" arms it; the schedulers master switch still holds it off. */
export const audienceEnabled = (env = process.env) => timerEnabled(TIMER_FLAG, env);

app.timer(TIMER_NAME, {
  schedule: TIMER_SCHEDULE,
  handler: async (_timer, context) => {
    if (!audienceEnabled()) {
      logDisabledSkip(context, TIMER_NAME);
      return;
    }
    const result = await createAudienceMonthlyRead({
      // createDoc is the atomic insert the hub uses for imported rows; the
      // patch carries the stored ETag (lib/ambassador/evidence.js, steps.js).
      store: { readDoc, createDoc, patchDoc },
      podbean: createPodbeanClient(),
      log: context,
      label: TIMER_NAME,
    }).run();
    context.log(`[${TIMER_NAME}] ${JSON.stringify(result)}`);
  },
});
