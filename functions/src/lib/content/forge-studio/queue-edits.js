/**
 * forge-studio/queue-edits.js — the Forge queue's add and update routes, and
 * the small helpers every queue route shares: reading the body, the ids it
 * names and the shape of an answer. Split out of queue.js, which describes
 * the queue and wires the routes.
 */
import { ADMIN_CONFIG_PARTITION } from '../../cosmos-client.js';
import { actorName, json } from './config.js';
import { text } from './brief.js';
import {
  CONTAINER,
  MAX_IDS_PER_CALL,
  MAX_QUEUE_ITEMS,
  MAX_URLS_PER_ADD,
  QUEUE_BRIEF_FIELDS,
  SAFE_ID,
  applyFields,
  newEntry,
  normalizeQueueUrl,
  readEntries,
  readEntry,
  updateEntry,
} from './queue-entries.js';
import { createUnlessPresent } from './queue-outcomes.js';

const refuse = (status, body) => ({ error: json(status, body) });

/** The ids a body names, cleaned; the refusal when none or too many. */
export function idsOf(body) {
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

const byNewest = (a, b) => String(b.addedAt).localeCompare(String(a.addedAt));

/** The list: every entry, newest first, and the cap. */
export const answerList = (items) =>
  json(200, { ok: true, items, total: items.length, max: MAX_QUEUE_ITEMS });

/**
 * A mutation's answer: only the entries it changed (`changed`, newest
 * first) and the ids it removed, never the whole queue — a 5,000-entry
 * queue must not come back on every Save. The page merges them.
 */
export const answerDelta = ({ changed = [], removed = [] }, extra = {}) =>
  json(200, {
    ok: true,
    changed: [...changed].sort(byNewest),
    removed,
    max: MAX_QUEUE_ITEMS,
    ...extra,
  });

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** POST cms/forge/queue — { urls[] } */
export async function addUrls(ctx, body, auth) {
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
export async function updateEntries(ctx, body) {
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
