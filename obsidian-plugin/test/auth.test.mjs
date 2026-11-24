import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../src/auth.js";
import { createMsalNetworkClient } from "../src/auth-network.js";

test("a refused device-code request fails with Entra's reason and opens no dialog", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const localAppData = process.env.LOCALAPPDATA;
  Object.defineProperty(process, "platform", { value: "win32" });
  process.env.LOCALAPPDATA = await mkdtemp(join(tmpdir(), "hcw-brain-auth-"));
  try {
    const network = createMsalNetworkClient(async () => ({
      status: 400,
      headers: {},
      json: {
        error: "invalid_scope",
        error_description: "AADSTS70011: The provided value for scope is not valid.",
      },
    }));
    let dialogs = 0;
    const auth = await createAuth(
      {
        tenantId: "00000000-0000-0000-0000-000000000001",
        clientId: "00000000-0000-0000-0000-000000000002",
        audience: "00000000-0000-0000-0000-000000000003",
      },
      () => {
        dialogs++;
        return () => {};
      },
      { networkClient: network, helperPath: "C:\\synthetic\\dpapi.ps1" },
    );
    await assert.rejects(auth.token(true), (error) => {
      assert.equal(error.stage, "device code request");
      assert.match(error.message, /did not issue a sign-in code/);
      assert.match(error.detail, /devicecode: HTTP 400 invalid_scope AADSTS70011/);
      return true;
    });
    assert.equal(dialogs, 0);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
  }
});
