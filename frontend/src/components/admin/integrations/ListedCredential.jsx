/**
 * A credential this hub LISTS and does not hold (owner instruction
 * 2026-11-22: "if it is not needed, do not add exposure; just list when
 * possible").
 *
 * Some sign-ins the estate depends on have no Key Vault row: a key that only
 * GitHub reads, a connection the AI Engine keeps for itself, or a secret
 * Terraform makes for an outside system (Muse's Azure reader). Until now
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

/** The runbook that turns Muse's read-only Azure access on, rotates it and takes it away. */
export const MUSE_READER_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/muse-azure-reader.md';

/** Where the Terraform workspace's variables are changed and its runs are started. */
export const TFC_AZURE_VARIABLES_URL =
  'https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables';
export const TFC_AZURE_RUNS_URL = 'https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs';

/**
 * Microsoft's pages for the three "it costs nothing" facts below (opened
 * 2026-11-24): the free directory has no product charges, Azure role
 * assignments are free and included in the subscription, and querying
 * Analytics-plan logs is not charged.
 */
export const ENTRA_FREE_DOCS_URL =
  'https://learn.microsoft.com/azure/cost-management-billing/manage/microsoft-entra-id-free';
export const AZURE_RBAC_DOCS_URL =
  'https://learn.microsoft.com/azure/role-based-access-control/overview';
export const AZURE_MONITOR_COST_DOCS_URL =
  'https://learn.microsoft.com/azure/azure-monitor/fundamentals/cost-usage';

/** What the Graph permission the Terraform run identity holds allows, in Microsoft's words. */
export const GRAPH_OWNED_BY_DOCS_URL =
  'https://learn.microsoft.com/en-us/graph/permissions-reference#applicationreadwriteownedby';

/** The standards page whose "Why OIDC federation…" table lists every keyless sign-in. */
export const KEYLESS_SIGN_INS_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/standards/variables-and-secrets.md';

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

/**
 * Muse's read-only Azure sign-in (#1763, ADR 0043): a client secret Terraform
 * makes and keeps in its own state. The site never reads it. The numbers are
 * `infra/muse-reader.tf`'s (180 days to the reminder, 30 more before it stops
 * working) and the register row is `tfc-azure-muse-reader-secret`.
 */
export function MuseReaderNote() {
  return (
    <ListedCredential
      intro={
        <>
          A password for a program (a client secret) that lets Muse, the outside system that runs
          Koda, sign in to Azure as <code>sp-muse-reader-plat-prod-cus-01</code> and look at the
          evidence behind an alert: logs, alert rules, costs and resource health in the three
          subscriptions. It holds the built-in Reader role only, so it can change nothing and cannot
          read Key Vault secrets, stored files or database documents.
        </>
      }
      facts={{
        'Stored in': (
          <>
            The Terraform workspace <code>hcw-azure</code>, in its saved state, as the hidden output{' '}
            <code>muse_reader_client_secret</code>, with a copy in Muse’s own vault. Not in Key
            Vault, so it is not on the Keys tab: nothing on this site reads it, and a copy here
            would add a way in that nothing needs.
          </>
        ),
        Cost: (
          <>
            Nothing. The directory entry (
            <External href={ENTRA_FREE_DOCS_URL}>no product charges</External>) and the three Reader
            grants (<External href={AZURE_RBAC_DOCS_URL}>free with the subscription</External>) are
            not billed, and Muse’s log queries are{' '}
            <External href={AZURE_MONITOR_COST_DOCS_URL}>not charged</External> on the standard log
            tables this estate uses.
          </>
        ),
        Test: (
          <>
            This page cannot test it, because the site does not hold it. Run the last step of “Turn
            it on” in <External href={MUSE_READER_RUNBOOK_URL}>the runbook</External> (“Check the
            three grants”): three rows that each say Reader mean the access is in place. Whether the
            copy in Muse’s vault works shows only in Muse.
          </>
        ),
        Replace: (
          <>
            On <External href={TFC_AZURE_VARIABLES_URL}>the workspace’s Variables page</External>,
            raise <code>muse_reader_secret_generation</code> by one, then start a run on{' '}
            <External href={TFC_AZURE_RUNS_URL}>its Runs page</External> and confirm it. The old
            secret stops working in that run, so copy the new one into Muse’s vault straight after
            with the one line in <External href={MUSE_READER_RUNBOOK_URL}>the runbook</External>{' '}
            (“Rotate the secret”).
          </>
        ),
        Expires: (
          <>
            Each secret works for 210 days and nothing renews it. The reminder is due at day 180,
            which leaves 30 days to replace it. The date and the reminder are on the{' '}
            {credentialsTab}; record the new date there after replacing it.
          </>
        ),
      }}
    />
  );
}

/**
 * The sign-in Terraform runs with. No secret exists, so this box is here for
 * the other half of the question a card answers: what the sign-in can reach.
 * Since #1763 that includes one Microsoft Graph permission, because
 * Terraform manages Muse's app registration through Microsoft Graph. The
 * register row is `tfc-azure-dynamic-credentials`.
 */
export function TerraformRunIdentityNote() {
  return (
    <ListedCredential
      intro={
        <>
          How Terraform, the tool that builds this estate’s Azure resources, signs in when a run
          plans or applies: as the identity <code>id-plat-terraform-prod-cus-01</code>. It manages
          the Azure resources in the three subscriptions, and it holds one permission on Microsoft
          Graph (the API that directory entries are managed through),{' '}
          <External href={GRAPH_OWNED_BY_DOCS_URL}>Application.ReadWrite.OwnedBy</External>: it can
          create app registrations and change or delete only the ones it owns, which today is
          Muse’s.
        </>
      }
      facts={{
        'Stored in': (
          <>
            Nowhere: there is no password or key. HCP Terraform proves who it is to Microsoft Entra
            with a short-lived token for each run, so it is not on the Keys tab and there is nothing
            to leak. The trust is listed with the other keyless sign-ins in{' '}
            <External href={KEYLESS_SIGN_INS_URL}>the standards page</External> (“Why OIDC
            federation means zero long-lived cloud credentials”).
          </>
        ),
        Cost: 'Nothing: neither the sign-in nor the Graph permission is billed.',
        Test: (
          <>
            This page cannot test it. Every run on{' '}
            <External href={TFC_AZURE_RUNS_URL}>the workspace’s Runs page</External> is the test: a
            plan that finishes means the sign-in worked. The runbook’s first step has a read-only
            line that prints the Graph permissions it holds (
            <External href={MUSE_READER_RUNBOOK_URL}>the runbook</External>).
          </>
        ),
        Replace: (
          <>
            Nothing to replace. To take the Graph permission away, use the line under “Revoke it” in{' '}
            <External href={MUSE_READER_RUNBOOK_URL}>the runbook</External>; Terraform then can no
            longer manage Muse’s app registration.
          </>
        ),
        Expires: (
          <>It does not expire. Its row is on the {credentialsTab}, marked as renewing itself.</>
        ),
      }}
    />
  );
}
