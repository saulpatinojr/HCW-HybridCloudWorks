/**
 * admin-handler.js — the pieces every admin CRUD handler module shares: the
 * JSON response shape, the body check, the read window, and the one handler
 * shape that recurs verbatim across hubs (list every document of a container
 * for a page that filters and sorts client-side).
 */

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const MAX_DOC_JSON = 120_000;
export const LIST_WINDOW = 1000;

/** A plain object no larger than MAX_DOC_JSON once serialised, or null. */
export function validBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (JSON.stringify(body).length > MAX_DOC_JSON) return null;
  return body;
}

/**
 * GET handler that answers every document of `container` behind the editor
 * role — `{ success, items, total }`, with the page doing its own filtering
 * and sorting. `name` is the handler's name for the error log line and
 * `failure` the 500 body's sentence.
 *
 * @param {{ guard: { requireRole: Function }, store: { queryDocs: Function } }} ctx
 * @param {{ container: string, name: string, failure: string }} spec
 */
export function listAllHandler({ guard, store }, { container, name, failure }) {
  return async function listAll(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;
    try {
      const continuationToken =
        request?.query?.get?.('continuationToken') ||
        request?.query?.continuationToken ||
        null;
      const limitRaw =
        request?.query?.get?.('limit') ||
        request?.query?.limit;
      const limit = Number(limitRaw) > 0 ? Math.min(Number(limitRaw), LIST_WINDOW) : LIST_WINDOW;

      if (typeof store.queryDocsPage === 'function') {
        const page = await store.queryDocsPage(
          container,
          'SELECT * FROM c ORDER BY c._ts DESC',
          [],
          {
            maxItemCount: limit,
            continuationToken: continuationToken || undefined,
          }
        );
        return json(200, {
          success: true,
          items: page.resources || [],
          total: (page.resources || []).length,
          continuationToken: page.continuationToken || null,
        });
      }

      const items = await store.queryDocs(
        container,
        `SELECT TOP ${limit} * FROM c ORDER BY c._ts DESC`,
        []
      );
      return json(200, {
        success: true,
        items,
        total: items.length,
        continuationToken: null,
      });
    } catch (error) {
      context.error(`${name} failed:`, error);
      return json(500, { error: failure });
    }
  };
}
