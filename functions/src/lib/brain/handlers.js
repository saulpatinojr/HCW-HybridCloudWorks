import { randomUUID } from 'node:crypto';
import {
  authoredMessage,
  authoredDetails,
  errorResponse,
  isAuthoredError,
} from '../http/error-response.js';
import { PRIVATE_HEADERS, BrainError } from './model.js';
import { requireBrainOwner } from './guard.js';
import { createSourceService } from './sources.js';
import { createBrainIndexer } from './indexing.js';
import * as actions from './handler-actions.js';

const response = (status, body) => ({
  status,
  headers: PRIVATE_HEADERS,
  body: JSON.stringify(body),
});

// One route: the owner check, then the work, then the answer. A failure is
// answered with its authored sentence, or with a fixed one and logged by
// its code (errorResponse).
function route({ guard, syncGuard, env, log }, work, sync = false) {
  return async (request, context = log) => {
    try {
      const auth = await requireBrainOwner(
        sync ? syncGuard : guard,
        request,
        env,
        sync,
      );
      if (auth.error)
        return {
          ...auth.error,
          headers: { ...auth.error.headers, ...PRIVATE_HEADERS },
        };
      return response(200, await work(request, auth));
    } catch (error) {
      if (error instanceof BrainError)
        return response(error.status, {
          ok: false,
          code: error.code,
          error: authoredMessage(error, 'Could not complete the action.'),
          ...authoredDetails(error),
        });
      if (isAuthoredError(error))
        return response(400, {
          ok: false,
          code: 'INVALID',
          error: authoredMessage(error, 'Invalid input.'),
        });
      const result = errorResponse(
        context,
        'Could not complete the Second Brain action. Your saved work is unchanged.',
        error,
        500,
      );
      return {
        ...result,
        headers: { ...result.headers, ...PRIVATE_HEADERS },
      };
    }
  };
}

export function createBrainHandlers({
  guard,
  syncGuard,
  repo,
  ai,
  env = process.env,
  enqueue = async () => {},
  log = console,
}) {
  const ctx = {
    repo,
    ai,
    env,
    enqueue,
    sources: createSourceService(repo),
    indexer: createBrainIndexer(repo),
  };
  const routeOf = (action, sync = false) =>
    route(
      { guard, syncGuard, env, log },
      (request, auth) => action(ctx, request, auth),
      sync,
    );
  return {
    status: routeOf(actions.status),
    list: routeOf(actions.list),
    get: routeOf(actions.get),
    save: routeOf(actions.save),
    history: routeOf(actions.history),
    search: routeOf(actions.search),
    graph: routeOf(actions.graph),
    reindex: routeOf(actions.reindex),
    draft: routeOf(actions.draft),
    context: routeOf(actions.context),
    ask: routeOf(actions.ask),
    syncPull: routeOf(actions.syncPull, true),
    syncPush: routeOf(actions.syncPush, true),
    syncStatus: routeOf(actions.syncStatus, true),
    syncReferences: routeOf(actions.syncReferences, true),
    newId: () => randomUUID(),
  };
}
