/**
 * "Claude Code" under the Anthropic card: the second credential Anthropic
 * issues to this estate, listed where the first one is (owner instruction
 * 2026-11-22).
 *
 * It is a different thing from the API key above it. The API key is read by
 * the site's own code, lives in Key Vault and is replaced on the Keys tab.
 * This one is a subscription token that only GitHub reads: it lets an
 * `@claude` comment start Claude Code in five repositories. The site never
 * holds it, on purpose: storing a copy here, or letting the site write
 * GitHub's secrets, would add a way in that nothing needs. So this box only
 * LISTS it: what it is, what it costs, how to check it, how to replace it
 * and where its renewal date is. Every line that names a place links it.
 *
 * Static on purpose: no read, no state. The facts below are the workflow's
 * (`.github/workflows/claude.yml`) and the credential register's
 * (`gh-claude-code-oauth-token`); change them together.
 */

import React from 'react';
import { Link } from 'react-router';
import { tabHref } from './tabs';

/** The five repositories that hold the token under the same secret name. */
export const CLAUDE_CODE_REPOSITORIES = Object.freeze([
  'HCW-HybridCloudWorks',
  'HCW-NetworkEyes_AddOn',
  'HCW-CloudAssessor_AddOn',
  'HCW-CloudCrawler_AddOn',
  'HCW-MigrateOrchestrator_AddOn',
]);

export const CLAUDE_CODE_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Where the owner sees every `@claude` run and whether it passed. */
export const CLAUDE_CODE_RUNS_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/claude.yml';

/** The issuer's page on how the token is made and how long it lasts. */
export const CLAUDE_CODE_TOKEN_DOCS_URL =
  'https://code.claude.com/docs/en/authentication.md#generate-a-long-lived-token';

/**
 * One PowerShell line that sets the secret in all five repositories. `gh`
 * asks for the value each time and hides the paste, so the token is never
 * on screen or in the shell's history.
 */
export const CLAUDE_CODE_ROTATE_COMMAND = `foreach ($r in '${CLAUDE_CODE_REPOSITORIES.join(
  "','"
)}') { gh secret set ${CLAUDE_CODE_SECRET} --repo "saulpatinojr/$r" }`;

const LINK = 'underline underline-offset-2 hover:text-foreground';

function External({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
    </a>
  );
}

function Fact({ label, children }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-2">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default function ClaudeCodeNote() {
  return (
    <div className="space-y-2 pb-2 pt-1 text-muted-foreground">
      <p>
        Answers an <code>@claude</code> comment on an issue or pull request in{' '}
        {CLAUDE_CODE_REPOSITORIES.length} repositories. A separate credential from the API key
        above: the site never reads it.
      </p>
      <dl className="space-y-1">
        <Fact label="Stored in">
          GitHub, as the Actions secret <code>{CLAUDE_CODE_SECRET}</code> in each repository. Not in
          Key Vault, so it is not on the Keys tab: only GitHub reads it, and a copy here would add a
          way in that nothing needs.
        </Fact>
        <Fact label="Cost">
          No bill per call. Each run uses the Claude subscription’s usage limits, and runs are set
          to the Opus model, which uses them faster.
        </Fact>
        <Fact label="Test">
          This page cannot test it, because the site does not hold it. Write an <code>@claude</code>{' '}
          comment and look for a reply, or open{' '}
          <External href={CLAUDE_CODE_RUNS_URL}>the run list</External>: a green run means the token
          signed in.
        </Fact>
        <Fact label="Replace">
          On your own computer, run <code>claude setup-token</code> (
          <External href={CLAUDE_CODE_TOKEN_DOCS_URL}>how it works</External>), then this one
          PowerShell line, pasting the new token each time it asks:
          <code className="mt-1 block select-all whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 text-[11px] text-foreground">
            {CLAUDE_CODE_ROTATE_COMMAND}
          </code>
        </Fact>
        <Fact label="Expires">
          One year after it is made. The date and the reminder are on the{' '}
          <Link to={tabHref('credentials')} className={LINK}>
            Credentials tab
          </Link>
          ; record the new date there after replacing it.
        </Fact>
      </dl>
    </div>
  );
}
