/**
 * bounded-body.js — read a JSON request body with a byte limit.
 *
 * Moved here from drafts-handlers.js so the Drafts upload and the Doc Vault
 * read a body the same way. The bytes are counted as they arrive and the read
 * is abandoned the moment the total passes `maxBytes`, so an oversize body is
 * never buffered whole or parsed. A declared Content-Length over the limit is
 * refused first, without reading anything; a missing or false one changes
 * nothing, because the count is of the bytes received. A request with no
 * readable stream (the test doubles) falls back to request.json().
 * Unparseable JSON, and JSON that is not an object, read as {}.
 *
 * Nothing here logs, and nothing here keeps the body: the caller gets the
 * parsed object or the word that it was too large.
 */

const asObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * @param {{ headers?: { get?: Function }, body?: { getReader?: Function }, json?: Function }} request
 * @param {number} maxBytes
 * @returns {Promise<{ tooLarge: true } | { tooLarge: false, body: object }>}
 */
export async function readJsonBodyWithin(request, maxBytes) {
  const declared = Number(request.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  const reader = request.body?.getReader?.();
  if (!reader) {
    return { tooLarge: false, body: asObject(await request.json().catch(() => null)) };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { tooLarge: false, body: asObject(JSON.parse(Buffer.concat(chunks).toString('utf8'))) };
  } catch {
    return { tooLarge: false, body: {} };
  }
}
