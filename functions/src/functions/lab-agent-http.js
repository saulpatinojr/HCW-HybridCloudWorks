/**
 * lab-agent-http.js — the five routes the Labs VPS agent may call.
 * Registration only; semantics in lib/lab-agent.js (and, for the Coder
 * automation report, lib/labs/coder-automation.js; for a host check's
 * report, lib/labs/host-checks.js), authorization in
 * lib/auth/require-agent.js.
 *
 * These are guarded, but not by `requireRole`: the agent is a machine identity
 * with its own App Role and its own registry, disjoint from the admin gates
 * (see require-agent.js for why). The route-inventory test knows about this
 * third guard explicitly — a new guard must be added there before its routes
 * count as guarded, which is the point of that test.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { getDefaultAgentGuard } from '../lib/auth/default-agent-guard.js';
import {
  createDoc,
  queryDocs,
  readDoc,
  patchDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { createLabAgentHandlers } from '../lib/lab-agent.js';
import { createNotifier } from '../lib/notify.js';

// The notifier is how the owner hears that an agent announced its own
// shutdown (lib/lab-agent.js, heartbeat); it reads and writes the cooldown
// document in `system`, hence upsertDoc beside the agent store's verbs.
// createDoc and upsertDoc are also the Coder automation report's: the first
// write of the report document and of the secret state document (both then
// replaceDocIfMatch, under their ETags), and the audit row
// (lib/labs/coder-automation.js).
const handlers = (context) =>
  createLabAgentHandlers({
    guard: getDefaultAgentGuard(),
    store: { queryDocs, readDoc, patchDoc, replaceDocIfMatch, createDoc, upsertDoc },
    notifier: createNotifier({ store: { readDoc, upsertDoc, patchDoc }, log: context }),
  });

httpRoute('claimLabJob', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agent/claimLabJob',
  handler: (request, context) => handlers(context).claimLabJob(request, context),
});

httpRoute('heartbeatLabAgent', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agent/heartbeat',
  handler: (request, context) => handlers(context).heartbeatAgent(request, context),
});

httpRoute('completeLabJob', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agent/completeLabJob',
  handler: (request, context) => handlers(context).completeLabJob(request, context),
});

// The lab host's Coder upkeep (2026-10-08): a report, and a renewed status
// token handed over for the site to verify and store. Named after its
// handler, as claimLabJob and completeLabJob are; the lab host calls it
// through vps-agent/bin/report-coder-automation.js.
httpRoute('reportCoderAutomation', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agent/reportCoderAutomation',
  handler: (request, context) => handlers(context).reportCoderAutomation(request, context),
});

// A check the lab host runs on itself (2026-10-19, #1282): the portainer
// role's hcw-portainer-check, every fifteen minutes, through
// vps-agent/bin/report-host-check.js. Anonymous at the host level like the
// four above, because requireAgent is the guard: the body's agentId bound to
// the token's object id, active agents only. The same createDoc then
// replaceDocIfMatch pair writes its one document (lib/labs/host-checks.js).
httpRoute('reportHostCheck', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agent/reportHostCheck',
  handler: (request, context) => handlers(context).reportHostCheck(request, context),
});
