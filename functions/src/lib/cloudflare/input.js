/**
 * cloudflare/input.js — reading and refusing a request to the Cloudflare
 * page's routes (#1905): the body (read with a byte limit), the path
 * values, and the two kinds of authored refusal the routes throw.
 *
 * A Refusal is a sentence written here or in a route, with the status and
 * code to answer with (and, for a protected thing, the reason the page
 * shows). An InputError is a Refusal of the caller's own input: 400.
 * handlers.js turns either into the answer; nothing here logs.
 */
import { AuthoredError } from '../http/error-response.js';

/** The largest request body read, in bytes (a phase's rules are the big one). */
export const MAX_BODY_BYTES = 64 * 1024;

/** A refusal with a sentence of our own, its status and code, and an optional reason. */
export class Refusal extends AuthoredError {
  /**
   * @param {string} message
   * @param {{ status: number, code: string, reason?: string|null }} options
   */
  constructor(message, { status, code, reason = null }) {
    super(message, { status, code });
    this.reason = reason;
  }
}

/** Thrown for input the caller can correct; answered as 400 with the sentence. */
export class InputError extends Refusal {
  constructor(message) {
    super(message, { status: 400, code: 'BAD_REQUEST' });
  }
}

export const bad = (message) => new InputError(message);

/** A 409 refusal of something protected, with its reason. */
export const protectedRefusal = (lead, reason, code = 'CLOUDFLARE_PROTECTED') =>
  new Refusal(`${lead}: ${reason}`, { status: 409, code, reason });

export const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

export const fail = (status, code, error, extra = {}) => json(status, { ok: false, code, error, ...extra });

const TOO_LARGE = `The request body must be JSON of at most ${MAX_BODY_BYTES} bytes.`;

/**
 * The body as text, refused as soon as it passes the limit: a declared
 * Content-Length over it is refused before anything is read, and a stream is
 * counted as it arrives and dropped the moment it passes, so an oversize body
 * is never held whole or parsed. A request with no stream (the test doubles)
 * is read with text() and measured.
 */
async function boundedText(request, maxBytes) {
  const declared = Number(request.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw bad(TOO_LARGE);
  const reader = request.body?.getReader?.();
  const text = reader ? await streamText(reader, maxBytes) : await request.text();
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes) throw bad(TOO_LARGE);
  return text;
}

/** A stream read to its end as text, or a refusal once it passes maxBytes. */
async function streamText(reader, maxBytes) {
  const chunks = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw bad(TOO_LARGE);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The body's text, with any failure to read it (other than its size) as one sentence. */
async function readText(request, maxBytes) {
  try {
    return await boundedText(request, maxBytes);
  } catch (error) {
    throw error instanceof InputError ? error : bad('The request body could not be read.');
  }
}

/** The JSON object a request carries, or an InputError. */
export async function bodyOf(request, maxBytes = MAX_BODY_BYTES) {
  const text = await readText(request, maxBytes);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('The request body must be JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  return body;
}

export function refuseUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw bad(`Not a field this route takes: ${unknown.slice(0, 5).join(', ')}.`);
}

export const paramOf = (request, name) => String(request?.params?.[name] ?? '');
