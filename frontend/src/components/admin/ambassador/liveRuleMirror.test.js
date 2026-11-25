/**
 * "Is this piece live?" is asked twice: by the program's "File as evidence"
 * button (isLivePiece) and by the server's import, which decides
 * (isLiveContent). They must give the same answer for every shape a content
 * document can have, or the button offers a filing the import refuses
 * (reviews of #1891).
 */
import { describe, it, expect } from 'vitest';
import { isLiveContent } from '../../../../../functions/src/lib/ambassador/import-readers.js';
import { isLivePiece } from './ProgramPipeline';

const CASES = [
  { Live: true },
  { Live: false },
  { Status: 'Live' },
  { Status: 'Draft' },
  { contentStatus: 'published' },
  { contentStatus: 'published_blog' },
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
    expect(isLivePiece({ id: 'c1', ...doc })).toBe(isLiveContent({ id: 'c1', ...doc }));
  });
});
