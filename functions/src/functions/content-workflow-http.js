/**
 * content-workflow-http.js — the content workflow write RPCs at the
 * frontend's route names. Registration only; semantics in
 * lib/content-workflow.js.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import {
  readDoc,
  patchDoc,
  upsertDoc,
  deleteDoc,
  deleteDocIfMatch,
  replaceDocIfMatch,
} from '../lib/cosmos-client.js';
import { createContentWorkflowHandlers } from '../lib/content-workflow.js';
import { createDashboardStatsMaintainer } from '../lib/triggers/dashboard-stats.js';

const handlers = () =>
  createContentWorkflowHandlers({
    guard: getDefaultGuard(),
    // deleteDocIfMatch: deleteContentItem deletes under the read's ETag.
    store: { readDoc, patchDoc, upsertDoc, deleteDocIfMatch },
    // T-324: the change feed never sees a delete; move the dashboard counters here.
    onContentDeleted: (contentId) =>
      createDashboardStatsMaintainer({
        store: { readDoc, upsertDoc, replaceDocIfMatch, deleteDoc, patchDoc },
      }).applyTransition({ contentId, afterData: null }),
  });

for (const name of [
  'saveEditorDraft',
  'unpublishContentToInspected',
  'deleteContentItem',
  'saveContentSchedule',
  'unscheduleContent',
  'softDeleteLivePage',
  'requestContentInspection',
  'resetContentReviewState',
]) {
  httpRoute(name, {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: name,
    handler: (request, context) => handlers()[name](request, context),
  });
}
