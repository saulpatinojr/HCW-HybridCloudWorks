/**
 * The route and body readers every Listen & Learn route goes through
 * (PR #841 split of handlers.js). The routes themselves stay pinned in
 * handlers.test.js and handlers.library.test.js.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  TOO_LARGE_TO_QUEUE,
  guardedWith,
  parseBody,
  queueJob,
  readRequest,
  readRoute,
  truthyQuery,
} from './handlers-shared.js';

const request = (params, body, query = {}) => ({
  params,
  query: { get: (name) => query[name] },
  json: vi.fn(async () => body),
});

describe('readRoute', () => {
  it('lower-cases the platform and refuses a route with a part missing', () => {
    const route = readRoute(request({ platform: 'Azure', examCode: 'AZ-104' }));
    expect(route).toMatchObject({ ok: true, ref: { platform: 'azure', examCode: 'AZ-104' } });
    expect(readRoute(request({ platform: 'azure' }))).toEqual({
      ok: false,
      status: 400,
      error: 'platform and examCode are required',
    });
  });

  it('validates the chapter and version ids as far as the route goes', () => {
    const base = { platform: 'azure', examCode: 'AZ-104' };
    expect(readRoute(request({ ...base, chapterId: 'Bad Id' }), { chapter: true })).toMatchObject({
      ok: false,
      error: 'platform, examCode and chapterId are required',
    });
    expect(
      readRoute(request({ ...base, chapterId: 'intro', versionId: 'v-1' }), {
        chapter: true,
        version: true,
      })
    ).toMatchObject({
      ok: false,
      error: 'platform, examCode, chapterId and versionId are required',
    });
    expect(
      readRoute(request({ ...base, chapterId: 'intro', versionId: 'abc123' }), {
        chapter: true,
        version: true,
      })
    ).toMatchObject({ ok: true, chapterId: 'intro', versionId: 'abc123' });
  });
});

describe('parseBody and readRequest', () => {
  const parse = (body) => (body.name ? { value: { name: body.name } } : { error: 'name required' });

  it('refuses a body that is not a plain object, then whatever the parser refuses', () => {
    expect(parseBody([], parse)).toEqual({
      ok: false,
      status: 400,
      error: 'Body must be a JSON object',
    });
    expect(parseBody({}, parse)).toEqual({ ok: false, status: 400, error: 'name required' });
    expect(parseBody({ name: 'x' }, parse)).toEqual({
      ok: true,
      body: { name: 'x' },
      parsed: { name: 'x' },
    });
  });

  it('reads the route first, then the body, and can treat no body as an empty one', async () => {
    const bad = await readRequest(request({ platform: 'azure' }, { name: 'x' }), { parse });
    expect(bad).toMatchObject({ ok: false, error: 'platform and examCode are required' });

    const ref = { platform: 'azure', examCode: 'AZ-104' };
    const noBody = await readRequest(request(ref, null), { parse });
    expect(noBody).toMatchObject({ ok: false, error: 'Body must be a JSON object' });

    const empty = await readRequest(request(ref, null), {
      parse: (body) => ({ value: { keys: Object.keys(body) } }),
      emptyBody: true,
    });
    expect(empty).toMatchObject({ ok: true, parsed: { keys: [] } });

    const routeOnly = await readRequest(request(ref, { name: 'ignored' }));
    expect(routeOnly).toMatchObject({ ok: true, ref: { id: expect.any(String) } });
    expect(routeOnly.parsed).toBeUndefined();
  });
});

describe('truthyQuery', () => {
  it('accepts 1, true and yes in any case and nothing else', () => {
    expect(truthyQuery(request({}, null, { force: 'YES' }), 'force')).toBe(true);
    expect(truthyQuery(request({}, null, { force: '1' }), 'force')).toBe(true);
    expect(truthyQuery(request({}, null, { force: 'no' }), 'force')).toBe(false);
    expect(truthyQuery(request({}, null, {}), 'force')).toBe(false);
  });
});

describe('a route whose job is over its payload bound (#942)', () => {
  const allow = { requireRole: async () => ({ user: { oid: 'o1', email: 'ed@example.test' } }) };
  const deps = (store) => ({ store, uuid: () => 'job-1', stamp: () => '2026-10-15T00:00:00.000Z' });

  it('answers 413 with a fixed sentence, not 500, and writes and queues nothing', async () => {
    const store = { upsertDoc: vi.fn() };
    const enqueue = vi.fn();
    const context = { error: vi.fn(), warn: vi.fn() };
    const route = guardedWith(allow)('editor', 'speakChapter', 'Failed to queue the chapter', ({ auth, io }) =>
      queueJob(deps(store), {
        // A type this process has not registered takes newJobDoc's 64 KiB default.
        type: 'not-registered-here',
        payload: { text: 'x'.repeat(70 * 1024) },
        user: auth.user,
        enqueue: io.enqueue,
      })
    );

    const res = await route({}, context, { enqueue });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: TOO_LARGE_TO_QUEUE });
    expect(res.body).not.toMatch(/bytes|not-registered-here/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(context.error).not.toHaveBeenCalled();
  });

  it('still answers any other throw, a 413 from elsewhere included, with the route’s 500', async () => {
    const context = { error: vi.fn(), warn: vi.fn() };
    const route = guardedWith(allow)('speakChapter', 'speakChapter', 'Failed to queue the chapter', async () => {
      throw Object.assign(new Error('upstream refused'), { status: 413 });
    });
    const res = await route({}, context, {});
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to queue the chapter' });
  });
});
