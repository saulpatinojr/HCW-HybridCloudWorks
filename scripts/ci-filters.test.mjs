/**
 * CI path filters match every cross-root file read or imported by tests (QA-4, #979).
 *
 * ## What this protects
 *
 * `.github/workflows/ci.yml` runs verify jobs across packages on pull requests
 * using `matrix.filter` regex change detection. When a pull request touches a
 * file outside a package's directory (for example, `frontend/` tests importing
 * `functions/src/lib/addons/registry.js`, or `functions/` tests importing
 * `frontend/src/lib/sourceUrl.js`), the package's verify job must run if that
 * out-of-package dependency changed.
 *
 * Before this test, filters were maintained by hand and revised at least six
 * times, with several cross-root reads drifting out of the regexes unnoticed.
 * This test derives out-of-tree dependencies from every test file across
 * packages and asserts that the CI filter for each package matches every
 * single one.
 */
import { describe, expect, it } from 'vitest';
import { COMPONENTS, deriveCrossRootReads, parseCiFilters } from './lib/ci-filters.mjs';

describe('CI filters change detection (QA-4, #979)', () => {
  const filters = parseCiFilters();

  it('declares filters for all expected matrix components in ci.yml', () => {
    for (const comp of COMPONENTS) {
      expect(
        filters.has(comp.dir),
        `Missing ci.yml filter for matrix row ${comp.name} (${comp.dir})`
      ).toBe(true);
    }
  });

  for (const comp of COMPONENTS) {
    describe(`matrix row: ${comp.name}`, () => {
      const crossReads = deriveCrossRootReads(comp.dir);

      it(`discovers cross-root reads and asserts ci.yml filter matches every single one`, () => {
        const compFilter = filters.get(comp.dir);
        expect(compFilter, `Filter must exist for ${comp.dir}`).toBeDefined();

        const unmatched = [];
        for (const file of crossReads) {
          if (!compFilter.regex.test(file)) {
            unmatched.push(file);
          }
        }

        expect(
          unmatched,
          `Component "${comp.name}" has test files reading out-of-package files that do not match filter "${compFilter.filter}":\n` +
            unmatched.map((f) => `  - ${f}`).join('\n')
        ).toEqual([]);
      });
    });
  }
});
