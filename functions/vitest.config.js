import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Test discovery is Vitest's default, exactly as it was before this file
// existed. The only setting here is coverage, which is collected only when
// asked for (`npm run test:coverage`), so `npm test` in the required
// `functions (azure)` CI job is unchanged. coverage.yml uploads
// coverage/lcov.info to Qlty (#568).
//
// `projectRoot` is the repository root, so lcov.info names files as
// `functions/src/...`. Qlty matches coverage to repository paths, and with
// both packages already repo-relative one upload carries frontend and
// functions together, with no per-file prefix fixing.
//
// `test:coverage` also passes --testTimeout=30000 --hookTimeout=60000.
// route-inventory.test.js imports every function module in one beforeAll, and
// under V8 coverage on a loaded machine that import passed Vitest's 10 s hook
// default locally (2026-09-14), failing the suite with no test at fault. The
// flags are on the coverage script only, so `npm test` keeps the defaults.
export default defineConfig({
  test: {
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: [
        'text-summary',
        ['lcovonly', { file: 'lcov.info', projectRoot: path.resolve(import.meta.dirname, '..') }],
      ],
      reportsDirectory: 'coverage',
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js', 'src/**/*.spec.js'],
    },
  },
});
