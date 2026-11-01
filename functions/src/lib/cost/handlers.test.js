/**
 * The Cost page routes: who may call them, what they refuse, what they write,
 * the refresh throttle, and what never reaches an audit row.
 */
import { describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../../test/memory-store.js';

import { AUDIT_ACTIONS, COST_ROLE, MAX_BODY_BYTES, createCostHandlers } from './handlers.js';
import { LEDGER_DOC_ID } from './ledger-store.js';
import { SNAPSHOT_DOC_ID } from './snapshot.js';

const NOW = new Date('2026-11-10T12:00:00Z');
const SECRET_NAME = 'PRIVATE-SERVICE-3c1';
const SECRET_NOTE = 'PRIVATE-NOTE-8e2';
const user = { oid: 'owner', name: 'Owner' };
const allow = { requireRole: vi.fn(async () => ({ user, role: 'editor', error: null })) };
const deny = { requireRole: vi.fn(async () => ({ user: null, role: null, error: { status: 403, body: '{}' } })) };

let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const context = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };

function request({ body, params = {}, query = {}, headers = {} } = {}) {
  return {
    params,
    query: { get: (key) => query[key] ?? null },
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  };
}

const parse = (response) => JSON.parse(response.body);

function setup({ guard = allow, initial = {}, refresh } = {}) {
  const store = memoryStore(initial);
  const refreshFn =
    refresh ??
    vi.fn(async ({ store: s }) => {
      const doc = { id: SNAPSHOT_DOC_ID, configScope: 'admin_config', readAt: NOW.toISOString(), lastRefreshAt: NOW.toISOString(), azure: { available: false, reason: 'not set', scopes: [] }, ai: null, sources: [] };
      await s.upsertDoc('admin_config', doc);
      return doc;
    });
  const handlers = createCostHandlers({ guard, store, now: () => NOW, uuid, refresh: refreshFn, env: {} });
  return { store, handlers, refresh: refreshFn };
}

describe('every route', () => {
  it('asks for the editor role and reads nothing when refused', async () => {
    const { store, handlers } = setup({ guard: deny });
    for (const name of ['summary', 'listServices', 'createService', 'updateService', 'removeService', 'getSettings', 'putSettings']) {
      const response = await handlers[name](request({ body: { name: 'x' }, params: { itemId: 'a1' } }), context);
      expect(response.status, name).toBe(403);
    }
    expect(deny.requireRole).toHaveBeenCalledWith(expect.anything(), COST_ROLE);
    expect(store.readDoc).not.toHaveBeenCalled();
  });
});

describe('the subscriptions ledger', () => {
  it('adds, lists, edits and removes a row, auditing ids and field names only', async () => {
    const { store, handlers } = setup();
    const created = await handlers.createService(
      request({ body: { name: SECRET_NAME, amount: 20, cycle: 'monthly', nextRenewal: '2026-11-15', note: SECRET_NOTE, category: 'infrastructure' } }),
      context
    );
    expect(created.status).toBe(201);
    expect(created.headers['Cache-Control']).toBe('private, no-store');
    const { item } = parse(created);
    expect(item).toMatchObject({ name: SECRET_NAME, monthlyEquivalent: 20, daysUntilRenewal: 5 });

    const listed = parse(await handlers.listServices(request(), context));
    expect(listed).toMatchObject({ ok: true, today: '2026-11-10', total: 1 });
    expect(listed.items[0].id).toBe(item.id);
    expect(Array.isArray(listed.suggestions)).toBe(true);

    const updated = await handlers.updateService(request({ body: { amount: 240, cycle: 'annual' }, params: { itemId: item.id } }), context);
    expect(updated.status).toBe(200);
    expect(parse(updated).item).toMatchObject({ amount: 240, cycle: 'annual', monthlyEquivalent: 20, name: SECRET_NAME });

    const removed = await handlers.removeService(request({ params: { itemId: item.id } }), context);
    expect(parse(removed)).toEqual({ ok: true, id: item.id });
    expect(store.get('admin_config', LEDGER_DOC_ID).items).toEqual([]);

    expect(store.audit.map((row) => row.action)).toEqual([AUDIT_ACTIONS.created, AUDIT_ACTIONS.updated, AUDIT_ACTIONS.deleted]);
    expect(store.audit[1].details).toEqual({ itemId: item.id, fields: ['amount', 'cycle'] });
    const audits = JSON.stringify(store.audit);
    expect(audits).not.toContain(SECRET_NAME);
    expect(audits).not.toContain(SECRET_NOTE);
  });

  it('answers a bad body with the field, an unknown id with 404, and a full ledger with 400', async () => {
    const { handlers } = setup({
      initial: {
        [`admin_config/${LEDGER_DOC_ID}`]: {
          id: LEDGER_DOC_ID,
          items: Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, name: `Row ${i}` })),
        },
      },
    });
    const bad = await handlers.createService(request({ body: { name: 'x', cycle: 'weekly' } }), context);
    expect(bad.status).toBe(400);
    expect(parse(bad).error).toContain('cycle must be one of');

    const full = await handlers.createService(request({ body: { name: 'x' } }), context);
    expect(full.status).toBe(400);
    expect(parse(full).error).toContain('holds 200 subscriptions');

    for (const itemId of ['nope', 'bad id!']) {
      expect((await handlers.updateService(request({ body: { amount: 1 }, params: { itemId } }), context)).status).toBe(404);
      expect((await handlers.removeService(request({ params: { itemId } }), context)).status).toBe(404);
    }
    expect((await handlers.updateService(request({ body: {}, params: { itemId: 'r1' } }), context)).status).toBe(400);
    expect((await handlers.createService(request({ body: ['x'] }), context)).status).toBe(400);
    expect((await handlers.createService(request(), context)).status).toBe(400);
  });

  it('refuses an oversized body before reading it', async () => {
    const { handlers } = setup();
    const declared = await handlers.createService(
      request({ body: { name: 'x' }, headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
      context
    );
    expect(declared.status).toBe(413);
    const long = await handlers.createService(request({ body: { name: 'x', note: 'y'.repeat(13_000) } }), context);
    expect(long.status).toBe(413);
  });

  it('says 409 when every write loses the race, and 500 with a fixed sentence when the store fails', async () => {
    const { store, handlers } = setup({ initial: { [`admin_config/${LEDGER_DOC_ID}`]: { id: LEDGER_DOC_ID, items: [] } } });
    store.fail('admin_config', LEDGER_DOC_ID, 'replaceDocIfMatch', Object.assign(new Error('p'), { code: 412 }), 5);
    const conflict = await handlers.createService(request({ body: { name: 'x' } }), context);
    expect(conflict.status).toBe(409);
    expect(parse(conflict).code).toBe('CONFLICT');

    store.fail('admin_config', LEDGER_DOC_ID, 'readDoc', Object.assign(new Error('secret-host down'), { code: 503 }));
    const broken = await handlers.listServices(request(), context);
    expect(broken.status).toBe(500);
    expect(broken.body).toContain('Failed to read the subscriptions');
    expect(broken.body).not.toContain('secret-host');
  });
});

describe('the settings', () => {
  it('reads the defaults, saves a whole object, and refuses a bad one', async () => {
    const { store, handlers } = setup();
    expect(parse(await handlers.getSettings(request(), context)).settings.refreshHours).toBe(6);
    const saved = await handlers.putSettings(
      request({ body: { aiMonthlyBudgetUsd: 20, renewalLeadDays: 10, telegram: false, monthlyDigest: true, refreshHours: 3 } }),
      context
    );
    expect(parse(saved).settings).toMatchObject({ aiMonthlyBudgetUsd: 20, renewalLeadDays: 10, telegram: false });
    expect(store.audit.at(-1)).toMatchObject({ action: AUDIT_ACTIONS.settings });
    const bad = await handlers.putSettings(request({ body: { refreshHours: 99 } }), context);
    expect(bad.status).toBe(400);
    expect(parse(bad).error).toContain('refreshHours');
    store.fail('admin_config', LEDGER_DOC_ID, 'readDoc', new Error('down'));
    expect((await handlers.getSettings(request(), context)).status).toBe(500);
  });
});

describe('the summary', () => {
  it('answers from the stored snapshot without reading Azure', async () => {
    const { handlers, refresh } = setup();
    const body = parse(await handlers.summary(request(), context));
    expect(body).toMatchObject({ ok: true, readAt: null, currency: 'USD' });
    expect(body).not.toHaveProperty('refreshed');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes on ?refresh=1, then throttles a second refresh for five minutes', async () => {
    const { store, handlers, refresh } = setup();
    const first = parse(await handlers.summary(request({ query: { refresh: '1' } }), context));
    expect(first).toMatchObject({ refreshed: true, nextRefreshAt: null, readAt: NOW.toISOString() });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.audit.at(-1)).toMatchObject({ action: AUDIT_ACTIONS.refreshed, details: { by: 'page' } });

    const second = parse(await handlers.summary(request({ query: { refresh: 'true' } }), context));
    expect(second.refreshed).toBe(false);
    expect(second.nextRefreshAt).toBe('2026-11-10T12:05:00.000Z');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('fails with a fixed sentence when the refresh throws', async () => {
    const { handlers } = setup({ refresh: vi.fn(async () => { throw new Error('boom secret'); }) });
    const response = await handlers.summary(request({ query: { refresh: '1' } }), context);
    expect(response.status).toBe(500);
    expect(response.body).toContain('Failed to read the cost summary');
    expect(response.body).not.toContain('boom secret');
  });
});
