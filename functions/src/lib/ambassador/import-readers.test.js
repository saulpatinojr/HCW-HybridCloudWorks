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
