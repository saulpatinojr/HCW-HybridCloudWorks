/**
 * A credential this hub LISTS and does not hold (owner instruction
 * 2026-11-22: "if it is not needed, do not add exposure; just list when
 * possible").
 *
 * Some sign-ins the estate depends on have no Key Vault row: a key that only
 * GitHub reads, or a connection the AI Engine keeps for itself. Until now
 * they appeared only on the Credentials tab, as a name and a date. Each gets
 * a titled box on its vendor's card, with the same five lines every time,
 * so the owner can find it where the vendor's other keys are:
 *
 *   Stored in  where the value lives, and that this tab does not hold it
 *   Cost       a bill per call, a plan's limits, or nothing
 *   Test       how to check it, or that this page cannot and what to do
 *   Replace    the shortest way to replace or reconnect it
 *   Expires    when it runs out and what renews it
 *
 * A line that does not apply SAYS so; none is left out. Static on purpose:
 * no read and no state, so listing a credential adds no way to reach it.
 * The facts are the credential register's (`register.js`); change them
 * together. `ClaudeCodeNote.jsx` is the first of these and keeps its own
 * file because it carries the one line that replaces its token.
 */

import React from 'react';
import { Link } from 'react-router';
import { tabHref } from './tabs';

const LINK = 'underline underline-offset-2 hover:text-foreground';

/** The AI Engine tab where an MCP connection is connected, tested and reconnected. */
export const MCP_SERVERS_HREF = '/admin/ai-engine?tab=mcp';

/** The runbook with the steps for the Copilot review App's key. */
export const COPILOT_REVIEW_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/copilot-code-review-mcp.md';

export const LISTED_FACT_LABELS = Object.freeze([
  'Stored in',
  'Cost',
  'Test',
  'Replace',
  'Expires',
]);

function External({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
    </a>
  );
}

function Internal({ to, children }) {
  return (
    <Link to={to} className={LINK}>
      {children}
    </Link>
  );
}

const credentialsTab = <Internal to={tabHref('credentials')}>Credentials tab</Internal>;

/** The five lines, in their fixed order; `facts` maps each label to what to show. */
export function ListedCredential({ intro, facts }) {
  return (
    <div className="space-y-2 pb-2 pt-1 text-muted-foreground">
      <p>{intro}</p>
      <dl className="space-y-1">
        {LISTED_FACT_LABELS.map((label) => (
          <div key={label} className="grid grid-cols-[5.5rem_1fr] gap-x-2">
            <dt className="font-medium text-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{facts[label]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** What the two MCP boxes share: the AI Engine keeps the connection and renews it. */
function McpConnection({ vendor, intro, cost }) {
  return (
    <ListedCredential
      intro={intro}
      facts={{
        'Stored in': (
          <>
            The site’s own database, as the AI Engine’s {vendor} connection. Not in Key Vault, so it
            is not on the Keys tab: it is a sign-in the AI Engine makes and keeps, not a key you
            paste.
          </>
        ),
        Cost: cost,
        Test: (
          <>
            Not from this card. Open{' '}
            <Internal to={MCP_SERVERS_HREF}>AI Engine → MCP Servers</Internal>: the {vendor} card
            there shows whether it is connected and has its own Test.
          </>
        ),
        Replace: (
          <>
            Nothing to paste. If it stops working, press Connect on its card under{' '}
            <Internal to={MCP_SERVERS_HREF}>AI Engine → MCP Servers</Internal> and sign in at{' '}
            {vendor} again.
          </>
        ),
        Expires: (
          <>
            The site renews it by itself before it runs out. Its dates are on the {credentialsTab}.
          </>
        ),
      }}
    />
  );
}

export function ReplicateMcpNote() {
  return (
    <McpConnection
      vendor="Replicate"
      intro="Lets the AI Engine’s assistant use Replicate’s tools (search models, start a run). A separate sign-in from the API key above."
      cost="Nothing for the connection. A tool call that runs a model is billed to the Replicate account, the same as the API key’s runs."
    />
  );
}

export function HostingerMcpNote() {
  return (
    <McpConnection
      vendor="Hostinger"
      intro="Lets the AI Engine’s assistant use Hostinger’s tools for the account that rents the lab host."
      cost="Nothing for the connection. What the tools can change (servers, domains) is billed by Hostinger as usual."
    />
  );
}

export function CopilotReviewNote() {
  return (
    <ListedCredential
      intro="A private key that lets GitHub Copilot’s code review read this repository’s CI results and security alerts while it reviews a pull request."
      facts={{
        'Stored in': (
          <>
            GitHub, as the Agents secret <code>COPILOT_REVIEW_APP_PRIVATE_KEY</code> (the
            repository’s Settings → Secrets and variables → Agents, which is a different list from
            the Actions secrets). Not in Key Vault, so it is not on the Keys tab: only GitHub reads
            it.
          </>
        ),
        Cost: 'Nothing for the key. Copilot code review itself comes with the GitHub Copilot subscription.',
        Test: (
          <>
            This page cannot test it, because the site does not hold it. Open a pull request and
            look for a Copilot review that mentions CI or alert results.
          </>
        ),
        Replace: (
          <>
            Make a new private key on the GitHub App’s settings page and store it as the Agents
            secret, then delete the old key. The steps are in{' '}
            <External href={COPILOT_REVIEW_RUNBOOK_URL}>the runbook</External> (step 4).
          </>
        ),
        Expires: (
          <>
            It does not expire by itself. The house rule is to replace it every 180 days; the date
            and the reminder are on the {credentialsTab}.
          </>
        ),
      }}
    />
  );
}
