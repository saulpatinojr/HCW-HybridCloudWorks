/**
 * labs-public-http.js — the anonymous labs routes. Registration only.
 *
 * The two reads for /education/labs (api-surface.json rest.publicReads; #664
 * and #680), semantics in lib/labs/estate.js and lib/labs/coder-status.js:
 * no guard, deliberately, because both serve the public page, and both are
 * bounded by a one-document, one-minute cache (lib/labs/minute-cache.js) so
 * anonymous traffic cannot drive the management plane or Coder.
 *
 * The public lab submission (api-surface.json rest.publicLabs; #672),
 * semantics in lib/labs/public-submit.js: `public/labs/submit` (GET is
 * whether a submission would be taken, POST submits one terraform-validate
 * job) and `public/labs/job` (one public job's status and visitor report). CLOSED
 * unless LABS_PUBLIC_SUBMISSION_ENABLED is exactly "true", which Terraform
 * sets from labs_public_submission_enabled since the owner revised ADR 0032
 * decision 6 on 2026-09-28. Open, a POST is taken only from the site's pane:
 * the site's exact Origin and a Cloudflare Turnstile token that siteverify
 * passes (lib/labs/public-lock.js), and with no Turnstile secret the path
 * stays closed. Past the lock it is bounded the way public/submissions is,
 * Cloudflare-verified hashed identity and per-client counter included, plus
 * the decision's own caps.
 *
 * Every route here is listed in PUBLIC_ROUTES in route-inventory.test.js with
 * its reason.
 *
 * The Resource Graph client and the client identity are built on first use
 * rather than at import: index.js is imported by the route-inventory and
 * api-contract tests under a mocked host, and nothing here may construct a
 * credential for them.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { createClientIdentity } from '../lib/auth/client-identity.js';
import {
  createDoc,
  incrementIf,
  queryDocs,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { createCoderStatusHandlers } from '../lib/labs/coder-status.js';
import { createEstateHandlers } from '../lib/labs/estate.js';
import { createPublicSubmitHandlers } from '../lib/labs/public-submit.js';
import { createResourceGraphClient } from '../lib/labs/resource-graph.js';
import { createVisitorSessionHandlers } from '../lib/labs/visitor-session.js';

const store = { queryDocs, readDoc, upsertDoc };

let arm = null;
// The status handlers also get the two conditional writes, and only those,
// so a visitor's read that reaches Coder (at most one a minute, through the
// minute cache) records Coder's answer to the status token for the health
// pulse (#1009; coder-status.js recordTokenAnswer, which writes one
// admin_config document at most hourly unless the answer changes).
const coder = () =>
  createCoderStatusHandlers({ store: { ...store, createDoc, replaceDocIfMatch } });
const estate = () =>
  createEstateHandlers({
    store,
    arm: (arm ??= createResourceGraphClient()),
    coderStatus: coder(),
  });

httpRoute('publicGetLabsEstate', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/labs/estate',
  handler: (request, context) => estate().getEstate(request, context),
});

httpRoute('publicGetLabsCoderStatus', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/labs/coder-status',
  handler: (request, context) => coder().getCoderStatus(request, context),
});

let submitHandlers = null;
const submit = () => {
  submitHandlers ??= createPublicSubmitHandlers({
    identity: createClientIdentity(),
    store: { queryDocs, readDoc, upsertDoc, createDoc, incrementIf, replaceDocIfMatch },
  });
  return submitHandlers;
};

httpRoute('publicLabsSubmit', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'public/labs/submit',
  handler: (request, context) => submit().submitRoute(request, context),
});

httpRoute('publicGetLabJob', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/labs/job',
  handler: (request, context) => submit().getJob(request, context),
});

let visitorHandlers = null;
const visitor = () => {
  visitorHandlers ??= createVisitorSessionHandlers({
    identity: createClientIdentity(),
    store: { queryDocs, readDoc, upsertDoc, createDoc, incrementIf, replaceDocIfMatch },
  });
  return visitorHandlers;
};

httpRoute('publicLabsVisitorSession', {
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'public/labs/visitor-session',
  handler: (request, context) => {
    const v = visitor();
    if (request.method === 'GET') return v.getStatus(request, context);
    if (request.method === 'POST') return v.startSession(request, context);
    if (request.method === 'DELETE') return v.stopSession(request, context);
    return { status: 405, headers: { Allow: 'GET, POST, DELETE' }, body: '' };
  },
});

