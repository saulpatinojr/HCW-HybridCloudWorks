/**
 * inspect-job.js — `batch-inspect`: inspect ingested documents, a few at a time.
 *
 * Upstream `batchInspect` only flipped `inspectTrigger: true` on ingested
 * documents and let the Firestore trigger do the work. There is no trigger on
 * Azure yet (T-324), so this job does both: it selects ingested documents —
 * flagged ones first, then unflagged ones that have not failed before — and
 * runs the inspector on each, four seconds apart as upstream staggered its
 * triggers. A failure is recorded on the document and the batch goes on.
 */
export const DEFAULT_BATCH = 10;
export const MAX_BATCH = 25;
export const STAGGER_MS = 4000;

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, patchDoc: Function }} deps.store
 * @param {{ executeInspection: Function }} deps.inspector
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => Date} [deps.now]
 * @param {{ log?: Function, warn?: Function }} [deps.log]
 */
export function createInspectBatch({
  store,
  inspector,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(),
  log = {},
  signal: defaultSignal,
}) {
  async function select(limit) {
    const flagged = await store.queryDocs(
      'content',
      `SELECT TOP ${limit} * FROM c WHERE c.contentStatus = 'ingested' AND c.inspectTrigger = true`,
      []
    );
    if (flagged.length >= limit) return flagged.slice(0, limit);
    const seen = new Set(flagged.map((d) => d.id));
    const unflagged = await store.queryDocs(
      'content',
      `SELECT TOP ${limit} * FROM c WHERE c.contentStatus = 'ingested' AND (NOT IS_DEFINED(c.inspectTrigger) OR c.inspectTrigger = false) AND NOT IS_DEFINED(c.inspectError)`,
      []
    );
    return [...flagged, ...unflagged.filter((d) => !seen.has(d.id))].slice(0, limit);
  }

  return {
    /**
     * @param {{ limit?: number, signal?: AbortSignal }} [payload]
     * @returns {Promise<{total: number, inspected: number, needsRework: number, failed: number, skipped: number, ids: {inspected: string[], failed: string[]}}>}
     */
    async run({ limit = DEFAULT_BATCH, signal: callSignal } = {}) {
      const activeSignal = callSignal || defaultSignal;
      if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
      const batch = Math.min(Math.max(Number(limit) || DEFAULT_BATCH, 1), MAX_BATCH);
      const docs = await select(batch);
      const result = {
        total: docs.length,
        inspected: 0,
        needsRework: 0,
        failed: 0,
        skipped: 0,
        ids: { inspected: [], failed: [] },
      };

      for (let i = 0; i < docs.length; i += 1) {
        if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
        const doc = docs[i];
        const url = doc.url || doc.sourceUrl || doc['CD Url'];
        if (!url) {
          result.skipped += 1;
          continue;
        }
        try {
          const outcome = await inspector.executeInspection({
            collectionName: 'content',
            docId: doc.id,
            newData: doc,
            signal: activeSignal,
          });
          result.inspected += 1;
          if (outcome.contentStatus === 'needs_rework') result.needsRework += 1;
          result.ids.inspected.push(doc.id);
        } catch (error) {
          result.failed += 1;
          result.ids.failed.push(doc.id);
          log.warn?.(`[batch-inspect] ${doc.id} failed: ${error?.message || error}`);
          await store.patchDoc('content', doc.id, {
            inspectTrigger: false,
            inspectError: String(error?.message || error).slice(0, 2000),
            inspectErrorAt: now().toISOString(),
          });
        }
        if (i < docs.length - 1) await sleep(STAGGER_MS);
      }
      log.log?.(
        `[batch-inspect] ${result.inspected}/${result.total} inspected, ${result.failed} failed`
      );
      return result;
    },
  };
}
