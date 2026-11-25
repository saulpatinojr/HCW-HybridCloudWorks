/**
 * What the weekly Learn catalogue branch is allowed to contain (#461 item 3).
 *
 * The same tripwire as manifest-workflow.test.mjs, for the same reason: the
 * `commit` job pushes a branch with a GitHub App installation token, and the
 * pull request it opens is what a reviewer reads. `git add
 * frontend/src/data/azure/certifications.js` keeps that to one file; `-A` or
 * `.` would sweep in whatever the earlier job left in the workspace, and the
 * substitution is one character wide.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'update-learn-catalogue.yml'
);

const CATALOGUE_PATH = 'frontend/src/data/azure/certifications.js';
// The rows the updater writes, split out of CATALOGUE_PATH by #1845 so Qlty's
// duplicate finder skips them (.qlty/qlty.toml excludes that folder by name).
const GENERATED_PATH = 'frontend/src/data/azure/generated/certifications.js';
// A directory since #500: one module per guide plus index.js.
const GUIDES_PATH = 'frontend/src/data/azure/study-guides';

/** Non-comment lines only, so prose about `git add -A` cannot trip it. */
function commandLines(source) {
  return String(source)
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line));
}

describe('the Learn catalogue workflow', () => {
  const source = readFileSync(WORKFLOW, 'utf8');
  const lines = commandLines(source);

  it('runs on Mondays at 06:30 UTC and by hand', () => {
    expect(lines.some((l) => l.includes("cron: '30 6 * * 1'"))).toBe(true);
    expect(lines.some((l) => /^\s*workflow_dispatch:/.test(l))).toBe(true);
  });

  it('stages the catalogue by path', () => {
    expect(lines.some((l) => l.includes(`git add ${CATALOGUE_PATH}`))).toBe(true);
  });

  it('stages the generated catalogue rows by path too (#1845)', () => {
    expect(lines.some((l) => l.includes(`git add ${GENERATED_PATH}`))).toBe(true);
  });

  it('stages the study-guide outlines by path too (#499)', () => {
    expect(lines.some((l) => l.includes(`git add ${GUIDES_PATH}`))).toBe(true);
  });

  /**
   * #499 widened this workflow from one output to two, and the one-file scope
   * was the argument for what the App token is allowed to reach. So the guard
   * is no longer "stages the catalogue" but "stages these two and nothing
   * else": enumerating every `git add` argument makes a third output a
   * deliberate edit here rather than a line that slips in with a feature.
   * #1845 made it three: the catalogue's rows moved to their own file.
   */
  it('stages exactly those three paths and nothing else', () => {
    const staged = lines
      .filter((l) => /\bgit add\b/.test(l))
      .map((l) => l.replace(/^.*\bgit add\s+/, '').trim())
      .sort();

    expect(staged).toEqual([CATALOGUE_PATH, GENERATED_PATH, GUIDES_PATH].sort());
  });

  /**
   * #500 split the outlines into one module per guide, so a week can ADD a
   * file. `git diff --quiet` does not see an untracked file, so a change check
   * built on it would call a week whose only news is a new exam "unchanged"
   * and open no pull request. Both jobs' checks must use `git status`, which
   * does, and must name the directory rather than the old single file.
   */
  it('detects a new guide module, not just an edited one (#500)', () => {
    const checks = lines.filter(
      (l) =>
        l.includes('frontend/src/data/azure/certifications.js') && /\bgit (diff|status)\b/.test(l)
    );
    expect(checks.length, 'one change check per job').toBe(2);
    for (const check of checks) {
      expect(check).toContain('git status --porcelain');
      expect(check).toContain(GUIDES_PATH);
      expect(check).toContain(GENERATED_PATH);
    }
    expect(lines.some((l) => l.includes('study-guides.js'))).toBe(false);
  });

  it('never stages with a wildcard', () => {
    const wildcards = lines.filter((l) => /\bgit add\s+(-A\b|--all\b|\.(\s|$)|:\/)/.test(l));
    expect(wildcards, `wildcard staging found: ${wildcards.join(' | ')}`).toEqual([]);
  });

  it('never commits with -a, which stages every tracked change', () => {
    const bare = lines.filter((l) => /\bgit commit\b[^\n]*\s-(a|am|-all)\b/.test(l));
    expect(bare, `git commit -a found: ${bare.join(' | ')}`).toEqual([]);
  });

  it('masks the App token before writing it anywhere', () => {
    const maskAt = source.indexOf('::add-mask::');
    const writeAt = source.indexOf('token=${token}');
    expect(maskAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(maskAt).toBeLessThan(writeAt);
  });

  it('makes the branch name unique per attempt, not just per run', () => {
    const branchLine = lines.find((l) => l.includes('branch="chore/learn-catalogue-'));
    expect(branchLine, 'the branch name line moved or was renamed').toBeTruthy();
    expect(branchLine).toContain('GITHUB_RUN_ID');
    expect(branchLine).toContain('GITHUB_RUN_ATTEMPT');
  });

  it('opens the pull request ready for review, never as a draft', () => {
    // Owner decision 2026-09-05 (.claude/CLAUDE.md): a draft costs a round
    // trip from a phone. `gh pr create` is ready for review unless told
    // otherwise, so the assertion is the absence of the flag.
    expect(lines.some((l) => l.includes('gh pr create'))).toBe(true);
    expect(lines.filter((l) => /--draft\b/.test(l))).toEqual([]);
  });

  it('gives neither job a write permission of its own', () => {
    expect(commandLines(source).some((l) => /contents:\s*write/.test(l))).toBe(false);
    expect(commandLines(source).some((l) => /id-token:\s*write/.test(l))).toBe(false);
    const commitJob = source.slice(source.indexOf('  commit:'));
    expect(commitJob).toContain('contents: read');
  });

  it('installs the frontend tree without lifecycle scripts', () => {
    expect(lines.some((l) => l.includes('npm ci --ignore-scripts'))).toBe(true);
  });

  it('runs the commit job only when the refresh job reported a change', () => {
    // The upload is conditional on the change, so an ungated commit job fails
    // at "Artifact not found" every week the catalogue is unchanged (run
    // 34408439025, 2026-09-09). The gate is the job-level `if`, not the
    // download step, so the job shows as skipped rather than failed.
    const updateJob = source.slice(source.indexOf('  update:'), source.indexOf('  commit:'));
    const commitJob = source.slice(source.indexOf('  commit:'));
    expect(updateJob).toContain('changed: ${{ steps.changed.outputs.changed }}');
    expect(commitJob).toContain("if: needs.update.outputs.changed == 'true'");

    // Anchored on the upload ACTION, not the step's prose name. This read
    // `indexOf('Upload the refreshed catalogue')` until #499 renamed the step
    // to "... and outlines" — which kept passing only because the new name
    // happens to contain the old one as a prefix. The next rename would not be
    // so lucky, and a locator that silently points at the wrong offset is
    // worse than one that cannot be found: `indexOf` returning -1 feeds
    // `slice(-1, …)` and the failure reads as an empty string not containing
    // the gate, which says nothing about the real cause.
    const uploadAt = updateJob.indexOf('uses: actions/upload-artifact');
    expect(uploadAt, 'the upload step is gone or no longer uses upload-artifact').toBeGreaterThan(
      -1
    );

    // Backwards from the action to its own `- name:`, so the window is exactly
    // this step rather than a fixed byte count that a longer comment breaks.
    const stepStart = updateJob.lastIndexOf('      - name:', uploadAt);
    const nextStep = updateJob.indexOf('      - name:', uploadAt);
    const uploadStep = updateJob.slice(stepStart, nextStep === -1 ? undefined : nextStep);
    expect(uploadStep).toContain("if: steps.changed.outputs.changed == 'true'");
  });
});
