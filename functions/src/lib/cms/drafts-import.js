/**
 * drafts-import.js — "Import from docs/content" on /admin/drafts (owner
 * request 2026-10-03): every `docs/content/blog-*.md` article on main becomes
 * a draft, once.
 *
 * THE IMPORT IS ONCE PER FILE. It lists docs/content through the existing
 * pinned source (repo-draft-source.js: two hosts, no token, no redirects, a
 * deadline and a byte cap), skips every path a document already claims
 * (`repoPath`) before fetching anything, and creates the rest create-only
 * under the id derived from the path (repoDraftContentId), so a double click
 * or a second run never duplicates: the database refuses the second create.
 * A file whose title a published article already carries is skipped, as the
 * original import refused it. Nothing here reads a file back over an existing
 * document: after import, the Drafts page is the article's source of truth
 * and docs/content is an archive.
 *
 * The file is read by the existing parser (parseRepoDraft) and shaped by the
 * existing builder (buildRepoDraftData); ./drafts.js asImportedDraft lays the
 * Drafts stage's status over it.
 */
import { authoredMessage, errorCode } from '../http/error-response.js';
import { buildDedupFields } from './content-dedup.js';
import {
  REPO_NAME,
  REPO_OWNER,
  REPO_REF,
  buildRepoDraftData,
  parseRepoDraft,
  repoDraftContentId,
} from './repo-draft.js';
import { DRAFTS_STAGE_STATUS, asImportedDraft, stageOf } from './drafts.js';

export const REPO = Object.freeze({ owner: REPO_OWNER, name: REPO_NAME, ref: REPO_REF });

/** Upstream failures the import maps to a status; anything else from GitHub is a 502. */
const STATUS_BY_UPSTREAM_CODE = Object.freeze({ RATE_LIMITED: 503, TIMEOUT: 504 });

export const editorOf = (user = {}) =>
  [user.email, user.preferred_username, user.oid, user.sub].find(Boolean) || 'admin';

/**
 * A published article already carrying this title, at any date, other than
 * `selfId`. Carried over from the original import (repo-import.js, retired
 * with this page): the dedup gate's seven-day title window does not see the
 * older hand-pasted posts docs/content also holds, and importing or sending
 * one of those must not queue a second copy of a live article.
 */
export async function publishedWithTitle(store, title, selfId = null) {
  const { normalizedTitle } = buildDedupFields({ title });
  if (!normalizedTitle) return null;
  const rows = await store.queryDocs(
    'content',
    'SELECT TOP 5 c.id, c.contentStatus, c.Live FROM c WHERE c.normalizedTitle = @title',
    [{ name: '@title', value: normalizedTitle }]
  );
  const isPublished = (row) => row.Live === true || row.contentStatus === 'published';
  return rows.find((row) => row.id !== selfId && isPublished(row)) || null;
}

async function claimsByPath(store, paths) {
  const byPath = new Map();
  if (paths.length === 0) return byPath;
  const rows = await store.queryDocs(
    'content',
    'SELECT c.id, c.repoPath, c.contentStatus, c.Live, c.Title, c.title FROM c WHERE ARRAY_CONTAINS(@paths, c.repoPath)',
    [{ name: '@paths', value: paths }]
  );
  for (const row of rows) byPath.set(row.repoPath, [...(byPath.get(row.repoPath) || []), row]);
  return byPath;
}

/** A path some document already claims: reported with where that document is, never fetched. */
function alreadyClaimed(path, rows) {
  if (rows.length > 1) {
    return {
      path,
      outcome: 'skipped',
      code: 'AMBIGUOUS',
      error: `${rows.length} documents claim this path; resolve that by hand.`,
      contentIds: rows.map((row) => row.id),
    };
  }
  const [row] = rows;
  return {
    path,
    outcome: 'skipped',
    code: 'ALREADY_IMPORTED',
    contentId: row.id,
    title: row.Title || row.title || null,
    contentStatus: row.contentStatus || null,
    stage: stageOf(row),
  };
}

/**
 * A coded error is the source's and says what happened, in a sentence the
 * source wrote (RepoSourceError); anything else is ours, and its own words
 * stay out of the answer (#945).
 *
 * @param {{ error?: Function }} log - the importer's logger
 * @param {string} path - the file that failed
 * @param {unknown} error - what the import threw
 * @returns {{ path: string, outcome: 'failed', code: string, error: string }}
 */
function importFailure(log, path, error) {
  if (typeof error?.code === 'string') {
    return {
      path,
      outcome: 'failed',
      code: error.code,
      error: authoredMessage(error, 'The file could not be imported.'),
    };
  }
  log.error?.(`[drafts] import failed (${errorCode(error)})`);
  return {
    path,
    outcome: 'failed',
    code: 'INTERNAL',
    error: 'The import failed unexpectedly; see the function logs.',
  };
}

function tally(results) {
  const counts = {};
  for (const { outcome } of results) counts[outcome] = (counts[outcome] || 0) + 1;
  return counts;
}

/**
 * The listing failed: the status and body the route answers. The sentence
 * is the source's own (RepoSourceError) or this one's, never the error's.
 *
 * @param {unknown} error - what the listing threw
 * @returns {{ status: number, body: object }}
 */
function listingFailure(error) {
  const upstream = typeof error?.code === 'string';
  return {
    status: upstream ? STATUS_BY_UPSTREAM_CODE[error.code] || 502 : 500,
    body: {
      ok: false,
      code: upstream ? error.code : 'INTERNAL',
      error: upstream
        ? `Could not list docs/content on GitHub: ${authoredMessage(error, 'the listing failed.')}`
        : 'Failed to list the repository drafts',
    },
  };
}

/** The write, create-only; a 409 is another import that finished first. */
async function createDraft(deps, { path, draft, file, user }) {
  const { store, now } = deps;
  const id = repoDraftContentId(path);
  const editor = editorOf(user);
  const doc = asImportedDraft(buildRepoDraftData({ path, draft, source: file, editor, now }), {
    id,
    editor,
    now,
  });
  // The invariant, checked where the write happens rather than trusted from
  // the builders.
  if (doc.contentStatus !== DRAFTS_STAGE_STATUS || doc.Live !== false) {
    throw new Error('drafts: refusing to import a document that is not a draft');
  }
  const created = await store.createDoc('content', doc).then(
    () => true,
    (error) => {
      if (error?.code === 409) return false;
      throw error;
    }
  );
  const base = { path, contentId: id, title: draft.title };
  return created
    ? {
        ...base,
        outcome: 'imported',
        contentStatus: DRAFTS_STAGE_STATUS,
        warnings: draft.warnings,
        repoCommitSha: file.commitSha,
      }
    : { ...base, outcome: 'skipped', code: 'ALREADY_IMPORTED' };
}

const publishedElsewhere = (path, title, live) => ({
  path,
  outcome: 'skipped',
  code: 'PUBLISHED_ELSEWHERE',
  title,
  existingId: live.id,
  error: `An article titled "${title}" is already published (${live.id}).`,
});

/** A path no document claims yet: fetch, parse, check the title, create. */
async function importNew(deps, path, user) {
  const { source, store } = deps;
  const [fetched, commitSha] = await Promise.all([
    source.fetchDraft(path),
    source.lastCommitSha(path),
  ]);
  const parsed = parseRepoDraft(fetched.text);
  if (!parsed.ok) return { path, outcome: 'refused', code: parsed.code, error: parsed.error };
  const { draft } = parsed;
  const live = await publishedWithTitle(store, draft.title);
  if (live) return publishedElsewhere(path, draft.title, live);
  return createDraft(deps, { path, draft, file: { ...fetched, commitSha }, user });
}

function importOne(deps, path, claims, user) {
  if (claims?.length) return alreadyClaimed(path, claims);
  return importNew(deps, path, user).catch((error) => importFailure(deps.log, path, error));
}

/**
 * Every docs/content article not yet imported. `{ status, body }`: 200 with
 * one result per file, or the listing's failure.
 */
async function importAll(deps, user) {
  const files = await deps.source.listCandidates().catch((error) => ({ error }));
  if (files.error) return listingFailure(files.error);
  const paths = files.map((file) => file.path);
  const claims = await claimsByPath(deps.store, paths);
  const results = await Promise.all(
    paths.map((path) => importOne(deps, path, claims.get(path), user))
  );
  return { status: 200, body: { ok: true, repo: REPO, results, counts: tally(results) } };
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, createDoc: Function }} deps.store `createDoc` is create-only
 * @param {ReturnType<import('./repo-draft-source.js').createRepoDraftSource>} deps.source
 * @param {() => Date} deps.now
 * @param {{ error?: Function }} [deps.log]
 */
export function createDraftsImporter({ store, source, now, log = {} }) {
  const deps = { store, source, now, log };
  return { importAll: (user) => importAll(deps, user) };
}
