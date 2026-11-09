/**
 * The two subscription ids are read from repository SECRETS, never from
 * repository variables (#1610).
 *
 * This repository is public, so every Actions log is public. GitHub prints a
 * step's `env:` and `with:` values in its log, and it masks a value as `***`
 * only when it came from a secret; a variable is printed as it is. Since
 * 2026-11-09 the owner keeps `SUBSCRIPTION_ID` and `SUBSCRIPTION_MGMT_ID` as
 * secrets, so a workflow that reads `vars.SUBSCRIPTION_ID` or
 * `vars.SUBSCRIPTION_MGMT_ID` would print a real id again (and, once the two
 * variables are deleted, would read an empty value). This test fails on any
 * such read in .github/workflows, comments included, and holds the script
 * that seeds the repository's variables to the same rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
const VARS_READ = /\bvars\s*\.\s*(SUBSCRIPTION_ID|SUBSCRIPTION_MGMT_ID)\b|\bvars\s*\[\s*['"](SUBSCRIPTION_ID|SUBSCRIPTION_MGMT_ID)['"]\s*\]/;

/** Each line of `text` that matches `pattern`, as `file:line: text`. */
function hits(file, text, pattern) {
  return text
    .split(/\r?\n/)
    .map((line, i) => [line, i + 1])
    .filter(([line]) => pattern.test(line))
    .map(([line, n]) => `${file}:${n}: ${line.trim()}`);
}

describe('subscription ids come from secrets, so public logs show ***', () => {
  it('finds the workflows to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no workflow reads vars.SUBSCRIPTION_ID or vars.SUBSCRIPTION_MGMT_ID', () => {
    const found = files.flatMap((file) => hits(file, readFileSync(join(WORKFLOWS, file), 'utf8'), VARS_READ));
    expect(found, 'read secrets.SUBSCRIPTION_ID / secrets.SUBSCRIPTION_MGMT_ID instead (#1610)').toEqual([]);
  });

  it('the workflows that sign in to a subscription read it from the secret', () => {
    const readers = files.filter((file) => /\$\{\{[^}]*secrets\.SUBSCRIPTION_ID\b[^}]*\}\}/.test(readFileSync(join(WORKFLOWS, file), 'utf8')));
    // A sanity floor, so a rename that drops every read is noticed: the
    // deploys, the monitors, the alert check, the Arc run and Copilot's setup.
    expect(readers.length).toBeGreaterThanOrEqual(9);
    expect(readFileSync(join(WORKFLOWS, 'verify-alert-state.yml'), 'utf8')).toContain('${{ secrets.SUBSCRIPTION_MGMT_ID }}');
  });

  it('the line that catches a variable read is not fooled by spacing', () => {
    for (const line of ['${{ vars.SUBSCRIPTION_ID }}', '${{ vars . SUBSCRIPTION_MGMT_ID }}', "${{ vars['SUBSCRIPTION_ID'] }}"]) {
      expect(VARS_READ.test(line), line).toBe(true);
    }
    for (const line of ['${{ secrets.SUBSCRIPTION_ID }}', '${{ vars.ARM_SUBSCRIPTION_ID_X }}', 'ALERT_SUBSCRIPTION_IDS']) {
      expect(VARS_READ.test(line), line).toBe(false);
    }
  });

  it('set-github-variables.ps1 no longer writes either id as a repository variable', () => {
    const script = readFileSync(join(REPO, 'scripts', 'set-github-variables.ps1'), 'utf8');
    expect(script).not.toMatch(/Set-RepoVariable\s+-Name\s+'SUBSCRIPTION(_MGMT)?_ID'/);
    expect(script).toMatch(/Set-RepoSecret\s+-Name\s+'SUBSCRIPTION_ID'/);
  });
});
