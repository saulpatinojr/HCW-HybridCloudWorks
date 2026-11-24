/**
 * A lint warning fails the build (owner request 2026-11-24).
 *
 * ESLint (the tool that reads the code for mistakes) sorts what it finds into
 * errors and warnings, and by itself it only fails on errors. Until this test
 * the three `lint` scripts ran it that way, so warnings piled up unread:
 * ci.yml's own comment counted 19 at one point. Each script now passes
 * `--max-warnings 0`, which makes ESLint fail on the first warning too, in CI
 * and in a local `npm run lint` alike.
 *
 * This test keeps it that way: every package that the verify job of ci.yml
 * lints must have the flag in its `lint` script, and the job must still run
 * that script (a row that called `eslint` directly would skip the flag).
 *
 * ESLint's documentation for the flag:
 * https://eslint.org/docs/latest/use/command-line-interface#--max-warnings
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
const matrixStep = workflow.jobs.changes.steps.find((step) => step.name === 'Build the verify matrix');
const LINTED = parse(matrixStep.env.ROWS).filter((row) => row.lint);

// Read one by one, by a path written out in full, so that the guard in
// ci-filters.test.mjs can see which files this test depends on.
const PACKAGES = {
  frontend: JSON.parse(readFileSync(join(ROOT, 'frontend', 'package.json'), 'utf8')),
  functions: JSON.parse(readFileSync(join(ROOT, 'functions', 'package.json'), 'utf8')),
  scripts: JSON.parse(readFileSync(join(ROOT, 'scripts', 'package.json'), 'utf8')),
};

describe('lint warnings fail the build', () => {
  it('the verify matrix lints exactly the packages this test reads, through their lint script', () => {
    expect(LINTED.map((row) => row.dir)).toEqual(Object.keys(PACKAGES));
    for (const row of LINTED) expect(row.lint).toBe('npm run lint');
  });

  it.each(Object.keys(PACKAGES))('%s: the lint script passes --max-warnings 0', (dir) => {
    const { lint } = PACKAGES[dir].scripts;
    expect(lint).toMatch(/^eslint /);
    expect(lint).toMatch(/(^| )--max-warnings 0( |$)/);
  });
});
