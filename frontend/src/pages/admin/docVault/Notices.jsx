/**
 * The Doc Vault page's fixed words: the private line that stays on screen in
 * every state, the two states with nothing else to show (no storage yet, not
 * a publisher), and the alert strip.
 */
import React from 'react';
import { Database, Lock, ShieldAlert } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { PRIVATE_BANNER } from './docVaultModel';

/** The runs list of the workspace that holds the estate's Terraform (docs/runbooks/doc-vault.md). */
const RUNS_URL = 'https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs';

/** "Private. Only signed-in admins see this. Never shown on the public site." */
export function PrivateBanner() {
  return (
    <p
      role="note"
      className="flex items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-100"
    >
      <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
      {PRIVATE_BANNER}
    </p>
  );
}

/** The state before the doc_vault container exists: what it is and the one step that fixes it. */
export function NotProvisioned({ onRetry }) {
  return (
    <EmptyState
      icon={Database}
      title="The Doc Vault has no storage yet"
      onRetry={onRetry}
      description={
        <>
          The vault keeps its documents in its own Cosmos DB container, <code>doc_vault</code>. The
          page and its API are deployed, but the container is created by a Terraform apply, and that
          is the owner&apos;s to confirm. In{' '}
          <a href={RUNS_URL} target="_blank" rel="noopener noreferrer" className="underline">
            HCP Terraform (opens in a new tab)
          </a>
          , open the latest run for the main branch, check that it adds one resource (
          <code>doc_vault</code>) and changes or destroys nothing, then confirm it. When it has
          applied, press Try again. The steps are in <code>docs/runbooks/doc-vault.md</code>.
        </>
      }
    />
  );
}

/** What a signed-in editor or viewer sees: why, and nothing requested for them. */
export function NeedsPublisher() {
  return (
    <EmptyState
      icon={ShieldAlert}
      title="The Doc Vault is for publishers and above"
      description="It holds private letters, applications and notes, so it needs the publisher role. Ask the owner if you need access."
    />
  );
}

/** A refusal or a lost race, in a strip above the columns. */
export function Alert({ tone = 'error', children }) {
  const toneClass =
    tone === 'conflict'
      ? 'border-amber-500/50 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
      : 'border-destructive/50 bg-destructive/10 text-destructive';
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm ${toneClass}`}
    >
      {children}
    </div>
  );
}
