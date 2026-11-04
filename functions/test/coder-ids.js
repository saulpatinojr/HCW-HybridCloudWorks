/**
 * Coder ids for tests. Coder's user and workspace ids are UUIDs, and the
 * visitor session broker writes nothing else into a Coder path as an id
 * (`isCoderId` in src/lib/labs/visitor-session.js, #1403), so a fixture's
 * id has to be one. `coderId(label)` turns a readable label such as `u-sess-1`
 * into the same UUID every time, so a test can still say which id it means
 * and compare two of them by their labels.
 *
 * `coderUserAnswer(url, username)` is what a fake Coder answers a
 * `GET /api/v2/users/{id}` with: the user whose id is the last part of the
 * path, under the visitor name given. The broker reads a user back that way
 * before it deletes it, so a fake that accepts every delete needs this answer
 * too.
 */
import { createHash } from 'node:crypto';

/** A UUID (version 4 shaped) made from a label; the same label gives the same id. */
export function coderId(label) {
  const hex = createHash('sha256').update(`coder-id:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Is this URL a read of one user by its id or name (`GET /api/v2/users/{user}`)? */
export function isUserRead(url, init) {
  return (init?.method ?? 'GET') === 'GET' && /\/api\/v2\/users\/[^/]+$/.test(new URL(String(url)).pathname);
}

/** The answer of a fake Coder to a read of one user: the id asked for, under the visitor name given. */
export function coderUserAnswer(url, username = 'v-0123456789ab') {
  const id = decodeURIComponent(new URL(String(url)).pathname.split('/').at(-1));
  return { ok: true, status: 200, json: async () => ({ id, username }) };
}
