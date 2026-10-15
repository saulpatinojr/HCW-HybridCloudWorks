import { describe, it, expect, vi } from 'vitest';
import { runPublishContent } from './publish-jobs.js';

const job = { requestedBy: { oid: null, email: 'telegram-bot@system' } };

function makePublish(result) {
  return { processPublishContent: vi.fn(async () => result) };
}

describe('runPublishContent', () => {
  it('publishes through processPublishContent with markLive and the scheduler param shape', async () => {
    const publish = makePublish({ blogId: 'b1', slug: 's', expectedPublicUrl: 'https://x/y' });
    const result = await runPublishContent({ contentId: 'doc-1' }, { job, publish });

    // Same param shape as the scheduled publisher (lib/scheduled-publish.js) —
    // the reuse contract: one publish pipeline, whoever triggers it.
    expect(publish.processPublishContent).toHaveBeenCalledWith('doc-1', {
      user: { oid: null, email: 'telegram-bot@system' },
      publishTarget: null,
      markLive: true,
      createSlugPageTrigger: true,
      addToCurated: true,
    });
    expect(result.expectedPublicUrl).toBe('https://x/y');
  });

  it('fails the job on a pipeline error so /status shows it', async () => {
    const publish = makePublish({ error: 'Content quality below threshold' });
    await expect(runPublishContent({ contentId: 'doc-1' }, { job, publish })).rejects.toThrow(
      'Content quality below threshold'
    );
  });

  it('returns a skip as a benign result, not a failure', async () => {
    const publish = makePublish({ skipped: true, reason: 'Content changed while publishing' });
    const result = await runPublishContent({ contentId: 'doc-1' }, { job, publish });
    expect(result.skipped).toBe(true);
  });

  it('requires contentId', async () => {
    const publish = makePublish({});
    await expect(runPublishContent({}, { job, publish })).rejects.toThrow('contentId required');
    expect(publish.processPublishContent).not.toHaveBeenCalled();
  });

  it('throws immediately when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const publish = makePublish({});
    await expect(
      runPublishContent({ contentId: 'doc-1' }, { job, publish, signal: controller.signal })
    ).rejects.toThrow();
  });
});
