/**
 * doc-vault-http.js — the Doc Vault, /admin/doc-vault (owner request
 * 2026-10-26). Registration only; semantics in lib/doc-vault/handlers.js.
 *
 * Six templates, so six registrations, each through httpRouteByMethod so a
 * later verb on any of them is a new key in `handlers`, never a second
 * function on the same template (T-510, route-inventory property 4).
 * `cms/doc-vault/upload` is a literal segment beside the `cms/doc-vault/{id}`
 * template, the arrangement `cms/drafts/from-markdown` already uses.
 *
 * Every route needs the publisher role (lib/doc-vault/model.js says why), and
 * none is public: the vault holds private letters, applications and notes.
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
import { createDocVaultHandlers } from '../lib/doc-vault/handlers.js';

const handlers = () =>
  createDocVaultHandlers({
    guard: getDefaultGuard(),
    store: {
      queryDocs,
      readDoc,
      createDoc,
      upsertDoc,
      replaceDocIfMatch,
      patchDoc,
      deleteDoc,
      deleteDocIfMatch,
    },
  });

httpRouteByMethod('cmsDocVault', {
  authLevel: 'anonymous',
  route: 'cms/doc-vault',
  handlers: {
    GET: (request, context) => handlers().list(request, context),
    POST: (request, context) => handlers().create(request, context),
  },
});

httpRouteByMethod('cmsDocVaultUpload', {
  authLevel: 'anonymous',
  route: 'cms/doc-vault/upload',
  handlers: {
    POST: (request, context) => handlers().upload(request, context),
  },
});

httpRouteByMethod('cmsDocVaultItem', {
  authLevel: 'anonymous',
  route: 'cms/doc-vault/{id}',
  handlers: {
    GET: (request, context) => handlers().get(request, context),
    PUT: (request, context) => handlers().update(request, context),
    DELETE: (request, context) => handlers().remove(request, context),
  },
});

httpRouteByMethod('cmsDocVaultUntrash', {
  authLevel: 'anonymous',
  route: 'cms/doc-vault/{id}/untrash',
  handlers: {
    POST: (request, context) => handlers().untrash(request, context),
  },
});

httpRouteByMethod('cmsDocVaultVersion', {
  authLevel: 'anonymous',
  route: 'cms/doc-vault/{id}/versions/{version}',
  handlers: {
    GET: (request, context) => handlers().getVersion(request, context),
  },
});

httpRouteByMethod('cmsDocVaultRestoreVersion', {
  authLevel: 'anonymous',
  route: 'cms/doc-vault/{id}/restore-version',
  handlers: {
    POST: (request, context) => handlers().restoreVersion(request, context),
  },
});
