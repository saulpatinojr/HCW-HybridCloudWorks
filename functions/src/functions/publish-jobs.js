/**
 * publish-jobs.js — `publish-content` as a platform job (T-606).
 *
 * The Telegram /approve command enqueues this; the worker calls the injected
 * `processPublishContent` with `markLive: true` — the same reuse contract the
 * scheduled publisher documents (lib/scheduled-publish.js: "it calls
 * processPublishContent, it does not reimplement publishing"). Every gate in
 * the publish pipeline — status, quality, image, slug, metadata — applies to
 * an approval from the phone exactly as it does to one from the portal.
 */
import * as store from '../lib/cosmos-client.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { createPublishHandlers } from '../lib/cms/publish.js';
import { createDefaultInlineImageRehoster } from '../lib/cms/inline-images-default.js';
import { createJobFailureOnComplete } from '../lib/job-failure-notify.js';
import { registerJobType } from '../lib/jobs.js';

/** Split for tests: the worker body with its dependencies injectable. */
export async function runPublishContent(payload, { job, publish, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('aborted');
  const contentId = String(payload?.contentId || '').trim();
  if (!contentId) throw new Error('contentId required');

  const result = await publish.processPublishContent(contentId, {
    // The enqueuing surface's identity (the Telegram path stamps
    // telegram-bot@system in functions/telegram-http.js makeEnqueue).
    user: job?.requestedBy || { oid: null, email: 'publish-content@system' },
    publishTarget: payload?.publishTarget || null,
    markLive: true,
    createSlugPageTrigger: true,
    addToCurated: true,
  });

  // processPublishContent never throws; a { error } result is this job's
  // failure (visible in /status and the jobs UI), a { skipped } is a benign
  // no-op worth surfacing as the job's result rather than a failure.
  if (result?.error) throw new Error(result.error);
  return result;
}

registerJobType('publish-content', {
  // MUST match POST /api/publishContent (cms/publish.js), which requires
  // publisher. The worker calls processPublishContent with markLive: true and
  // that function carries no guard of its own — this declaration is the only
  // thing standing between an editor token and a live publish (T-701).
  role: 'publisher',
  description:
    'Publish one content document live through the full processPublishContent pipeline (status, quality, image and metadata gates included). Enqueued by the Telegram /approve command.',
  maxPayloadBytes: 2048,
  timeoutMs: 5 * 60 * 1000,
  worker: async (payload, { job, signal } = {}) => {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const publish = createPublishHandlers({
      guard: getDefaultGuard(),
      store,
      inlineImages: createDefaultInlineImageRehoster(),
    });
    return runPublishContent(payload, { job, publish, signal });
  },
  // A failed approval-from-the-phone must come back to the phone (T-607).
  onComplete: createJobFailureOnComplete({ store }),
});
