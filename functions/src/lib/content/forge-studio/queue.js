/**
 * The Forge Studio Queue (owner request 2026-10-06): many URLs in, each one
 * a queue entry whose "From a URL" fields the owner completes one at a time
 * or for several at once, and which then goes through the same
 * `forge-from-url` job a single URL does — with its brief carried on the
 * job, so the brief lands on the document the job creates whether or not a
 * browser is still open to save it.
 *
 * One document PER ENTRY in `admin_config` (`docType: forge_queue_item`,
 * the constant partition every admin_config document carries). The first
 * cut held every entry in one document; the owner's first real import was a
 * browser favourites export of several hundred links, which a 2 MB item
 * cannot hold and a 200-entry cap refused (owner, 2026-10-06). Entries as
 * documents lift the cap to MAX_QUEUE_ITEMS, make every edit an independent
 * ETag-guarded write, and let the job's onComplete record an outcome
 * without racing a bulk edit of other entries. The old single document is
 * migrated into entries on the first read after deploy and emptied.
 *
 * An entry's id is the hash of its URL (`entryIdFor`), so the URL is the
 * identity: two adds of one URL, or an add racing the migration, meet at
 * `createDoc` and the loser's 409 reads as "already there" — no read-then-
 * create window. Mutations answer only the entries they changed (and the
 * ids they removed); the list answers the queue once, bounded by the cap.
 *
 * Entry statuses: `queued` (fields may still be blank), `forging` (a job is
 * running, `jobId` says which), `forged` (`contentId` is the document; the
 * entry stays until removed so the owner can open it), `failed` (`error`
 * says why; Save again re-queues it).
 */
import { createHash } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../../cosmos-client.js';
import { authoredMessage, errorCode, failureFields } from '../../http/error-response.js';
import { JOBS_CONTAINER, TERMINAL_JOB_STATUSES, newJobDoc } from '../../jobs.js';
import { actorName, json } from './config.js';
import { normalizeBrief, text } from './brief.js';

export const QUEUE_DOC_TYPE = 'forge_queue_item';
export const QUEUE_ID_PREFIX = 'forge_queue_item:';
/** The single document the first cut kept; read once and emptied. */
export const LEGACY_QUEUE_DOC_ID = 'forge_queue';
/** A favourites export is hundreds; thousands is still one admin's list. */
export const MAX_QUEUE_ITEMS = 5000;
export const MAX_URLS_PER_ADD = 2000;
export const MAX_IDS_PER_CALL = 2000;
/** Per-entry ETag retries: a bulk edit and the job's onComplete can touch one entry together. */
export const ITEM_WRITE_ATTEMPTS = 6;
/** Forging entries the list reconciles against their job documents per read. */
export const RECONCILE_PER_READ = 50;
export const QUEUE_STATUSES = Object.freeze(['queued', 'forging', 'forged', 'failed']);
/** The brief fields a queue entry may carry; `mode` and `sourceUrl` are the entry's own. */
export const QUEUE_BRIEF_FIELDS = Object.freeze([
  'objective',
  'audience',
  'tone',
  'readingLevel',
  'targetLength',
  'keyMessage',
  'requiredTopics',
  'prohibitedTopics',
  'callsToAction',
  'sources',
  'targetChannel',
  'campaign',
  'seoKeywords',
]);

const SAFE_ID = /^[A-Za-z0-9_:-]{1,120}$/;
const refuse = (status, body) => ({ error: json(status, body) });
const CONTAINER = 'admin_config';
const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

/**
 * A URL as the queue stores it: http(s) only, trimmed, the fragment dropped
 * (it never reaches the server), nothing else changed — tracking parameters
 * stay because the page they lead to is the same page the owner saw.
 */
export function normalizeQueueUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  parsed.hash = '';
  return parsed.toString().slice(0, 2000);
}

/** The brief a queue entry carries, normalised, always in URL mode on its own URL. */
export function entryBrief(entry, fields = {}) {
  const merged = { ...(entry.brief || {}) };
  for (const key of QUEUE_BRIEF_FIELDS) {
    if (fields[key] !== undefined) merged[key] = fields[key];
  }
  return normalizeBrief({ ...merged, mode: 'url', sourceUrl: entry.url });
}

/** The id a URL's entry has: the prefix plus the URL's SHA-1, so one URL is one entry. */
export const entryIdFor = (url) =>
  `${QUEUE_ID_PREFIX}${createHash('sha1').update(String(url)).digest('hex')}`;

/** The queue entry a URL becomes: one admin_config document of its own, its id the URL's hash. */
export function newEntry({ url, stamp, actor, title = '' }) {
  return {
    id: entryIdFor(url),
    configScope: ADMIN_CONFIG_PARTITION,
    docType: QUEUE_DOC_TYPE,
    url,
    title: text(title, 300),
    addedAt: stamp,
    addedBy: actor,
    brief: normalizeBrief({ mode: 'url', sourceUrl: url }),
    kind: '',
    ideaOrigin: 'imported-source',
    status: 'queued',
    jobId: null,
    contentId: null,
    error: null,
    updatedAt: stamp,
  };
}

/** Every entry, newest first (same stamp: insertion order). */
export async function readEntries(store) {
  // Bounded by the cap, which is the one thing the add path enforces, so
  // fetchAll accumulates at most MAX_QUEUE_ITEMS entries.
  const rows = await store.queryDocs(
    CONTAINER,
    `SELECT TOP ${MAX_QUEUE_ITEMS} * FROM c WHERE c.configScope = @scope AND c.docType = @type`,
    [
      { name: '@scope', value: ADMIN_CONFIG_PARTITION },
      { name: '@type', value: QUEUE_DOC_TYPE },
    ],
    PK
  );
  return [...(rows || [])].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

/** One entry by id, or null when there is none (or the id names something else). */
export async function readEntry(store, id) {
  if (!SAFE_ID.test(String(id || '')) || !String(id).startsWith(QUEUE_ID_PREFIX)) return null;
  const doc = await store.readDoc(CONTAINER, id, ADMIN_CONFIG_PARTITION);
  return doc && doc.docType === QUEUE_DOC_TYPE ? doc : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read → `change(entry)` → patch under the entry's ETag, retried while
 * another writer gets there first. `change` returns the fields to write, or
 * null to write nothing. Resolves to the entry after, or null when it is
 * gone.
 */
export async function updateEntry(
  store,
  id,
  change,
  { attempts = ITEM_WRITE_ATTEMPTS, sleep = null } = {}
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && sleep) await sleep(25 * 2 ** Math.min(attempt, 5) + Math.random() * 25);
    const current = await readEntry(store, id);
    if (!current) return null;
    const patch = change({ ...current });
    if (!patch) return current;
    try {
      return await store.patchDoc(CONTAINER, id, patch, { ...PK, ifMatch: current._etag });
    } catch (error) {
      if (error?.code !== 412) throw error;
    }
  }
  throw new Error('A queue entry kept changing; nothing was written. Try again.');
}

/** The ids a body names, cleaned; the refusal when none or too many. */
function idsOf(body) {
  const raw = Array.isArray(body?.ids) ? body.ids : [];
  const ids = [
    ...new Set(raw.map((id) => String(id || '').trim()).filter((id) => SAFE_ID.test(id))),
  ];
  if (!ids.length) return refuse(400, { ok: false, error: 'ids required' });
  if (ids.length > MAX_IDS_PER_CALL) {
    return refuse(400, { ok: false, error: `At most ${MAX_IDS_PER_CALL} ids per call` });
  }
  return { ids };
}

/** The `fields` of an update: only the brief keys the queue knows, plus `kind`; the refusal when nothing usable. */
function fieldsOf(body) {
  const raw = body?.fields && typeof body.fields === 'object' ? body.fields : {};
  const fields = {};
  for (const key of QUEUE_BRIEF_FIELDS) {
    if (raw[key] !== undefined) fields[key] = raw[key];
  }
  const kind = raw.kind !== undefined ? text(raw.kind, 60) : undefined;
  if (!Object.keys(fields).length && kind === undefined) {
    return refuse(400, { ok: false, error: 'fields required: nothing to apply' });
  }
  return { fields, kind };
}

/** The patch that applies `fields` (and `kind`) to an entry; a failed entry goes back to queued. */
export function applyFields(entry, { fields, kind }, stamp) {
  return {
    brief: entryBrief(entry, fields),
    ...(kind !== undefined ? { kind } : {}),
    ...(entry.status === 'failed' ? { status: 'queued', error: null } : {}),
    updatedAt: stamp,
  };
}

/**
 * What a job's onComplete records on the entry it was started for: the
 * document when it succeeded, the error when it did not. A `skipped`
 * duplicate (the forge's 409) is recorded as forged on the duplicate.
 */
export function outcomeFor({ status, result, error }) {
  if (status === 'succeeded' && result && result.success !== false) {
    return { status: 'forged', contentId: result.contentId || null, error: null };
  }
  if (status === 'succeeded' && result?.skipped) {
    return {
      status: 'forged',
      contentId: result.duplicateOf || result.contentId || null,
      error: result.error ? String(result.error).slice(0, 500) : null,
    };
  }
  const message = error || result?.error || `the forge job ${status || 'did not finish'}`;
  return {
    status: 'failed',
    contentId: result?.contentId || null,
    error: String(message).slice(0, 500),
  };
}

/**
 * The job's onComplete half: the entry `queueItemId` names takes the
 * outcome, under its own ETag with retries. Nothing when the entry is gone
 * (the owner removed it while the job ran). Should every attempt lose, the
 * list's reconcile reads the job document on the next open.
 */
export async function recordQueueOutcome(
  store,
  { queueItemId, status, result, error },
  { now, sleep = defaultSleep }
) {
  const id = String(queueItemId || '');
  if (!SAFE_ID.test(id)) return null;
  const outcome = outcomeFor({ status, result, error });
  return updateEntry(store, id, () => ({ ...outcome, updatedAt: now().toISOString() }), {
    attempts: 10,
    sleep,
  });
}

/**
 * Forging entries whose job has already finished take its outcome from the
 * job document: the hook above may have lost every ETag race, or the host
 * may have recycled before it ran. At most RECONCILE_PER_READ per read.
 * Resolves to the entries with the outcomes applied.
 */
export async function reconcileForging(ctx, entries) {
  const forging = entries
    .filter((item) => item.status === 'forging' && item.jobId)
    .slice(0, RECONCILE_PER_READ);
  if (!forging.length) return entries;
  const updated = new Map();
  for (const item of forging) {
    const job = await ctx.store.readDoc(JOBS_CONTAINER, item.jobId, item.jobId).catch(() => null);
    if (job && !TERMINAL_JOB_STATUSES.includes(job.status)) continue;
    // No job document at all: the claim was written and the job never was
    // (the write failed and the revert failed too). Failed, not forging.
    const outcome = job
      ? outcomeFor({ status: job.status, result: job.result, error: job.error })
      : { status: 'failed', contentId: null, error: 'the forge job was never written; Save again' };
    const after = await updateEntry(ctx.store, item.id, (entry) =>
      entry.status === 'forging' ? { ...outcome, updatedAt: ctx.now().toISOString() } : null
    ).catch(() => null);
    if (after) updated.set(item.id, after);
  }
  return updated.size ? entries.map((item) => updated.get(item.id) || item) : entries;
}

/** A legacy item as an entry document, its fields and status kept. */
function entryFromLegacy(ctx, item, url) {
  const stamp = ctx.now().toISOString();
  return {
    ...newEntry({
      url,
      stamp: item.addedAt || stamp,
      actor: item.addedBy || 'migration',
      title: item.title,
    }),
    brief: entryBrief({ url, brief: item.brief || {} }),
    kind: text(item.kind, 60),
    status: QUEUE_STATUSES.includes(item.status) ? item.status : 'queued',
    jobId: item.jobId || null,
    contentId: item.contentId || null,
    error: item.error || null,
    updatedAt: item.updatedAt || stamp,
  };
}

/** `createDoc`, with a 409 (the URL's entry exists) answered as null rather than thrown. */
async function createUnlessPresent(store, entry) {
  try {
    return await store.createDoc(CONTAINER, entry);
  } catch (error) {
    if (error?.code === 409) return null;
    throw error;
  }
}

/**
 * The first cut's single document: its entries become documents of their
 * own and it is emptied so this runs once. Idempotent under concurrent
 * first reads: an entry's id is its URL's hash, so a second reader's
 * createDoc meets a 409 and moves on, and the final emptying is under the
 * legacy document's ETag (the loser's 412 is nothing to do). Nothing when
 * there is no such document or it is already empty.
 */
export async function migrateLegacyQueue(ctx) {
  const legacy = await ctx.store.readDoc(CONTAINER, LEGACY_QUEUE_DOC_ID, ADMIN_CONFIG_PARTITION);
  const items = Array.isArray(legacy?.items) ? legacy.items : [];
  if (!items.length) return 0;
  let moved = 0;
  for (const item of items) {
    const url = normalizeQueueUrl(item.url);
    if (!url) continue;
    if (await createUnlessPresent(ctx.store, entryFromLegacy(ctx, item, url))) moved += 1;
  }
  try {
    await ctx.store.replaceDocIfMatch(
      CONTAINER,
      { ...legacy, items: [], migratedAt: ctx.now().toISOString(), migratedCount: moved },
      PK
    );
  } catch (error) {
    if (error?.code !== 412) throw error;
  }
  return moved;
}

const byNewest = (a, b) => String(b.addedAt).localeCompare(String(a.addedAt));

/** The list: every entry, newest first, and the cap. */
const answerList = (items) =>
  json(200, { ok: true, items, total: items.length, max: MAX_QUEUE_ITEMS });

/**
 * A mutation's answer: only the entries it changed (`changed`, newest
 * first) and the ids it removed, never the whole queue — a 5,000-entry
 * queue must not come back on every Save. The page merges them.
 */
const answerDelta = ({ changed = [], removed = [] }, extra = {}) =>
  json(200, {
    ok: true,
    changed: [...changed].sort(byNewest),
    removed,
    max: MAX_QUEUE_ITEMS,
    ...extra,
  });

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** POST cms/forge/queue — { urls[] } */
async function addUrls(ctx, body, auth) {
  const raw = Array.isArray(body?.urls) ? body.urls : [];
  if (raw.length > MAX_URLS_PER_ADD) {
    return json(400, { ok: false, error: `At most ${MAX_URLS_PER_ADD} URLs per add` });
  }
  const urls = [...new Set(raw.map(normalizeQueueUrl).filter(Boolean))];
  if (!urls.length) return json(400, { ok: false, error: 'urls required: no http(s) URL given' });
  let count = (await readEntries(ctx.store)).length;
  const stamp = ctx.now().toISOString();
  const actor = actorName(auth.user);
  const changed = [];
  const added = [];
  const skipped = [];
  let full = 0;
  for (const url of urls) {
    if (count >= MAX_QUEUE_ITEMS) {
      full += 1;
      continue;
    }
    // The id is the URL's hash: an existing entry answers 409 here, which is
    // the dedupe — no read-then-create window for two adds to slip through.
    const written = await createUnlessPresent(ctx.store, newEntry({ url, stamp, actor }));
    if (!written) {
      skipped.push(url);
      continue;
    }
    changed.push(written);
    added.push(written.id);
    count += 1;
  }
  return answerDelta({ changed }, { added, skipped, full });
}

/**
 * POST cms/forge/queue/update — { ids[], remove: true }. A forging entry is
 * kept: its job is running and will report to it; `removed` names only what
 * went.
 */
async function removeEntries(ctx, ids) {
  const removed = [];
  for (const id of ids) {
    const entry = await readEntry(ctx.store, id);
    if (!entry || entry.status === 'forging') continue;
    try {
      await ctx.store.deleteDoc(CONTAINER, id, ADMIN_CONFIG_PARTITION);
    } catch (error) {
      if (error?.code !== 404) throw error; // already gone: the same outcome
    }
    removed.push(id);
  }
  return answerDelta({ removed });
}

/** POST cms/forge/queue/update — { ids[], fields } */
async function updateEntries(ctx, body) {
  const picked = idsOf(body);
  if (picked.error) return picked.error;
  if (body?.remove === true) return removeEntries(ctx, picked.ids);
  const change = fieldsOf(body);
  if (change.error) return change.error;
  const stamp = ctx.now().toISOString();
  const applied = [];
  const changed = [];
  for (const id of picked.ids) {
    const after = await updateEntry(ctx.store, id, (entry) =>
      entry.status === 'forging' ? null : applyFields(entry, change, stamp)
    );
    if (!after || after.status === 'forging') continue;
    applied.push(id);
    changed.push(after);
  }
  return answerDelta({ changed }, { applied });
}

/** The job document one entry starts; the entry's brief rides on the payload. */
const jobFor = (item, { jobId, user, stamp }) =>
  newJobDoc({
    id: jobId,
    type: 'forge-from-url',
    payload: {
      url: item.url,
      brief: entryBrief(item),
      kind: item.kind || '',
      ideaOrigin: item.ideaOrigin || 'imported-source',
      queueItemId: item.id,
    },
    requestedBy: user,
    createdAt: stamp,
  });

const canForge = (item) => item.status !== 'forging' && item.status !== 'forged';

/**
 * One entry into the forge. The entry is CLAIMED first — marked forging
 * with the job's id under its own ETag, only if still forgeable — so two
 * Saves racing on one entry start one job: the loser reads it forging and
 * skips. Then the job document is written and its message emitted. A job
 * write that fails reverts the claim to queued (best effort; should that
 * fail too, the list's reconcile reads "no job document" as failed), and so
 * does a job document that cannot be built — newJobDoc refuses a brief over
 * the type's payload bound (#942 follow-up).
 * Resolves to `{ started, entry }`, `{ failed, entry }` or `{ skipped }`.
 */
async function forgeOne(ctx, id, { user, stamp, context, io }) {
  // The job id is drawn inside the claim, so an entry that is skipped
  // consumes none, and a retried claim carries the id it finally wrote.
  let jobId = null;
  const entry = await updateEntry(ctx.store, id, (current) => {
    if (!canForge(current)) return null;
    jobId = ctx.uuid();
    return { status: 'forging', jobId, error: null, updatedAt: stamp };
  });
  if (!entry || !jobId) return { skipped: true };
  let jobDoc;
  try {
    jobDoc = jobFor(entry, { jobId, user, stamp });
    await ctx.store.upsertDoc(JOBS_CONTAINER, jobDoc);
  } catch (error) {
    // `failed` reaches the page as this entry's reason: newJobDoc's own
    // payload refusal (authored) is shown, the store's words are not (#945).
    // The log keeps the code.
    context?.error?.(`[forge/queue] job write failed (${errorCode(error)})`);
    const reverted = await updateEntry(ctx.store, id, (current) =>
      current.jobId === jobId ? { status: 'queued', jobId: null, updatedAt: stamp } : null
    ).catch(() => null);
    return {
      failed: authoredMessage(error, 'The job could not be written; the entry was put back in the queue.'),
      entry: reverted || entry,
    };
  }
  io.enqueue({ jobId: jobDoc.id, type: jobDoc.type });
  return { started: { id, jobId }, entry };
}

/**
 * POST cms/forge/queue/forge — { ids[] }; `io.enqueue` is the queue output
 * binding (the route collects what it emits and sets the binding once).
 *
 * A job write that fails leaves that entry (reverted) and the later ones
 * queued and names them in `notStarted`, so Save again picks them up.
 */
async function forgeEntries(ctx, body, auth, context, io) {
  if (typeof io?.enqueue !== 'function') {
    context?.error?.('forge/queue/forge: no queue output wired');
    return json(500, { ok: false, error: 'Job queue is not configured' });
  }
  const picked = idsOf(body);
  if (picked.error) return picked.error;
  const stamp = ctx.now().toISOString();
  const started = [];
  const notStarted = [];
  const changed = [];
  for (const id of picked.ids) {
    if (notStarted.length) {
      notStarted.push({ id, error: 'not attempted after an earlier job write failed' });
      continue;
    }
    const one = await forgeOne(ctx, id, { user: auth.user, stamp, context, io });
    if (one.entry) changed.push(one.entry);
    if (one.started) started.push(one.started);
    else if (one.failed) notStarted.push({ id, error: one.failed });
  }
  return answerDelta({ changed }, { started, ...(notStarted.length ? { notStarted } : {}) });
}

/**
 * The four routes (editor), each one call:
 *   GET  cms/forge/queue          → every entry (legacy document migrated first, forging entries reconciled)
 *   POST cms/forge/queue          { urls[] }         add; answers the entries created
 *   POST cms/forge/queue/update   { ids[], fields }  apply fields; { ids[], remove: true } removes; answers the delta
 *   POST cms/forge/queue/forge    { ids[] }          one forge-from-url job per entry; answers the delta
 */
export function createForgeQueueHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = () => crypto.randomUUID(),
}) {
  const ctx = { store, now, uuid };
  /**
   * A queue route: the editor gate, then the work, inside a catch that
   * answers through the door (#945).
   *
   * @param {Function} fn - the route body
   * @returns {Function}
   */
  const guarded = (fn) => async (request, context, io) => {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    try {
      return await fn(request, auth, context, io);
    } catch (error) {
      return json(502, failureFields(context, 'The queue could not be updated.', error, request));
    }
  };
  return {
    list: guarded(async () => {
      await migrateLegacyQueue(ctx);
      return answerList(await reconcileForging(ctx, await readEntries(store)));
    }),
    add: guarded(async (request, auth) => addUrls(ctx, await readBody(request), auth)),
    update: guarded(async (request) => updateEntries(ctx, await readBody(request))),
    forge: guarded(async (request, auth, context, io) =>
      forgeEntries(ctx, await readBody(request), auth, context, io)
    ),
  };
}
