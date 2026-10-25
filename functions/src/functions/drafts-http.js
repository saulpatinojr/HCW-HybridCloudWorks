/**
 * drafts-http.js — the Drafts stage, /admin/drafts (owner request
 * 2026-10-03). Semantics in lib/cms/drafts-handlers.js and lib/cms/drafts.js.
 *
 * Six templates, so six registrations, each through httpRouteByMethod so a
 * later verb on any of them is a new key in `handlers`, never a second
 * function on the same template (T-510, route-inventory property 4).
 * `cms/drafts/import-repo` is a literal segment beside the `cms/drafts/{id}`
 * template, the arrangement `cms/content/{id}` and its literal siblings
 * (item, slug, rehost-images) already use.
 *
 * Replaces content-import-http.js (POST cms/content/import-repo and GET
 * cms/content/import-repo/candidates), retired with this page: that import
 * wrote straight to in_review and refreshed in-review articles from the
 * repository, which would now overwrite edits made on the Drafts page.
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
import { createRepoDraftSource } from '../lib/cms/repo-draft-source.js';
import { createDraftsHandlers } from '../lib/cms/drafts-handlers.js';
import { createDashboardStatsMaintainer } from '../lib/triggers/dashboard-stats.js';

const handlers = (context) =>
  createDraftsHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, createDoc, patchDoc, deleteDocIfMatch, upsertDoc },
    source: createRepoDraftSource(),
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

httpRouteByMethod('cmsDraftsImportRepo', {
  authLevel: 'anonymous',
  route: 'cms/drafts/import-repo',
  handlers: {
    POST: (request, context) => handlers(context).importFromRepo(request, context),
  },
});
