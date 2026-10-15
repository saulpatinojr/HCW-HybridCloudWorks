/**
 * `callMcpTool` — the server-side tool call a job makes with the stored
 * credential (#442). The proxy handler is a wrapper over it, so the two
 * assertions that matter are that it answers the same outcomes the proxy
 * answered before the extraction, and that a rejected credential is
 * reported as `UNAUTHENTICATED` rather than as a generic failure.
 */
import { describe, expect, it, vi } from "vitest";
import { callMcpTool } from "./mcp.js";

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  text: async () => JSON.stringify(body),
});

const server = {
  id: "plaud",
  url: "https://mcp.plaud.test/mcp",
  transport: "http",
  enabled: true,
  oauthToken: "stored-oauth",
};
const store = (doc = server) => ({ readDoc: vi.fn(async () => doc) });
const quiet = { warn: vi.fn(), error: vi.fn() };

describe("callMcpTool", () => {
  it("calls the tool with the stored OAuth token and returns the text plus raw result", async () => {
    const fetch = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe("Bearer stored-oauth");
      expect(JSON.parse(options.body)).toMatchObject({
        method: "tools/call",
        params: { name: "get_transcript", arguments: { file_id: "rec-1" } },
      });
      return response({
        jsonrpc: "2.0",
        result: { content: [{ type: "text", text: '{"segments":[]}' }] },
      });
    });
    const out = await callMcpTool({
      store: store(),
      serverId: "plaud",
      tool: "get_transcript",
      arguments: { file_id: "rec-1" },
      env: {},
      fetch,
      log: quiet,
    });
    expect(out).toEqual({
      ok: true,
      result: '{"segments":[]}',
      raw: { content: [{ type: "text", text: '{"segments":[]}' }] },
      httpStatus: 200,
    });
  });

  it("logs an upstream failure as server, tool, status and message — never the response body", async () => {
    // A tool call's error body can be the tool's output: a transcript. The
    // log must carry none of it.
    const secret = "Speaker 1: the quarterly numbers are confidential";
    const fetch = vi.fn(async () =>
      response({ error: "server_error", error_description: secret, content: secret }, 500),
    );
    const log = { warn: vi.fn(), error: vi.fn() };
    const out = await callMcpTool({
      store: store(),
      serverId: "plaud",
      tool: "get_transcript",
      arguments: { file_id: "rec-1" },
      env: {},
      fetch,
      log,
    });

    expect(out.ok).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    const call = log.error.mock.calls[0];
    // One string argument, not an error object with `responseBody` on it.
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
    expect(call[0]).toBe(
      "[mcp] upstream call failed: server=plaud tool=get_transcript status=500 MCP server returned HTTP 500",
    );
    const logged = JSON.stringify(log.error.mock.calls) + JSON.stringify(log.warn.mock.calls);
    for (const fragment of ["Speaker 1", "quarterly", "confidential", "responseBody"]) {
      expect(logged).not.toContain(fragment);
    }
  });

  it("logs a configuration read failure as server, code and message only", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const failing = {
      readDoc: vi.fn(async () => {
        throw Object.assign(new Error("Request rate is large"), {
          code: 429,
          body: '{"oauthToken":"stored-oauth"}',
        });
      }),
    };
    const out = await callMcpTool({ store: failing, serverId: "plaud", tool: "t", env: {}, log });
    expect(out).toMatchObject({ ok: false, httpStatus: 500 });
    expect(log.error.mock.calls[0]).toEqual([
      "[mcp] configuration read failed: server=plaud code=429 Request rate is large",
    ]);
  });

  it("reports a rejected credential as UNAUTHENTICATED without leaking it", async () => {
    const fetch = vi.fn(async () => response({ error: "invalid_token" }, 401));
    const out = await callMcpTool({
      store: store(),
      serverId: "plaud",
      tool: "get_file",
      arguments: {},
      env: {},
      fetch,
      log: quiet,
    });
    expect(out).toMatchObject({ ok: false, code: "UNAUTHENTICATED", httpStatus: 200 });
    expect(JSON.stringify(out)).not.toContain("stored-oauth");
  });

  it("answers the proxy's statuses for a missing, disabled or malformed server without calling it", async () => {
    const fetch = vi.fn();
    const at = (doc, over = {}) =>
      callMcpTool({ store: store(doc), serverId: "plaud", tool: "t", fetch, env: {}, log: quiet, ...over });
    expect(await at(null)).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await at({ ...server, enabled: false })).toMatchObject({ ok: false, httpStatus: 403 });
    expect(await at({ ...server, url: "ftp://x" })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await at(server, { arguments: [] })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await at(server, { tool: "" })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces a JSON-RPC error by its code and an isError result with the tool's output", async () => {
    // The server's own error sentence stays out of the outcome (#945); the
    // JSON-RPC code says which error it was.
    const errored = vi.fn(async () =>
      response({ jsonrpc: "2.0", error: { code: -32000, message: "CLIENT_USER_AUTH_REVOKED" } }),
    );
    expect(
      await callMcpTool({ store: store(), serverId: "plaud", tool: "t", fetch: errored, env: {}, log: quiet }),
    ).toEqual({
      ok: false,
      error: "The MCP server answered the call with an error.",
      code: -32000,
      httpStatus: 200,
    });

    // A code that is not one (a sentence where the number belongs) is not kept.
    const sentenceCode = vi.fn(async () =>
      response({ jsonrpc: "2.0", error: { code: "token abc expired for user ana@example.com", message: "x" } }),
    );
    expect(
      await callMcpTool({ store: store(), serverId: "plaud", tool: "t", fetch: sentenceCode, env: {}, log: quiet }),
    ).toMatchObject({ ok: false, code: null });

    const isError = vi.fn(async () =>
      response({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "no such file" }] } }),
    );
    expect(
      await callMcpTool({ store: store(), serverId: "plaud", tool: "t", fetch: isError, env: {}, log: quiet }),
    ).toEqual({ ok: false, error: "no such file", httpStatus: 200 });
  });
});
