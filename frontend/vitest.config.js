/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.js',
    // POOL: vmThreads, NOT THE DEFAULT forks (#645).
    //
    // A jsdom per test file, 172 of them, was half this suite's tracked time:
    // 84.6 s wall clock with the environment at 50%. vmThreads builds one V8
    // context per worker and reuses it, which runs the same 2,272 tests in
    // 25.0 s on the same 4-core machine. CI pays this twice — the `frontend`
    // job and `coverage (qlty)` — and coverage drops 100 s to 55 s.
    //
    // WHY NOT `isolate: false`, WHICH VITEST SUGGESTS IN THE SAME BREATH. The
    // two are not the same trade, and the difference is the whole decision.
    // Measured with two test files, one mutating a shared module object and
    // setting a global, the other reporting what it inherited: under
    // `isolate: false`, once both landed in one worker, the second file saw
    // the mutation and the global. Module state crosses file boundaries there.
    // That is exactly the bug #640 was filed as — passing alone, failing in a
    // full run — and it would be nondeterministic, since whether two files
    // share a worker is a scheduling detail. vmThreads keeps per-file
    // isolation: the same probe in the same worker saw a fresh module registry
    // and no global. Speed is not worth manufacturing the bug this repository
    // has just finished proving it does not have.
    //
    // WHAT IT COST, and where it was paid. A VM context has no web-stream
    // globals and its `window.location` is non-configurable. Both were handled
    // in the places that were wrong anyway (#645): setupTests.js states the
    // streams a browser provides, scripts/audit-published-pages.test.js asks
    // for the node environment it always needed, and AuthCallbackPage.test.jsx
    // uses a real URL rather than a fabricated Location. None of the three is
    // a workaround for this pool.
    //
    // Coverage was checked, not assumed, and the check is worth stating
    // precisely. Statements, branches, functions and lines come out identical
    // under both pools, to the same numerators and denominators. The two
    // lcov.info files are NOT byte-identical: they carry the same 36,985
    // records, none present in one and missing from the other, but 398 differ
    // in HIT COUNT — `DA:34,475` against `DA:34,476`. Not one record flips
    // covered to uncovered or back, which is why the percentages match exactly
    // and why the Qlty upload below reports what it did before: it gates on
    // coverage status, not on how many times a covered line ran.
    //
    // And the pool is not what causes even that. Two runs of the SAME pool,
    // back to back, differ in 164 hit counts by the same measure — also with
    // no flips and no record present in one file and missing from the other.
    // Hit counts are run-to-run nondeterministic here whatever the pool;
    // vmThreads roughly doubles the spread and changes nothing that is gated.
    // Recorded so the next person to diff two lcov files does not go hunting
    // for a vmThreads bug that is not there.
    //
    // THE WINDOWS CRASH WAS NOT THIS POOL (#720). On Windows, `npm test` died
    // partway with 0xC0000005 under Node 24 and 26 alike, which looked like a
    // vmThreads bug. `threads` crashed too, and more often; `forks` and
    // `vmForks` never did. The cause was a native addon that pdf-parse loads,
    // @napi-rs/canvas 0.1.80, which kills the process when a worker thread
    // that loaded it exits. package.json overrides it, and
    // scripts/pdf-parse-canvas-worker.test.js holds the override. If a Windows
    // run dies that way again, run the same files with `--pool=vmForks`: it
    // keeps these VM contexts but puts each worker in a child process, so a
    // clean run there points at a native module loaded in a worker thread
    // rather than at this pool.
    pool: 'vmThreads',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/e2e/**',
      '**/tests-e2e/**',
      '**/ToDelete/**',
    ],
    // Only collected when asked for (`npm run test:coverage`, or
    // `vitest run --coverage`), so `npm test` in the required CI job is
    // unchanged. coverage.yml uploads coverage/lcov.info to Qlty (#568).
    // `projectRoot` is the repository root, so lcov.info names files as
    // `frontend/src/...` and one Qlty upload can carry frontend and functions
    // together without per-package prefix fixing.
    // `test:coverage` passes --testTimeout=30000 --hookTimeout=60000: under V8
    // coverage on a loaded machine, CertDetailPage.test.jsx's walk over every
    // landing-page slug ran past the 5 s default locally (2026-09-14). That
    // walk now states its own 30 s budget on the test itself, because the same
    // overrun reached a plain `npm test` run too (#640) — so these flags are a
    // backstop for whatever else coverage slows down, not the only thing
    // holding that one test up. They stay on the coverage script, so `npm test`
    // keeps the 5 s default for every test that has not asked for more.
    coverage: {
      provider: 'v8',
      reporter: [
        'text-summary',
        ['lcovonly', { file: 'lcov.info', projectRoot: path.resolve(import.meta.dirname, '..') }],
      ],
      thresholds: {
        lines: 75.5,
        statements: 74.0,
        functions: 69.0,
        branches: 65.0,
        autoUpdate: true,
      },
      reportsDirectory: 'coverage',
      include: ['src/**/*.{js,jsx,ts,tsx}'],
      exclude: [
        'src/**/*.test.{js,jsx,ts,tsx}',
        'src/**/*.spec.{js,jsx,ts,tsx}',
        'src/**/__tests__/**',
        'src/setupTests.js',
        'src/**/*.d.ts',
      ],
    },
  },
});
