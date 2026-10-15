/**
 * probe-results.js — the Health Hub's memory: the last result of every probe,
 * kept server-side so a status survives a reload, a sign-out, an expired
 * session and a restart (#1011).
 *
 * Until this existed the only stored results were the live probes', in the
 * browser tab's sessionStorage: sign out, open a new tab, or let the session
 * lapse, and every card went back to "Not tested yet" although the platform
 * had been checked minutes before. The Integrations Hub had already solved
 * half of this for its own tests (lib/integrations/integration-status.js);
 * this is the same idea for every probe, plus the health pulse's writes.
 *
 * ONE DOCUMENT PER PROBE in `admin_config` (`docType: health_probe_result`,
 * id `health_probe_result:<probeId>`, the constant partition every
 * admin_config document carries). Not one document with a map: Test all runs
 * about twenty probes at once and records each as it lands, and the pulse
 * records a dozen every five minutes, so writers to one map would spend their
 * time retrying each other. As documents, a write contends only with another
 * write of the same probe — the Forge Studio Queue's reasoning
 * (lib/content/forge-studio/queue.js), for the same reason.
 *
 * Every write is read, decide, write-if-unchanged: `replaceDocIfMatch` under
 * the `_etag` it read, or `createDoc` for a probe's first result, retried on
 * the 412 or 409 a concurrent writer causes. The read is what makes a
 * transition: `statusSince` moves only when the status changes, and
 * `previousStatus` says what it changed from, so the page can say "critical
 * since 10:40". A write older than the stored result (a slow browser PUT
 * landing after a newer pulse) is dropped, so the newest evidence wins
 * whatever order the writes arrive in.
 *
 * The pulse's heartbeat is one more document, `health_pulse`, written by the
 * pulse alone after each run.
 *
 * Who may do what:
 *   GET  cms/health/probe-results  viewer — the Health page's read
 *   PUT  cms/health/probe-results  the probe's own `writeRole`
 *        (probe-catalogue.js): whoever could run the probe may record it
 *
 * What is never kept or shown: a credential or a token. A summary is the
 * sentence the probe already showed the person who ran it, capped; the
 * actor is stored as `recordedBy` for audit and presented only as "an admin"
 * (`checkedBy: 'admin'`), because the Health page shows no person's identity.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { AuthoredError, authoredMessage } from '../http/error-response.js';
import { actorName } from '../auth/actor-name.js';
import { satisfiesRole } from '../auth/roles.js';
import { healthProbe } from './probe-catalogue.js';
import { PULSE_INTERVAL_MS, PULSE_LATE_AFTER_MS, normalizeStatus } from './status-model.js';

export const PROBE_RESULTS_CONTAINER = 'admin_config';
export const PROBE_RESULT_DOC_TYPE = 'health_probe_result';
export const PROBE_RESULT_ID_PREFIX = 'health_probe_result:';
export const PULSE_DOC_ID = 'health_pulse';
export const PULSE_DOC_TYPE = 'health_pulse';
export const PROBE_RESULTS_READ_ROLE = 'viewer';

/** Per-probe ETag retries: the pulse and a Test button can write one probe together. */
export const WRITE_ATTEMPTS = 6;
export const MAX_SUMMARY_LENGTH = 500;
export const MAX_DETAIL_LENGTH = 2000;
/** The slowest probe is the Labs round trip, well under this. */
export const MAX_DURATION_MS = 10 * 60 * 1000;
/** Bounded: the catalogue is about forty probes. */
export const MAX_RESULTS = 200;

const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const resultDocId = (probeId) => `${PROBE_RESULT_ID_PREFIX}${probeId}`;

const text = (value, max) => {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : '';
};
const isoOrNull = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

/**
 * One stored result as the page reads it, field by field — never a spread of
 * the document, so a field a future writer adds cannot reach the page
 * unreviewed, and `recordedBy` never does.
 */
export function presentResult(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return {
    probeId: String(doc.probeId ?? ''),
    kind: typeof doc.kind === 'string' ? doc.kind : null,
    status: normalizeStatus(doc.status) ?? 'unknown',
    summary: typeof doc.summary === 'string' ? doc.summary : '',
    detail: typeof doc.detail === 'string' && doc.detail ? doc.detail : null,
    checkedAt: isoOrNull(doc.checkedAt),
    checkedBy: doc.checkedBy === 'pulse' ? 'pulse' : 'admin',
    durationMs: finiteOrNull(doc.durationMs),
    statusSince: isoOrNull(doc.statusSince),
    previousStatus: normalizeStatus(doc.previousStatus),
  };
}

/** The pulse's heartbeat as the page reads it, or null when it has never beaten. */
export function presentPulse(doc) {
  const lastBeatAt = isoOrNull(doc?.lastBeatAt);
  if (!lastBeatAt) return null;
  return {
    lastBeatAt,
    intervalMs: finiteOrNull(doc.intervalMs) ?? PULSE_INTERVAL_MS,
    lateAfterMs: finiteOrNull(doc.lateAfterMs) ?? PULSE_LATE_AFTER_MS,
    durationMs: finiteOrNull(doc.durationMs),
    checks: finiteOrNull(doc.checks),
    recorded: finiteOrNull(doc.recorded),
    failures: Array.isArray(doc.failures)
      ? doc.failures.slice(0, 20).map((row) => ({
          probeId: String(row?.probeId ?? ''),
          error: text(row?.error, 300),
        }))
      : [],
  };
}

/**
 * Validate a PUT body. Returns the entry to record (without its time and
 * actor, which the server supplies) or `{ problem }`.
 */
export function parseResultWrite(body) {
  const probeId = String(body?.probeId ?? '').trim();
  const entry = healthProbe(probeId);
  if (!entry) return { problem: 'probeId must name a probe in the Health Hub registry' };
  const status = normalizeStatus(body?.status);
  if (!status) {
    return { problem: 'status must be one of healthy, degraded, critical, offline or unknown' };
  }
  const summary = text(body?.summary, MAX_SUMMARY_LENGTH);
  if (!summary) return { problem: 'summary is required: the sentence the probe showed' };
  let durationMs = null;
  if (body?.durationMs !== undefined && body?.durationMs !== null) {
    const value = Number(body.durationMs);
    if (!Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) {
      return { problem: `durationMs must be a number of milliseconds up to ${MAX_DURATION_MS}` };
    }
    durationMs = Math.round(value);
  }
  return {
    probeId,
    kind: entry.kind,
    writeRole: entry.writeRole,
    status,
    summary,
    detail: text(body?.detail, MAX_DETAIL_LENGTH) || null,
    durationMs,
  };
}

/** True when `stored` is a strictly later time than `incoming`. */
const isNewer = (stored, incoming) => Date.parse(stored ?? '') > Date.parse(incoming ?? '');

/** The document a result becomes, given the one it replaces (or none). */
export function nextResultDoc(current, entry) {
  const changed = !current || normalizeStatus(current.status) !== entry.status;
  return {
    id: resultDocId(entry.probeId),
    configScope: ADMIN_CONFIG_PARTITION,
    docType: PROBE_RESULT_DOC_TYPE,
    probeId: entry.probeId,
    kind: entry.kind,
    status: entry.status,
    summary: entry.summary,
    detail: entry.detail ?? null,
    checkedAt: entry.checkedAt,
    checkedBy: entry.checkedBy,
    recordedBy: entry.recordedBy ?? entry.checkedBy,
    durationMs: entry.durationMs ?? null,
    statusSince: changed ? entry.checkedAt : (current.statusSince ?? current.checkedAt),
    previousStatus: changed
      ? (normalizeStatus(current?.status) ?? null)
      : (current.previousStatus ?? null),
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Record one result: read → decide → write-if-unchanged, retried while
 * another writer of the same probe gets there first.
 *
 * Resolves `{ doc, written }`: `written: false` when the stored result is
 * newer than this one, which is then left as it is. Rejects with
 * `code: 'CONFLICT'` when every attempt lost a race.
 *
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function }} store
 * @param {object} entry parseResultWrite's entry plus `checkedAt`, `checkedBy`, `recordedBy`
 */
export async function recordProbeResult(
  store,
  entry,
  { attempts = WRITE_ATTEMPTS, sleep = defaultSleep } = {}
) {
  const id = resultDocId(entry.probeId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(20 * 2 ** Math.min(attempt, 5) + Math.random() * 20);
    const current = await store.readDoc(PROBE_RESULTS_CONTAINER, id, ADMIN_CONFIG_PARTITION);
    if (current && isNewer(current.checkedAt, entry.checkedAt)) {
      return { doc: current, written: false };
    }
    const next = nextResultDoc(current, entry);
    try {
      const doc = current
        ? await store.replaceDocIfMatch(PROBE_RESULTS_CONTAINER, { ...next, _etag: current._etag }, PK)
        : await store.createDoc(PROBE_RESULTS_CONTAINER, next);
      return { doc: doc ?? next, written: true };
    } catch (error) {
      // 412: someone replaced it since our read. 409: someone created it
      // since our read found nothing. Either way, read again and decide again.
      if (error?.code !== 412 && error?.code !== 409) throw error;
    }
  }
  throw new AuthoredError(
    `The ${entry.probeId} result kept changing while it was written; nothing was saved.`,
    { code: 'CONFLICT' }
  );
}

/** Every stored result by probe id, and the pulse's heartbeat. */
export async function readProbeResults(store) {
  const [rows, pulseDoc] = await Promise.all([
    store.queryDocs(
      PROBE_RESULTS_CONTAINER,
      `SELECT TOP ${MAX_RESULTS} * FROM c WHERE c.configScope = @scope AND c.docType = @type`,
      [
        { name: '@scope', value: ADMIN_CONFIG_PARTITION },
        { name: '@type', value: PROBE_RESULT_DOC_TYPE },
      ],
      PK
    ),
    store.readDoc(PROBE_RESULTS_CONTAINER, PULSE_DOC_ID, ADMIN_CONFIG_PARTITION),
  ]);
  const results = {};
  for (const row of rows || []) {
    const presented = presentResult(row);
    // Only probes the catalogue still names: a retired probe's document stays
    // in Cosmos until someone deletes it, but it never reaches the page.
    if (presented?.probeId && healthProbe(presented.probeId)) results[presented.probeId] = presented;
  }
  return { results, pulse: presentPulse(pulseDoc) };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, createDoc: Function, replaceDocIfMatch: Function, queryDocs: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createProbeResultHandlers({ guard, store, now = () => new Date(), sleep }) {
  return {
    /** GET /api/cms/health/probe-results — every probe's last result, and the pulse. */
    async getProbeResults(request, context) {
      const auth = await guard.requireRole(request, PROBE_RESULTS_READ_ROLE);
      if (auth.error) return auth.error;
      try {
        const { results, pulse } = await readProbeResults(store);
        return json(200, { success: true, results, pulse, readAt: now().toISOString() });
      } catch (error) {
        context.error?.(`getProbeResults failed: ${error?.message || error}`);
        return json(500, { error: 'Failed to read the stored probe results' });
      }
    },

    /** PUT /api/cms/health/probe-results — body `{ probeId, status, summary, detail?, durationMs? }`. */
    async putProbeResult(request, context) {
      // Any admin first, so nothing about the body is answered to a stranger;
      // then the probe's own role, which only the body can name.
      const auth = await guard.requireRole(request, PROBE_RESULTS_READ_ROLE);
      if (auth.error) return auth.error;
      const body = await request.json().catch(() => null);
      const parsed = parseResultWrite(body);
      if (parsed.problem) return json(400, { error: parsed.problem });
      if (!satisfiesRole(auth.role, parsed.writeRole)) {
        return json(403, { error: `Recording ${parsed.probeId} requires ${parsed.writeRole} or higher` });
      }
      try {
        const { doc, written } = await recordProbeResult(
          store,
          {
            ...parsed,
            // The server's clock, not the browser's: every stored time is
            // then on one clock, the pulse's included.
            checkedAt: now().toISOString(),
            checkedBy: 'admin',
            recordedBy: actorName(auth.user),
          },
          sleep ? { sleep } : {}
        );
        return json(200, { success: true, written, result: presentResult(doc) });
      } catch (error) {
        if (error?.code === 'CONFLICT') {
          return json(409, { error: authoredMessage(error, 'The result changed while it was written.') });
        }
        context.error?.(`putProbeResult failed: ${error?.message || error}`);
        return json(500, { error: 'Failed to record the probe result' });
      }
    },
  };
}
