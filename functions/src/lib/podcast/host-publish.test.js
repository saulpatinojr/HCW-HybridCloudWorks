/**
 * Publishing an episode document to Podbean (#437, ADR 0029 §1c).
 *
 * Two properties carry the issue's acceptance: a second run on the same
 * document updates rather than creates, and a failure records itself under
 * `host.podbean` without touching the approval. Everything else is the shape
 * of what Podbean is told.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  HOST_CONTENT_TEXT_MAX,
  HOST_TITLE_MAX,
  ATTEMPT_SPAN_MS,
  RECONCILE_WINDOW_MS,
  describeForHost,
  findUnrecordedEpisode,
  publishEpisodeToHost,
} from './host-publish.js';
import { PODBEAN_API_BASE_URL, PodbeanError, createPodbeanClient } from './podbean.js';

const TOKEN = 'not-a-real-podbean-access-token-0001';
const ENV = {
  PODBEAN_CLIENT_ID: 'not-a-real-podbean-client-id',
  PODBEAN_CLIENT_SECRET: 'not-a-real-podbean-client-secret-EXAMPLE',
};
const NOW = new Date('2026-10-13T10:00:00.000Z');
const now = () => NOW;

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const tokenReply = () => reply(200, { access_token: TOKEN, token_type: 'Bearer', expires_in: 604800 });

const PODBEAN_EPISODE = {
  id: 'IWPNG2FB3F',
  title: 'Manage Azure identities and governance',
  media_url: 'https://mcdn.podbean.com/mf/web/x/manage-governance.mp3',
  permalink_url: 'https://podcast.hybridcloudworks.com/e/manage-azure-identities-and-governance/',
  publish_time: 1760349600,
  status: 'publish',
  type: 'public',
};

const AUTHORIZED = {
  presigned_url: 'https://s3.amazonaws.com/podbean-uploads/tmp2/1/manage-governance.mp3?X-Amz-Signature=sig',
  expire_in: 600,
  file_key: 'tmp2/1/manage-governance.mp3',
};

const doc = (overrides = {}) => ({
  id: 'manage-governance',
  setId: 'azure_az-104',
  title: 'Manage Azure identities and governance',
  summary: 'What the exam expects you to know about identities, RBAC and policy.',
  keyTakeaways: ['Roles are scoped', 'Policy is not RBAC', 'Locks beat everyone'],
  audioPath: 'azure/az-104/manage-governance.mp3',
  status: 'published',
  approvedAt: '2026-10-13T09:00:00.000Z',
  approvedBy: 'oid-owner',
  ...overrides,
});

/** A fetch that answers in order and records what it was asked. */
function fakeHost(responses) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => queue.shift() || reply(200, {}));
  const calls = () => fetchImpl.mock.calls.map(([url, init]) => ({ url, method: init.method, init }));
  const methods = () => calls().map((c) => `${c.method} ${new URL(c.url).pathname}`);
  const form = (i) => Object.fromEntries(new URLSearchParams(calls()[i].init.body));
  return { fetchImpl, calls, methods, form };
}

const readAudio = vi.fn(async () => ({ bytes: Buffer.from('mp3'), contentType: 'audio/mpeg' }));

const HAPPY = [tokenReply(), reply(200, AUTHORIZED), reply(200), reply(200, { episode: PODBEAN_EPISODE })];

const NOTES =
  '<p>What the exam expects you to know about identities, RBAC and policy.</p>' +
  '<p>Key takeaways:</p><ul><li>Roles are scoped</li><li>Policy is not RBAC</li><li>Locks beat everyone</li></ul>';

describe('describeForHost', () => {
  it('maps title, summary and takeaways to HTML notes, published, public and full', () => {
    const out = describeForHost(doc());
    expect(out).toEqual({
      title: 'Manage Azure identities and governance',
      content: NOTES,
      status: 'publish',
      type: 'public',
      apple_episode_type: 'full',
    });
    // Nothing RSS.com had that Podbean does not.
    expect(out).not.toHaveProperty('ai_content');
    expect(out).not.toHaveProperty('custom_link');
    expect(out).not.toHaveProperty('description');
  });

  it('links the article at the end of the notes, since Podbean has no custom_link field', () => {
    const out = describeForHost(doc(), { publicUrl: 'https://hybridcloudworks.com/blog/x?a=1&b=2' });
    expect(out.content).toBe(
      `${NOTES}<p>Read the article: <a href="https://hybridcloudworks.com/blog/x?a=1&amp;b=2">` +
        'https://hybridcloudworks.com/blog/x?a=1&amp;b=2</a></p>'
    );
  });

  it('refuses an article link that is not an http(s) URL', () => {
    expect(() => describeForHost(doc(), { publicUrl: 'javascript:alert(1)' })).toThrow(PodbeanError);
  });

  it('escapes the text, so a summary cannot inject markup Podbean would render', () => {
    const out = describeForHost(
      doc({
        summary: 'Use <script>alert("x")</script> & friends',
        keyTakeaways: ['<b>bold</b>', "it's"],
      })
    );
    expect(out.content).toBe(
      '<p>Use &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; friends</p>' +
        '<p>Key takeaways:</p><ul><li>&lt;b&gt;bold&lt;/b&gt;</li><li>it&#39;s</li></ul>'
    );
    // Case-insensitive: an HTML tag is one whatever its case (CodeQL
    // js/bad-tag-filter on #1117), so `<SCRIPT` must fail this too.
    expect(out.content).not.toMatch(/<script|<b>/i);
  });

  it('falls back to the title when there is no summary and no takeaways', () => {
    const out = describeForHost(doc({ summary: '', keyTakeaways: [] }));
    expect(out.content).toBe('<p>Manage Azure identities and governance</p>');
  });

  it('ignores blank takeaways and collapses whitespace', () => {
    const out = describeForHost(doc({ summary: '  two   words \n', keyTakeaways: ['', '  ', ' a  b '] }));
    expect(out.content).toBe('<p>two words</p><p>Key takeaways:</p><ul><li>a b</li></ul>');
  });

  it('keeps title and the notes text inside the caps, cutting at a word', () => {
    const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    const out = describeForHost(doc({ title: long, summary: long, keyTakeaways: [] }));
    expect(out.title.length).toBeLessThanOrEqual(HOST_TITLE_MAX);
    expect(out.title.endsWith('…')).toBe(true);
    expect(long.startsWith(`${out.title.slice(0, -1)} `)).toBe(true);
    const text = out.content.replace(/^<p>|<\/p>$/g, '');
    expect(text.length).toBeLessThanOrEqual(HOST_CONTENT_TEXT_MAX);
    expect(long.startsWith(`${text.slice(0, -1)} `)).toBe(true);
  });

  it('refuses an episode with no title', () => {
    expect(() => describeForHost(doc({ title: '   ' }))).toThrow(/no title/);
  });
});

describe('publishEpisodeToHost — first publish', () => {
  it('authorises, uploads, creates, and returns the host record to store', async () => {
    const host = fakeHost(HAPPY);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({
      client,
      readAudio,
      doc: doc(),
      now,
      publicUrl: 'https://hybridcloudworks.com/azure/audio',
    });

    expect(host.methods()).toEqual([
      'POST /v1/oauth/token',
      'GET /v1/files/uploadAuthorize',
      'PUT /podbean-uploads/tmp2/1/manage-governance.mp3',
      'POST /v1/episodes',
    ]);
    expect(readAudio).toHaveBeenCalledWith('azure/az-104/manage-governance.mp3');

    const [, authorize, put, create] = host.calls();
    expect(Object.fromEntries(new URL(authorize.url).searchParams)).toEqual({
      access_token: TOKEN,
      filename: 'manage-governance.mp3',
      filesize: '3',
      content_type: 'audio/mpeg',
    });
    expect(put.url).toBe(AUTHORIZED.presigned_url);
    expect(put.init.headers['Content-Type']).toBe('audio/mpeg');
    expect(JSON.stringify(put.init.headers)).not.toContain(TOKEN);
    expect(create.url).toBe(`${PODBEAN_API_BASE_URL}/episodes`);
    expect(host.form(3)).toEqual({
      access_token: TOKEN,
      title: 'Manage Azure identities and governance',
      content: expect.stringContaining('<p>Read the article: <a href="https://hybridcloudworks.com/azure/audio">'),
      status: 'publish',
      type: 'public',
      apple_episode_type: 'full',
      media_key: 'tmp2/1/manage-governance.mp3',
    });

    expect(patch).toEqual({
      host: {
        podbean: {
          episodeId: 'IWPNG2FB3F',
          permalinkUrl: PODBEAN_EPISODE.permalink_url,
          mediaUrl: PODBEAN_EPISODE.media_url,
          hostStatus: 'publish',
          audioPath: 'azure/az-104/manage-governance.mp3',
          fileKey: 'tmp2/1/manage-governance.mp3',
          publishedAt: NOW.toISOString(),
          firstAttemptAt: NOW.toISOString(),
          lastAttemptAt: NOW.toISOString(),
          error: null,
        },
      },
    });
    // The patch is host state only: approval fields are not the orchestrator's to write.
    expect(Object.keys(patch)).toEqual(['host']);
    expect(Object.keys(patch.host)).toEqual(['podbean']);
  });

  it('accepts a bare Buffer from readAudio and defaults the content type', async () => {
    const host = fakeHost(HAPPY);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({
      client,
      readAudio: async () => Buffer.from('mp3'),
      doc: doc(),
      now,
    });
    expect(patch.host.podbean.error).toBeNull();
    expect(new URL(host.calls()[1].url).searchParams.get('content_type')).toBe('audio/mpeg');
  });

  it('never reads or writes host.rsscom, whatever an old document carries', async () => {
    // Production documents only ever held host.rsscom.skipped = 'not_configured'.
    const host = fakeHost(HAPPY);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({
      client,
      readAudio,
      doc: doc({ host: { rsscom: { episodeId: 9001, skipped: 'not_configured' } } }),
      now,
    });
    expect(host.methods()).toContain('POST /v1/episodes');
    expect(patch.host).not.toHaveProperty('rsscom');
    expect(patch.host.podbean.episodeId).toBe('IWPNG2FB3F');
  });
});

describe('publishEpisodeToHost — idempotent re-publish', () => {
  const previouslyPublished = () =>
    doc({
      host: {
        podbean: {
          episodeId: 'IWPNG2FB3F',
          permalinkUrl: PODBEAN_EPISODE.permalink_url,
          mediaUrl: PODBEAN_EPISODE.media_url,
          hostStatus: 'publish',
          audioPath: 'azure/az-104/manage-governance.mp3',
          fileKey: 'tmp2/1/manage-governance.mp3',
          publishedAt: '2026-10-12T10:00:00.000Z',
          lastAttemptAt: '2026-10-12T10:00:00.000Z',
          error: null,
        },
      },
    });

  it('updates the recorded episode, sending title, content, status and type, and never creates a second', async () => {
    const host = fakeHost([tokenReply(), reply(200, { episode: PODBEAN_EPISODE })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const read = vi.fn(async () => Buffer.from('mp3'));
    const patch = await publishEpisodeToHost({
      client,
      readAudio: read,
      doc: previouslyPublished(),
      now,
    });

    expect(host.methods()).toEqual(['POST /v1/oauth/token', 'POST /v1/episodes/IWPNG2FB3F']);
    expect(read).not.toHaveBeenCalled();
    const body = host.form(1);
    expect(body).toMatchObject({
      title: 'Manage Azure identities and governance',
      content: NOTES,
      status: 'publish',
      type: 'public',
    });
    expect(body.media_key).toBeUndefined();

    expect(patch.host.podbean).toEqual({
      ...previouslyPublished().host.podbean,
      // A record from before firstAttemptAt existed: its last attempt stands in.
      firstAttemptAt: '2026-10-12T10:00:00.000Z',
      lastAttemptAt: NOW.toISOString(),
      error: null,
    });
  });

  it('re-uploads the audio only when audioPath changed, and records the new file key', async () => {
    const host = fakeHost([
      tokenReply(),
      reply(200, { ...AUTHORIZED, file_key: 'tmp2/1/manage-governance-v2.mp3' }),
      reply(200),
      reply(200, { episode: { ...PODBEAN_EPISODE, media_url: 'https://mcdn.podbean.com/v2.mp3' } }),
    ]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const regenerated = previouslyPublished();
    regenerated.audioPath = 'azure/az-104/manage-governance-v2.mp3';
    const patch = await publishEpisodeToHost({ client, readAudio, doc: regenerated, now });

    expect(host.methods()).toEqual([
      'POST /v1/oauth/token',
      'GET /v1/files/uploadAuthorize',
      'PUT /podbean-uploads/tmp2/1/manage-governance.mp3',
      'POST /v1/episodes/IWPNG2FB3F',
    ]);
    expect(host.form(3).media_key).toBe('tmp2/1/manage-governance-v2.mp3');
    expect(patch.host.podbean).toMatchObject({
      episodeId: 'IWPNG2FB3F',
      fileKey: 'tmp2/1/manage-governance-v2.mp3',
      audioPath: 'azure/az-104/manage-governance-v2.mp3',
      mediaUrl: 'https://mcdn.podbean.com/v2.mp3',
      publishedAt: '2026-10-12T10:00:00.000Z',
    });
  });

  it('a retry after a recorded failure still updates the same episode and clears the error', async () => {
    const host = fakeHost([tokenReply(), reply(200, { episode: PODBEAN_EPISODE })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const failed = previouslyPublished();
    failed.host.podbean.error = { status: 503, message: 'earlier' };
    const patch = await publishEpisodeToHost({ client, readAudio, doc: failed, now });
    expect(host.methods()).toEqual(['POST /v1/oauth/token', 'POST /v1/episodes/IWPNG2FB3F']);
    expect(patch.host.podbean.error).toBeNull();
    expect(patch.host.podbean.episodeId).toBe('IWPNG2FB3F');
  });

  it('keeps the recorded values when an update answers without an episode', async () => {
    const host = fakeHost([tokenReply(), reply(200, {})]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: previouslyPublished(), now });
    expect(patch.host.podbean).toMatchObject({
      episodeId: 'IWPNG2FB3F',
      permalinkUrl: PODBEAN_EPISODE.permalink_url,
      hostStatus: 'publish',
      error: null,
    });
  });
});

describe('publishEpisodeToHost — a create whose answer was lost (#1118)', () => {
  const secs = (iso) => Math.floor(Date.parse(iso) / 1000);
  const FIRST = '2026-10-13T09:50:00.000Z';
  /** An earlier attempt that sent the create and heard nothing back. */
  const timedOut = (overrides = {}) =>
    doc({
      host: {
        podbean: {
          firstAttemptAt: FIRST,
          lastAttemptAt: FIRST,
          error: { status: null, code: 'TIMEOUT', message: 'Podbean did not answer.', retryable: true },
        },
      },
      ...overrides,
    });
  const listed = (episodes) => reply(200, { episodes, offset: 0, limit: 20, has_more: false, count: episodes.length });
  const LOST = { ...PODBEAN_EPISODE, publish_time: secs('2026-10-13T09:50:40.000Z') };

  it('adopts the episode the lost create made and updates it, audio re-sent, never creating a second', async () => {
    const host = fakeHost([
      tokenReply(),
      listed([LOST]),
      reply(200, AUTHORIZED),
      reply(200),
      reply(200, { episode: LOST }),
    ]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: timedOut(), now });

    expect(host.methods()).toEqual([
      'POST /v1/oauth/token',
      'GET /v1/episodes',
      'GET /v1/files/uploadAuthorize',
      'PUT /podbean-uploads/tmp2/1/manage-governance.mp3',
      `POST /v1/episodes/${LOST.id}`,
    ]);
    expect(Object.fromEntries(new URL(host.calls()[1].url).searchParams)).toMatchObject({ limit: '20' });
    expect(host.form(4)).toMatchObject({ title: LOST.title, media_key: AUTHORIZED.file_key, type: 'public' });
    expect(patch.host.podbean).toMatchObject({
      episodeId: LOST.id,
      adoptedAt: NOW.toISOString(),
      firstAttemptAt: FIRST,
      lastAttemptAt: NOW.toISOString(),
      publishedAt: '2026-10-13T09:50:40.000Z',
      fileKey: AUTHORIZED.file_key,
      error: null,
    });
  });

  it('does not take over an older episode with the same title: it predates the first attempt', async () => {
    const OLD = { ...PODBEAN_EPISODE, id: 'OLDER0001', publish_time: secs('2026-09-01T08:00:00.000Z') };
    const host = fakeHost([tokenReply(), listed([OLD]), ...HAPPY.slice(1)]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: timedOut(), now });

    expect(host.methods()).toContain('POST /v1/episodes');
    expect(host.methods()).not.toContain('POST /v1/episodes/OLDER0001');
    expect(patch.host.podbean).toMatchObject({ episodeId: PODBEAN_EPISODE.id, error: null });
    expect(patch.host.podbean).not.toHaveProperty('adoptedAt');
  });

  it('creates when the listing has no such episode', async () => {
    const host = fakeHost([tokenReply(), listed([]), ...HAPPY.slice(1)]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: timedOut(), now });

    expect(host.methods()).toEqual([
      'POST /v1/oauth/token',
      'GET /v1/episodes',
      'GET /v1/files/uploadAuthorize',
      'PUT /podbean-uploads/tmp2/1/manage-governance.mp3',
      'POST /v1/episodes',
    ]);
    expect(patch.host.podbean).toMatchObject({ episodeId: PODBEAN_EPISODE.id, firstAttemptAt: FIRST, error: null });
  });

  it('creates nothing when the listing fails, and records why', async () => {
    const host = fakeHost([tokenReply(), reply(503, { error: 'server_error', error_description: 'busy' })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: timedOut(), now });

    expect(host.methods()).toEqual(['POST /v1/oauth/token', 'GET /v1/episodes']);
    expect(patch.host.podbean).toMatchObject({
      firstAttemptAt: FIRST,
      lastAttemptAt: NOW.toISOString(),
      error: { status: 503, code: 'UPSTREAM', retryable: true },
    });
    expect(patch.host.podbean).not.toHaveProperty('episodeId');
  });

  it('creates nothing when the listing comes back without an episodes array', async () => {
    const host = fakeHost([tokenReply(), reply(200, { count: 0 })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: timedOut(), now });

    expect(host.methods()).toEqual(['POST /v1/oauth/token', 'GET /v1/episodes']);
    expect(patch.host.podbean.error).toMatchObject({ code: 'UPSTREAM', retryable: true });
    expect(patch.host.podbean.error.message).toMatch(/Could not tell whether an earlier attempt created the episode/);
  });

  it('never lists on a first attempt: there is no earlier create to find', async () => {
    const host = fakeHost(HAPPY);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(host.methods()).not.toContain('GET /v1/episodes');
  });

  it('matches through HTML entities and whitespace, newest first, and only inside the window', async () => {
    const title = 'Q&A: roles  and policy';
    const listing = {
      episodes: [
        { id: 'EARLY', title: 'Q&amp;A: roles and policy', publish_time: secs(FIRST) - RECONCILE_WINDOW_MS / 1000 - 60 },
        { id: 'OLDERMATCH', title: 'Q&amp;A: roles and policy', publish_time: secs('2026-10-13T09:51:00.000Z') },
        { id: 'NEWER', title: 'Q&A:  roles and policy', publish_time: secs('2026-10-13T09:55:00.000Z') },
        { id: 'OTHER', title: 'Something else', publish_time: secs('2026-10-13T09:56:00.000Z') },
      ],
    };
    const client = { listEpisodes: vi.fn(async () => listing) };
    const found = await findUnrecordedEpisode({ client, title, since: FIRST, until: FIRST });
    expect(found.id).toBe('NEWER');
    expect(client.listEpisodes).toHaveBeenCalledWith({ limit: 20 });
  });

  it('a late retry does not adopt an unrelated episode published after every recorded attempt (CodeRabbit on #1117)', async () => {
    // The last attempt timed out at 09:50; this retry runs at 10:00 the next
    // day. A same-title episode published at 18:00 the evening before, by
    // hand, was not made by any recorded attempt.
    const LATER = { ...PODBEAN_EPISODE, id: 'BYHAND001', publish_time: secs('2026-10-13T18:00:00.000Z') };
    const nextDay = () => new Date('2026-10-14T10:00:00.000Z');
    const host = fakeHost([tokenReply(), listed([LATER]), ...HAPPY.slice(1)]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: timedOut(), now: nextDay });

    expect(host.methods()).toContain('POST /v1/episodes');
    expect(host.methods()).not.toContain('POST /v1/episodes/BYHAND001');
    expect(patch.host.podbean).not.toHaveProperty('adoptedAt');
  });

  it('the window ends ATTEMPT_SPAN_MS plus the margin after the last attempt, inclusive', async () => {
    const edge = secs(FIRST) + (ATTEMPT_SPAN_MS + RECONCILE_WINDOW_MS) / 1000;
    const listing = {
      episodes: [
        { id: 'JUSTPAST', title: PODBEAN_EPISODE.title, publish_time: edge + 1 },
        { id: 'ATEDGE', title: PODBEAN_EPISODE.title, publish_time: edge },
      ],
    };
    const client = { listEpisodes: vi.fn(async () => listing) };
    const found = await findUnrecordedEpisode({ client, title: PODBEAN_EPISODE.title, since: FIRST, until: FIRST });
    expect(found.id).toBe('ATEDGE');
  });

  it('fails closed, without listing, on an unreadable attempt time: a local data error, not retryable', async () => {
    const host = fakeHost([tokenReply()]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const broken = timedOut();
    broken.host.podbean.firstAttemptAt = 'not a time';
    const patch = await publishEpisodeToHost({ client, readAudio, doc: broken, now });

    expect(host.methods()).not.toContain('GET /v1/episodes');
    expect(host.methods()).not.toContain('POST /v1/episodes');
    expect(patch.host.podbean.error).toMatchObject({ code: 'VALIDATION', retryable: false });
    expect(patch.host.podbean.error.message).toMatch(/recorded attempt time is unreadable/);
  });
});

describe('publishEpisodeToHost — failure is recorded, never thrown', () => {
  it('records an upstream failure with status and message and keeps the previous host record', async () => {
    const host = fakeHost([
      tokenReply(),
      reply(200, AUTHORIZED),
      reply(200),
      reply(503, { error: 'server_error', error_description: 'busy' }),
    ]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const original = doc();
    const snapshot = JSON.stringify(original);
    const patch = await publishEpisodeToHost({ client, readAudio, doc: original, now });

    expect(patch).toEqual({
      host: {
        podbean: {
          firstAttemptAt: NOW.toISOString(),
          lastAttemptAt: NOW.toISOString(),
          error: {
            status: 503,
            code: 'UPSTREAM',
            message: 'Podbean answered 503 while creating the episode: server_error: busy.',
            retryable: true,
          },
        },
      },
    });
    // No episodeId was recorded, so the next run creates rather than updates a ghost.
    expect(patch.host.podbean.episodeId).toBeUndefined();
    // The document itself is untouched, and approval never appears in the patch.
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('approvedAt');
    expect(patch).not.toHaveProperty('approvedBy');
  });

  it('keeps the previous host record beside the error on a failed re-publish', async () => {
    const host = fakeHost([tokenReply(), reply(500, { error: 'server_error' })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const previous = {
      episodeId: 'IWPNG2FB3F',
      permalinkUrl: PODBEAN_EPISODE.permalink_url,
      mediaUrl: PODBEAN_EPISODE.media_url,
      hostStatus: 'publish',
      audioPath: 'azure/az-104/manage-governance.mp3',
      fileKey: 'tmp2/1/manage-governance.mp3',
      publishedAt: '2026-10-12T10:00:00.000Z',
      lastAttemptAt: '2026-10-12T10:00:00.000Z',
      error: null,
    };
    const patch = await publishEpisodeToHost({
      client,
      readAudio,
      doc: doc({ host: { podbean: previous } }),
      now,
    });
    expect(patch.host.podbean).toEqual({
      ...previous,
      firstAttemptAt: previous.firstAttemptAt ?? previous.lastAttemptAt,
      lastAttemptAt: NOW.toISOString(),
      error: { status: 500, code: 'UPSTREAM', message: expect.stringContaining('500'), retryable: true },
    });
  });

  it('refused credentials are surfaced as configured-but-rejected, not as not-configured', async () => {
    const host = fakeHost([reply(400, { error: 'invalid_client', error_description: 'unknown client' })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(patch.host.podbean.error).toEqual({
      status: 400,
      code: 'CREDENTIALS_REJECTED',
      message:
        'Podbean refused the client ID and secret while requesting an access token ' +
        '(400 invalid_client: unknown client).',
      retryable: false,
    });
  });

  it('a spent storage allowance is recorded as STORAGE_LIMIT and not retryable', async () => {
    const host = fakeHost([
      tokenReply(),
      reply(400, { error: 'storage_limit_reach', error_description: "You've uploaded too much this month" }),
    ]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(patch.host.podbean.error).toMatchObject({ code: 'STORAGE_LIMIT', retryable: false });
    expect(host.methods()).not.toContain('POST /v1/episodes');
  });

  it('not configured → the plain sentence, no network call, no throw', async () => {
    const host = fakeHost([]);
    const client = createPodbeanClient({ env: {}, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(host.fetchImpl).not.toHaveBeenCalled();
    expect(patch.host.podbean.error.status).toBeNull();
    expect(patch.host.podbean.error.code).toBe('NOT_CONFIGURED');
    expect(patch.host.podbean.error.message).toMatch(
      /^Podbean publishing is not configured: PODBEAN_CLIENT_ID .* and PODBEAN_CLIENT_SECRET .* are not set/
    );
  });

  it('an episode with no audio is refused before any call is made', async () => {
    const host = fakeHost([]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc({ audioPath: null }), now });
    expect(host.fetchImpl).not.toHaveBeenCalled();
    expect(patch.host.podbean.error.code).toBe('VALIDATION');
    expect(patch.host.podbean.error.message).toMatch(/no audio/);
  });

  it('a blob read that throws is recorded as UNEXPECTED rather than escaping', async () => {
    const host = fakeHost([]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({
      client,
      readAudio: async () => {
        throw new Error('BlobNotFound');
      },
      doc: doc(),
      now,
    });
    expect(host.fetchImpl).not.toHaveBeenCalled();
    expect(patch.host.podbean.error).toEqual({
      status: null,
      code: 'UNEXPECTED',
      message: 'BlobNotFound',
      retryable: false,
    });
  });

  it('an authorisation without a presigned URL is a failure that never quotes one', async () => {
    const host = fakeHost([tokenReply(), reply(200, { file_key: 'tmp2/1/x.mp3' })]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(patch.host.podbean.error.code).toBe('UPSTREAM');
    expect(patch.host.podbean.error.message).toMatch(/without a presigned_url and a file_key/);
    expect(host.methods()).not.toContain('POST /v1/episodes');
  });

  it('a create that answers without an id is a failure, so nothing half-recorded is stored', async () => {
    const host = fakeHost([
      tokenReply(),
      reply(200, AUTHORIZED),
      reply(200),
      reply(200, { episode: { title: 'no id here' } }),
    ]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(patch.host.podbean.episodeId).toBeUndefined();
    expect(patch.host.podbean.error.code).toBe('UPSTREAM');
    expect(patch.host.podbean.error.message).toMatch(/without an id/);
  });

  it('a missing client is a recorded failure too', async () => {
    const patch = await publishEpisodeToHost({ client: null, readAudio, doc: doc(), now });
    expect(patch.host.podbean.error.code).toBe('NOT_CONFIGURED');
  });

  it('no recorded error carries the access token', async () => {
    const host = fakeHost([
      tokenReply(),
      reply(400, { error: 'invalid_request', error_description: `bad ?access_token=${TOKEN}` }),
    ]);
    const client = createPodbeanClient({ env: ENV, fetch: host.fetchImpl });
    const patch = await publishEpisodeToHost({ client, readAudio, doc: doc(), now });
    expect(patch.host.podbean.error.code).toBe('VALIDATION');
    expect(JSON.stringify(patch)).not.toContain(TOKEN);
  });

  it('the API base URL is the v1 host the documentation names', () => {
    expect(PODBEAN_API_BASE_URL).toBe('https://api.podbean.com/v1');
  });
});
