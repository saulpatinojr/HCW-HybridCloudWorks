/**
 * forge-studio/queue-entries.js — one entry of the Forge queue: its id, its
 * document, and the guarded read-change-write every update goes through.
 * Split out of queue.js, which describes the queue and re-exports this.
 */
import { createHash } from 'node:crypto';
import { ADMIN_CONFIG_PARTITION } from '../../cosmos-client.js';
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

export const SAFE_ID = /^[A-Za-z0-9_:-]{1,120}$/;
export const CONTAINER = 'admin_config';
export const PK = { partitionKey: ADMIN_CONFIG_PARTITION };

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

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The patch that applies `fields` (and `kind`) to an entry; a failed entry goes back to queued. */
export function applyFields(entry, { fields, kind }, stamp) {
  return {
    brief: entryBrief(entry, fields),
    ...(kind !== undefined ? { kind } : {}),
    ...(entry.status === 'failed' ? { status: 'queued', error: null } : {}),
    updatedAt: stamp,
  };
}
