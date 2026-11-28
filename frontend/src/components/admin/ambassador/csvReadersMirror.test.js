/**
 * The import dialog's list of CSV files (CSV_IMPORTS) mirrors the API's
 * CSV_READERS (functions/src/lib/ambassador/import-readers.js): the same
 * reader ids in the same order, each with the same label and the same
 * evidence source. A reader added, renamed or relabelled on one side only
 * fails here.
 */
import { describe, it, expect } from 'vitest';
import { CSV_READERS } from '../../../../../functions/src/lib/ambassador/import-readers.js';
import { CSV_IMPORTS } from './ambassadorModel';

describe('CSV_IMPORTS mirrors the API’s CSV_READERS', () => {
  it('lists the same readers, in order, with the same label and source', () => {
    expect(CSV_IMPORTS.map((entry) => entry.reader)).toEqual(Object.keys(CSV_READERS));
    for (const entry of CSV_IMPORTS) {
      const server = CSV_READERS[entry.reader];
      expect(entry.label, entry.reader).toBe(server.label);
      expect(entry.sourceModule, entry.reader).toBe(server.sourceModule);
    }
  });
});
