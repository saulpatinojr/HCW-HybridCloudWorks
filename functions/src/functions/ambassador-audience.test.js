/**
 * The monthly audience timer (#1302): registered on the first of the month
 * behind its own flag; reads the previous calendar month (January reads the
 * prior December); asks Cloudflare for exactly the documented dataset over
 * exactly the month's window; files one row per programme and UPDATES it on
 * a re-run rather than adding another; files the page-view figure even when
 * Podbean is unavailable; writes nothing when the token is missing or the
 * Cloudflare read fails; and logs no secret and no response body.
 */
import { describe, it, expect, vi } from 'vitest';

const timers = new Map();
vi.mock('@azure/functions', () => ({
  app: {
    timer: (name, options) => timers.set(name, options),
    http: () => {},
    storageQueue: () => {},
    cosmosDB: () => {},
  },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));

const { TIMER_FLAG, TIMER_NAME, TIMER_SCHEDULE, audienceEnabled } = await import('./ambassador-audience.js');
const {
  ACCOUNT_ID_SETTING,
  AUDIENCE_PROGRAMS,
  CF_GRAPHQL_URL,
  PAGE_VIEWS_QUERY,
  SITE_TAG_SETTING,
  TOKEN_SETTING,
  audienceEvidenceId,
  audienceRow,
  createAudienceMonthlyRead,
  missingSettings,
  previousMonth,
} = await import('../lib/timers/ambassador-audience.js');
const { importedEvidenceId } = await import('../lib/ambassador/evidence.js');
const { DEFAULT_PROGRAMS } = await import('../lib/ambassador/programs.js');
const { validateEvidence } = await import('../lib/ambassador/validate.js');
const { PodbeanError } = await import('../lib/podcast/podbean.js');

const TOKEN = 'cf-read-only-token-abcdefghijklmnopqrstuvwxyz0123456789';
const SITE = '0123456789abcdef0123456789abcdef';
const ACCOUNT = 'fedcba9876543210fedcba9876543210';
const env = () => ({
  [TOKEN_SETTING]: TOKEN,
  [SITE_TAG_SETTING]: SITE,
  [ACCOUNT_ID_SETTING]: ACCOUNT,
});

/** 2026-10-01 06:00 UTC: the first run after September 2026. */
const OCTOBER_FIRST = new Date('2026-10-01T06:00:00.000Z');

/** An in-memory `ambassador` container with the hub's three write verbs. */
function memStore() {
  const rows = new Map();
  return {
    rows,
    readDoc: vi.fn(async (_name, id) => rows.get(id) || null),
    createDoc: vi.fn(async (_name, doc) => {
      if (rows.has(doc.id)) throw Object.assign(new Error('Conflict'), { code: 409 });
      rows.set(doc.id, { ...doc, _etag: `etag-${rows.size + 1}` });
      return rows.get(doc.id);
    }),
    patchDoc: vi.fn(async (_name, id, updates) => {
      const next = { ...rows.get(id), ...updates, _etag: `etag-${Math.random()}` };
      rows.set(id, next);
      return next;
    }),
  };
}

/** A Cloudflare that answers `count` page views for the month, recording the request. */
function cloudflare({ count = 5100, status = 200, body } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const payload =
      body ??
      JSON.stringify({
        data: {
          viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [{ count, sum: { visits: 3000 } }] }] },
        },
      });
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  });
  return { calls, fetch };
}

/** A Podbean client that answers daily downloads, or throws what Podbean would. */
const podbean = (byDay = { '2026-09-01': 100, '2026-09-15': 60, '2026-09-30': 50 }) => ({
  getDownloadStats: vi.fn(async () => byDay),
});

const resolve = async () => ({ address: '104.16.132.229' });
const dispatcherFor = () => null;

function reader({ store = memStore(), cf = cloudflare(), client = podbean(), now = OCTOBER_FIRST, settings = env() } = {}) {
  const log = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const read = createAudienceMonthlyRead({
    store,
    podbean: client,
    env: settings,
    now: () => now,
    fetch: cf.fetch,
    resolve,
    dispatcherFor,
    log,
  });
  return { read, store, cf, client, log };
}

describe('ambassadorAudienceMonthly registration', () => {
  it('runs daily at 06:45 UTC (the run records each month once), with no queue output', () => {
    // Daily, not `0 0 6 1 * *`: alert-timer-overdue computes a due time from
    // a fixed period, and a day-of-month schedule has none
    // (infra/observability.tf, timer_schedules). The once-a-month part is
    // the run's own check, tested below.
    const timer = timers.get(TIMER_NAME);
    expect(timer).toBeDefined();
    expect(TIMER_SCHEDULE).toBe('0 45 6 * * *');
    expect(timer.schedule).toBe(TIMER_SCHEDULE);
    expect(timer.extraOutputs).toBeUndefined();
  });

  it('is inert until FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY is "true", and the master switch still wins', () => {
    expect(TIMER_FLAG).toBe('AMBASSADOR_AUDIENCE_MONTHLY');
    expect(audienceEnabled({})).toBe(false);
    expect(audienceEnabled({ FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY: '1' })).toBe(false);
    expect(audienceEnabled({ FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY: 'true' })).toBe(true);
    expect(
      audienceEnabled({ FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY: 'true', FEATURE_FLAG_SCHEDULERS: 'false' })
    ).toBe(false);
  });

  it('a disabled timer logs the skip and reads nothing', async () => {
    const saved = process.env.FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY;
    delete process.env.FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY;
    try {
      const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await timers.get(TIMER_NAME).handler({}, context);
      const lines = [...context.log.mock.calls, ...context.warn.mock.calls].flat().join('\n');
      expect(lines).toContain(`[${TIMER_NAME}] disabled`);
    } finally {
      if (saved !== undefined) process.env.FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY = saved;
    }
  });
});

describe('previousMonth', () => {
  it('names the month before now, in UTC, with its window and its last day', () => {
    expect(previousMonth(OCTOBER_FIRST)).toEqual({
      key: '2026-09',
      label: 'September 2026',
      since: '2026-09-01T00:00:00Z',
      until: '2026-10-01T00:00:00Z',
      start: '2026-09-01',
      end: '2026-09-30',
    });
  });

  it('January reads December of the prior year', () => {
    expect(previousMonth(new Date('2027-01-01T06:00:00.000Z'))).toEqual({
      key: '2026-12',
      label: 'December 2026',
      since: '2026-12-01T00:00:00Z',
      until: '2027-01-01T00:00:00Z',
      start: '2026-12-01',
      end: '2026-12-31',
    });
  });

  it.each([
    ['2026-03-01T06:00:00Z', '2026-02-28', 'a 28-day February'],
    ['2028-03-01T06:00:00Z', '2028-02-29', 'a leap-year February'],
    ['2026-05-01T06:00:00Z', '2026-04-30', 'a 30-day month'],
    ['2026-08-01T06:00:00Z', '2026-07-31', 'a 31-day month'],
  ])('at %s the last day is %s (%s)', (now, end) => {
    expect(previousMonth(new Date(now)).end).toBe(end);
  });

  it('is the UTC month even late on the last local day', () => {
    // 2026-09-30 23:30 UTC-5 is 2026-10-01 04:30 UTC: the run that fires at
    // 06:00 UTC on the first sees October and reads September.
    expect(previousMonth(new Date('2026-10-01T04:30:00.000Z')).key).toBe('2026-09');
  });
});

describe('the Cloudflare read', () => {
  it('POSTs the documented query to the GraphQL endpoint with the bearer token and the month as variables', async () => {
    const { read, cf } = reader();
    await read.run();
    expect(cf.calls).toHaveLength(1);
    const [{ url, init }] = cf.calls;
    expect(url).toBe(CF_GRAPHQL_URL);
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.query).toBe(PAGE_VIEWS_QUERY);
    expect(body.variables).toEqual({
      accountTag: ACCOUNT,
      siteTag: SITE,
      since: '2026-09-01T00:00:00Z',
      until: '2026-10-01T00:00:00Z',
    });
  });

  it('asks for exactly the dataset, under the account, filtered by site and the half-open window', () => {
    expect(PAGE_VIEWS_QUERY).toContain('accounts(filter: { accountTag: $accountTag })');
    expect(PAGE_VIEWS_QUERY).toContain('rumPageloadEventsAdaptiveGroups(');
    expect(PAGE_VIEWS_QUERY).toContain('filter: { siteTag: $siteTag, datetime_geq: $since, datetime_lt: $until }');
    expect(PAGE_VIEWS_QUERY).toContain('count');
    expect(PAGE_VIEWS_QUERY).toContain('$since: Time!');
    expect(PAGE_VIEWS_QUERY).not.toContain('datetime_leq');
  });

  it('sums count over the groups, and a month with no groups is zero', async () => {
    const empty = cloudflare({ body: JSON.stringify({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [] }] } } }) });
    const { read } = reader({ cf: empty });
    const result = await read.run();
    expect(result.pageViews).toBe(0);
    expect(result.rows).toEqual({ created: 2, updated: 0, skipped: 0 });
  });

  it.each([
    ['HTTP 403', { status: 403, body: '{"success":false}' }, /HTTP 403/],
    ['GraphQL errors', { body: JSON.stringify({ data: null, errors: [{ message: 'siteTag x not found' }] }) }, /1 error/],
    ['a shape without the dataset', { body: JSON.stringify({ data: { viewer: { accounts: [] } } }) }, /without the dataset/],
    ['a non-JSON body', { body: '<html>' }, /other than JSON/],
  ])('on %s writes nothing, logs a content-free line and fails the run', async (_what, answer, message) => {
    const { read, store, log } = reader({ cf: cloudflare(answer) });
    await expect(read.run()).rejects.toThrow(message);
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    const logged = [...log.log.mock.calls, ...log.error.mock.calls].flat().join('\n');
    expect(logged).toContain('nothing written');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('siteTag x not found');
    expect(logged).not.toContain('<html>');
  });
});

describe('the rows', () => {
  it('files one manual row per programme that asks for reach, dated the last day of the month, with both figures', async () => {
    const { read, store } = reader();
    const result = await read.run();
    expect(result).toEqual({
      month: '2026-09',
      pageViews: 5100,
      podcastDownloads: 210,
      podcast: 'ok',
      rows: { created: 2, updated: 0, skipped: 0 },
    });
    expect(AUDIENCE_PROGRAMS.map((p) => p.programId)).toEqual(['program-docker-captain', 'program-microsoft-mvp']);
    expect(store.rows.size).toBe(2);
    for (const { programId } of AUDIENCE_PROGRAMS) {
      const row = store.rows.get(audienceEvidenceId('2026-09', programId));
      expect(row).toMatchObject({
        docType: 'evidence',
        title: 'Audience, September 2026: 5,100 page views, 210 podcast downloads',
        date: '2026-09-30',
        sourceModule: 'manual',
        sourceId: `audience-2026-09-${programId}`,
        url: null,
        programIds: [programId],
        metrics: { reach: 210, attendees: null, views: 5100, credits: null },
        verificationStatus: 'unverified',
        createdBy: 'ambassadorAudienceMonthly',
        createdAt: '2026-10-01T06:00:00.000Z',
      });
      expect(row.description).toContain('Page views: 5,100');
      expect(row.description).toContain('Podcast downloads: 210');
      expect(row.description).toContain('lite mode');
      expect(row.description).toContain('Read on 2026-10-01');
      expect(row.snapshot).toEqual({
        title: row.title,
        date: '2026-09-30',
        url: null,
        capturedAt: '2026-10-01T06:00:00.000Z',
      });
    }
  });

  it('is stored under the hub’s deterministic import id for (manual, sourceId)', () => {
    expect(audienceEvidenceId('2026-09', 'program-docker-captain')).toBe(
      importedEvidenceId('manual', 'audience-2026-09-program-docker-captain')
    );
    expect(audienceEvidenceId('2026-09', 'program-docker-captain')).not.toBe(
      audienceEvidenceId('2026-09', 'program-microsoft-mvp')
    );
    expect(audienceEvidenceId('2026-09', 'program-docker-captain')).not.toBe(
      audienceEvidenceId('2026-10', 'program-docker-captain')
    );
  });

  it('passes the hub’s own evidence validator, so the row reads like one the owner created', () => {
    const month = previousMonth(OCTOBER_FIRST);
    const podcast = { available: true, downloads: 210 };
    for (const { programId } of AUDIENCE_PROGRAMS) {
      const row = audienceRow({ programId, month, pageViews: 5100, podcast, readAt: OCTOBER_FIRST.toISOString() });
      const { id, docType, createdAt, createdBy, updatedAt, ...body } = row;
      expect(validateEvidence(body).error, programId).toBeUndefined();
      expect(id).toBe(audienceEvidenceId(month.key, programId));
      expect([docType, createdBy, createdAt, updatedAt]).toEqual([
        'evidence',
        'ambassadorAudienceMonthly',
        '2026-10-01T06:00:00.000Z',
        '2026-10-01T06:00:00.000Z',
      ]);
    }
  });

  it('counts under each programme’s reach requirement: the seeds list manual there', () => {
    for (const { programId, requirementId } of AUDIENCE_PROGRAMS) {
      const program = DEFAULT_PROGRAMS.find((p) => p.id === programId);
      const requirement = program.requirements.find((r) => r.id === requirementId);
      expect(requirement, `${programId} has no ${requirementId} requirement`).toBeDefined();
      expect(requirement.evidenceTypes, `${programId}.${requirementId}`).toContain('manual');
    }
  });

  it('once the month is recorded, the daily run logs one line and reads nothing', async () => {
    const store = memStore();
    await reader({ store }).read.run();
    const { read, cf, client, log } = reader({ store, now: new Date('2026-10-02T06:45:00.000Z') });
    const result = await read.run();
    expect(result).toEqual({ skipped: 'recorded', month: '2026-09' });
    expect(cf.fetch).not.toHaveBeenCalled();
    expect(client.getDownloadStats).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(2);
    expect(store.createDoc).toHaveBeenCalledTimes(2);
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0][0]).toContain('2026-09 already recorded');
    // The first run of the NEXT month is not "recorded" and does the work.
    const november = reader({ store, now: new Date('2026-11-01T06:45:00.000Z') });
    expect((await november.read.run()).rows).toEqual({ created: 2, updated: 0, skipped: 0 });
    expect(store.rows.size).toBe(4);
  });

  it('a month with one row missing is read again: the missing row is created and the present one updated in place, never a third', async () => {
    const store = memStore();
    await reader({ store, cf: cloudflare({ count: 5100 }) }).read.run();
    const dockerId = audienceEvidenceId('2026-09', 'program-docker-captain');
    const mvpId = audienceEvidenceId('2026-09', 'program-microsoft-mvp');
    const was = { ...store.rows.get(mvpId) };
    store.rows.delete(dockerId);

    const second = reader({ store, cf: cloudflare({ count: 5250 }), now: new Date('2026-10-02T06:45:00.000Z') });
    const result = await second.read.run();
    expect(result.rows).toEqual({ created: 1, updated: 1, skipped: 0 });
    expect(store.rows.size).toBe(2);
    expect(store.createDoc).toHaveBeenCalledTimes(3);
    expect(store.patchDoc).toHaveBeenCalledTimes(1);
    const mvp = store.rows.get(mvpId);
    expect(mvp.title).toBe('Audience, September 2026: 5,250 page views, 210 podcast downloads');
    expect(mvp.metrics.views).toBe(5250);
    expect(mvp.createdAt).toBe(was.createdAt);
    expect(mvp.updatedAt).toBe('2026-10-02T06:45:00.000Z');
    expect(store.rows.get(dockerId).metrics.views).toBe(5250);
    // The patch carries only the owned fields, on the stored ETag.
    const [, id, patch, options] = store.patchDoc.mock.calls[0];
    expect(id).toBe(mvpId);
    expect(Object.keys(patch).sort()).toEqual(
      ['date', 'description', 'metrics', 'programIds', 'snapshot', 'title', 'updatedAt'].sort()
    );
    expect(options).toEqual({ ifMatch: was._etag });
  });

  it('leaves the owner’s notes, tags and verification alone on an update, and a soft-deleted row deleted', async () => {
    const store = memStore();
    await reader({ store }).read.run();
    const [dockerId, mvpId] = AUDIENCE_PROGRAMS.map((p) => audienceEvidenceId('2026-09', p.programId));
    store.rows.set(dockerId, {
      ...store.rows.get(dockerId),
      notes: 'checked against the dashboard',
      tags: ['audience', 'checked'],
      verificationStatus: 'verified',
    });
    store.rows.set(mvpId, { ...store.rows.get(mvpId), softDeletedAt: '2026-10-02T00:00:00.000Z' });

    // Both rows exist, so a plain daily run reads nothing; a re-read is
    // forced here by answering "absent" for the Docker row once, the way a
    // row deleted outright (not soft-deleted) would read.
    const dockerRow = store.rows.get(dockerId);
    store.readDoc.mockImplementationOnce(async () => null);
    const result = await reader({ store, cf: cloudflare({ count: 5250 }) }).read.run();
    expect(result.rows).toEqual({ created: 0, updated: 1, skipped: 1 });
    expect(store.rows.get(dockerId)).not.toBe(dockerRow);
    expect(store.rows.get(dockerId)).toMatchObject({
      notes: 'checked against the dashboard',
      tags: ['audience', 'checked'],
      verificationStatus: 'verified',
      metrics: { views: 5250 },
    });
    expect(store.rows.get(mvpId).metrics.views).toBe(5100);
    expect(store.rows.get(mvpId).softDeletedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('a 409 on create (another run landed the month first) becomes an update, not a failure', async () => {
    const store = memStore();
    const seeded = memStore();
    await reader({ store: seeded }).read.run();
    // readDoc says "absent", createDoc says "exists": the race, as Cosmos reports it.
    store.readDoc.mockResolvedValue(null);
    store.createDoc.mockRejectedValue(Object.assign(new Error('Conflict'), { code: 409 }));
    const result = await reader({ store }).read.run();
    expect(result.rows).toEqual({ created: 0, updated: 2, skipped: 0 });
    expect(store.patchDoc).toHaveBeenCalledTimes(2);
    expect(store.patchDoc.mock.calls[0][3]).toEqual({});
  });
});

describe('the Podbean half', () => {
  it('reads the month’s days, summed, through the existing client', async () => {
    const { read, client } = reader();
    await read.run();
    expect(client.getDownloadStats).toHaveBeenCalledWith({ start: '2026-09-01', end: '2026-09-30', period: 'd' });
  });

  it.each([
    ['the credential is absent', new PodbeanError('Podbean publishing is not configured', { status: null, code: 'NOT_CONFIGURED' }), 'NOT_CONFIGURED'],
    ['Podbean refuses the token', new PodbeanError('invalid_token', { status: 400, code: 'REJECTED' }), 'REJECTED'],
    ['the read throws something else', new TypeError('fetch failed'), 'UNEXPECTED'],
  ])('when %s, the row says the downloads are unavailable and the page views still land', async (_what, error, code) => {
    const client = { getDownloadStats: vi.fn(async () => { throw error; }) };
    const { read, store, log } = reader({ client });
    const result = await read.run();
    expect(result.podcast).toBe(`unavailable:${code}`);
    expect(result.podcastDownloads).toBeNull();
    expect(result.rows).toEqual({ created: 2, updated: 0, skipped: 0 });
    const row = store.rows.get(audienceEvidenceId('2026-09', 'program-docker-captain'));
    expect(row.title).toBe('Audience, September 2026: 5,100 page views, podcast downloads unavailable');
    expect(row.description).toContain('Podcast downloads: unavailable this month');
    expect(row.description).toContain(code);
    expect(row.metrics).toEqual({ reach: null, attendees: null, views: 5100, credits: null });
    expect(log.log.mock.calls.flat().join('\n')).toContain(`podbean read: unavailable (${code}`);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('when the beacon is not configured', () => {
  it.each([
    ['the token is absent', { [TOKEN_SETTING]: undefined }, [TOKEN_SETTING]],
    ['the token is an unresolved Key Vault reference', { [TOKEN_SETTING]: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/X)' }, [TOKEN_SETTING]],
    ['the site tag is empty', { [SITE_TAG_SETTING]: '' }, [SITE_TAG_SETTING]],
    ['the account id is blank', { [ACCOUNT_ID_SETTING]: '   ' }, [ACCOUNT_ID_SETTING]],
    ['nothing is set', { [TOKEN_SETTING]: '', [SITE_TAG_SETTING]: '', [ACCOUNT_ID_SETTING]: '' }, [TOKEN_SETTING, SITE_TAG_SETTING, ACCOUNT_ID_SETTING]],
  ])('when %s, the run logs one line naming the setting and writes nothing', async (_what, overrides, missing) => {
    const settings = { ...env(), ...overrides };
    expect(missingSettings(settings)).toEqual(missing);
    const { read, store, cf, client, log } = reader({ settings });
    const result = await read.run();
    expect(result).toEqual({ skipped: 'not-configured', missing });
    expect(cf.fetch).not.toHaveBeenCalled();
    expect(client.getDownloadStats).not.toHaveBeenCalled();
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(store.patchDoc).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0][0]).toContain(missing.join(', '));
    expect(log.error).not.toHaveBeenCalled();
  });
});
