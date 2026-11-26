/**
 * What can be recorded as evidence from published content (#1897): exactly
 * what a visitor can open, by the public site's own rule and clauses, not a
 * copy of them.
 */
import { describe, it, expect } from 'vitest';
import { IMPORT_READERS, isLiveContent } from './import-readers.js';
import { SQL_NOT_SOFT_DELETED, SQL_PUBLIC_CLAUSE, isPublicDocument } from '../public-read-rules.js';

describe('the content reader', () => {
  const reader = IMPORT_READERS.content;

  it('lists live content with the public site clauses', () => {
    expect(reader.listQuery).toContain(`WHERE ${SQL_PUBLIC_CLAUSE} AND ${SQL_NOT_SOFT_DELETED}`);
    // A draft is never public, so the picker does not list one the import would refuse.
    expect(reader.listQuery).toContain(
      '(NOT IS_STRING(c.contentStatus) OR NOT (c.contentStatus IN ("drafting")))',
    );
    expect(reader.listQuery).not.toMatch(/NOT IN/);
  });

  it('accepts by id exactly what the public site shows', () => {
    const cases = [
      { contentStatus: 'published' },
      { contentStatus: 'published_blog' },
      { contentStatus: 'drafting', Live: true },
      { Live: true, softDeleteExpiresAt: '2026-12-20T00:00:00.000Z' },
      { Live: false, contentStatus: 'approved' },
    ];
    for (const doc of cases) {
      expect(reader.accepts(doc), JSON.stringify(doc)).toBe(isPublicDocument(doc));
    }
    expect(reader.accepts).toBe(isLiveContent);
  });

  it('records an older published spelling, and never a draft', () => {
    expect(isLiveContent({ contentStatus: 'published_news' })).toBe(true);
    expect(isLiveContent({ contentStatus: 'drafting', Live: true })).toBe(false);
    expect(isLiveContent(null)).toBe(false);
  });
});

describe('the import picker', () => {
  it('lists only what the import would accept, whatever shape a row has', async () => {
    const { listImportSources } = await import('./evidence.js');
    const rows = [
      { id: 'live-1', title: 'Example live piece', Live: true, contentStatus: 'published' },
      // Odd data: a status stored as a list reads as "drafting" to the public rule.
      { id: 'odd-1', title: 'Example odd row', Live: true, contentStatus: ['drafting'] },
    ];
    const ctx = {
      store: { queryDocs: async () => rows },
      listKind: async () => [],
    };
    const res = await listImportSources(ctx, { params: { sourceModule: 'content' } });
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.jsonBody || res.body;
    expect(body.items.map((item) => item.id)).toEqual(['live-1']);
  });
});
