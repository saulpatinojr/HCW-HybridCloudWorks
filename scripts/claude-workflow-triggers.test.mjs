/**
 * What starts `claude.yml` (the `@claude` mention workflow), read from the file.
 *
 * #1946: the workflow used to start on `pull_request_review` and
 * `pull_request_review_comment` as well. Every Copilot review started both,
 * and GitHub holds a run that Copilot starts until a person approves it
 * (https://github.blog/changelog/2025-04-15-upcoming-breaking-changes-and-releases-for-github-actions/).
 * The hold comes before any job, so the job's `if:` could not prevent it: each
 * review left a held run per line comment and a red "failure" run with no
 * jobs. No review had ever asked for `@claude`, so the two triggers were
 * removed. `@claude` still works in an issue and in any comment on an issue or
 * on a pull request's conversation tab (both are `issue_comment`).
 *
 * This test fails if either review trigger comes back. If one is really
 * needed again, read the header of claude.yml first: the red runs will return
 * with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(join(REPO, '.github', 'workflows', 'claude.yml'), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW = parseYaml(TEXT);
const JOB_IF = WORKFLOW.jobs.claude.if;
const OWNER_GATE = `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)`;

describe('claude.yml: what starts it (#1946)', () => {
  it('starts only on a new comment and on an issue opened or assigned', () => {
    expect(WORKFLOW.on).toEqual({
      issue_comment: { types: ['created'] },
      issues: { types: ['opened', 'assigned'] },
    });
  });

  it('has no review trigger, so a Copilot review starts no held or failed run', () => {
    expect(Object.keys(WORKFLOW.on)).not.toContain('pull_request_review');
    expect(Object.keys(WORKFLOW.on)).not.toContain('pull_request_review_comment');
    // The job condition names no event the workflow no longer receives.
    expect(JOB_IF).not.toMatch(/pull_request_review/);
  });

  it('still answers @claude in a comment, from the owner, a member or a collaborator only', () => {
    // issue_comment covers comments on issues and on a pull request's conversation tab.
    expect(JOB_IF).toContain("github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')");
    expect(JOB_IF).toContain(OWNER_GATE);
    expect(JOB_IF).toContain(
      `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.issue.author_association)`,
    );
  });

  it('never uses pull_request_target', () => {
    // pull_request_target runs with a token that can write, on code from a fork.
    expect(TEXT.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')).not.toContain('pull_request_target');
  });
});
