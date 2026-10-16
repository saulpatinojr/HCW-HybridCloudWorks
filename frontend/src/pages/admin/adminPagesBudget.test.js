import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_PAGE_LINES = 600;

describe('Admin pages budget and test coverage (AP-F10)', () => {
  const adminDir = __dirname;
  const entries = fs.readdirSync(adminDir, { withFileTypes: true });

  const pageFiles = entries
    .filter(
      (entry) => entry.isFile() && /\.(jsx|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)
    )
    .map((entry) => entry.name);

  it('verifies all admin page files exist and are identified', () => {
    expect(pageFiles.length).toBeGreaterThanOrEqual(25);
  });

  pageFiles.forEach((file) => {
    describe(`file: ${file}`, () => {
      it(`does not exceed ${MAX_PAGE_LINES} lines`, () => {
        const fullPath = path.join(adminDir, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.endsWith('\n')
          ? content.slice(0, -1).split('\n')
          : content.split('\n');
        const lineCount = lines.length;
        expect(
          lineCount,
          `${file} has ${lineCount} lines, which exceeds the ${MAX_PAGE_LINES} line budget`
        ).toBeLessThanOrEqual(MAX_PAGE_LINES);
      });

      it('has a sibling test file', () => {
        const baseName = file.replace(/\.(jsx|tsx)$/, '');
        const candidateTestFiles = [
          `${baseName}.test.jsx`,
          `${baseName}.test.tsx`,
          `${baseName}.test.js`,
          `${baseName}.test.ts`,
        ];

        const hasSiblingTest = candidateTestFiles.some((testFile) =>
          fs.existsSync(path.join(adminDir, testFile))
        );

        expect(
          hasSiblingTest,
          `Expected ${file} to have a sibling test file (e.g. ${candidateTestFiles[0]})`
        ).toBe(true);
      });
    });
  });
});
