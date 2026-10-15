/**
 * generate-article-draft-http.js — registration for `generateArticleDraft`
 * (Blog Machine T-602, closing one of #180's fifteen). Semantics in
 * lib/content/draft-from-url.js.
 *
 * Named for the one RPC it registers (AP-F13, #937): until 2026-10-15 this
 * was `draft-http.js`, one letter from `drafts-http.js`, which is the Drafts
 * stage of the pipeline and nothing to do with drafting from a URL. The
 * function name is unchanged, so the route inventory and the deployed
 * function are untouched.
 *
 * RPC-style route, not REST: the Publish-Ready Builder and the editor both
 * post to the function NAME (`postJSON('generateArticleDraft', ...)`), the
 * shape the Firebase callables had. Their two payload dialects are accepted
 * by the same handler.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { readDoc, queryDocs, patchDoc, upsertDoc } from '../lib/cosmos-client.js';
import * as ai from '../lib/ai/router.js';
import { createDrafter } from '../lib/content/drafting.js';
import {
  createUrlDrafter,
  createGenerateArticleDraftHandler,
} from '../lib/content/draft-from-url.js';

/**
 * generateArticleDraft over the live store and AI, built on each call with the
 * invocation's context as the drafter's log.
 */
const handler = (request, context) =>
  createGenerateArticleDraftHandler({
    guard: getDefaultGuard(),
    urlDrafter: createUrlDrafter({
      drafter: createDrafter({ store: { readDoc, queryDocs, patchDoc, upsertDoc }, ai }),
      log: context,
    }),
  })(request, context);

httpRoute('generateArticleDraft', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'generateArticleDraft',
  handler,
});
