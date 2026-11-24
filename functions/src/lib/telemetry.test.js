import { describe, it, expect, vi } from 'vitest';
import {
  parseConnectionString,
  stringifyProperties,
  buildEventEnvelope,
  createEventTracker,
} from './telemetry.js';

const CONN =
  'InstrumentationKey=00000000-0000-0000-0000-000000000001;IngestionEndpoint=https://centralus-0.in.example.test';
const NOW = new Date('2026-09-13T03:20:00.000Z');

describe('parseConnectionString', () => {
  it('reads the key and endpoint and normalises the trailing slash', () => {
    expect(parseConnectionString(CONN)).toEqual({
      iKey: '00000000-0000-0000-0000-000000000001',
      endpoint: 'https://centralus-0.in.example.test/',
    });
    expect(parseConnectionString(`${CONN}/`).endpoint).toBe('https://centralus-0.in.example.test/');
  });

  it('refuses a string missing either half', () => {
    expect(() => parseConnectionString('InstrumentationKey=abc')).toThrow(/IngestionEndpoint/);
    expect(() => parseConnectionString(undefined)).toThrow(/InstrumentationKey/);
  });
});

describe('buildEventEnvelope', () => {
  it('is an EventData envelope with every property as text', () => {
    const env = buildEventEnvelope({
      iKey: 'k',
      name: 'cosmosExportCompleted',
      properties: { mode: 'full', docs: 1234, containers: 60, skipped: null, ok: true },
      time: NOW,
    });
    expect(env).toEqual({
      name: 'Microsoft.ApplicationInsights.Event',
      time: '2026-09-13T03:20:00.000Z',
      iKey: 'k',
      data: {
        baseType: 'EventData',
        baseData: {
          ver: 2,
          name: 'cosmosExportCompleted',
          properties: { mode: 'full', docs: '1234', containers: '60', ok: 'true' },
        },
      },
    });
  });

  it('requires a name, and sends a padded one trimmed so the alert query matches it', () => {
    expect(() => buildEventEnvelope({ iKey: 'k', name: '' })).toThrow(/name is required/);
    expect(() => buildEventEnvelope({ iKey: 'k', name: '   ' })).toThrow(/name is required/);
    expect(() => buildEventEnvelope({ iKey: 'k', name: 42 })).toThrow(/name is required/);
    expect(
      buildEventEnvelope({ iKey: 'k', name: '  cosmosExportCompleted \n' }).data.baseData.name
    ).toBe('cosmosExportCompleted');
  });

  it('stringifyProperties drops null and undefined and keeps strings as they are', () => {
    expect(stringifyProperties({ a: 'x', b: undefined, c: null, d: 0 })).toEqual({
      a: 'x',
      d: '0',
    });
  });
});

describe('createEventTracker', () => {
  it('posts to v2/track and resolves true on 200', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const tracker = createEventTracker({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONN },
      fetcher,
      now: () => NOW,
    });
    await expect(tracker.trackEvent('cosmosExportCompleted', { mode: 'delta' })).resolves.toBe(
      true
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://centralus-0.in.example.test/v2/track');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.data.baseData.name).toBe('cosmosExportCompleted');
    expect(body.data.baseData.properties).toEqual({ mode: 'delta' });
    expect(body.time).toBe(NOW.toISOString());
  });

  it('never throws: a missing setting, a rejected POST and a network error all resolve false with a warning', async () => {
    const warn = vi.fn();
    const noSetting = createEventTracker({ env: {}, fetcher: vi.fn(), log: { warn } });
    await expect(noSetting.trackEvent('e')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('e not sent'));

    const rejected = createEventTracker({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONN },
      fetcher: vi.fn(async () => ({ ok: false, status: 400 })),
      log: { warn },
    });
    await expect(rejected.trackEvent('e')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'));

    const down = createEventTracker({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONN },
      fetcher: vi.fn(async () => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }),
      log: { warn },
    });
    await expect(down.trackEvent('e')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=ECONNRESET'));
    expect(warn.mock.calls.flat().join(' ')).not.toContain('socket hang up');
  });

  it('a property that cannot be serialised, or a bad name, resolves false with a warning and never posts', async () => {
    const warn = vi.fn();
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    const tracker = createEventTracker({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONN },
      fetcher,
      log: { warn },
    });
    const circular = {};
    circular.self = circular;
    await expect(tracker.trackEvent('e', { circular })).resolves.toBe(false);
    await expect(tracker.trackEvent('e', { big: 10n })).resolves.toBe(false);
    await expect(tracker.trackEvent('', { mode: 'full' })).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    // Each line names the error's class and where it was thrown, never its message (#1794).
    expect(warn.mock.calls[0][0]).toMatch(/e not sent: name=TypeError\b/);
    expect(warn.mock.calls[2][0]).toMatch(/not sent: name=\w*Error\b.* at=src\/lib\/telemetry\.js:\d+/);
  });
});
