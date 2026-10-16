/**
 * admin-identity-http.js — the admin identity and speaker-event RPCs at the
 * route names the frontend already calls (postJSON/authedFetch convention).
 * Registration only; semantics in lib/admin-identity.js.
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { queryDocs, readDoc, upsertDoc, patchDoc, deleteDoc } from '../lib/cosmos-client.js';
import { createAdminIdentityHandlers } from '../lib/admin-identity.js';

const handlers = () =>
  createAdminIdentityHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, upsertDoc, patchDoc, deleteDoc },
  });

httpRoute('getCurrentAdminStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'getCurrentAdminStatus',
  handler: (request, context) => handlers().getCurrentAdminStatus(request, context),
});

httpRoute('getAuthExpectations', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'getAuthExpectations',
  handler: (request, context) => handlers().getAuthExpectations(request, context),
});

httpRoute('bootstrapCurrentUserAdmin', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'bootstrapCurrentUserAdmin',
  handler: (request, context) => handlers().bootstrapCurrentUserAdmin(request, context),
});

httpRoute('recordAdminAudit', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'recordAdminAudit',
  handler: (request, context) => handlers().recordAdminAudit(request, context),
});

httpRoute('upsertSpeakerEvent', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'upsertSpeakerEvent',
  handler: (request, context) => handlers().upsertSpeakerEvent(request, context),
});

httpRoute('deleteSpeakerEvent', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'deleteSpeakerEvent',
  handler: (request, context) => handlers().deleteSpeakerEvent(request, context),
});

httpRoute('cmsAdmins', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/admins',
  handler: (request, context) => handlers().listAdmins(request, context),
});

httpRouteByMethod('cmsAdminDetail', {
  authLevel: 'anonymous',
  route: 'cms/admins/{id}',
  handlers: {
    PATCH: (request, context) => handlers().updateAdmin(request, context),
    DELETE: (request, context) => handlers().deactivateAdmin(request, context),
  },
});

httpRoute('cmsBootstrapReset', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/bootstrap/reset',
  handler: (request, context) => handlers().resetBootstrapState(request, context),
});
