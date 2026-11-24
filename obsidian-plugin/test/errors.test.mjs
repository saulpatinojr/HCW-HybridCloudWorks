import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, failureText, safeText } from "../src/errors.js";
import { helperFailure } from "../src/cache.js";
import { createMsalNetworkClient } from "../src/auth-network.js";

const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(60)}.${"b".repeat(40)}`;

test("error text hides tokens and device codes but keeps ids and AADSTS codes", () => {
  const guid = "00000000-0000-0000-0000-000000000001";
  const text = safeText(
    `AADSTS65001: consent missing for ${guid} token ${jwt} code ${"Z9_-".repeat(30)}`,
  );
  assert.match(text, /AADSTS65001/);
  assert.match(text, new RegExp(guid));
  assert.doesNotMatch(text, /eyJ/);
  assert.doesNotMatch(text, /Z9_-Z9_-Z9_-/);
  assert.ok(safeText("x ".repeat(400)).length <= 300);
});

test("the sign-in notice names the step, the code and Microsoft's reply", () => {
  const error = Object.assign(new Error("Post request failed from the server."), {
    stage: "device code request",
    errorCode: "post_request_failed",
    detail: "Microsoft devicecode: HTTP 400 invalid_scope AADSTS70011: bad scope",
  });
  const text = failureText(error);
  assert.match(text, /^Step: device code request\./);
  assert.match(text, /post_request_failed/);
  assert.match(text, /AADSTS70011/);
  assert.equal(describeError("plain").stage, "unknown");
});

test("a helper failure names its cause without repeating stderr", () => {
  const secret = "synthetic-secret-in-stderr";
  const policy = helperFailure(
    1,
    `File dpapi.ps1 cannot be loaded because running scripts is disabled on this system. ${secret}`,
  );
  assert.equal(policy.code, "helper_execution_policy");
  assert.equal(policy.stage, "token cache (Windows encryption)");
  assert.doesNotMatch(policy.message, new RegExp(secret));
  assert.equal(helperFailure(3, "").code, "dpapi_refused");
  assert.equal(helperFailure(1, "").code, "helper_failed");
  assert.match(helperFailure(1, "").message, /exit code 1/);
});

test("the transport keeps Entra's refusal for the caller, not the polling wait", async () => {
  let reply = {
    status: 400,
    headers: {},
    json: {
      error: "invalid_client",
      error_description: "AADSTS7000218: client_secret required.\r\nTrace ID: x",
    },
  };
  const network = createMsalNetworkClient(async () => reply);
  await network.sendPostRequestAsync(
    "https://login.microsoftonline.com/tenant/oauth2/v2.0/devicecode",
    { body: "synthetic" },
  );
  assert.equal(
    network.lastFailure(),
    "Microsoft devicecode: HTTP 400 invalid_client AADSTS7000218: client_secret required.",
  );
  network.clearFailure();
  reply = { status: 400, headers: {}, json: { error: "authorization_pending" } };
  await network.sendPostRequestAsync(
    "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    { body: "synthetic" },
  );
  assert.equal(network.lastFailure(), null);
});

test("an unreadable reply and a transport failure are both reported", async () => {
  const html = createMsalNetworkClient(async () => ({
    status: 502,
    headers: {},
    get json() {
      throw new SyntaxError("Unexpected token <");
    },
  }));
  await assert.rejects(
    html.sendGetRequestAsync("https://login.microsoftonline.com/x/metadata"),
    /unreadable reply \(HTTP 502\)/,
  );
  assert.match(html.lastFailure(), /metadata: HTTP 502, reply was not JSON/);
  const down = createMsalNetworkClient(async () => {
    throw new Error("net::ERR_NAME_NOT_RESOLVED");
  });
  await assert.rejects(
    down.sendPostRequestAsync("https://login.microsoftonline.com/x/devicecode", {}),
  );
  assert.match(down.lastFailure(), /devicecode: request failed: net::ERR_NAME_NOT_RESOLVED/);
});
