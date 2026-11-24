/**
 * labs-jobs.js — the labs rollup timer (#665, Phase 5 of #656).
 *
 * Once a day, at 23:55 UTC, fold the two labs minute-caches and the day's
 * `lab_jobs` rows into one `labs:day:<YYYY-MM-DD>` document in
 * `tool_service_cache` (lib/labs/rollup.js has the shape and the reads). The
 * newsletter's "Lab this week" section reads seven of those by point read,
 * which is how the Monday build reports Arc uptime, jobs by type and the
 * Coder peak without ever calling Azure or Coder itself.
 *
 * 23:55 rather than just after midnight so the document describes the day it
 * runs in: the estate cache it reads is the one visitors filled that day, and
 * the job query covers the day from 00:00 to now. The five minutes it leaves
 * are a lab job or two, not a heartbeat.
 *
 * Gated like every timer: the master `FEATURE_FLAG_SCHEDULERS` must not be
 * "false" AND `FEATURE_FLAG_LABS_WEEKLY_ROLLUP` must be "true" — the shared
 * gate in lib/timers/flag-gate.js. The flag is in `local.timer_catalogue`
 * (infra/functionapp.tf) and arms through `enabled_timers` like the rest; the
 * app clock is UTC (#416).
 *
 * Runs inline, not as a platform job: three point reads, one grouped count
 * and one upsert are seconds of work, and the summary the host logs is the
 * whole record an operator needs. A thrown store error is left to the host
 * so the run is recorded as failed.
 */
import { app } from '@azure/functions';
import * as store from '../lib/cosmos-client.js';
import { logDisabledSkip, timerEnabled } from '../lib/timers/flag-gate.js';
import { createLabsDayRollup } from '../lib/labs/rollup.js';
import { jsonForLog } from '../lib/http/log-json.js';

export const TIMER_NAME = 'labsWeeklyRollup';
export const TIMER_FLAG = 'LABS_WEEKLY_ROLLUP';
/** Daily 23:55 UTC. */
export const TIMER_SCHEDULE = '0 55 23 * * *';

/** "true" arms it; the schedulers master switch still holds it off. */
export const rollupEnabled = (env = process.env) => timerEnabled(TIMER_FLAG, env);

app.timer(TIMER_NAME, {
  schedule: TIMER_SCHEDULE,
  handler: async (_timer, context) => {
    if (!rollupEnabled()) {
      logDisabledSkip(context, TIMER_NAME);
      return;
    }
    const result = await createLabsDayRollup({ store }).run();
    context.log(`[${TIMER_NAME}] ${jsonForLog(result)}`);
  },
});
