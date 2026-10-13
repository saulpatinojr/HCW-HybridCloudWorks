/**
 * streamyard-http.js — HTTP routes for the StreamYard On-Air webinar
 * integration (`lib/streamyard/onair.js`):
 *
 *   GET  /api/cms/streamyard/status      editor  — key status + recent registrants
 *   POST /api/cms/streamyard/test-event  editor  — portal test-event simulation
 *   POST /api/streamyard/webhook         webhook — guarded by X-StreamYard-Api-Key
 *   POST /api/public/webinars/register   public  — Cloudflare-verified, quota-limited
 */
import { httpRoute } from "../lib/auth/http-route.js";
import { getDefaultGuard } from "../lib/auth/default-guard.js";
import { createClientIdentity } from "../lib/auth/client-identity.js";
import {
  createDoc,
  incrementIf,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from "../lib/cosmos-client.js";
import { createStreamYardHandlers } from "../lib/streamyard/onair.js";

const handlers = () =>
  createStreamYardHandlers({
    guard: getDefaultGuard(),
    identity: createClientIdentity(),
    store: { readDoc, upsertDoc, incrementIf, createDoc, replaceDocIfMatch },
  });

httpRoute("getStreamYardStatus", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "cms/streamyard/status",
  handler: (request, context) => handlers().getStatus(request, context),
});

httpRoute("testStreamYardEvent", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "cms/streamyard/test-event",
  handler: (request, context) => handlers().testEvent(request, context),
});

httpRoute("streamyardWebhook", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "streamyard/webhook",
  handler: (request, context) => handlers().webhook(request, context),
});

httpRoute("publicWebinarRegister", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "public/webinars/register",
  handler: (request, context) => handlers().publicRegister(request, context),
});
