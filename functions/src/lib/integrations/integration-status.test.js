/**
 * The persisted outcome of each service test (ADR 0033 Platform). What must
 * hold: a success and a failure are recorded on separate fields so both
 * survive, the failure keeps the upstream's sentence and nothing else, the
 * document is one record per service, and the read returns exactly the four
 * fields the page shows.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createIntegrationStatusHandlers,
  parseStatusWrite,
  presentServiceStatus,
} from './integration-status.js';

const context = { error: vi.fn() };
const allow = {
  requireRole: vi.fn(async () => ({ user: { oid: 'u1' }, error: null })),
};
const deny = {
  requireRole: vi.fn(async () => ({
    user: null,
    error: { status: 403, body: '{}' },
  })),
};
const req = (body) => ({ json: async () => body });
const bodyOf = (res) => JSON.parse(res.body);
const NOW = new Date('2026-10-03T12:00:00.000Z');

function store(existing = null) {
  return {
    readDoc: vi.fn(async () => existing),
    upsertDoc: vi.fn(async (_c, doc) => doc),
  };
}

describe('parseStatusWrite', () => {
  it('accepts a registry-shaped id and a boolean, trims the error', () => {
    expect(
      parseStatusWrite({
        service: 'cloud-pricing',
        ok: false,
        error: '  Stale  ',
      })
    ).toEqual({
      service: 'cloud-pricing',
      ok: false,
      error: 'Stale',
    });
    expect(parseStatusWrite({ service: 'publer', ok: true, error: 'ignored' })).toEqual({
      service: 'publer',
      ok: true,
      error: null,
    });
  });

  it('refuses a missing id, an odd id and a non-boolean verdict', () => {
    expect(parseStatusWrite({ ok: true }).problem).toMatch(/service/);
    expect(parseStatusWrite({ service: 'Publer!', ok: true }).problem).toMatch(/service/);
    expect(parseStatusWrite({ service: 'publer', ok: 'yes' }).problem).toMatch(/ok/);
  });

  it('bounds the error sentence', () => {
    const long = 'x'.repeat(400);
    expect(parseStatusWrite({ service: 'publer', ok: false, error: long }).error).toHaveLength(300);
  });
});

describe('the record', () => {
  it('presents exactly four fields, whatever the stored record grows', () => {
    expect(
      presentServiceStatus({
        lastOkAt: 'a',
        lastFailAt: 'b',
        lastError: 'c',
        lastTestedBy: 'd',
        x: 1,
      })
    ).toEqual({
      lastOkAt: 'a',
      lastFailAt: 'b',
      lastError: 'c',
      lastTestedBy: 'd',
    });
    expect(presentServiceStatus()).toEqual({
      lastOkAt: null,
      lastFailAt: null,
      lastError: null,
      lastTestedBy: null,
    });
  });
});

describe('the handlers', () => {
  it('deny without touching the store', async () => {
    const s = store();
    const h = createIntegrationStatusHandlers({ guard: deny, store: s });
    expect((await h.getIntegrationStatus(req(), context)).status).toBe(403);
    expect(
      (await h.putIntegrationStatus(req({ service: 'publer', ok: true }), context)).status
    ).toBe(403);
    expect(s.readDoc).not.toHaveBeenCalled();
    expect(s.upsertDoc).not.toHaveBeenCalled();
  });

  it('GET answers an empty map when nothing was recorded', async () => {
    const h = createIntegrationStatusHandlers({ guard: allow, store: store() });
    expect(bodyOf(await h.getIntegrationStatus(req(), context))).toEqual({
      success: true,
      services: {},
    });
  });

  it('PUT records a success without erasing the last failure, and vice versa', async () => {
    const existing = {
      id: 'integration-status',
      services: {
        publer: {
          lastFailAt: '2026-10-01T00:00:00.000Z',
          lastError: 'Forbidden',
        },
      },
    };
    const s = store(existing);
    const h = createIntegrationStatusHandlers({
      guard: allow,
      store: s,
      now: () => NOW,
    });

    const okRes = bodyOf(
      await h.putIntegrationStatus(req({ service: 'publer', ok: true }), context)
    );
    expect(okRes.status).toEqual({
      lastOkAt: NOW.toISOString(),
      lastFailAt: '2026-10-01T00:00:00.000Z',
      lastError: 'Forbidden',
      lastTestedBy: 'u1',
    });
    const [, doc] = s.upsertDoc.mock.calls[0];
    expect(doc.id).toBe('integration-status');
    expect(doc.services.publer.lastOkAt).toBe(NOW.toISOString());

    const failRes = bodyOf(
      await h.putIntegrationStatus(
        req({ service: 'resend', ok: false, error: 'restricted_api_key' }),
        context
      )
    );
    expect(failRes.status).toMatchObject({
      lastOkAt: null,
      lastFailAt: NOW.toISOString(),
      lastError: 'restricted_api_key',
    });
  });

  it('PUT 400s a bad body before touching the store', async () => {
    const s = store();
    const h = createIntegrationStatusHandlers({ guard: allow, store: s });
    const res = await h.putIntegrationStatus(req({ service: '', ok: true }), context);
    expect(res.status).toBe(400);
    expect(s.upsertDoc).not.toHaveBeenCalled();
  });

  it('uses replaceDocIfMatch with _etag and retries on 412 conflict (AP-B11)', async () => {
    let callCount = 0;
    const s = {
      readDoc: vi.fn(async () => {
        callCount += 1;
        return {
          id: 'integration-status',
          services: { other: { lastOkAt: 'prev' } },
          _etag: `"etag-${callCount}"`,
        };
      }),
      replaceDocIfMatch: vi.fn(async (_c, doc) => {
        if (callCount === 1) {
          const err = new Error('Precondition failed');
          err.code = 412;
          throw err;
        }
        return doc;
      }),
    };
    const h = createIntegrationStatusHandlers({ guard: allow, store: s, now: () => NOW });
    const res = await h.putIntegrationStatus(req({ service: 'publer', ok: true }), context);
    expect(res.status).toBe(200);
    expect(s.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(s.replaceDocIfMatch.mock.calls[0][1]._etag).toBe('"etag-1"');
    expect(s.replaceDocIfMatch.mock.calls[1][1]._etag).toBe('"etag-2"');
    expect(s.replaceDocIfMatch.mock.calls[1][1].services.publer.lastOkAt).toBe(NOW.toISOString());
    expect(s.replaceDocIfMatch.mock.calls[1][1].services.other.lastOkAt).toBe('prev');
  });
});
