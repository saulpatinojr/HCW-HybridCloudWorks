import { createHash } from 'node:crypto';
import { AuthoredError } from '../http/error-response.js';

export const RECORDS = 'brain_records';
export const SEARCH = 'brain_search';
export const SYNC_SCOPE = 'brain_sync';
export const MAX_BODY = 128 * 1024;
export const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const TYPES = ['note', 'topic', 'project', 'conflict'];
export const PRIVATE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow',
};

export class BrainError extends AuthoredError {
  constructor(status, code, message, details = {}) {
    super(message, { status, code });
    Object.assign(this, { status, code, details });
  }
}
export const fail = (status, code, message, details) => {
  throw new BrainError(status, code, message, details);
};
export const digest = (value) =>
  createHash('sha256').update(value).digest('hex');
export const sourceKey = (container, id) =>
  `ref_${digest(`${container}/${id}`).slice(0, 40)}`;
export const clean = (record) => {
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !key.startsWith('_') && key !== 'ownerId',
    ),
  );
};
export const text = (value, max = 300) =>
  typeof value === 'string' ? value.slice(0, max).trim() : '';
export const tokens = (value) =>
  [
    ...new Set(
      String(value)
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [],
    ),
  ].slice(0, 3000);

export function ownerEnabled(user, env = process.env) {
  return (
    env.BRAIN_ENABLED === 'true' &&
    Boolean(env.BRAIN_OWNER_OID && env.BRAIN_OWNER_TENANT_ID) &&
    String(user?.oid || '').toLowerCase() ===
      env.BRAIN_OWNER_OID.toLowerCase() &&
    String(user?.tid || '').toLowerCase() ===
      env.BRAIN_OWNER_TENANT_ID.toLowerCase()
  );
}

export function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail(400, 'INVALID', 'A note or collection is required.');
  if (!ID.test(input.id || ''))
    fail(400, 'INVALID', 'A stable item id is required.');
  if (
    ['state', 'indexing', 'sync-status'].includes(input.id) ||
    /^(ref|revision|mutation|event|provenance)_/.test(input.id)
  )
    fail(400, 'INVALID', 'That item id is reserved for workspace metadata.');
  if (!TYPES.includes(input.type)) fail(400, 'INVALID', 'Unknown item type.');
  if (
    typeof input.body !== 'string' ||
    Buffer.byteLength(input.body) > MAX_BODY
  )
    fail(413, 'TOO_LARGE', 'Notes may contain at most 128 KB of Markdown.');
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 300
  )
    fail(400, 'INVALID', 'A title of at most 300 characters is required.');
  const list = (key, max, check) => {
    const values = input[key] ?? [];
    if (
      !Array.isArray(values) ||
      values.length > max ||
      values.some((v) => typeof v !== 'string' || !check(v))
    )
      fail(400, 'INVALID', `Invalid ${key}.`);
    return [...new Set(values)];
  };
  const urls = list('urls', 30, (v) => {
    try {
      return (
        ['https:', 'http:'].includes(new URL(v).protocol) && v.length <= 2000
      );
    } catch {
      return false;
    }
  });
  const properties = input.properties ?? {};
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    Buffer.byteLength(JSON.stringify(properties)) > 16384
  )
    fail(400, 'INVALID', 'Note properties must be an object of at most 16 KB.');
  const checkProperties = (value, depth = 0) => {
    if (depth > 20)
      fail(400, 'INVALID', 'Note properties are nested too deeply.');
    if (value && typeof value === 'object')
      for (const [key, nested] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          fail(400, 'INVALID', 'Unsupported note property name.');
        checkProperties(nested, depth + 1);
      }
  };
  checkProperties(properties);
  if (
    properties.heading !== undefined &&
    (typeof properties.heading !== 'string' ||
      !properties.heading.trim() ||
      properties.heading.length > 80 ||
      properties.heading.trim().split(/\s+/).length > 4)
  )
    fail(
      400,
      'INVALID',
      'Use a short heading of 1–4 words and at most 80 characters.',
    );
  return {
    id: input.id,
    type: input.type,
    title: input.title.trim(),
    body: input.body,
    tags: list('tags', 30, (v) => v.length > 0 && v.length <= 60),
    links: list('links', 100, (v) => ID.test(v)),
    collections: list('collections', 50, (v) => ID.test(v)),
    urls,
    properties: JSON.parse(JSON.stringify(properties)),
    archived: input.archived === true,
    inbox: input.inbox !== false,
    ...(input.type === 'conflict' && {
      conflictOf: text(input.conflictOf, 128),
    }),
  };
}

export async function readJson(request) {
  const chunks = [];
  const reader = request.body?.getReader?.();
  if (Number(request.headers?.get?.('content-length')) > MAX_BODY + 32000)
    fail(413, 'TOO_LARGE', 'Request too large.');
  if (reader) {
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY + 32000) {
        await reader.cancel();
        fail(413, 'TOO_LARGE', 'Request too large.');
      }
      chunks.push(value);
    }
  }
  try {
    const body = reader
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : await request.json();
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Buffer.byteLength(JSON.stringify(body)) > MAX_BODY + 32000
    )
      throw new Error();
    return body;
  } catch {
    fail(400, 'INVALID', 'A valid JSON object is required.');
  }
}
