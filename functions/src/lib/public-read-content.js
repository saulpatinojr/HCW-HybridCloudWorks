/**
 * public-read-content.js — the content list and detail reads, and the published snapshots. Each read takes the store and the
 * request; public-reads.js wires them into createPublicReadHandlers.
 */
import { errorFacts } from './http/error-response.js';
import {
  CONTENT_DETAIL_PROJECTION,
  FETCH_WINDOW,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  LIST_PROJECTION,
  LIST_SOURCES,
  PROVIDER_ALIASES,
  PUBLIC_CONTENT_DETAIL_FIELDS,
  PUBLIC_CONTENT_LIST_FIELDS,
  SLUG_CANDIDATES,
  SQL_NOT_SOFT_DELETED,
  SQL_PUBLIC_CLAUSE,
  isPublicDocument,
  json,
  projectFields,
  resolvePublishedDateValue,
  stripInternalFields,
} from './public-read-rules.js';

/**
 * GET /api/public/content?type=&provider=&limit=&offset=&source=
 * Returns each document projected to PUBLIC_CONTENT_LIST_FIELDS — in SQL,
 * and again in code — which is far more than card fields
 * (frameworkConcepts, featured, altCoverImageVariants, curatedSubpagePath,
 * costAnalysis, …) because the list consumers read them.
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function listContent(store, request, context) {
  try {
    const type = String(request.query.get('type') || '')
      .trim()
      .toLowerCase();
    const provider = String(request.query.get('provider') || '')
      .trim()
      .toLowerCase();
    const requestedSource = String(request.query.get('source') || 'content').trim();
    if (!LIST_SOURCES.has(requestedSource)) {
      return json(400, { error: 'Invalid source' });
    }
    const limit = Math.min(
      Math.max(Number(request.query.get('limit')) || LIST_DEFAULT_LIMIT, 1),
      LIST_MAX_LIMIT
    );
    const offset = Math.max(Number(request.query.get('offset')) || 0, 0);

    // The public filter runs in SQL so the TOP window counts published
    // documents rather than all documents, and the projection replaces
    // `SELECT *` so a list request stops transferring article bodies —
    // both halves of T-206. `isPublicDocument` still re-filters
    // every row below; see SQL_PUBLIC_CLAUSE for why both layers exist.
    const clauses = [SQL_PUBLIC_CLAUSE, SQL_NOT_SOFT_DELETED];
    const parameters = [];
    if (type) {
      clauses.push('LOWER(c.type) = @type');
      parameters.push({ name: '@type', value: type });
    }
    if (provider) {
      const labels = PROVIDER_ALIASES[provider] || [provider, provider.toUpperCase()];
      clauses.push(
        '(ARRAY_CONTAINS(@providers, c["Cloud Provider"]) OR ARRAY_CONTAINS(@providers, c["cloudProvider"]))'
      );
      parameters.push({ name: '@providers', value: labels });
    }
    // T-206 step 3, behind a flag so deploy order is safe in either
    // direction. With PUBLIC_LIST_SQL_ORDER=1 the window becomes the
    // NEWEST N documents instead of an arbitrary N — the last part of the
    // finding. `cp_sortDate` is a COMPUTED property (defined on every
    // document, '' when no date alias is present), which is what makes
    // this exempt from rule 2's "never ORDER BY a possibly-missing field":
    // it cannot be missing.
    //
    // Three preconditions, all three required, learned the hard way on
    // 2026-08-21 when the flag went live and every list call failed with
    // "The index path corresponding to the specified order-by item is
    // excluded": (1) apply-computed-sortdate.mjs --inspect clean;
    // (2) the property exists, which the Terraform apply now guarantees
    // (azapi_update_resource.cosmos_computed_properties, #816); (3) `/cp_sortDate/?` is
    // an INCLUDED PATH in the container's indexing policy — computed
    // properties are not covered by the `/*` wildcard (Cosmos docs), and an
    // ORDER BY on an unindexed property is an error, not a slow query.
    // infra/cosmos-containers.json carries the path for content and blogs.
    // The in-memory sort below stays either way — it is the authority on
    // order exactly as isPublicDocument is on visibility.
    const orderBy =
      process.env.PUBLIC_LIST_SQL_ORDER === '1' ? ' ORDER BY c.cp_sortDate DESC' : '';
    const query = `SELECT TOP ${FETCH_WINDOW} ${LIST_PROJECTION} FROM c WHERE ${clauses.join(' AND ')}${orderBy}`;

    const rows = await store.queryDocs(requestedSource, query, parameters);
    const matching = rows
      .filter(isPublicDocument)
      .sort((a, b) => resolvePublishedDateValue(b) - resolvePublishedDateValue(a));
    const items = matching
      .slice(offset, offset + limit)
      .map((doc) => projectFields(doc, PUBLIC_CONTENT_LIST_FIELDS));

    // `total` is the number of matching documents, not the size of this
    // page — it was measured after the slice, so it always equalled
    // `items.length` and any paginating consumer would have concluded there
    // was exactly one page (T-407).
    //
    // It is still bounded by FETCH_WINDOW, so on a collection larger than
    // that it under-reports. That is a smaller lie than the page size and
    // it is the honest one available without a second COUNT query; a
    // consumer that needs an exact total needs the cursor API tracked in
    // T-206.
    return json(200, { success: true, items, total: matching.length }, 300);
  } catch (error) {
    context.error('publicListContent failed:', errorFacts(error));
    return json(500, { error: 'Failed to list content' });
  }
}

/**
 * GET /api/public/content/{slugOrId} — id, then slug/Slug in content,
 * then the same three lookups in legacy blogs: the fallback chain the
 * detail templates run client-side today, folded server-side.
 *
 * The item is projected to PUBLIC_CONTENT_DETAIL_FIELDS: in SQL for the
 * slug lookups, and in code for both paths, since a point read by id
 * always returns the whole document.
 *
 * @param {object} request the Functions HTTP request
 * @param {object} context the invocation context, for error logging
 */
export async function getContent(store, request, context) {
  try {
    const slugOrId = String(request.params.slugOrId || '').trim();
    if (!slugOrId) return json(400, { error: 'slugOrId required' });

    for (const container of ['content', 'blogs']) {
      const byId = await store.readDoc(container, slugOrId, slugOrId);
      if (byId && isPublicDocument(byId)) {
        return json(
          200,
          {
            success: true,
            item: projectFields(byId, PUBLIC_CONTENT_DETAIL_FIELDS),
            source: container,
          },
          300
        );
      }
      for (const field of ['slug', 'Slug']) {
        const rows = await store.queryDocs(
          container,
          `SELECT TOP ${SLUG_CANDIDATES} ${CONTENT_DETAIL_PROJECTION} FROM c WHERE c["${field}"] = @slug ORDER BY c._ts DESC`,
          [{ name: '@slug', value: slugOrId }]
        );
        // `find`, not `rows[0] && isPublicDocument(...)`. Filtering after
        // taking one row meant a published article 404'd whenever an
        // unpublished document happened to share its slug and win the
        // arbitrary pick (T-305).
        const match = rows.find(isPublicDocument);
        if (match) {
          return json(
            200,
            {
              success: true,
              item: projectFields(match, PUBLIC_CONTENT_DETAIL_FIELDS),
              source: container,
            },
            300
          );
        }
      }
    }
    // Non-public and missing answer identically — see header rule 1.
    return json(404, { error: 'Content not found' });
  } catch (error) {
    context.error('publicGetContent failed:', errorFacts(error));
    return json(500, { error: 'Failed to get content' });
  }
}

/**
 * GET /api/public/snapshots/{id} — the build-time projections that
 * PublishSnapshotButton writes. Allowlisted to the two snapshots public
 * pages consume; this endpoint must not become a generic container read.
 */
export async function getSnapshot(store, request, context) {
  const PUBLIC_SNAPSHOTS = new Set(['certifications', 'speakerevents']);
  try {
    const id = String(request.params.id || '').trim();
    if (!PUBLIC_SNAPSHOTS.has(id)) return json(404, { error: 'Snapshot not found' });
    const doc = await store.readDoc('_snapshots', id, id);
    if (!doc) return json(404, { error: 'Snapshot not found' });

    // Defence in depth. The publish-side sanitizers
    // (lib/snapshots-publish.js) are the real boundary — they decide which
    // fields exist in the stored snapshot at all. But stripInternalFields
    // used to be applied to the wrapper only, so `createdBy` and
    // `updatedBy` inside items[] were never reached, and a collection with
    // no sanitizer leaked wholesale (T-201).
    //
    // Descending here means a future snapshot collection added without a
    // sanitizer still cannot publish admin emails. It is not a substitute
    // for the sanitizer: a missing one still leaks every non-internal
    // field, and display:false rows.
    const snapshot = stripInternalFields(doc);
    if (Array.isArray(snapshot.items)) {
      snapshot.items = snapshot.items.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? stripInternalFields(item)
          : item
      );
    }
    return json(200, { success: true, snapshot }, 600);
  } catch (error) {
    context.error('publicGetSnapshot failed:', errorFacts(error));
    return json(500, { error: 'Failed to get snapshot' });
  }
}
