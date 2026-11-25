/**
 * mcp-calls.js — what mcp.js does with an MCP answer: the text of a tool
 * result, the tool list, the outcome of a tools/call, the fields of an
 * upstream failure, and the OAuth Connect call that refreshes a token and
 * retries once.
 */
import { parseMcpResponseBody } from '../cloud-tools/mcp-parse.js';
import { codeShaped } from '../http/error-response.js';
import {
  McpOAuthNotConnectedError,
  REFRESH_SKEW_MS,
  notConnectedMessage,
  oauthConnectionState,
  refreshOAuthToken,
  tokenExpiresWithin,
} from './mcp-oauth.js';
import { McpUpstreamError } from './mcp-transport.js';

const MCP_CONTAINER = 'mcp_servers';

export function extractMcpText(rawResult) {
  if (typeof rawResult === 'string') return rawResult;
  if (Array.isArray(rawResult?.content)) {
    return rawResult.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return JSON.stringify(rawResult ?? {});
}

export function normalizeMcpTools(rpcResult) {
  const tools = Array.isArray(rpcResult?.result?.tools) ? rpcResult.result.tools : [];
  return tools.map((tool) => ({
    name: tool.name || '',
    description: tool.description || '',
    inputSchema: tool.inputSchema || {},
  }));
}

/**
 * The status and the OAuth error code an upstream failure carries. The
 * server's `error_description` is its own sentence and is not read (#945).
 *
 * @param {unknown} error - what the transport threw
 * @returns {{ status: number|undefined, upstreamError: string|undefined }}
 */
export function errorFields(error) {
  let upstream = {};
  try {
    upstream = parseMcpResponseBody(error.responseBody || '') || {};
  } catch {
    upstream = {};
  }
  return {
    status: error.status,
    upstreamError: upstream.error,
  };
}

/**
 * The upstream told us the bearer is not (or no longer) good: a 401, or an
 * `invalid_token` in the body. A 403 is not this — a refresh does not grant
 * a scope the token was never given.
 */
export function isTokenRejection(error) {
  return (
    error instanceof McpUpstreamError &&
    (error.status === 401 || errorFields(error).upstreamError === 'invalid_token')
  );
}

/**
 * An RPC to a server that signs in with OAuth Connect. Refuses without a live
 * connection (nothing is sent tokenless); refreshes first when the access
 * token has under REFRESH_SKEW_MS left; and on a token rejection refreshes
 * once and retries once. A refresh the server refuses marks the document as
 * needing a connection (mcp-oauth.js) and surfaces as the "press Connect"
 * sentence; one that could not reach the server leaves the original failure
 * standing.
 */
export async function rpcWithOAuth({ serverId, server, send, options }) {
  const { store, now = () => new Date(), oauthHttp, log } = options;
  if (oauthConnectionState(server) !== 'connected') {
    throw new McpOAuthNotConnectedError(notConnectedMessage(server, serverId));
  }
  const refresh = (current) =>
    refreshOAuthToken({ store, serverId, server: current, http: oauthHttp, now, log });

  let current = server;
  if (tokenExpiresWithin(current, REFRESH_SKEW_MS, now)) {
    const refreshed = await refresh(current);
    if (refreshed.ok) current = refreshed.server;
    else if (refreshed.disconnected) throw new McpOAuthNotConnectedError(refreshed.sentence);
    // Transient: the stored token may still have a minute in it; try it.
  }

  try {
    return await send(current);
  } catch (error) {
    if (!isTokenRejection(error)) throw error;
    const refreshed = await refresh(current);
    if (!refreshed.ok) {
      if (refreshed.disconnected) throw new McpOAuthNotConnectedError(refreshed.sentence);
      throw error;
    }
    // One retry. A second rejection is reported as the auth failure it is.
    return send(refreshed.server);
  }
}

/** A tools/call reply as the outcome callMcpTool reports; every shape is a 200. */
export function toolCallOutcome(rpcResult) {
  if (rpcResult?.error) {
    // The JSON-RPC error code is kept, when it is one; the server's own
    // sentence is not (#945).
    const { code } = rpcResult.error;
    return {
      ok: false,
      error: 'The MCP server answered the call with an error.',
      code: Number.isInteger(code) ? code : codeShaped(code) || null,
      httpStatus: 200,
    };
  }
  if (!rpcResult || !Object.hasOwn(rpcResult, 'result')) {
    return {
      ok: false,
      error: 'MCP server returned no tool result',
      httpStatus: 200,
    };
  }
  const rawResult = rpcResult.result;
  const result = extractMcpText(rawResult);
  if (rawResult?.isError) {
    return { ok: false, error: result || 'MCP tool error', httpStatus: 200 };
  }
  return { ok: true, result, raw: rawResult, httpStatus: 200 };
}

export async function markServerError(store, serverId, message, now) {
  try {
    await store.patchDoc(MCP_CONTAINER, serverId, {
      status: 'error',
      lastTested: now().toISOString(),
      lastError: message,
    });
  } catch {
    // The upstream failure is the useful result; do not mask it with a status-write failure.
  }
}

/**
 * An OAuth server with no live connection: amber "press Connect", not a red
 * error, because nothing failed — nobody has signed in yet, or the sign-in
 * expired.
 */
export async function markServerNeedsConnection(store, serverId, message, now) {
  try {
    await store.patchDoc(MCP_CONTAINER, serverId, {
      status: 'needs_connection',
      lastTested: now().toISOString(),
      lastError: message,
    });
  } catch {
    // As above: the refusal is the useful result.
  }
}

/**
 * The configured server, or the outcome refusing the call: 500 when the
 * configuration could not be read (`onReadError` gets the error, so each
 * caller logs it its own way), 404 when there is no such server.
 */
export async function loadMcpServer(store, serverId, onReadError) {
  let server;
  try {
    server = await store.readDoc(MCP_CONTAINER, serverId, serverId);
  } catch (error) {
    onReadError(error);
    return {
      failure: {
        ok: false,
        error: 'Failed to read MCP server configuration',
        httpStatus: 500,
      },
    };
  }
  if (!server) return { failure: { ok: false, error: 'MCP server not found', httpStatus: 404 } };
  return { server };
}
