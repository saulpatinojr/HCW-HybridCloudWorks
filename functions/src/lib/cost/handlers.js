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

  async function audit(action, user, details, context) {
    await recordMutationAudit(store, {
      action,
      actor: user,
      resource: `admin_config:cost_ledger${details.itemId ? `:${details.itemId}` : ''}`,
      details,
      now,
      uuid,
      context,
    });
  }

  function itemIdOf(request) {
    const id = request.params?.itemId;
    return isItemId(id) ? { id } : { error: new CostServiceNotFoundError() };
  }

  const wantsRefresh = (request) => {
    const value = request.query?.get?.('refresh') ?? request.query?.refresh;
    return value === '1' || value === 'true';
  };

  return {
    /** GET cms/cost/summary */
    async summary(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const at = now();
        const ledger = await readLedger(store);
        let snapshot = await readSnapshot(store);
        let refreshed;
        let nextRefreshAt = null;
        if (wantsRefresh(request)) {
          const allowed = refreshAllowed(snapshot, at);
          if (allowed.allowed) {
            snapshot = await refresh({ store, ledger, now, env, fetchImpl });
            refreshed = true;
            await audit(AUDIT_ACTIONS.refreshed, auth.user, { by: 'page' }, context);
          } else {
            refreshed = false;
            nextRefreshAt = allowed.nextRefreshAt;
          }
        }
        const summary = buildSummary({ snapshot, ledger, now: at });
        return privateJson(200, {
          ok: true,
          ...(refreshed === undefined ? {} : { refreshed, nextRefreshAt }),
          ...summary,
        });
      } catch (error) {
        return failed(context, request, 'Failed to read the cost summary', error);
      }
    },

    /** GET cms/cost/services */
    async listServices(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const today = dateOnly(now());
        const ledger = await readLedger(store);
        const items = ledger.items
          .filter(isStoredItem)
          .map((row) => presentItem(row, today))
          .sort(compareItems);
        return privateJson(200, { ok: true, today, items, total: items.length, suggestions: suggestionsFor(items) });
      } catch (error) {
        return failed(context, request, 'Failed to read the subscriptions', error);
      }
    },

    /** POST cms/cost/services */
    async createService(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const fields = normalizeFields(await readBody(request));
        const at = now().toISOString();
        const row = newItem(fields, { id: uuid(), at });
        await changeLedger(
          store,
          (state) => {
            if (state.items.length >= MAX_ITEMS) throw new CostLedgerFullError();
            return { write: true, state: { ...state, items: [...state.items, row] } };
          },
          { now }
        );
        await audit(AUDIT_ACTIONS.created, auth.user, { itemId: row.id, category: row.category, cycle: row.cycle }, context);
        return privateJson(201, { ok: true, item: presentItem(row, dateOnly(now())) });
      } catch (error) {
        return failed(context, request, 'Failed to save the subscription', error);
      }
    },

    /** PATCH cms/cost/services/{itemId} */
    async updateService(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const target = itemIdOf(request);
        if (target.error) throw target.error;
        const body = await readBody(request);
        const changed = patchFields(body);
        const at = now().toISOString();
        const { result } = await changeLedger(
          store,
          (state) => {
            const row = state.items.find((entry) => entry?.id === target.id);
            if (!row || !isStoredItem(row)) throw new CostServiceNotFoundError();
            const next = { ...row, ...normalizeFields(body, row), updatedAt: at };
            return {
              write: true,
              state: { ...state, items: state.items.map((entry) => (entry?.id === target.id ? next : entry)) },
              result: next,
            };
          },
          { now }
        );
        await audit(AUDIT_ACTIONS.updated, auth.user, { itemId: target.id, fields: changed }, context);
        return privateJson(200, { ok: true, item: presentItem(result, dateOnly(now())) });
      } catch (error) {
        return failed(context, request, 'Failed to update the subscription', error);
      }
    },

    /** DELETE cms/cost/services/{itemId} */
    async removeService(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const target = itemIdOf(request);
        if (target.error) throw target.error;
        await changeLedger(
          store,
          (state) => {
            if (!state.items.some((entry) => entry?.id === target.id)) throw new CostServiceNotFoundError();
            return { write: true, state: { ...state, items: state.items.filter((entry) => entry?.id !== target.id) } };
          },
          { now }
        );
        await audit(AUDIT_ACTIONS.deleted, auth.user, { itemId: target.id }, context);
        return privateJson(200, { ok: true, id: target.id });
      } catch (error) {
        return failed(context, request, 'Failed to delete the subscription', error);
      }
    },

    /** GET cms/cost/settings */
    async getSettings(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const ledger = await readLedger(store);
        return privateJson(200, { ok: true, settings: ledger.settings });
      } catch (error) {
        return failed(context, request, 'Failed to read the cost settings', error);
      }
    },

    /** PUT cms/cost/settings */
    async putSettings(request, context) {
      const auth = await guard.requireRole(request, COST_ROLE);
      if (auth.error) return auth.error;
      try {
        const settings = normalizeSettings(await readBody(request), { strict: true });
        await changeLedger(store, (state) => ({ write: true, state: { ...state, settings } }), { now });
        await audit(
          AUDIT_ACTIONS.settings,
          auth.user,
          { telegram: settings.telegram, monthlyDigest: settings.monthlyDigest, refreshHours: settings.refreshHours },
          context
        );
        return privateJson(200, { ok: true, settings });
      } catch (error) {
        return failed(context, request, 'Failed to save the cost settings', error);
      }
    },
  };
}

/** A failed read, logged content-free; exported for the watch's log lines. */
export { logFailure };
