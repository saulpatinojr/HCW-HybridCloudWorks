/**
 * The parts of a private brain workspace that the creator Second Brain and
 * the Code Conductor brain share (#1457): the private response wrapper, safe
 * paging, the checks before a save, and the sync heartbeat. Each workspace
 * keeps its own handlers, guard, configuration and storage; only these
 * mechanics are common, so a fix here reaches both and neither can drift.
 */
import {
  authoredMessage,
  authoredDetails,
  errorResponse,
  isAuthoredError,
} from '../http/error-response.js';
import {
  PRIVATE_HEADERS,
  TYPES,
  BrainError,
  fail,
  clean,
  validateRecord,
  text,
} from './model.js';

export const PAGE_SIZE = 50;

export const privateResponse = (status, body) => ({
  status,
  headers: PRIVATE_HEADERS,
  body: JSON.stringify(body),
});

export const queryOf = (request) =>
  request.query || new URL(request.url).searchParams;

/** A whole number from 0 to `max`, or `fallback` for anything else. */
export const safeNumber = (value, fallback, max) =>
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) <= max
    ? Number(value)
    : fallback;

/** A record without its body or derived fields, with a short excerpt. */
export const summary = (item) => {
  const {
    body,
    searchable: _searchable,
    tokens: _tokens,
    ...rest
  } = clean(item);
  return { ...rest, excerpt: text(body, 300) };
};

/**
 * Wrap a handler body: authorize first, answer with private no-store headers
 * on every path, and turn an unexpected failure into a generic 500 that names
 * no internal detail.
 *
 * @param {(request: object, auth: object) => Promise<object>} work
 * @param {{ authorize: (request: object) => Promise<object>, failure: string, log?: object }} options
 */
export function privateRoute(work, { authorize, failure, log = console }) {
  return async (request, context = log) => {
    try {
      const auth = await authorize(request);
      if (auth.error)
        return {
          ...auth.error,
          headers: { ...auth.error.headers, ...PRIVATE_HEADERS },
        };
      return privateResponse(200, await work(request, auth));
    } catch (error) {
      if (error instanceof BrainError)
        return privateResponse(error.status, {
          ok: false,
          code: error.code,
          error: authoredMessage(error, 'Could not complete the action.'),
          ...authoredDetails(error),
        });
      if (isAuthoredError(error))
        return privateResponse(400, {
          ok: false,
          code: 'INVALID',
          error: authoredMessage(error, 'Invalid input.'),
        });
      const result = errorResponse(context, failure, error, 500);
      return {
        ...result,
        headers: { ...result.headers, ...PRIVATE_HEADERS },
      };
    }
  };
}

/**
 * Validate a save body: the record, a base version, and collections that
 * are active topics or projects in the same workspace.
 */
export async function prepareWrite(repo, body) {
  const item = validateRecord(body.item);
  if (!Number.isSafeInteger(body.version) || body.version < 0)
    fail(400, 'INVALID', 'A base version is required.');
  for (const id of item.collections) {
    const collection = await repo.read(id);
    if (
      !collection ||
      collection.archived ||
      !['topic', 'project'].includes(collection.type)
    )
      fail(400, 'INVALID', 'Choose an active topic or project.');
  }
  return item;
}

/** One page of records, newest change first; `after` is the last page's cursor. */
export async function listPage(repo, request) {
  const q = queryOf(request);
  const items = await repo.list({
    after: text(q.get('after'), 128),
    limit: PAGE_SIZE,
    archived: q.get('archived') === 'true',
    type: TYPES.includes(q.get('type')) ? q.get('type') : null,
  });
  return {
    items: items.map(summary),
    after: items.length === PAGE_SIZE ? items.at(-1).seq : null,
  };
}

/** One page of a record's revisions, newest first; `before` pages back. */
export async function historyPage(repo, id, request) {
  const before =
    safeNumber(
      queryOf(request).get('before'),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ) || Number.MAX_SAFE_INTEGER;
  const items = await repo.history(id, before);
  return {
    items: items.map(clean),
    before: items.length === PAGE_SIZE ? items.at(-1).seq : null,
  };
}

/** The desktop plugin's heartbeat, checked field by field. */
export function syncStatusRecord(body) {
  const pending = safeNumber(body.pending, -1, 1000000);
  const conflicts = safeNumber(body.conflicts, -1, 1000000);
  if (
    pending < 0 ||
    conflicts < 0 ||
    !['none', 'offline', 'authentication', 'conflict', 'unavailable'].includes(
      body.error,
    )
  )
    fail(400, 'INVALID', 'Invalid sync status.');
  const lastSuccessfulSync =
    typeof body.lastSuccessfulSync === 'string' &&
    Number.isFinite(Date.parse(body.lastSuccessfulSync))
      ? new Date(body.lastSuccessfulSync).toISOString()
      : null;
  return {
    id: 'sync-status',
    type: 'sync-status',
    pending,
    conflicts,
    error: body.error,
    lastSuccessfulSync,
    lastSeenAt: new Date().toISOString(),
  };
}
