/**
 * "Is this piece live?" is asked in the browser (isLivePiece, lib/nextSteps.js:
 * the program's "File as evidence" button and the Pipeline's next-step link)
 * and by the server's import, which decides (isLiveContent). Both are the
 * public site's rule (isPublicDocument, #1897): a piece is live when a visitor
 * can open it. All three must give the same answer for every shape a content
 * document can have, or the button offers a filing the import refuses
 * (reviews of #1891).
 */
import { describe, it, expect } from 'vitest';
import { isLiveContent } from '../../../../../functions/src/lib/ambassador/import-readers.js';
import {
  PUBLIC_STATUSES as SERVER_PUBLIC_STATUSES,
  isPublicDocument,
} from '../../../../../functions/src/lib/public-read-rules.js';
import { PUBLIC_STATUSES, isLivePiece } from '@/lib/nextSteps';

const CASES = [
  { Live: true },
  { Live: false },
  { Status: 'Live' },
  { Status: 'Draft' },
  { contentStatus: 'published' },
  { contentStatus: 'published_blog' },
  { contentStatus: 'published_news' },
  { contentStatus: 'published_both' },
  { contentStatus: 'published_live' },
  { contentStatus: 'drafting', Live: true },
  { contentStatus: ['drafting'], Status: 'Live' },
  { contentStatus: 'published', Live: false },
  { Live: true, softDeleteExpiresAt: '2026-12-20T00:00:00.000Z' },
  { Live: true, softDeletedAt: 0 },
  { contentStatus: 'approved' },
  { contentStatus: 'forge_ready', Live: false },
  { contentStatus: 'archived', Live: true },
  { Live: true, softDeletedAt: '2026-11-20T00:00:00.000Z' },
  { Live: true, softDeletedAt: '' },
  { Live: true, softDeletedAt: false },
  { Live: true, softDeletedAt: null },
  {},
];

describe('the page and the import agree on what is live', () => {
  it.each(CASES)('%o', (doc) => {
    const piece = { id: 'c1', ...doc };
    expect(isLiveContent(piece)).toBe(isPublicDocument(piece));
    expect(isLivePiece(piece)).toBe(isPublicDocument(piece));
  });
});

describe('the published statuses', () => {
  it('are the same list in the browser and on the public site', () => {
    expect([...PUBLIC_STATUSES].sort()).toEqual([...SERVER_PUBLIC_STATUSES].sort());
  });
});
