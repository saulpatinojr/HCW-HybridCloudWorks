/**
 * interviews-admin-http.js — the admin routes of the `interview` content type
 * (ADR 0040, D5). Semantics in lib/interviews/admin.js; registration only.
 *
 * Three templates through httpRouteByMethod, so a later verb on one is a new
 * key in `handlers` and never a second function on the same template
 * (route-inventory property 4). The upload routes (`cms/interviews/uploads`,
 * the upload slice) and the job routes (`cms/interviews/{id}/transcribe` and
 * siblings, the jobs slice) are literal and longer templates beside these,
 * the arrangement `cms/drafts` and `cms/drafts/{id}` already use.
 */
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { patchDoc, queryDocs, readDoc, upsertDoc } from '../lib/cosmos-client.js';
import { deleteBlob, downloadBlob, getContainerClient } from '../lib/blob-storage.js';
import { createInterviewAdminHandlers } from '../lib/interviews/admin.js';

const handlers = (context) =>
  createInterviewAdminHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, upsertDoc, patchDoc },
    blobs: { downloadBlob, deleteBlob, getContainerClient },
    log: context,
  });

httpRouteByMethod('cmsInterviews', {
  authLevel: 'anonymous',
  route: 'cms/interviews',
  handlers: {
    GET: (request, context) => handlers(context).list(request, context),
    POST: (request, context) => handlers(context).create(request, context),
  },
});

httpRouteByMethod('cmsInterviewItem', {
  authLevel: 'anonymous',
  route: 'cms/interviews/{id}',
  handlers: {
    GET: (request, context) => handlers(context).get(request, context),
  },
});

httpRouteByMethod('cmsInterviewAudio', {
  authLevel: 'anonymous',
  route: 'cms/interviews/{id}/audio',
  handlers: {
    DELETE: (request, context) => handlers(context).deleteAudio(request, context),
  },
});
