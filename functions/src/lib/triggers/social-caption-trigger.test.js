import { describe, it, expect, vi } from 'vitest';
import {
  createSocialCaptionQueuer,
  buildAutopostBulk,
  publicUrlOf,
  SOCIAL_CAPTION_CLAIM_FIELDS,
} from './social-caption-trigger.js';

const NOW = new Date('2026-08-28T12:00:00Z');

const contentDoc = (overrides = {}) => ({
  id: 'doc-1',
  Title: 'Cut EBS cost',
  Summary: 'gp2 to gp3 with zero downtime',
  publishedUrl: 'https://hybridcloudworks.com/aws/blog/cut-ebs-cost',
  socialCaptionTrigger: true,
  _etag: 'e',
  ...overrides,
});

const autopostConfig = (overrides = {}) => ({
  id: 'social_autopost',
  enabled: true,
  accountIds: [
    { id: 'acc-li', provider: 'LinkedIn' },
    { id: 'acc-tw', provider: 'twitter' },
  ],
  scheduleDelayMinutes: 30,
  ...overrides,
});

function makeQueuer({ doc = contentDoc(), config = autopostConfig(), configured = true } = {}) {
  const docs = new Map([['doc-1', doc]]);
  const store = {
    readDoc: vi.fn(async (container, id) =>
      container === 'content' ? (docs.get(id) ?? null) : container === 'admin_config' ? config : null
    ),
    replaceDocIfMatch: vi.fn(async (container, next) => {
      docs.set(next.id, next);
      return next;
    }),
    patchDoc: vi.fn(async (container, id, updates) => {
      if (container === 'content') docs.set(id, { ...(docs.get(id) || { id }), ...updates });
      return docs.get(id);
    }),
    upsertDoc: vi.fn(async (container, d) => d),
  };
  const ai = { generateTextResponse: vi.fn(async () => 'A sharp caption.') };
  const publer = {
    configured,
    request: vi.fn(async () => ({ data: { job_id: 'pj-1' } })),
  };
  const queuer = createSocialCaptionQueuer({
    store,
    ai,
    publer,
    now: () => NOW,
    uuid: () => 'sp-1',
  });
  return { queuer, store, ai, publer, docs };
}

describe('pure helpers', () => {
  it('publicUrlOf mirrors the Social Hub derivation', () => {
    expect(publicUrlOf({ publishedUrl: 'https://x/a' })).toBe('https://x/a');
    expect(publicUrlOf({ curatedSubpagePath: '/aws/blog/x' })).toBe(
      'https://hybridcloudworks.com/aws/blog/x'
    );
    expect(publicUrlOf({})).toBe('');
  });

  it('buildAutopostBulk emits the exact shape the manual compose sends', () => {
    const bulk = buildAutopostBulk(
      [{ id: 'acc-li', provider: 'LinkedIn' }],
      'text here',
      '2026-08-28T13:00:00.000Z'
    );
    expect(bulk).toEqual({
      state: 'scheduled',
      posts: [
        {
          networks: { linkedin: { type: 'status', text: 'text here' } },
          accounts: [{ id: 'acc-li', scheduled_at: '2026-08-28T13:00:00.000Z' }],
        },
      ],
    });
  });
});

describe('createSocialCaptionQueuer', () => {
  it('claims, generates, schedules in Publer with the delay, and records the social post', async () => {
    const { queuer, store, ai, publer } = makeQueuer();
    const result = await queuer.run('doc-1', 'etag-1');
    expect(result).toEqual({ ran: true, reason: 'queued_to_publer', socialPostId: 'sp-1' });

    // Caption call is platform-aware and never handed the URL.
    const prompt = ai.generateTextResponse.mock.calls[0][0].prompt;
    expect(prompt).toContain('linkedin, twitter');
    expect(prompt).not.toContain('hybridcloudworks.com');

    // One bulk schedule call, 30 min out, link appended after the caption.
    const [path, method, body] = publer.request.mock.calls[0];
    expect(path).toBe('/posts/schedule');
    expect(method).toBe('POST');
    expect(body.bulk.state).toBe('scheduled');
    expect(body.bulk.posts).toHaveLength(2);
    expect(body.bulk.posts[0].accounts[0].scheduled_at).toBe(
      new Date(NOW.getTime() + 30 * 60 * 1000).toISOString()
    );
    expect(body.bulk.posts[0].networks.linkedin.text).toBe(
      'A sharp caption.\n\nhttps://hybridcloudworks.com/aws/blog/cut-ebs-cost'
    );

    // The social_posts doc the reconcile timer will adopt by publerJobId,
    // written so the social_posts feed handler will NOT push it back.
    const [container, socialPost] = store.upsertDoc.mock.calls[0];
    expect(container).toBe('social_posts');
    expect(socialPost).toMatchObject({
      id: 'sp-1',
      contentId: 'doc-1',
      caption: 'A sharp caption.',
      publerJobId: 'pj-1',
      status: 'scheduled',
      syncOrigin: 'system',
      source: 'auto_publish',
      accountIds: ['acc-li', 'acc-tw'],
      platforms: ['linkedin', 'twitter'],
    });

    // Completion: flag cleared, claim released, provenance stamped.
    expect(store.patchDoc).toHaveBeenCalledWith(
      'content',
      'doc-1',
      expect.objectContaining({
        socialCaptionTrigger: false,
        [SOCIAL_CAPTION_CLAIM_FIELDS.claimField]: null,
        socialCaptionGeneratedAt: NOW.toISOString(),
        socialPostId: 'sp-1',
      })
    );
  });

  it('clears quietly without a model call when autoposting is disabled or unconfigured', async () => {
    for (const config of [null, autopostConfig({ enabled: false }), autopostConfig({ accountIds: [] })]) {
      const { queuer, store, ai, publer } = makeQueuer({ config });
      const result = await queuer.run('doc-1', 'etag-1');
      expect(result).toEqual({ ran: false, reason: 'autopost_disabled' });
      expect(ai.generateTextResponse).not.toHaveBeenCalled();
      expect(publer.request).not.toHaveBeenCalled();
      expect(store.patchDoc).toHaveBeenCalledWith(
        'content',
        'doc-1',
        expect.objectContaining({ socialCaptionTrigger: false })
      );
    }
  });

  it('keeps the caption as a Social Hub draft when Publer is not configured', async () => {
    const { queuer, store, publer } = makeQueuer({ configured: false });
    const result = await queuer.run('doc-1', 'etag-1');
    expect(result.reason).toBe('queued_draft:publer_not_configured');
    expect(publer.request).not.toHaveBeenCalled();
    const [, socialPost] = store.upsertDoc.mock.calls[0];
    expect(socialPost).toMatchObject({ status: 'draft', publerJobId: null, scheduledAt: null });
  });

  it('skips when the flag is not set and on a repeated event id', async () => {
    const unflagged = makeQueuer({ doc: contentDoc({ socialCaptionTrigger: false }) });
    expect((await unflagged.queuer.run('doc-1', 'e1')).reason).toBe('flag_not_set');

    const claimed = makeQueuer({
      doc: contentDoc({ socialCaptionRunId: 'e1', socialCaptionRunAt: NOW.toISOString() }),
    });
    expect((await claimed.queuer.run('doc-1', 'e1')).reason).toBe('already_run_by_this_event');
  });

  it('a Publer failure clears the flag with the error — no retry loop, caption path stays manual', async () => {
    const { queuer, store, publer, docs } = makeQueuer();
    // publer-sync's shape: the status rides on the error.
    publer.request.mockRejectedValueOnce(
      Object.assign(new Error('Publer POST /posts/schedule failed with HTTP 429'), { status: 429 })
    );
    const result = await queuer.run('doc-1', 'etag-1');
    expect(result.ran).toBe(false);
    expect(docs.get('doc-1')).toMatchObject({
      socialCaptionTrigger: false,
      socialCaptionRunId: null,
      socialCaptionError: expect.stringMatching(
        /^The social caption could not be written \(HTTP_429; reference [\w.:-]+\)\.$/
      ),
    });
    expect(docs.get('doc-1').socialCaptionError).not.toContain('/posts/schedule');
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });
});
