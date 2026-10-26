/**
 * labs-http.js — Labs platform RPCs at the frontend's route names.
 * Semantics in lib/labs.js (the labs-functions.js port).
 *
 * The stub-era labs/jobs + labs/agents scaffolding routes are retired: the
 * stub accepted arbitrary job bodies with no type allowlist or payload cap —
 * a validation-free write path must not coexist with the real one (the same
 * rule as the retired cms/content raw-upsert save). submitPublicLabJob is
 * deliberately not registered — it authenticates plain (non-admin) users and
 * belongs to the frontend auth-swap phase; see lib/labs.js. The anonymous
 * public/labs/submit route (#672) is registered in labs-public-http.js,
 * closed by default.
 *
 * The lab agent registry's write path (#740), semantics in
 * lib/labs/agent-registry.js and agent-registry-rules.js: `cms/labs/agents`
 * (POST registers an agent) and `cms/labs/agents/{agentId}` (PATCH activates
 * or deactivates one; DELETE removes a deactivated one, owner request
 * 2026-09-28). Two templates, so two registrations, each through
 * httpRouteByMethod so that a later verb on either is a new key in
 * `handlers`, never a second function on the same template (T-510).
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import {
  createDoc,
  deleteDoc,
  queryDocs,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
  patchDoc,
} from '../lib/cosmos-client.js';
import { createLabHandlers } from '../lib/labs.js';
import { createAgentRegistryHandlers } from '../lib/labs/agent-registry.js';
import { createCoderStatusHandlers } from '../lib/labs/coder-status.js';
import { createCoderAutomationReadHandler } from '../lib/labs/coder-automation.js';
import { createLabStartsReadHandler } from '../lib/labs/lab-starts.js';

const handlers = () =>
  createLabHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, upsertDoc, patchDoc },
  });

const registry = () =>
  createAgentRegistryHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, createDoc, patchDoc, upsertDoc, queryDocs, deleteDoc },
  });

httpRoute('enqueueLabJob', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'enqueueLabJob',
  handler: (request, context) => handlers().enqueueLabJob(request, context),
});

httpRoute('getLabsSnapshot', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'getLabsSnapshot',
  handler: (request, context) => handlers().getLabsSnapshot(request, context),
});

httpRoute('getLabJob', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'getLabJob',
  handler: (request, context) => handlers().getLabJob(request, context),
});

httpRoute('cancelLabJob', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cancelLabJob',
  handler: (request, context) => handlers().cancelLabJob(request, context),
});

httpRouteByMethod('cmsLabAgents', {
  authLevel: 'anonymous',
  route: 'cms/labs/agents',
  handlers: {
    POST: (request, context) => registry().registerAgent(request, context),
  },
});

httpRouteByMethod('cmsLabAgent', {
  authLevel: 'anonymous',
  route: 'cms/labs/agents/{agentId}',
  handlers: {
    PATCH: (request, context) => registry().setAgentActive(request, context),
    DELETE: (request, context) => registry().removeAgent(request, context),
  },
});

// When the status token expires, for the Integrations card (#763): the
// same module as the public status read, with the editor guard. The two
// conditional writes record Coder's answer to the token for the health
// pulse (#1009, admin_config/coder_status_token).
const coderToken = () =>
  createCoderStatusHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, upsertDoc, createDoc, replaceDocIfMatch },
  });

httpRoute('cmsLabsCoderToken', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/labs/coder-token',
  handler: (request, context) => coderToken().getCoderToken(request, context),
});

// What the lab host last reported about its Coder upkeep, for the same card
// (2026-10-08): one admin_config document, written by the agent route
// agent/reportCoderAutomation. Editor, as the token read beside it is.
httpRoute('cmsLabsCoderAutomation', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/labs/coder-automation',
  handler: (request, context) =>
    createCoderAutomationReadHandler({ guard: getDefaultGuard(), store: { readDoc } })(
      request,
      context
    ),
});

// How many lab sessions the site has started for visitors, as plain counts
// per lab per UTC day (lib/labs/lab-starts.js), for the Labs hub Dashboard
// card. Editor, as the reads above. Aggregates only; the write is made by the
// visitor session broker (public/labs/visitor-session), never by this route.
httpRoute('cmsLabsStarts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/labs/starts',
  handler: (request, context) =>
    createLabStartsReadHandler({ guard: getDefaultGuard(), store: { readDoc, createDoc, queryDocs } })(
      request,
      context
    ),
});
