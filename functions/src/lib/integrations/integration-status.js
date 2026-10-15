/**
 * integration-status.js — the last outcome of each service's connection test,
 * persisted so the Integrations Hub can say "last worked 2 d ago, last failed
 * 10 min ago — Unauthorized" after a reload (ADR 0033 §1 Platform).
 *
 * Until this existed a test result lived only in the browser session that ran
 * it: leave the page and the hub forgot whether Publer had ever answered. The
 * key lights (admin-secrets.js) persist, but they judge one credential at a
 * time and only where a reporter exists; this records what the SERVICE test
 * said, whichever keys it exercised.
 *
 * One document, `admin_settings/integration-status`, with a record per service
 * id: `{ lastOkAt, lastFailAt, lastError, lastTestedBy }`. The browser PUTs
 * after each test it runs; the Integrations and Health pages GET it on load.
 * Editor role on both: the record names no credential and carries only the
 * upstream's own error sentence, which the test already showed the editor who
 * pressed the button.
 *
 * No new container: `admin_settings` already holds the integrations settings
 * document this sits beside.
 */

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const INTEGRATION_STATUS_CONTAINER = 'admin_settings';
export const INTEGRATION_STATUS_DOC_ID = 'integration-status';
export const INTEGRATION_STATUS_ROLE = 'editor';

/** Service ids are the registry's: lower-case words joined by hyphens. */
const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Long enough for any upstream sentence, short enough for a card. */
const MAX_ERROR_LENGTH = 300;

const strOrNull = (value) => (typeof value === 'string' && value ? value : null);

/**
 * One service's record, field by field — never a spread of the stored
 * object, so a field a future writer adds cannot reach the page unreviewed.
 */
export function presentServiceStatus(record = {}) {
  return {
    lastOkAt: strOrNull(record?.lastOkAt),
    lastFailAt: strOrNull(record?.lastFailAt),
    lastError: strOrNull(record?.lastError),
    lastTestedBy: strOrNull(record?.lastTestedBy),
  };
}

/**
 * Validate a PUT body. Returns `{ service, ok, error }` or `{ problem }`.
 */
export function parseStatusWrite(body) {
  const service = String(body?.service ?? '').trim();
  if (!SERVICE_ID.test(service)) {
    return {
      problem: 'service must be a lower-case id such as publer or cloud-pricing',
    };
  }
  if (typeof body?.ok !== 'boolean') return { problem: 'ok must be true or false' };
  const error = body.ok
    ? null
    : String(body?.error ?? '')
        .trim()
        .slice(0, MAX_ERROR_LENGTH) || null;
  return { service, ok: body.ok, error };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, upsertDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 */
export function createIntegrationStatusHandlers({ guard, store, now = () => new Date() }) {
  async function readServices() {
    const doc = await store.readDoc(
      INTEGRATION_STATUS_CONTAINER,
      INTEGRATION_STATUS_DOC_ID,
      INTEGRATION_STATUS_DOC_ID
    );
    return doc?.services && typeof doc.services === 'object' && !Array.isArray(doc.services)
      ? doc.services
      : {};
  }

  return {
    /** GET /api/cms/integration-status — every service's last outcome. */
    async getIntegrationStatus(request, context) {
      const auth = await guard.requireRole(request, INTEGRATION_STATUS_ROLE);
      if (auth.error) return auth.error;
      try {
        const services = await readServices();
        return json(200, {
          success: true,
          services: Object.fromEntries(
            Object.entries(services).map(([id, record]) => [id, presentServiceStatus(record)])
          ),
        });
      } catch (error) {
        context.error?.(`getIntegrationStatus failed: ${error?.message || error}`);
        return json(500, { error: 'Failed to read integration status' });
      }
    },

    /** PUT /api/cms/integration-status — body `{ service, ok, error? }`. */
    async putIntegrationStatus(request, context) {
      const auth = await guard.requireRole(request, INTEGRATION_STATUS_ROLE);
      if (auth.error) return auth.error;
      const body = await request.json().catch(() => null);
      const parsed = parseStatusWrite(body);
      if (parsed.problem) return json(400, { error: parsed.problem });
      try {
        const nowIso = now().toISOString();
        const actor = auth.user?.oid ?? auth.user?.sub ?? auth.user?.preferred_username ?? null;
        const newOutcome = parsed.ok
          ? { lastOkAt: nowIso, lastTestedBy: actor }
          : {
              lastFailAt: nowIso,
              // Overwritten on every failure, including with null when the
              // test gave no sentence: a stale reason beside a fresh time is
              // worse than no reason at all (the admin-secrets rule).
              lastError: parsed.error,
              lastTestedBy: actor,
            };

        const MAX_RETRIES = 5;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
          const doc = await store.readDoc(
            INTEGRATION_STATUS_CONTAINER,
            INTEGRATION_STATUS_DOC_ID,
            INTEGRATION_STATUS_DOC_ID
          );
          const services =
            doc?.services && typeof doc.services === 'object' && !Array.isArray(doc.services)
              ? { ...doc.services }
              : {};
          const previous = services[parsed.service] ?? {};
          services[parsed.service] = { ...previous, ...newOutcome };

          const nextDoc = {
            id: INTEGRATION_STATUS_DOC_ID,
            services,
            updatedAt: nowIso,
          };

          if (typeof store.replaceDocIfMatch === 'function' && doc?._etag) {
            try {
              await store.replaceDocIfMatch(
                INTEGRATION_STATUS_CONTAINER,
                { ...nextDoc, _etag: doc._etag },
                { partitionKey: INTEGRATION_STATUS_DOC_ID }
              );
              return json(200, {
                success: true,
                service: parsed.service,
                status: presentServiceStatus(services[parsed.service]),
              });
            } catch (err) {
              if (err?.code === 412 || /412|precondition/i.test(err?.message)) {
                lastError = err;
                continue;
              }
              throw err;
            }
          } else {
            await store.upsertDoc(INTEGRATION_STATUS_CONTAINER, nextDoc);
            return json(200, {
              success: true,
              service: parsed.service,
              status: presentServiceStatus(services[parsed.service]),
            });
          }
        }
        throw lastError || new Error('Concurrency conflict: maximum retries exceeded');
      } catch (error) {
        context.error?.(`putIntegrationStatus failed: ${error?.message || error}`);
        return json(500, { error: 'Failed to record integration status' });
      }
    },
  };
}
