/**
 * The Doc Vault's pure half (model.js): identity, the fields a request may
 * carry, and the shapes a document is stored and shown in.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  DOCUMENT_ID_PATTERN,
  DOC_TYPES,
  EDITABLE_FIELDS,
  KEPT_VERSIONS,
  MAX_BODY_BYTES,
  MAX_LINK_CHARS,
  MAX_TAGS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  SALT_DOCUMENT_ID,
  TRASH_DAYS,
  adminIdOf,
  buildArchivedVersion,
  buildNewDocument,
  buildNextDocument,
  canonicalCategory,
  dedupeKeyOf,
  fieldsOfVersion,
  isSafeLink,
  normalizeText,
  normalizeVaultTitle,
  purgeAtOf,
  readTags,
  readVersionNumber,
  sameContent,
  toSummary,
  toVersionSummary,
  toVersionView,
  toView,
  trashCutoff,
  validateFields,
  vaultDocumentId,
  versionDocId,
} from './model.js';

const FIELDS = Object.freeze({
  title: 'Cover letter template',
  category: 'Template',
  tags: ['outreach', 'mvp'],
  body: 'Dear team,\n\nI would like to…',
  relatedLink: 'https://example.com/role',
});
const NOW = new Date('2026-10-26T12:00:00.000Z');

describe('identity', () => {
  it('folds a title to its letters and digits, keeping letters outside A-Z', () => {
    expect(normalizeVaultTitle('  Cover   Letter: v2! ')).toBe('cover letter v2');
    expect(normalizeVaultTitle('Résumé — Café')).toBe('resume cafe');
    expect(normalizeVaultTitle('日本語の手紙')).toBe('日本語の手紙');
    expect(normalizeVaultTitle('ＡＢＣ １２３')).toBe('abc 123');
    expect(normalizeVaultTitle('!!! ---')).toBe('');
    expect(normalizeVaultTitle(null)).toBe('');
  });

  it('keys a document by its category and folded title, and has no key for a title with no letters', () => {
    expect(dedupeKeyOf('Letter', 'Cover letter!')).toBe('letter|cover letter');
    expect(dedupeKeyOf('Letter', 'COVER   LETTER')).toBe(dedupeKeyOf('Letter', 'cover letter'));
    expect(dedupeKeyOf('Template', 'Cover letter')).not.toBe(dedupeKeyOf('Letter', 'Cover letter'));
    expect(dedupeKeyOf('Letter', '--')).toBeNull();
  });

  const SALT = 'a'.repeat(64);

  it('derives a stable, UUID-shaped id from the key and the salt', () => {
    const id = vaultDocumentId('letter|cover letter', SALT);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(vaultDocumentId('letter|cover letter', SALT)).toBe(id);
    expect(vaultDocumentId('letter|other', SALT)).not.toBe(id);
  });

  it('gives a different id under another salt, so an id cannot be checked against a guessed title', () => {
    const id = vaultDocumentId('letter|cover letter', SALT);
    expect(vaultDocumentId('letter|cover letter', 'b'.repeat(64))).not.toBe(id);
    // The old derivation, a plain hash of the key, is not what is used any more.
    const plain = createHash('sha1').update('doc-vault:letter|cover letter').digest('hex');
    expect(id.replace(/-/g, '')).not.toBe(plain.slice(0, 32));
  });

  it('pins one derived id, because changing the derivation makes the next upload of a document a duplicate', () => {
    expect(vaultDocumentId('letter|cover letter', SALT)).toBe('65366fec-6676-500f-a584-aedcce98b4ad');
  });

  it('refuses to derive an id without a real salt', () => {
    for (const salt of [undefined, null, '', 'short', 12345]) {
      expect(() => vaultDocumentId('letter|cover letter', salt), String(salt)).toThrow(/salt/);
    }
  });

  it('names the salt item with an id a document id pattern accepts, so the route has to refuse it by its type', () => {
    expect(SALT_DOCUMENT_ID).toMatch(DOCUMENT_ID_PATTERN);
    expect(DOC_TYPES.salt).toBe('salt');
  });

  it('names an earlier version with a character no document id can hold', () => {
    expect(versionDocId('abc', 3)).toBe('abc~v3');
    expect('~').not.toMatch(/[A-Za-z0-9_-]/);
  });

  it('records the admin id and never a name or an address', () => {
    expect(adminIdOf({ oid: 'o1', sub: 's1', email: 'a@b.c', name: 'A' })).toBe('o1');
    expect(adminIdOf({ sub: 's1', email: 'a@b.c' })).toBe('s1');
    expect(adminIdOf({ email: 'a@b.c' })).toBe('unknown');
    expect(adminIdOf(undefined)).toBe('unknown');
  });
});

describe('categories', () => {
  it('are the six the owner named', () => {
    expect(CATEGORIES).toEqual(['Template', 'Application', 'Letter', 'Notes', 'Reference', 'Other']);
  });

  it('are matched without regard to case, and only exactly', () => {
    expect(canonicalCategory('letter')).toBe('Letter');
    expect(canonicalCategory('  NOTES ')).toBe('Notes');
    expect(canonicalCategory('Letters')).toBeNull();
    expect(canonicalCategory('')).toBeNull();
    expect(canonicalCategory(undefined)).toBeNull();
  });
});

describe('tags', () => {
  it('accept a list or a comma-separated string, drop a leading #, and fold duplicates', () => {
    expect(readTags('a, #B, b, ,c')).toEqual(['a', 'B', 'c']);
    expect(readTags(['x', 'X', '##y'])).toEqual(['x', 'y']);
    expect(readTags(undefined)).toEqual([]);
    expect(readTags('')).toEqual([]);
  });

  it('refuse more than twelve, one over forty characters, a control character and a non-list', () => {
    expect(readTags(Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
    expect(() => readTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))).toThrow(/at most 12/);
    expect(() => readTags(['x'.repeat(MAX_TAG_CHARS + 1)])).toThrow(/at most 40/);
    expect(readTags(['x'.repeat(MAX_TAG_CHARS)])).toHaveLength(1);
    expect(() => readTags(['a\u0007b'])).toThrow(/control/);
    expect(() => readTags({ not: 'a list' })).toThrow(/list of words/);
    expect(() => readTags([1])).toThrow(/list of words/);
  });
});

describe('isSafeLink', () => {
  it.each([
    'https://example.com',
    'https://example.com/a/b?c=d#e',
    '/admin/ambassador',
    '/admin',
  ])('accepts %s', (link) => {
    expect(isSafeLink(link)).toBe(true);
  });

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>1</script>',
    '//evil.example.com',
    '/administrator',
    '/admin//x',
    '/admin\\x',
    'https://user:pass@example.com',
    'https://exa mple.com',
    'https://example.com/\nx',
    'ftp://example.com',
    'mailto:a@b.c',
    '',
    `https://example.com/${'a'.repeat(MAX_LINK_CHARS)}`,
    42,
    null,
  ])('refuses %j', (link) => {
    expect(isSafeLink(link)).toBe(false);
  });
});

describe('text', () => {
  it('is stored with LF line endings and without a byte-order mark', () => {
    expect(normalizeText('﻿a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(normalizeText('plain')).toBe('plain');
  });
});

describe('validateFields', () => {
  it('returns exactly the five editable fields, cleaned', () => {
    const fields = validateFields({
      title: '  Cover   letter  template ',
      category: 'template',
      tags: 'outreach, mvp',
      body: 'Line one\r\nLine two',
      relatedLink: ' https://example.com/role ',
    });
    expect(Object.keys(fields).sort()).toEqual([...EDITABLE_FIELDS].sort());
    expect(fields).toEqual({
      title: 'Cover letter template',
      category: 'Template',
      tags: ['outreach', 'mvp'],
      body: 'Line one\nLine two',
      relatedLink: 'https://example.com/role',
    });
  });

  it('defaults tags to none and the link to null', () => {
    const fields = validateFields({ title: 'A', category: 'Other', body: 'x' });
    expect(fields.tags).toEqual([]);
    expect(fields.relatedLink).toBeNull();
    expect(validateFields({ ...FIELDS, relatedLink: '   ' }).relatedLink).toBeNull();
  });

  it.each([null, undefined, 'text', 7, ['a']])('refuses fields that are %j', (fields) => {
    expect(() => validateFields(fields)).toThrow(/fields is required/);
  });

  it.each([
    'id',
    'docType',
    'version',
    'createdBy',
    'createdAt',
    'updatedBy',
    'deletedAt',
    'dedupeKey',
    'source',
    'bodyBytes',
    'contentStatus',
    'Live',
    'slug',
    'partitionKey',
    'ttl',
    '_etag',
    'constructor',
  ])('refuses a request that tries to set %s', (key) => {
    expect(() => validateFields({ ...FIELDS, [key]: 'x' })).toThrow(/a field a document does not have/);
  });

  it('refuses an own __proto__ key (as JSON.parse makes one) and builds the result from the five names', () => {
    const hostile = JSON.parse(
      '{"title":"A","category":"Other","body":"x","__proto__":{"isAdmin":true,"deletedAt":"x"}}'
    );
    expect(Object.keys(hostile)).toContain('__proto__');
    expect(() => validateFields(hostile)).toThrow(/a field a document does not have/);
    expect({}.isAdmin).toBeUndefined();
    expect(Object.prototype.isAdmin).toBeUndefined();
  });

  it('requires a title with a letter or digit, of at most 200 characters, with no control characters', () => {
    expect(() => validateFields({ ...FIELDS, title: undefined })).toThrow(/title is required/);
    expect(() => validateFields({ ...FIELDS, title: '   ' })).toThrow(/title is required/);
    expect(() => validateFields({ ...FIELDS, title: 42 })).toThrow(/title is required/);
    expect(() => validateFields({ ...FIELDS, title: '!!!' })).toThrow(/letter or digit/);
    expect(() => validateFields({ ...FIELDS, title: 'x'.repeat(MAX_TITLE_CHARS + 1) })).toThrow(/at most 200/);
    expect(validateFields({ ...FIELDS, title: 'x'.repeat(MAX_TITLE_CHARS) }).title).toHaveLength(MAX_TITLE_CHARS);
    expect(() => validateFields({ ...FIELDS, title: 'a\u0000b' })).toThrow(/control/);
  });

  it('requires one of the six categories', () => {
    expect(() => validateFields({ ...FIELDS, category: 'Poem' })).toThrow(/category must be one of/);
    expect(() => validateFields({ ...FIELDS, category: undefined })).toThrow(/category must be one of/);
  });

  it('requires text, counts it in UTF-8 bytes, and refuses control characters but not layout', () => {
    expect(() => validateFields({ ...FIELDS, body: undefined })).toThrow(/body is required/);
    expect(() => validateFields({ ...FIELDS, body: ' \n ' })).toThrow(/body is required/);
    expect(() => validateFields({ ...FIELDS, body: 'a\u0000b' })).toThrow(/control characters/);
    expect(() => validateFields({ ...FIELDS, body: 'a\u001bb' })).toThrow(/control characters/);
    expect(validateFields({ ...FIELDS, body: 'a\tb\nc' }).body).toBe('a\tb\nc');
    expect(validateFields({ ...FIELDS, body: 'x'.repeat(MAX_BODY_BYTES) }).body).toHaveLength(MAX_BODY_BYTES);
    expect(() => validateFields({ ...FIELDS, body: 'x'.repeat(MAX_BODY_BYTES + 1) })).toThrow(/over 256 KB/);
    // 100,000 three-byte characters are 300,000 bytes: over the cap though only 100,000 long.
    expect(() => validateFields({ ...FIELDS, body: '€'.repeat(100_000) })).toThrow(/over 256 KB/);
  });

  it('refuses a link that is not https or an /admin route, in plain words', () => {
    expect(() => validateFields({ ...FIELDS, relatedLink: 'javascript:alert(1)' })).toThrow(/https address/);
    expect(() => validateFields({ ...FIELDS, relatedLink: 5 })).toThrow(/relatedLink must be text/);
    expect(validateFields({ ...FIELDS, relatedLink: '/admin/doc-vault' }).relatedLink).toBe('/admin/doc-vault');
  });

  it('throws only authored errors, whose sentences name the rule and never echo the text', () => {
    const body = 'SECRET-BODY-TEXT\u0000';
    let caught;
    try {
      validateFields({ ...FIELDS, body });
    } catch (error) {
      caught = error;
    }
    expect(caught?.name).toBe('DocVaultInputError');
    expect(caught.message).not.toContain('SECRET-BODY-TEXT');
  });
});

describe('sameContent', () => {
  const stored = { ...FIELDS };

  it('is true for the same title, category, tags, text and link, a missing link and a null one being the same', () => {
    expect(sameContent(stored, { ...FIELDS })).toBe(true);
    expect(sameContent({ ...stored, relatedLink: undefined }, { ...FIELDS, relatedLink: null })).toBe(true);
  });

  it.each([
    ['title', { title: 'Another' }],
    ['category', { category: 'Letter' }],
    ['tags', { tags: ['x'] }],
    ['body', { body: 'changed' }],
    ['link', { relatedLink: null }],
  ])('is false when the %s differs', (_name, change) => {
    expect(sameContent(stored, { ...FIELDS, ...change })).toBe(false);
  });
});

describe('the stored shapes', () => {
  const admin = 'admin-1';
  const created = buildNewDocument({
    id: 'doc-1',
    fields: FIELDS,
    source: 'pasted',
    adminId: admin,
    now: NOW,
  });

  it('a new document is version 1, carries who and when, and nothing a public read keys on', () => {
    expect(created).toEqual({
      id: 'doc-1',
      docType: DOC_TYPES.document,
      title: FIELDS.title,
      category: 'Template',
      tags: ['outreach', 'mvp'],
      body: FIELDS.body,
      bodyBytes: Buffer.byteLength(FIELDS.body, 'utf8'),
      source: 'pasted',
      relatedLink: FIELDS.relatedLink,
      dedupeKey: 'template|cover letter template',
      version: 1,
      restoredFromVersion: null,
      createdAt: NOW.toISOString(),
      createdBy: admin,
      updatedAt: NOW.toISOString(),
      updatedBy: admin,
      deletedAt: null,
      deletedBy: null,
    });
    for (const key of ['Live', 'live', 'contentStatus', 'Status', 'slug', 'public', 'published', 'partitionKey']) {
      expect(Object.keys(created)).not.toContain(key);
    }
  });

  it('the next document bumps the version, keeps the creator, and leaves Trash', () => {
    const later = new Date(NOW.getTime() + 60_000);
    const current = { ...created, _etag: '"e1"', deletedAt: '2026-10-20T00:00:00.000Z', deletedBy: 'x' };
    const next = buildNextDocument({
      current,
      fields: { ...FIELDS, title: 'Cover letter v2', body: 'new' },
      source: 'uploaded',
      adminId: 'admin-2',
      now: later,
      restoredFromVersion: 1,
    });
    expect(next).toMatchObject({
      id: 'doc-1',
      version: 2,
      title: 'Cover letter v2',
      body: 'new',
      bodyBytes: 3,
      source: 'uploaded',
      dedupeKey: 'template|cover letter v2',
      restoredFromVersion: 1,
      createdAt: NOW.toISOString(),
      createdBy: admin,
      updatedAt: later.toISOString(),
      updatedBy: 'admin-2',
      deletedAt: null,
      deletedBy: null,
      _etag: '"e1"',
    });
  });

  it('an archived version is the document as it stood, under a version id', () => {
    const archived = buildArchivedVersion({ ...created, version: 4, restoredFromVersion: 2 });
    expect(archived).toEqual({
      id: 'doc-1~v4',
      docType: DOC_TYPES.version,
      documentId: 'doc-1',
      version: 4,
      title: FIELDS.title,
      category: 'Template',
      tags: ['outreach', 'mvp'],
      body: FIELDS.body,
      bodyBytes: Buffer.byteLength(FIELDS.body, 'utf8'),
      source: 'pasted',
      relatedLink: FIELDS.relatedLink,
      restoredFromVersion: 2,
      savedAt: NOW.toISOString(),
      savedBy: admin,
    });
    expect(fieldsOfVersion(archived)).toEqual(FIELDS);
  });

  it('a list row has no text; a view has it; neither carries a stored system field but the etag', () => {
    const doc = { ...created, _etag: '"e9"', _rid: 'r', _self: 's', _ts: 1 };
    const summary = toSummary(doc);
    expect(summary).not.toHaveProperty('body');
    expect(summary).toMatchObject({ id: 'doc-1', version: 1, etag: '"e9"', deletedAt: null, purgeAt: null });
    expect(JSON.stringify(summary)).not.toContain(FIELDS.body);
    const view = toView(doc);
    expect(view.body).toBe(FIELDS.body);
    expect(view.createdBy).toBe(admin);
    expect(JSON.stringify(view)).not.toContain('"_rid"');
  });

  it('a version row has no text; a version view has it', () => {
    const archived = buildArchivedVersion(created);
    expect(toVersionSummary(archived)).not.toHaveProperty('body');
    expect(toVersionSummary(archived)).toMatchObject({ version: 1, savedAt: NOW.toISOString() });
    expect(toVersionView(archived)).toMatchObject({ body: FIELDS.body, tags: ['outreach', 'mvp'] });
  });
});

describe('versions and Trash', () => {
  it('keeps ten versions, the current one included, and thirty days of Trash', () => {
    expect(KEPT_VERSIONS).toBe(10);
    expect(TRASH_DAYS).toBe(30);
  });

  it('reads a version number only as a whole number from 1', () => {
    expect(readVersionNumber('3')).toBe(3);
    expect(readVersionNumber('10')).toBe(10);
    for (const bad of ['0', '-1', '1.5', '1e3', '', 'abc', '1 ', ' 1', '1234567', null, undefined, '٣']) {
      expect(readVersionNumber(bad), String(bad)).toBeNull();
    }
  });

  it('works out when Trash is emptied, and the oldest deletion still inside the window', () => {
    expect(purgeAtOf({ deletedAt: '2026-10-01T00:00:00.000Z' })).toBe('2026-10-31T00:00:00.000Z');
    expect(purgeAtOf({ deletedAt: null })).toBeNull();
    expect(trashCutoff(new Date('2026-10-31T00:00:00.000Z'))).toBe('2026-10-01T00:00:00.000Z');
  });
});
