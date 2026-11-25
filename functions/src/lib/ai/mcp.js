/**
 * Server-side MCP transport for the AI Engine admin tools.
 *
 * The browser calls these handlers with its Entra bearer token. MCP
 * credentials are resolved here from Azure Function App settings / Key Vault
 * references or from the write-only oauthToken field in Cosmos DB.
 *
 * A server that signs in with the OAuth Connect flow (`usesOAuthConnect`,
 * 2026-10-08) is never called without a live connection: its access token is
 * refreshed first when it has under two minutes left, and a 401 or
 * `invalid_token` from the server earns one refresh and one retry
 * (rpcWithOAuth below; the grants themselves are mcp-oauth.js). API-key and
 * keyless servers, and Plaud's pasted token, take the path they always did.
 */
import { parseMcpResponseBody } from '../cloud-tools/mcp-parse.js';
import { AuthoredError, authoredMessage, codeShaped, errorCode, errorFacts } from '../http/error-response.js';
import {
  INTEGRATION_KEY_HOSTS,
  KNOWN_INTEGRATION_KEY_NAMES,
  MCP_KEY_ENV_PATTERN,
  TOOL_ALLOWLIST_REQUIRED_KEYS,
  mcpToolRefusal,
  readMcpSecret,
  requiresToolAllowlist,
  resolveMcpAuthHeaders,
  usesOAuthConnect,
  validateMcpAllowedTools,
  validateMcpApiKeyEnvVar,
  validateMcpKeyBinding,
  validateMcpToolPolicy,
  validateMcpUrl,
} from './mcp-policy.js';
import {
  McpOAuthNotConnectedError,
  REFRESH_SKEW_MS,
  createOAuthHttp,
  notConnectedMessage,
  oauthConnectionState,
  refreshOAuthToken,
  tokenExpiresWithin,
} from './mcp-oauth.js';

const MCP_CONTAINER = 'mcp_servers';
const SESSION_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const SSE_TIMEOUT_MS = 25_000;
const sessions = new Map();

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * A transport-level MCP failure: a timeout, an HTTP status, a stream that
 * ended. Every sentence is written in this module (authored, #945); the
 * server's body rides on `responseBody` for the OAuth error code and never
 * reaches a sentence.
 */
class McpUpstreamError extends AuthoredError {
  /**
   * @param {string} message - the authored sentence
   * @param {{ status?: number, responseBody?: string }} [options]
   */
  constructor(message, { status = 0, responseBody = '' } = {}) {
    super(message);
    this.name = 'McpUpstreamError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * The URL rule, the key-name allowlist and the credential resolution are
 * mcp-policy.js; they are re-exported so every caller keeps importing them
 * from here.
 */
export {
  INTEGRATION_KEY_HOSTS,
  KNOWN_INTEGRATION_KEY_NAMES,
  MCP_KEY_ENV_PATTERN,
  TOOL_ALLOWLIST_REQUIRED_KEYS,
  mcpToolRefusal,
  readMcpSecret,
  requiresToolAllowlist,
  resolveMcpAuthHeaders,
  usesOAuthConnect,
  validateMcpAllowedTools,
  validateMcpApiKeyEnvVar,
  validateMcpKeyBinding,
  validateMcpToolPolicy,
  validateMcpUrl,
};

function sessionFor(serverId) {
  const entry = sessions.get(serverId);
  if (entry && entry.expiresAt > Date.now()) return entry.sessionId;
  if (entry) sessions.delete(serverId);
  return null;
}

function rememberSession(serverId, sessionId) {
  if (sessionId)
    sessions.set(serverId, {
      sessionId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
}

function clearSession(serverId) {
  sessions.delete(serverId);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const parentSignal = options?.signal;
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  if (signal.aborted) {
    clearTimeout(timer);
    throw signal.reason || new McpUpstreamError(`MCP request timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
  try {
    return await fetchImpl(url, { ...options, signal });
  } catch (error) {
    if (error?.name === 'AbortError' && !parentSignal?.aborted) {
      throw new McpUpstreamError(`MCP request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getSessionId(serverId, url, authHeaders, { fetchImpl, log, timeoutMs }) {
  const cached = sessionFor(serverId);
  if (cached) return cached;

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...authHeaders,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'hcw-mcp-proxy', version: '1.0.0' },
          },
          id: -1,
        }),
      },
      timeoutMs
    );
    const sessionId =
      response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || null;
    if (sessionId) rememberSession(serverId, sessionId);
    return sessionId;
  } catch (error) {
    log.warn?.('[mcp] initialize handshake failed', {
      serverId,
      code: errorCode(error),
    });
    return null;
  }
}

async function httpRpc(serverId, url, rpcBody, authHeaders, options) {
  const { fetchImpl, log, timeoutMs } = options;
  const makeHeaders = (sessionId) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...authHeaders,
    ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}),
  });

  const post = async (sessionId) => {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: makeHeaders(sessionId),
        body: JSON.stringify(rpcBody),
      },
      timeoutMs
    );
    const responseBody = await response.text();
    return { response, responseBody };
  };

  let sessionId = sessionFor(serverId);
  let result = await post(sessionId);

  // Stateless servers work on the first request. Session-based servers often
  // signal that they need initialize with 400/404/406; retry once with the
  // negotiated session, matching the behavior of the previous implementation.
  if ([400, 404, 406].includes(result.response.status)) {
    clearSession(serverId);
    sessionId = await getSessionId(serverId, url, authHeaders, {
      fetchImpl,
      log,
      timeoutMs,
    });
    result = await post(sessionId);
  }

  if (!result.response.ok) {
    throw new McpUpstreamError(`MCP server returned HTTP ${result.response.status}`, {
      status: result.response.status,
      responseBody: result.responseBody,
    });
  }

  return parseMcpResponseBody(result.responseBody);
}

function drainSseFrames(buffer) {
  const lines = buffer.split('\n');
  const tail = lines.pop();
  const frames = [];
  let event = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) event = trimmed.slice(6).trim();
    if (trimmed.startsWith('data:')) frames.push({ event, data: trimmed.slice(5).trim() });
  }
  return { frames, tail };
}

function sseEndpoint(postUrl, frame, sseUrl) {
  if (
    postUrl ||
    !(frame.event === 'endpoint' || frame.data.startsWith('/') || frame.data.startsWith('http'))
  ) {
    return postUrl;
  }
  try {
    return new URL(frame.data, sseUrl).toString();
  } catch {
    return frame.data;
  }
}

/** Whether an SSE message endpoint is https on the stream's own origin. */
function sameOriginHttps(endpoint, sseUrl) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && url.origin === new URL(sseUrl).origin;
  } catch {
    return false;
  }
}

function matchingSseResponse(data, targetId) {
  if (!data.startsWith('{')) return null;
  try {
    const message = JSON.parse(data);
    return message.id === targetId ? message : null;
  } catch {
    return null;
  }
}

/**
 * Relay an SSE MCP connection. Firecrawl and Replicate still use the legacy
 * SSE transport in the seeded configuration, while custom servers default to
 * Streamable HTTP.
 */
function sseRpc(sseUrl, authHeaders, rpcBody, options) {
  return new Promise((resolve, reject) => {
    const session = openSseSession({ sseUrl, authHeaders, rpcBody, options, resolve, reject });
    readSseStream(session).catch((error) => {
      if (!session.settled && error?.name !== 'AbortError') session.finish(null, error);
    });
  });
}

/**
 * The state of one SSE exchange: where to POST (once the stream names it),
 * whether the request went, the unparsed tail of the stream, and `finish`,
 * which settles the exchange once and stops the stream and the timers.
 */
function openSseSession({ sseUrl, authHeaders, rpcBody, options, resolve, reject }) {
  const session = {
    sseUrl,
    authHeaders,
    rpcBody,
    options,
    controller: new AbortController(),
    postUrl: null,
    requestSent: false,
    settled: false,
    buffer: '',
    readyTimer: null,
    timeoutHandle: null,
  };
  session.finish = (result, error) => {
    if (session.settled) return;
    session.settled = true;
    clearTimeout(session.timeoutHandle);
    if (session.readyTimer) clearTimeout(session.readyTimer);
    session.controller.abort();
    if (error) reject(error);
    else resolve(result);
  };
  session.timeoutHandle = setTimeout(
    () => session.finish(null, new McpUpstreamError('SSE MCP request timed out')),
    Math.min(options.timeoutMs, SSE_TIMEOUT_MS)
  );
  return session;
}

/** POST one JSON-RPC message to the endpoint the stream named. */
async function postSse({ postUrl, authHeaders, options }, body) {
  const response = await fetchWithTimeout(
    options.fetchImpl,
    postUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(body),
    },
    options.timeoutMs
  );
  await response.text();
  if (!response.ok)
    throw new McpUpstreamError(`SSE MCP POST returned HTTP ${response.status}`, {
      status: response.status,
    });
}

/** Send the request once, after the endpoint is known; a failed POST finishes the exchange. */
async function sendSseRequest(session) {
  if (session.requestSent || session.settled || !session.postUrl) return;
  session.requestSent = true;
  try {
    // The SSE transport requires initialize and initialized before the
    // requested tools/list or tools/call message.
    await postSse(session, {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hcw-mcp-proxy', version: '1.0.0' },
      },
      id: -1,
    });
    await postSse(session, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    await postSse(session, session.rpcBody);
  } catch (error) {
    session.finish(null, error);
  }
}

/** Why the event stream cannot be read: a non-2xx answer or no readable body. Null when it can. */
function sseStreamRefusal(response) {
  if (!response.ok) {
    return new McpUpstreamError(`SSE GET returned HTTP ${response.status}`, {
      status: response.status,
    });
  }
  if (!response.body?.getReader) {
    return new McpUpstreamError('SSE server returned no readable event stream');
  }
  return null;
}

/** Open the event stream and read it until the exchange is settled. */
async function readSseStream(session) {
  const { sseUrl, authHeaders, options } = session;
  const response = await fetchWithTimeout(
    options.fetchImpl,
    sseUrl,
    {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...authHeaders,
      },
      signal: session.controller.signal,
    },
    options.timeoutMs
  );
  const refused = sseStreamRefusal(response);
  if (refused) return session.finish(null, refused);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (!session.settled) {
    const { value, done } = await reader.read();
    if (done)
      return session.finish(null, new McpUpstreamError('SSE stream ended before the MCP response'));
    session.buffer += decoder.decode(value, { stream: true });
    const drained = drainSseFrames(session.buffer);
    session.buffer = drained.tail;
    for (const frame of drained.frames) {
      if (handleSseFrame(session, frame)) return undefined;
    }
  }
  return undefined;
}

/** One frame of the stream: the endpoint, the request timing, the answer. True when it ended the exchange early. */
function handleSseFrame(session, frame) {
  session.postUrl = sseEndpoint(session.postUrl, frame, session.sseUrl);
  // An OAuth Connect token is for this server only (RFC 8707): a
  // stream that names its message endpoint on another host, or over
  // plain http, does not get it.
  if (
    session.postUrl &&
    session.options.requireSameOriginEndpoint &&
    !sameOriginHttps(session.postUrl, session.sseUrl)
  ) {
    session.finish(
      null,
      new McpUpstreamError(
        'The SSE server named a message endpoint on another host or over http; the sign-in token is not sent there'
      )
    );
    return true;
  }
  scheduleSseRequest(session, frame);
  const matched = matchingSseResponse(frame.data, session.rpcBody.id);
  if (matched) session.finish(matched, null);
  return false;
}

/** Send a second after the endpoint is known, or 50 ms after the server says it is ready. */
function scheduleSseRequest(session, frame) {
  if (!session.postUrl) return;
  if (!session.readyTimer) session.readyTimer = setTimeout(() => sendSseRequest(session), 1_000);
  if (frame.data.includes('SSE Connection established')) {
    clearTimeout(session.readyTimer);
    session.readyTimer = setTimeout(() => sendSseRequest(session), 50);
  }
}

function callMcpRpc({ serverId, url, transport, authHeaders, rpcBody, options }) {
  if (transport === 'sse') return sseRpc(url, authHeaders, rpcBody, options);
  return httpRpc(serverId, url, rpcBody, authHeaders, options);
}

function extractMcpText(rawResult) {
  if (typeof rawResult === 'string') return rawResult;
  if (Array.isArray(rawResult?.content)) {
    return rawResult.content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n');
  }
  return JSON.stringify(rawResult ?? {});
}

function normalizeMcpTools(rpcResult) {
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
function errorFields(error) {
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
 * A failed MCP call as `{ error, code }`: a credential refusal says so in a
 * fixed sentence; anything else is the transport's authored sentence or the
 * caller's fallback, never the server's own words (#945).
 *
 * @param {unknown} error - what the transport threw
 * @param {string} fallback - the caller's sentence
 * @returns {{ error: string, code: string|null }}
 */
function mcpAuthError(error, fallback) {
  const fields = errorFields(error);
  if ([401, 402, 403].includes(fields.status) || fields.upstreamError === 'invalid_token') {
    return {
      error:
        'MCP authentication failed. Check the Azure Function App setting or stored OAuth token for this server.',
      code: 'UNAUTHENTICATED',
    };
  }
  return {
    error: authoredMessage(error, fallback),
    code: null,
  };
}

function failureBody(authFailure, extra = {}) {
  return {
    ok: false,
    error: authFailure.error,
    ...(authFailure.code ? { code: authFailure.code } : {}),
    ...extra,
  };
}

async function markServerError(store, serverId, message, now) {
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
async function markServerNeedsConnection(store, serverId, message, now) {
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
async function loadMcpServer(store, serverId, onReadError) {
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

/** The server's URL under the URL rule and the key-name allowlist, or the message refusing it. */
function validatedMcpUrl(server) {
  try {
    const url = validateMcpUrl(server.url);
    validateMcpKeyBinding({ url, apiKeyEnvVar: server.apiKeyEnvVar });
    return { url };
  } catch (error) {
    return { error: authoredMessage(error, 'The MCP server URL or key binding was refused.') };
  }
}

const isJsonObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * What stands between a found server and a tool call: the server must be
 * enabled, its URL and key name must pass policy, the tool must be one its
 * `allowedTools` names (#995; mcp-policy.js says when a list applies), and
 * the arguments must be a JSON object. The URL on success, the outcome on
 * refusal. The tool check is the role-independent boundary: it runs for
 * every caller, the browser proxy and the platform jobs alike.
 */
function prepareToolCall({ serverId, server, tool, toolArguments }) {
  if (server.enabled !== true) {
    return { failure: { ok: false, error: 'MCP server is disabled', httpStatus: 403 } };
  }
  const { url, error } = validatedMcpUrl(server);
  if (error) return { failure: { ok: false, error, httpStatus: 400 } };
  const refusal = mcpToolRefusal({ serverId, server, tool });
  if (refusal) return { failure: { ok: false, error: refusal, httpStatus: 403 } };
  if (!isJsonObject(toolArguments)) {
    return {
      failure: {
        ok: false,
        error: 'arguments must be a JSON object',
        httpStatus: 400,
      },
    };
  }
  return { url };
}

/**
 * The upstream told us the bearer is not (or no longer) good: a 401, or an
 * `invalid_token` in the body. A 403 is not this — a refresh does not grant
 * a scope the token was never given.
 */
function isTokenRejection(error) {
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
async function rpcWithOAuth({ serverId, server, send, options }) {
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

/** One JSON-RPC call to a configured server, with the credential it stores. */
function rpcOnServer({ serverId, server, url, rpcBody, env, options }) {
  const sendWith = (current, transportOptions) =>
    callMcpRpc({
      serverId,
      url,
      transport: server.transport || 'http',
      authHeaders: resolveMcpAuthHeaders({
        oauthToken: current.oauthToken,
        apiKeyEnvVar: current.apiKeyEnvVar,
        url,
        env,
      }),
      rpcBody,
      options: transportOptions,
    });
  const send = (current) => sendWith(current, options);
  if (!usesOAuthConnect(server)) return send(server);
  return rpcWithOAuth({
    serverId,
    server,
    send: (current) => sendWith(current, { ...options, requireSameOriginEndpoint: true }),
    options,
  });
}

/** A tools/call reply as the outcome callMcpTool reports; every shape is a 200. */
function toolCallOutcome(rpcResult) {
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

/**
 * Call one tool on one configured MCP server, server-side, with the stored
 * credential — the same transport, auth resolution and error mapping
 * `mcpProxy` uses, without the HTTP request around it.
 *
 * Extracted so a platform job can read a Plaud transcript with the token the
 * Connect tab stored (lib/podcast/recording-generate.js) instead of routing
 * through the browser proxy it cannot call. `mcpProxy` is a thin wrapper over
 * this, so the two cannot drift.
 *
 * Returns an outcome rather than throwing: `{ ok: true, result, raw }` on a
 * tool result, or `{ ok: false, error, code?, httpStatus }` where `httpStatus`
 * is what the proxy answers for that failure (404 unknown server, 403
 * disabled or a tool outside the server's allowedTools, 400 bad URL or
 * arguments, 500 configuration read failed) and 200
 * for an upstream failure the proxy reports in the body. `code` is
 * `UNAUTHENTICATED` when the upstream rejected the credential (401/402/403 or
 * `invalid_token`), or when an OAuth Connect server has no live connection,
 * which is the signal a caller uses to say "reconnect" rather than "retry".
 *
 * @param {object} params
 * @param {{ readDoc: Function, patchDoc?: Function }} params.store - patchDoc
 *   is needed only for an OAuth Connect server, whose refreshed token is stored
 * @param {string} params.serverId
 * @param {string} params.tool
 * @param {object} [params.arguments]
 * @param {object} [params.env]
 * @param {Function} [params.fetch]
 * @param {{ warn?: Function, error?: Function }} [params.log]
 * @param {number} [params.timeoutMs]
 * @param {() => Date} [params.now]
 * @param {Function} [params.oauthHttp] - mcp-oauth.js createOAuthHttp(), for tests
 * @param {Function} [params.authorize] - `({ serverId, server })` → a refusal
 *   outcome or null, run after the policy checks and before any upstream
 *   request; mcpProxy uses it to hold OAuth Connect servers to super_admin
 */
export async function callMcpTool({
  store,
  serverId: rawServerId,
  tool: rawTool,
  arguments: toolArguments = {},
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  log = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  oauthHttp = createOAuthHttp(),
  authorize = null,
}) {
  const serverId = String(rawServerId || '').trim();
  const tool = String(rawTool || '').trim();
  if (!serverId || !tool) {
    return {
      ok: false,
      error: 'serverId and tool are required',
      httpStatus: 400,
    };
  }

  const loaded = await loadMcpServer(store, serverId, (error) =>
    log.error?.(
      `[mcp] configuration read failed: ${errorFacts(error)}`
    )
  );
  if (loaded.failure) return loaded.failure;
  const { server } = loaded;

  const prepared = prepareToolCall({ serverId, server, tool, toolArguments });
  if (prepared.failure) return prepared.failure;
  if (authorize) {
    const refusal = await authorize({ serverId, server });
    if (refusal) return refusal;
  }

  try {
    const rpcResult = await rpcOnServer({
      serverId,
      server,
      url: prepared.url,
      rpcBody: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: tool, arguments: toolArguments },
        id: 2,
      },
      env,
      options: { fetchImpl, log, timeoutMs, store, now, oauthHttp },
    });
    return toolCallOutcome(rpcResult);
  } catch (error) {
    if (error instanceof McpOAuthNotConnectedError) {
      log.warn?.('[mcp] tools/call refused: the server signs in with Connect and is not connected');
      return {
        ok: false,
        error: authoredMessage(error, 'The server is not connected; press Connect on its card.'),
        code: 'UNAUTHENTICATED',
        httpStatus: 200,
      };
    }
    // Content-free on purpose: a McpUpstreamError carries `responseBody`,
    // which for a tool call can be the tool's output — a transcript — and
    // logging the error object whole would put that in Function logs. The
    // server, the tool and the error's class, code and HTTP status are all
    // an operator needs (never its message, #1794); the body reaches only the caller, through
    // `mcpAuthError`, and only as an OAuth error description.
    log.error?.(
      `[mcp] upstream call failed: server=${serverId} tool=${tool} ${errorFacts(error)}`
    );
    return {
      ...failureBody(mcpAuthError(error, 'MCP tool call failed')),
      httpStatus: 200,
    };
  }
}

/** A sync that could not reach a tool list: the server marked, the 200 saying why. */
async function syncFailed({ store, now }, serverId, message) {
  await markServerError(store, serverId, message, now);
  return json(200, { ok: false, error: message, tools: [] });
}

/** A tools/list reply as the tools it carries, or the message refusing it. */
function toolListOutcome(rpcResult) {
  // The JSON-RPC error code is kept; the server's own sentence is not (#945).
  if (rpcResult?.error) {
    return { error: `The MCP server answered tools/list with an error (code ${Number(rpcResult.error.code) || 'none'}).` };
  }
  if (!rpcResult || !Object.hasOwn(rpcResult, 'result')) {
    return { error: 'MCP server returned no tool list' };
  }
  return { tools: normalizeMcpTools(rpcResult) };
}

/**
 * tools/list on a validated server, the result stored on its document. The
 * patch names `tools` and the status fields only: a sync records what the
 * server offers and never widens `allowedTools`, which only a super_admin
 * config write sets (#995). Resolves `{ ok: true, tools }` or
 * `{ ok: false, error, code? }`; the document is marked either way.
 */
async function syncToolListOutcome(ctx, context, { serverId, server, url }) {
  const { store, env, now, transportOptions } = ctx;
  try {
    const rpcResult = await rpcOnServer({
      serverId,
      server,
      url,
      rpcBody: { jsonrpc: '2.0', method: 'tools/list', params: {}, id: 1 },
      env,
      options: transportOptions,
    });
    const outcome = toolListOutcome(rpcResult);
    if (outcome.error) {
      await markServerError(store, serverId, outcome.error, now);
      return { ok: false, error: outcome.error };
    }

    await store.patchDoc(MCP_CONTAINER, serverId, {
      tools: outcome.tools,
      status: 'connected',
      lastTested: now().toISOString(),
      lastError: null,
    });
    return { ok: true, tools: outcome.tools };
  } catch (error) {
    if (error instanceof McpOAuthNotConnectedError) {
      const notConnected = authoredMessage(error, 'The server is not connected; press Connect on its card.');
      await markServerNeedsConnection(store, serverId, notConnected, now);
      return { ok: false, error: notConnected, code: 'UNAUTHENTICATED' };
    }
    // The transport's authored sentence, or the fallback; the log line is
    // content-free (#945).
    const message = authoredMessage(error, 'MCP tool sync failed.');
    context.error?.(`[syncMcpTools] upstream call failed (${errorCode(error)})`);
    await markServerError(store, serverId, message, now);
    return failureBody(mcpAuthError(error, message));
  }
}

async function syncToolList(ctx, context, args) {
  const outcome = await syncToolListOutcome(ctx, context, args);
  return json(200, outcome.ok ? outcome : { ...outcome, tools: [] });
}

/**
 * The same tool sync the Sync Tools button runs, for a caller that already
 * holds the document — the OAuth callback runs it right after storing the
 * new token (mcp-oauth-handlers.js). Resolves `{ ok: true, tools }` or
 * `{ ok: false, error, code? }`.
 */
export async function syncMcpServerTools({
  store,
  serverId,
  server,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  log = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  oauthHttp = createOAuthHttp(),
  context = {},
}) {
  const { url, error } = validatedMcpUrl(server);
  if (error) {
    await markServerError(store, serverId, error, now);
    return { ok: false, error };
  }
  const ctx = {
    store,
    env,
    now,
    transportOptions: { fetchImpl, log, timeoutMs, store, now, oauthHttp },
  };
  return syncToolListOutcome(ctx, context, { serverId, server, url });
}

/** POST syncMcpTools: parse, find the server, check its URL, then list its tools. */
async function syncMcpTools(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const serverId = String(body?.serverId || '').trim();
  if (!serverId) return json(400, { ok: false, error: 'serverId is required' });

  const loaded = await loadMcpServer(ctx.store, serverId, (error) =>
    context.error?.('[syncMcpTools] configuration read failed:', errorFacts(error))
  );
  if (loaded.failure) {
    const { httpStatus, ...failure } = loaded.failure;
    return json(httpStatus, failure);
  }

  const { url, error } = validatedMcpUrl(loaded.server);
  if (error) return syncFailed(ctx, serverId, error);
  return syncToolList(ctx, context, { serverId, server: loaded.server, url });
}

/**
 * Create the two admin MCP handlers with injectable dependencies for tests.
 * `oauthHttp` is the request function the OAuth refresh uses
 * (mcp-oauth.js createOAuthHttp); tests pass one over their fake fetch.
 */
export function createMcpHandlers({
  guard,
  store,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  now = () => new Date(),
  log = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  oauthHttp = createOAuthHttp(),
}) {
  const ctx = {
    guard,
    store,
    env,
    now,
    transportOptions: { fetchImpl, log, timeoutMs, store, now, oauthHttp },
  };

  return {
    async mcpProxy(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;

      const body = await request.json().catch(() => null);
      const { httpStatus, ...outcome } = await callMcpTool({
        store,
        serverId: body?.serverId,
        tool: body?.tool,
        arguments: body?.arguments ?? {},
        env,
        fetch: fetchImpl,
        log: {
          warn: (...args) => log.warn?.(...args),
          error: (...args) => context.error?.('[mcpProxy]', ...args),
        },
        timeoutMs,
        now,
        oauthHttp,
        // An OAuth Connect server's token is the account a super_admin
        // signed in with — Hostinger's can change VPS, DNS and domain
        // settings — so its tools are a super_admin's to call, the same
        // role that connects it. Every other server keeps the editor gate.
        authorize: async ({ serverId, server }) => {
          if (!usesOAuthConnect(server)) return null;
          const elevated = await guard.requireRole(request, 'super_admin');
          if (!elevated.error) return null;
          return {
            ok: false,
            error: `${server.name || serverId} acts on the account a super_admin signed in with, so calling its tools needs super_admin.`,
            code: 'FORBIDDEN',
            httpStatus: 403,
          };
        },
      });
      return json(httpStatus, outcome);
    },

    syncMcpTools: (request, context) => syncMcpTools(ctx, request, context),
  };
}
