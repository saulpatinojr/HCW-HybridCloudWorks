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
import { authoredMessage, errorCode, failureFields } from '../../http/error-response.js';
import { JOBS_CONTAINER, newJobDoc } from '../../jobs.js';
import { json } from './config.js';
import { entryBrief, readEntries, updateEntry } from './queue-entries.js';
import { addUrls, answerDelta, answerList, idsOf, readBody, updateEntries } from './queue-edits.js';
import {
  migrateLegacyQueue,
  reconcileForging,
} from './queue-outcomes.js';

// One entry's document and update are in queue-entries.js; job outcomes,
// the reconcile and the legacy move in queue-outcomes.js; the add and
// update routes and the shared answer helpers in queue-edits.js.
export {
  ITEM_WRITE_ATTEMPTS,
  LEGACY_QUEUE_DOC_ID,
  MAX_IDS_PER_CALL,
  MAX_QUEUE_ITEMS,
  MAX_URLS_PER_ADD,
  QUEUE_BRIEF_FIELDS,
  QUEUE_DOC_TYPE,
  QUEUE_ID_PREFIX,
  QUEUE_STATUSES,
  RECONCILE_PER_READ,
  applyFields,
  entryBrief,
  entryIdFor,
  newEntry,
  normalizeQueueUrl,
  readEntries,
  readEntry,
  updateEntry,
} from './queue-entries.js';
export {
  migrateLegacyQueue,
  outcomeFor,
  reconcileForging,
  recordQueueOutcome,
} from './queue-outcomes.js';

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
    // "Put back in the queue" only when the revert says so: a revert that
    // failed, or found the entry changed under it, confirms nothing, and the
    // list's reconcile settles the entry on its next read.
    const fallback = reverted
      ? 'The job could not be written; the entry was put back in the queue.'
      : 'The job could not be written, and the entry could not be confirmed back in the queue; reload the list.';
    return {
      failed: authoredMessage(error, fallback),
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
