/**
 * mcp-transport.js — how an MCP request travels: the deadline every request
 * carries, the transport failure it raises, and the legacy SSE relay.
 * mcp.js picks the transport and handles what comes back.
 */
import { AuthoredError } from '../http/error-response.js';

const SSE_TIMEOUT_MS = 25_000;

/**
 * A transport-level MCP failure: a timeout, an HTTP status, a stream that
 * ended. Every sentence is written in this module (authored, #945); the
 * server's body rides on `responseBody` for the OAuth error code and never
 * reaches a sentence.
 */
export class McpUpstreamError extends AuthoredError {
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

export async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
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
export function sseRpc(sseUrl, authHeaders, rpcBody, options) {
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
