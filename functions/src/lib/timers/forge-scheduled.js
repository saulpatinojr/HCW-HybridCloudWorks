/**
 * forge-scheduled.js — `forgeScheduled`, daily autonomous forging.
 *
 * Ported from Site-Main `cms/forge.js` (088f458). Off by default twice over:
 * the timer flag, and the Auto-Forge toggle in Forge Memory
 * (`admin_config/forge_prompts.autoForge`). Picks up to the day's REMAINING
 * `dailyLimit` unforged draft/ingested/inspected items — the forge_stats
 * `today` counter (written by every forge run, manual /forge and forge-from-url
 * included) is the ledger, so a morning of hand-forging spends the same budget
 * the timer would (T-607). Candidates are ranked by the owner's interest-area
 * weights from forge_profile before the cut, so a small daily budget goes to
 * the topics the owner actually cares about. Results land in `forge_ready`
 * (or `editing`) and still need the human one-click publish.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

export const CANDIDATE_STATUSES = ['draft', 'ingested', 'inspected'];
export const FORGE_SCHEDULER_ACTOR = Object.freeze({
  oid: 'forge_scheduler',
  email: 'forge_scheduler@system',
});

/** Forged-so-far today from the forge_stats rolling day bucket (0 on a new day). */
export function forgedTodayCount(statsDoc, todayKey) {
  return statsDoc?.today?.date === todayKey ? Number(statsDoc.today.forged) || 0 : 0;
}

/**
 * Sum of the weights of every interest area with a keyword hit in the
 * candidate's title/topics/provider. Pure; case-insensitive substring match —
 * the same looseness the areas' keyword lists are written for.
 */
export function scoreCandidate(candidate = {}, interestAreas = []) {
  const haystack = [
    candidate.Title,
    candidate.title,
    Array.isArray(candidate.keyTopics) ? candidate.keyTopics.join(' ') : '',
    candidate.cloudProvider,
    candidate.cloudProviderLegacy,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const area of interestAreas || []) {
    const keywords = Array.isArray(area?.keywords) ? area.keywords : [];
    if (keywords.some((kw) => kw && haystack.includes(String(kw).toLowerCase()))) {
      score += Number(area.weight) || 0;
    }
  }
  return score;
}

/**
 * The candidate query. An interview is never a forge candidate (ADR 0040,
 * D5): its body is a guest's words, and the blog pipeline must not rewrite
 * them. A document with no `type` is a blog post and stays in.
 */
export const CANDIDATE_QUERY =
  'SELECT TOP 25 c.id, c.forgeMeta, c.Title, c.keyTopics, c.cloudProvider, c["Cloud Provider"] AS cloudProviderLegacy FROM c ' +
  `WHERE c.contentStatus IN (${CANDIDATE_STATUSES.map((s) => `'${s}'`).join(', ')}) ` +
  "AND (NOT IS_STRING(c.type) OR LOWER(c.type) != 'interview')";

/** Unforged candidates, highest interest score first; ties keep query order. */
export function rankCandidates(rows = [], interestAreas = []) {
  return (rows || [])
    .filter((item) => !item.forgeMeta)
    .map((item, index) => ({ item, index, score: scoreCandidate(item, interestAreas) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

export function createForgeScheduled({ store, config, forge, now = () => new Date(), log = {} }) {
  const emptySummary = (reason) => ({
    skippedRun: true,
    reason,
    attempted: 0,
    staged: 0,
    editing: 0,
    skipped: 0,
    errors: 0,
  });

  async function run() {
    const prompts = await config.loadForgePrompts({ bypassCache: true });
    if (!prompts.autoForge?.enabled || prompts.autoForge.dailyLimit < 1) {
      log.log?.('[forgeScheduled] auto-forge disabled, skipping run.');
      return emptySummary('auto_forge_disabled');
    }

    const todayKey = now().toISOString().slice(0, 10);
    const stats = await store.readDoc('admin_config', 'forge_stats', ADMIN_CONFIG_PARTITION);
    const forgedToday = forgedTodayCount(stats, todayKey);
    const remaining = prompts.autoForge.dailyLimit - forgedToday;
    if (remaining < 1) {
      log.log?.(
        `[forgeScheduled] daily limit reached (${forgedToday}/${prompts.autoForge.dailyLimit}), skipping run.`
      );
      return { ...emptySummary('daily_limit_reached'), forgedToday };
    }

    const profile = await config.loadForgeProfile();
    const rows = await store.queryDocs('content', CANDIDATE_QUERY, []);
    const candidates = rankCandidates(rows, profile?.interestAreas).slice(0, remaining);

    const summary = {
      skippedRun: false,
      attempted: 0,
      staged: 0,
      editing: 0,
      skipped: 0,
      errors: 0,
      failures: [],
    };
    for (const candidate of candidates) {
      summary.attempted += 1;
      try {
        const outcome = await forge.runForgePipeline({
          contentId: candidate.id,
          actor: FORGE_SCHEDULER_ACTOR,
          // The real ceiling, claimed per document inside the pipeline before
          // any model call (T-761). The `remaining` slice above is now only a
          // cheap early-out: it was computed once, before this loop, so it
          // cannot see a manual forge that starts while the loop is running —
          // and the count it read came from a best-effort write that swallows
          // its own failures. Both are fine for "don't rank 25 candidates for
          // nothing"; neither is fine as the only thing standing between this
          // timer and an unbounded model bill.
          budget: { limit: prompts.autoForge.dailyLimit, enforce: true },
        });
        if (!outcome.ok) {
          // The budget ran out mid-loop — a manual forge consumed the rest, or
          // the pre-loop count was stale. Stop rather than churning through
          // the remaining candidates to be refused one at a time.
          if (outcome.budgetExhausted) {
            summary.attempted -= 1;
            summary.stoppedOnBudget = true;
            log.log?.(`[forgeScheduled] ${outcome.error}`);
            break;
          }
          if (outcome.httpStatus === 409) summary.skipped += 1;
          else {
            summary.errors += 1;
            summary.failures.push({ contentId: candidate.id, error: outcome.error });
          }
          log.warn?.(`[forgeScheduled] ${candidate.id} -> ${outcome.error}`);
        } else if (outcome.result.status === 'forge_ready') summary.staged += 1;
        else summary.editing += 1;
      } catch (err) {
        summary.errors += 1;
        summary.failures.push({ contentId: candidate.id, error: err?.message || String(err) });
        log.error?.(`[forgeScheduled] ${candidate.id} threw: ${err?.message || err}`);
      }
    }
    log.log?.(
      `[forgeScheduled] run complete: ${JSON.stringify({ ...summary, failures: undefined })}`
    );
    return summary;
  }
  return { run };
}
