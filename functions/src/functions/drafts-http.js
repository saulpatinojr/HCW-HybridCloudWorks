/**
 * drafts-http.js — the Drafts stage, /admin/drafts (owner request
 * 2026-10-03). Semantics in lib/cms/drafts-handlers.js and lib/cms/drafts.js.
 *
 * Five templates, so five registrations, each through httpRouteByMethod so a
 * later verb on any of them is a new key in `handlers`, never a second
 * function on the same template (T-510, route-inventory property 4).
 * `cms/drafts/from-markdown` is a literal segment beside the `cms/drafts/{id}`
 * template, the arrangement `cms/content/{id}` and its literal siblings
 * (item, slug, rehost-images) already use.
 *
 * There is no route that reads drafts from the repository: pre-publish drafts
 * do not live in the public repository (owner rule 2026-10-25), so
 * `cms/drafts/import-repo` was removed, and a draft comes in through
 * `cms/drafts/from-markdown` instead.
 */
import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import {
  createDoc,
  deleteDoc,
  deleteDocIfMatch,
  patchDoc,
  queryDocs,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { createDraftsHandlers } from '../lib/cms/drafts-handlers.js';
import { createDashboardStatsMaintainer } from '../lib/triggers/dashboard-stats.js';

const handlers = (context) =>
  createDraftsHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, createDoc, patchDoc, deleteDocIfMatch, upsertDoc },
    // The change feed never sees a delete (T-324): move the counters here, as
    // DELETE cms/content/{id} does.
    onContentDeleted: (contentId) =>
      createDashboardStatsMaintainer({
        store: { readDoc, upsertDoc, replaceDocIfMatch, deleteDoc, patchDoc },
      }).applyTransition({ contentId, afterData: null }),
    log: context,
  });

httpRouteByMethod('cmsDrafts', {
  authLevel: 'anonymous',
  route: 'cms/drafts',
  handlers: {
    GET: (request, context) => handlers(context).list(request, context),
    POST: (request, context) => handlers(context).create(request, context),
  },
});

httpRouteByMethod('cmsDraftsFromMarkdown', {
  authLevel: 'anonymous',
  route: 'cms/drafts/from-markdown',
  handlers: {
    POST: (request, context) => handlers(context).createFromMarkdown(request, context),
  },
});

httpRouteByMethod('cmsDraftItem', {
  authLevel: 'anonymous',
  route: 'cms/drafts/{id}',
  handlers: {
    GET: (request, context) => handlers(context).get(request, context),
    PUT: (request, context) => handlers(context).update(request, context),
    DELETE: (request, context) => handlers(context).remove(request, context),
  },
});

httpRouteByMethod('cmsDraftSendToReview', {
  authLevel: 'anonymous',
  route: 'cms/drafts/{id}/send-to-review',
  handlers: {
    POST: (request, context) => handlers(context).sendToReview(request, context),
  },
});

httpRouteByMethod('cmsDraftBackToDrafts', {
  authLevel: 'anonymous',
  route: 'cms/drafts/{id}/back-to-drafts',
  handlers: {
    POST: (request, context) => handlers(context).backToDrafts(request, context),
  },
});
