/**
 * The host checks' report: POST /api/agent/reportHostCheck (#1282).
 *
 * The load-bearing assertions are the containment ones, as for every agent
 * route (lab-agent.test.js): a refused credential reaches nothing; a body
 * that is not exactly the contract reaches nothing, and the sentence that
 * refuses it names a field of the contract and never the value or the key
 * the caller sent; the document is one, each check's entry replaced whole
 * under the document's ETag; and no audit row is ever written, because the
 * report comes every fifteen minutes from a machine. Exercised through
 * createLabAgentHandlers, so the guard order is the production one.
 */
import { describe, expect, it, vi } from 'vitest';

import { createLabAgentHandlers } from '../lab-agent.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { MAX_CLOCK_SKEW_MS, REPORT_WRITE_ATTEMPTS } from './coder-automation.js';
import {
  BODY_FIELDS,
  CONTAINER_COUNT_FIELDS,
  HOST_CHECKS_DOC_ID,
  HOST_CHECK_IDS,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_ERROR_LENGTH,
  MAX_VERSION_LENGTH,
  PORTAINER_OPTIONAL_FIELDS,
  PORTAINER_REPORT_FIELDS,
  mergeHostCheck,
  parseHostCheckBody,
  recordHostCheck,
} from './host-checks.js';

const AGENT_ID = 'vps-hostinger-01';
const NOW = new Date('2026-10-19T05:00:00.000Z');
const nowMs = NOW.getTime();
// A value no field may legitimately hold, planted in refused fields to prove
// a refusal never quotes what it was sent.
const PLANTED = 'FAKEVALUE-never-echoed';

const REPORT = Object.freeze({
  checkedAt: '2026-10-19T04:59:00Z',
  up: true,
  version: '2.45.2',
  edition: 'EE',
  licenseValid: true,
  licenseExpiresAt: '2027-09-26T00:00:00Z',
  environmentName: 'local',
  environmentUp: true,
  containers: Object.freeze({ total: 10, running: 8, unhealthy: 0, restarting: 0, exited: 2 }),
  imagesChecked: 8,
  imagesOutdated: 0,
  error: null,
});

const allowGuard = () => ({
  requireAgent: vi.fn(async (_request, agentId) => ({
    agent: { agentId, active: true, oid: 'oid-agent-1', capabilities: [] },
    identity: { oid: 'oid-agent-1' },
    error: null,
  })),
});
const denyGuard = () => ({
  requireAgent: vi.fn(async () => ({
    agent: null,
    identity: null,
    error: { status: 403, body: JSON.stringify({ ok: false, error: 'Agent access required' }) },
  })),
});

/**
 * An in-memory admin_config with real ETag semantics: a replace with a stale
 * `_etag` is a 412, a create over an existing id a 409. `upsertDoc` is the
 * audit row's verb, here only to prove it is never called.
 */
function makeStore(initial = {}) {
  const docs = new Map(Object.entries(initial));
  let etag = 0;
  const stamp = (doc) => ({ ...doc, _etag: `"e${++etag}"` });
  for (const [id, doc] of docs) docs.set(id, stamp(doc));
  return {
    docs,
    readDoc: vi.fn(async (container, id, pk) => {
      if (container === 'admin_config') expect(pk).toBe(ADMIN_CONFIG_PARTITION);
      return docs.has(id) ? structuredClone(docs.get(id)) : null;
    }),
    createDoc: vi.fn(async (_container, doc) => {
      if (docs.has(doc.id)) throw Object.assign(new Error('conflict'), { code: 409 });
      docs.set(doc.id, stamp(doc));
      return docs.get(doc.id);
    }),
    replaceDocIfMatch: vi.fn(async (_container, doc, options) => {
      expect(options).toEqual({ partitionKey: ADMIN_CONFIG_PARTITION });
      if (docs.get(doc.id)?._etag !== doc._etag) {
        throw Object.assign(new Error('precondition'), { code: 412 });
      }
      docs.set(doc.id, stamp(doc));
      return docs.get(doc.id);
    }),
    upsertDoc: vi.fn(async (_container, doc) => doc),
    queryDocs: vi.fn(async () => []),
    patchDoc: vi.fn(async () => ({})),
  };
}

function setup({ guard = allowGuard(), store = makeStore() } = {}) {
  const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handlers = createLabAgentHandlers({ guard, store, now: () => NOW });
  const send = async (body) => {
    const res = await handlers.reportHostCheck({ json: async () => body }, context);
    return { res, body: JSON.parse(res.body) };
  };
  return { guard, store, context, send };
}

const bodyWith = (over = {}) => ({ agentId: AGENT_ID, check: 'portainer', report: { ...REPORT }, ...over });
const reportWith = (over = {}) => bodyWith({ report: { ...REPORT, ...over } });
const stored = (store) => store.docs.get(HOST_CHECKS_DOC_ID);
const writes = (store) => store.readDoc.mock.calls.length + store.createDoc.mock.calls.length + store.replaceDocIfMatch.mock.calls.length;

describe('the guard comes first, as on every agent route', () => {
  it('a refused credential reaches nothing: no read, no write, no log', async () => {
    const t = setup({ guard: denyGuard() });
    const { res } = await t.send(bodyWith());
    expect(res.status).toBe(403);
    expect(writes(t.store)).toBe(0);
    expect(t.store.upsertDoc).not.toHaveBeenCalled();
    expect(t.context.error).not.toHaveBeenCalled();
  });

  it('binds the body’s agentId through requireAgent', async () => {
    const t = setup();
    await t.send(bodyWith());
    expect(t.guard.requireAgent).toHaveBeenCalledWith(expect.anything(), AGENT_ID);
  });
});

describe('the body is exactly the contract, or a 400 with a sentence that names no value', () => {
  it('records a well-formed portainer report whole, stamped with the site’s time of receipt', async () => {
    const t = setup();
    const { res, body } = await t.send(bodyWith());
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(t.store.createDoc).toHaveBeenCalledTimes(1);
    expect(stored(t.store)).toMatchObject({
      id: HOST_CHECKS_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: 'host_checks',
      checks: {
        portainer: {
          ...REPORT,
          // Dates are normalised to toISOString; receivedAt is the site's clock.
          checkedAt: '2026-10-19T04:59:00.000Z',
          licenseExpiresAt: '2027-09-26T00:00:00.000Z',
          // The agent the guard verified, never the body's raw value.
          agentId: AGENT_ID,
          receivedAt: NOW.toISOString(),
        },
      },
    });
    expect(Object.keys(stored(t.store).checks.portainer)).toEqual([...PORTAINER_REPORT_FIELDS, 'agentId', 'receivedAt']);
    expect(t.context.error).not.toHaveBeenCalled();
    expect(t.context.warn).not.toHaveBeenCalled();
  });

  it('accepts a report without version and edition (Portainer down gives neither), storing null for both', async () => {
    const t = setup();
    const { version: _v, edition: _e, ...noVersion } = REPORT;
    const { res } = await t.send(
      bodyWith({ report: { ...noVersion, up: false, environmentName: '', environmentUp: false, error: 'no answer on the loopback' } })
    );
    expect(res.status).toBe(200);
    expect(stored(t.store).checks.portainer).toMatchObject({ version: null, edition: null, up: false, error: 'no answer on the loopback' });
    expect(PORTAINER_OPTIONAL_FIELDS).toEqual(['version', 'edition']);
  });

  it('accepts null where the contract allows it, and a clock within the skew either way', async () => {
    const t = setup();
    for (const over of [
      { licenseValid: null, licenseExpiresAt: null, imagesChecked: null, imagesOutdated: null, version: null, edition: null },
      { checkedAt: new Date(nowMs + MAX_CLOCK_SKEW_MS - 1000).toISOString() },
      { checkedAt: new Date(nowMs - MAX_CLOCK_SKEW_MS + 1000).toISOString() },
      { error: '   ' },
    ]) {
      const { res } = await t.send(reportWith(over));
      expect(res.status, JSON.stringify(over)).toBe(200);
    }
    // Blank error text is no error.
    expect(stored(t.store).checks.portainer.error).toBeNull();
  });

  it.each([
    ['a key the body does not carry', bodyWith({ [PLANTED]: 1 }), /carries a field this route does not read/],
    ['a token where none belongs', bodyWith({ statusToken: PLANTED }), /carries a field this route does not read/],
    ['no check', { agentId: AGENT_ID, report: REPORT }, /check must name a host check/],
    ['a check this route does not record', bodyWith({ check: PLANTED }), /check must name a host check this route records: portainer/],
    ['no report', { agentId: AGENT_ID, check: 'portainer' }, /report is required/],
    ['a report that is not an object', bodyWith({ report: PLANTED }), /report must be a JSON object/],
    ['a key the report does not carry', reportWith({ [PLANTED]: 'x' }), /report carries a field this route does not read/],
    ['a required field missing', (() => { const { licenseValid: _l, ...rest } = REPORT; return bodyWith({ report: rest }); })(), /report\.licenseValid is required/],
    ['checkedAt that is not a date-time', reportWith({ checkedAt: PLANTED }), /report\.checkedAt must be an ISO 8601 date-time/],
    ['checkedAt without a zone', reportWith({ checkedAt: '2026-10-19T04:59:00' }), /report\.checkedAt must be an ISO 8601 date-time/],
    ['a host clock that is fast', reportWith({ checkedAt: new Date(nowMs + MAX_CLOCK_SKEW_MS + 1000).toISOString() }), /more than 10 minutes ahead of the site's clock/],
    ['a reading that is stale', reportWith({ checkedAt: new Date(nowMs - MAX_CLOCK_SKEW_MS - 1000).toISOString() }), /more than 10 minutes behind the site's clock/],
    ['up that is not a boolean', reportWith({ up: PLANTED }), /report\.up must be true or false/],
    ['a version too long', reportWith({ version: 'v'.repeat(MAX_VERSION_LENGTH + 1) }), /report\.version must be a version of 1 to 32 characters/],
    ['a blank version', reportWith({ version: ' ' }), /report\.version must be a version/],
    ['an edition Portainer does not have', reportWith({ edition: PLANTED }), /report\.edition must be EE or CE/],
    ['licenseValid that is not a boolean or null', reportWith({ licenseValid: PLANTED }), /report\.licenseValid must be true, false or null/],
    ['licenseExpiresAt that is not a date-time', reportWith({ licenseExpiresAt: PLANTED }), /report\.licenseExpiresAt must be an ISO 8601 date-time/],
    ['an environment name too long', reportWith({ environmentName: 'e'.repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1) }), /report\.environmentName must be a string of at most 64/],
    ['an environment name that is not a string', reportWith({ environmentName: null }), /report\.environmentName must be a string/],
    ['an environment name with a line break', reportWith({ environmentName: `local\n${PLANTED}` }), /report\.environmentName must be a string of at most 64 printable characters/],
    ['a version with a line break', reportWith({ version: `2.45.2\n${PLANTED}` }), /report\.version must be a version/],
    ['a version with a space', reportWith({ version: '2.45.2 EE' }), /report\.version must be a version/],
    ['an error with a line break', reportWith({ error: `boom\n${PLANTED}` }), /report\.error must be one line/],
    ['an error with a control character', reportWith({ error: 'boom\u0007' }), /report\.error must be one line/],
    ['more running than total', reportWith({ containers: { total: 8, running: 9, unhealthy: 0, restarting: 0, exited: 0 } }), /running cannot exceed report\.containers\.total/],
    ['more unhealthy, restarting and exited than total', reportWith({ containers: { total: 8, running: 8, unhealthy: 5, restarting: 3, exited: 1 } }), /together cannot exceed report\.containers\.total/],
    ['outdated images without a checked count', reportWith({ imagesChecked: null, imagesOutdated: 2 }), /imagesOutdated must be null when report\.imagesChecked is null/],
    ['more outdated images than checked', reportWith({ imagesChecked: 3, imagesOutdated: 4 }), /imagesOutdated cannot exceed report\.imagesChecked/],
    ['environmentUp that is not a boolean', reportWith({ environmentUp: 1 }), /report\.environmentUp must be true or false/],
    ['containers that are not an object', reportWith({ containers: PLANTED }), /report\.containers must be a JSON object/],
    ['a container count missing', reportWith({ containers: { total: 1, running: 1, unhealthy: 0, restarting: 0 } }), /report\.containers\.exited must be a whole number/],
    ['a field beside the counts', reportWith({ containers: { ...REPORT.containers, [PLANTED]: ['a-name'] } }), /report\.containers carries a field this route does not read/],
    ['a negative count', reportWith({ containers: { ...REPORT.containers, unhealthy: -1 } }), /report\.containers\.unhealthy must be a whole number of zero or more/],
    ['a fractional count', reportWith({ containers: { ...REPORT.containers, running: 1.5 } }), /report\.containers\.running must be a whole number/],
    ['imagesChecked that is not a count or null', reportWith({ imagesChecked: PLANTED }), /report\.imagesChecked must be a whole number of zero or more, or null/],
    ['imagesOutdated negative', reportWith({ imagesOutdated: -2 }), /report\.imagesOutdated must be a whole number/],
    ['an error too long', reportWith({ error: 'x'.repeat(MAX_ERROR_LENGTH + 1) }), /report.error must be one line of at most 300 printable characters, or null/],
    ['an error that is not a string or null', reportWith({ error: { text: PLANTED } }), /report\.error must be one line/],
  ])('refuses %s with 400, before any store call, naming no value', async (_what, body, sentence) => {
    const t = setup();
    const { res, body: answer } = await t.send(body);
    expect(res.status).toBe(400);
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(sentence);
    expect(answer.error).not.toMatch(/FAKEVALUE/);
    expect(answer.error).not.toMatch(/a-name/);
    expect(writes(t.store)).toBe(0);
    expect(t.store.upsertDoc).not.toHaveBeenCalled();
  });

  it('refuses a body that is not an object, and the contract’s constants read as the header says', () => {
    expect(parseHostCheckBody(null, nowMs).error).toBe('The body must be a JSON object');
    expect(parseHostCheckBody([bodyWith()], nowMs).error).toBe('The body must be a JSON object');
    expect([...BODY_FIELDS]).toEqual(['agentId', 'check', 'report']);
    expect([...HOST_CHECK_IDS]).toEqual(['portainer']);
    expect([...CONTAINER_COUNT_FIELDS]).toEqual(['total', 'running', 'unhealthy', 'restarting', 'exited']);
    // The report is a closed set: nothing in it can hold a container or image name.
    expect(PORTAINER_REPORT_FIELDS).not.toContain('names');
    expect(PORTAINER_REPORT_FIELDS).not.toContain('images');
  });
});

describe('the document: one, each check’s entry replaced whole under the document’s ETag', () => {
  it('a second report replaces the portainer entry whole, so an earlier error does not linger', async () => {
    const t = setup();
    await t.send(reportWith({ up: false, error: 'no answer on the loopback' }));
    await t.send(reportWith({ checkedAt: '2026-10-19T04:59:30Z' }));
    const entry = stored(t.store).checks.portainer;
    expect(entry.error).toBeNull();
    expect(entry.up).toBe(true);
    expect(entry.checkedAt).toBe('2026-10-19T04:59:30.000Z');
    expect(t.store.createDoc).toHaveBeenCalledTimes(1);
    expect(t.store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
  });

  it('builds the document from named fields only: a stray field or an unknown check is dropped', () => {
    const entry = { ...REPORT, receivedAt: NOW.toISOString() };
    const merged = mergeHostCheck(
      {
        id: HOST_CHECKS_DOC_ID,
        strayField: 'x',
        _etag: '"e"',
        checks: { portainer: { up: false }, bogus: { up: true } },
      },
      'portainer',
      entry
    );
    expect(merged).toEqual({
      id: HOST_CHECKS_DOC_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      docType: 'host_checks',
      checks: { portainer: entry },
    });
  });

  it('reads again and merges again when another writer got there first', async () => {
    const store = makeStore({ [HOST_CHECKS_DOC_ID]: { id: HOST_CHECKS_DOC_ID, checks: {} } });
    const replace = store.replaceDocIfMatch;
    let raced = false;
    store.replaceDocIfMatch = vi.fn(async (container, doc, options) => {
      if (!raced) {
        raced = true;
        const current = store.docs.get(HOST_CHECKS_DOC_ID);
        store.docs.set(HOST_CHECKS_DOC_ID, { ...current, _etag: '"other"' });
      }
      return replace(container, doc, options);
    });
    const doc = await recordHostCheck(store, { check: 'portainer', report: REPORT }, nowMs, { sleep: async () => {} });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(store.readDoc).toHaveBeenCalledTimes(2);
    expect(doc.checks.portainer.receivedAt).toBe(NOW.toISOString());
  });

  it('reads again when a first report races another first report', async () => {
    const store = makeStore();
    const create = store.createDoc;
    store.createDoc = vi.fn(async (container, doc) => {
      store.docs.set(doc.id, { id: doc.id, checks: {}, _etag: '"first"' });
      return create(container, doc);
    });
    const doc = await recordHostCheck(store, { check: 'portainer', report: REPORT }, nowMs, { sleep: async () => {} });
    expect(store.createDoc).toHaveBeenCalledTimes(1);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(1);
    expect(doc.checks.portainer.up).toBe(true);
  });

  it('gives up after the shared number of attempts, answering 500 with a content-free line in the log', async () => {
    const t = setup();
    t.store.createDoc = vi.fn(async () => {
      throw Object.assign(new Error('conflict'), { code: 409 });
    });
    const { res, body } = await t.send(bodyWith());
    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: 'The report could not be recorded' });
    expect(t.store.readDoc).toHaveBeenCalledTimes(REPORT_WRITE_ATTEMPTS);
    expect(t.context.error).toHaveBeenCalledWith('reportHostCheck: the report could not be recorded (CONFLICT)');
    for (const line of t.context.error.mock.calls.flat().map(String)) {
      expect(line).not.toMatch(/portainer|vps-hostinger|host_checks|2\.45\.2/);
    }
  }, 20_000);

  it('a store error that is not a race is the same 500, with its code', async () => {
    const t = setup();
    t.store.createDoc = vi.fn(async () => {
      throw Object.assign(new Error('Request rate is large'), { code: 429 });
    });
    const { res } = await t.send(bodyWith());
    expect(res.status).toBe(500);
    expect(t.store.readDoc).toHaveBeenCalledTimes(1);
    expect(t.context.error).toHaveBeenCalledWith('reportHostCheck: the report could not be recorded (429)');
  });

  it('writes no audit row and touches no other container, on success or refusal', async () => {
    const t = setup();
    await t.send(bodyWith());
    await t.send(reportWith({ up: PLANTED }));
    expect(t.store.upsertDoc).not.toHaveBeenCalled();
    expect(t.store.queryDocs).not.toHaveBeenCalled();
    expect(t.store.patchDoc).not.toHaveBeenCalled();
    for (const [container] of [...t.store.readDoc.mock.calls, ...t.store.createDoc.mock.calls]) {
      expect(container).toBe('admin_config');
    }
  });
});
