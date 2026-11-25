/**
 * cost/handlers.js — the routes behind the admin portal's Cost page (ADR 0039).
 *
 *   GET    cms/cost/summary[?refresh=1]     the whole page in one read        editor
 *   GET    cms/cost/services                the subscriptions ledger          editor
 *   POST   cms/cost/services                add a subscription                editor
 *   PATCH  cms/cost/services/{itemId}       edit one                          editor
 *   DELETE cms/cost/services/{itemId}       remove one                        editor
 *   GET    cms/cost/settings                the page's settings               editor
 *   PUT    cms/cost/settings                replace them                      editor
 *
 * Editor and above, like Platform Settings and the calendar alerts these sit
 * beside: what the platform costs is the owner's business, so the viewer role
 * (which may see the Health page) does not see it. Koda's key reaches the
 * three GETs under its Platform switch (agent-content/admin-access.js) and
 * none of the writes.
 *
 * NOTHING PRIVATE IN A LOG OR AN AUDIT ROW. A subscription's name, vendor,
 * amount and note are the owner's own and are never logged: a failure is
 * logged by its code (http/error-response.js), and an audit row carries the
 * row's id and the NAMES of the fields a change touched. No subscription id
 * (the Azure GUID) ever leaves the server: the summary carries the
 * configured scope label and display name only (cost/azure.js). The answers
 * are `Cache-Control: private, no-store`.
 *
 * Every refusal is a sentence this code wrote (AuthoredError, #945); a
 * failure of the store is a fixed sentence plus a correlation id.
 */
import { randomUUID } from 'node:crypto';

import { recordMutationAudit } from '../audit.js';
import { authoredMessage, errorResponse, isAuthoredError, logFailure } from '../http/error-response.js';
import { changeLedger, normalizeSettings, readLedger } from './ledger-store.js';
import {
  CostLedgerFullError,
  CostServiceNotFoundError,
  CostServiceValidationError,
  MAX_ITEMS,
  compareItems,
  isItemId,
  isStoredItem,
  newItem,
  normalizeFields,
  patchFields,
  presentItem,
  suggestionsFor,
} from './services.js';
import { buildSummary, readSnapshot, refreshAllowed, refreshSnapshot } from './snapshot.js';
import { dateOnly } from './model.js';

export const COST_ROLE = 'editor';

export const AUDIT_ACTIONS = Object.freeze({
  created: 'cost_service_created',
  updated: 'cost_service_updated',
  deleted: 'cost_service_deleted',
  settings: 'cost_settings_updated',
  refreshed: 'cost_snapshot_refreshed',
});

/** A body past this is refused before it is parsed; the largest valid row is about 4 000 characters. */
export const MAX_BODY_JSON = 12_000;
export const MAX_BODY_BYTES = 48_000;

class CostBodyTooLargeError extends CostServiceValidationError {
  constructor() {
    super('The request is too large.');
    this.status = 413;
    this.code = 'TOO_LARGE';
  }
}

const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

/** A refusal this code wrote (below 500) is answered with its sentence; anything else is a logged 500. */
function failed(context, request, sentence, error) {
  if (isAuthoredError(error) && Number.isInteger(error.status) && error.status < 500) {
    return privateJson(error.status, {
      ok: false,
      error: authoredMessage(error, sentence),
      ...(error.status === 409 ? { code: 'CONFLICT' } : {}),
    });
  }
  return errorResponse(context, sentence, error, 500, request);
}

async function readBody(request) {
  const declared = Number(request.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new CostBodyTooLargeError();
  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CostServiceValidationError('The body must be a JSON object');
  }
  if (JSON.stringify(body).length > MAX_BODY_JSON) throw new CostBodyTooLargeError();
  return body;
}

async function audit(deps, action, user, details, context) {
  await recordMutationAudit(deps.store, {
    action,
    actor: user,
    resource: `admin_config:cost_ledger${details.itemId ? `:${details.itemId}` : ''}`,
    details,
    now: deps.now,
    uuid: deps.uuid,
    context,
  });
}

/** The row id from the route, or the not-found refusal thrown. */
function itemIdOf(request) {
  const id = request.params?.itemId;
  if (!isItemId(id)) throw new CostServiceNotFoundError();
  return id;
}

const wantsRefresh = (request) => {
  const value = request.query?.get?.('refresh') ?? request.query?.refresh;
  return value === '1' || value === 'true';
};

/**
 * One route: the role check first, then `work`, and any failure answered by
 * `failed` with the route's own sentence.
 */
function costRoute(deps, sentence, work) {
  return async (request, context) => {
    const auth = await deps.guard.requireRole(request, COST_ROLE);
    if (auth.error) return auth.error;
    try {
      return await work(deps, { request, context, user: auth.user });
    } catch (error) {
      return failed(context, request, sentence, error);
    }
  };
}

/** GET cms/cost/summary */
async function summary(deps, { request, context, user }) {
  const at = deps.now();
  const ledger = await readLedger(deps.store);
  let snapshot = await readSnapshot(deps.store);
  let refreshState = {};
  if (wantsRefresh(request)) {
    const allowed = refreshAllowed(snapshot, at);
    if (allowed.allowed) {
      const { store, now, env, fetchImpl } = deps;
      snapshot = await deps.refresh({ store, ledger, now, env, fetchImpl });
      refreshState = { refreshed: true, nextRefreshAt: null };
      await audit(deps, AUDIT_ACTIONS.refreshed, user, { by: 'page' }, context);
    } else {
      refreshState = { refreshed: false, nextRefreshAt: allowed.nextRefreshAt };
    }
  }
  return privateJson(200, { ok: true, ...refreshState, ...buildSummary({ snapshot, ledger, now: at }) });
}

/** GET cms/cost/services */
async function listServices(deps) {
  const today = dateOnly(deps.now());
  const ledger = await readLedger(deps.store);
  const items = ledger.items
    .filter(isStoredItem)
    .map((row) => presentItem(row, today))
    .sort(compareItems);
  return privateJson(200, { ok: true, today, items, total: items.length, suggestions: suggestionsFor(items) });
}

/** POST cms/cost/services */
async function createService(deps, { request, context, user }) {
  const fields = normalizeFields(await readBody(request));
  const at = deps.now().toISOString();
  const row = newItem(fields, { id: deps.uuid(), at });
  await changeLedger(
    deps.store,
    (state) => {
      if (state.items.length >= MAX_ITEMS) throw new CostLedgerFullError();
      return { write: true, state: { ...state, items: [...state.items, row] } };
    },
    { now: deps.now }
  );
  await audit(deps, AUDIT_ACTIONS.created, user, { itemId: row.id, category: row.category, cycle: row.cycle }, context);
  return privateJson(201, { ok: true, item: presentItem(row, dateOnly(deps.now())) });
}

/** PATCH cms/cost/services/{itemId} */
async function updateService(deps, { request, context, user }) {
  const id = itemIdOf(request);
  const body = await readBody(request);
  const changed = patchFields(body);
  const at = deps.now().toISOString();
  const { result } = await changeLedger(
    deps.store,
    (state) => {
      const row = state.items.find((entry) => entry?.id === id);
      if (!row || !isStoredItem(row)) throw new CostServiceNotFoundError();
      const next = { ...row, ...normalizeFields(body, row), updatedAt: at };
      return {
        write: true,
        state: { ...state, items: state.items.map((entry) => (entry?.id === id ? next : entry)) },
        result: next,
      };
    },
    { now: deps.now }
  );
  await audit(deps, AUDIT_ACTIONS.updated, user, { itemId: id, fields: changed }, context);
  return privateJson(200, { ok: true, item: presentItem(result, dateOnly(deps.now())) });
}

/** DELETE cms/cost/services/{itemId} */
async function removeService(deps, { request, context, user }) {
  const id = itemIdOf(request);
  await changeLedger(
    deps.store,
    (state) => {
      if (!state.items.some((entry) => entry?.id === id)) throw new CostServiceNotFoundError();
      return { write: true, state: { ...state, items: state.items.filter((entry) => entry?.id !== id) } };
    },
    { now: deps.now }
  );
  await audit(deps, AUDIT_ACTIONS.deleted, user, { itemId: id }, context);
  return privateJson(200, { ok: true, id });
}

/** GET cms/cost/settings */
async function getSettings(deps) {
  const ledger = await readLedger(deps.store);
  return privateJson(200, { ok: true, settings: ledger.settings });
}

/** PUT cms/cost/settings */
async function putSettings(deps, { request, context, user }) {
  const settings = normalizeSettings(await readBody(request), { strict: true });
  await changeLedger(deps.store, (state) => ({ write: true, state: { ...state, settings } }), { now: deps.now });
  await audit(
    deps,
    AUDIT_ACTIONS.settings,
    user,
    { telegram: settings.telegram, monthlyDigest: settings.monthlyDigest, refreshHours: settings.refreshHours },
    context
  );
  return privateJson(200, { ok: true, settings });
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {object} deps.store readDoc, createDoc, replaceDocIfMatch, upsertDoc (audit), queryDocs (the AI ledger)
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {Function} [deps.refresh] test seam for refreshSnapshot
 * @param {Record<string, string|undefined>} [deps.env]
 * @param {Function} [deps.fetchImpl]
 */
export function createCostHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  refresh = refreshSnapshot,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const deps = { guard, store, now, uuid, refresh, env, fetchImpl };
  return {
    summary: costRoute(deps, 'Failed to read the cost summary', summary),
    listServices: costRoute(deps, 'Failed to read the subscriptions', listServices),
    createService: costRoute(deps, 'Failed to save the subscription', createService),
    updateService: costRoute(deps, 'Failed to update the subscription', updateService),
    removeService: costRoute(deps, 'Failed to delete the subscription', removeService),
    getSettings: costRoute(deps, 'Failed to read the cost settings', getSettings),
    putSettings: costRoute(deps, 'Failed to save the cost settings', putSettings),
  };
}

/** A failed read, logged content-free; exported for the watch's log lines. */
export { logFailure };
