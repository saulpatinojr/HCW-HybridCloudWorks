import { test } from "node:test";
import assert from "node:assert/strict";
import { createMsalNetworkClient } from "../src/auth-network.js";

test("device-code polling preserves an authorization-pending response", async () => {
  let sent;
  const network = createMsalNetworkClient(async (request) => {
    sent = request;
    return {
      status: 400,
      headers: { "Retry-After": "5" },
      json: { error: "authorization_pending" },
    };
  });
  const result = await network.sendPostRequestAsync(
    "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=synthetic&device_code=synthetic",
    },
  );
  assert.equal(sent.throw, false);
  assert.equal(sent.method, "POST");
  assert.equal(sent.body, "grant_type=synthetic&device_code=synthetic");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "authorization_pending");
  assert.equal(result.headers["retry-after"], "5");
});

test("authority discovery uses the host transport without a request body", async () => {
  const network = createMsalNetworkClient(async (request) => {
    assert.equal(request.method, "GET");
    assert.equal(Object.hasOwn(request, "body"), false);
    return { status: 200, headers: {}, json: { issuer: "synthetic" } };
  });
  assert.equal(
    (
      await network.sendGetRequestAsync(
        "https://login.microsoftonline.com/tenant/v2.0/.well-known/openid-configuration",
      )
    ).body.issuer,
    "synthetic",
  );
});

test("refuses unexpected authority destinations before transmitting", async () => {
  let calls = 0;
  const network = createMsalNetworkClient(async () => {
    calls++;
  });
  for (const url of [
    "http://login.microsoftonline.com/token",
    "https://example.com/token",
    "https://user:secret@login.microsoftonline.com/token",
    "https://login.microsoftonline.com:444/token",
  ]) {
    await assert.rejects(
      network.sendPostRequestAsync(url, { body: "synthetic" }),
      /HTTPS authority/,
    );
  }
  assert.equal(calls, 0);
});

test("a stalled transport returns a bounded failure", async () => {
  const network = createMsalNetworkClient(() => new Promise(() => {}), {
    timeoutMs: 10,
  });
  await assert.rejects(
    network.sendGetRequestAsync("https://login.microsoftonline.com/metadata"),
    /timed out/,
  );
});
