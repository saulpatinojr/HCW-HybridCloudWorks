/**
 * inspect-jobs.js — `batch-inspect` as a platform job (T-322).
 *
 * Site-Main: `batchInspect`, a 300 s HTTP handler that flagged documents for
 * the `inspectAndPopulateContent` Firestore trigger. Here the job selects and
 * inspects in one pass (lib/content/inspect-job.js); the admin "Batch
 * Inspect" button enqueues it through runJob().
 */
import { queryDocs, patchDoc } from '../lib/cosmos-client.js';
import * as ai from '../lib/ai/router.js';
import { scrapeArticle } from '../lib/content/scrape.js';
import { createCritic } from '../lib/content/critique.js';
import { createInspector } from '../lib/content/inspect.js';
import { createInspectBatch } from '../lib/content/inspect-job.js';
import { registerJobType } from '../lib/jobs.js';

registerJobType('batch-inspect', {
  // Inspection enriches drafts in place; editor, as the HTTP inspect route is.
  role: 'editor',
  description:
    'Inspect ingested content: scrape the source, analyse it with the configured AI provider, critique and revise once, write the draft back.',
  maxPayloadBytes: 256,
  // Up to 25 documents × (scrape ≤30 s + two or three model calls + 4 s stagger).
  timeoutMs: 28 * 60 * 1000,
  worker: (payload, { context, signal }) => {
    const store = { queryDocs, patchDoc };
    const inspector = createInspector({
      store,
      ai,
      scrape: (url, opts) => scrapeArticle(url, { log: context, signal, ...opts }),
      critic: createCritic({ ai, signal }),
      log: context,
      signal,
    });
    return createInspectBatch({ store, inspector, log: context, signal }).run({ limit: payload?.limit, signal });
  },
});
