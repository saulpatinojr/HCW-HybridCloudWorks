import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function WorkspaceHome({
  notes,
  collections,
  status,
  busy,
  onRefresh,
  onReindex,
  children,
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['Ideas in your loaded inbox', notes.filter((n) => n.inbox).length],
          ['Topics & projects loaded', collections.length],
          ['Index status', status.indexing?.status || 'Not started'],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border bg-card p-5">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Resume your work</h2>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {children}
      <section className="space-y-3 rounded-xl border p-5">
        <h2 className="font-semibold">Connected content & Obsidian</h2>
        <p className="text-sm text-muted-foreground">
          Search index: {status.indexing?.count || 0} records processed
          {status.indexing?.completedAt
            ? ` · Last completed ${new Date(status.indexing.completedAt).toLocaleString()}`
            : ''}
          . New changes are reconciled every 15 minutes.
        </p>
        <Button variant="outline" disabled={busy} onClick={onReindex}>
          Index creator content
        </Button>
        <p className="text-sm">
          Obsidian last completed:{' '}
          {status.sync?.lastSuccessfulSync
            ? new Date(status.sync.lastSuccessfulSync).toLocaleString()
            : 'Not yet connected'}
        </p>
        {status.sync && (
          <p className="text-sm text-muted-foreground">
            Last reported: {status.sync.pending} pending · {status.sync.conflicts} conflicts ·{' '}
            {status.sync.error === 'none' ? 'Connected' : 'Sync needs attention'}. Offline devices
            cannot report fresh status.
          </p>
        )}
        <details>
          <summary className="cursor-pointer text-sm underline">
            Connect the Obsidian plugin
          </summary>
          <p className="my-2 text-sm">
            Install the HCW Second Brain desktop plugin, preview and choose notes to enroll, and
            sign in with your owner account. Sync runs while the vault is open. Conflict copies are
            retained for review.
          </p>
          <dl className="space-y-1 break-all text-xs">
            <dt>Tenant</dt>
            <dd>{status.tenantId}</dd>
            <dt>Desktop client</dt>
            <dd>{status.syncClientId || 'Not configured'}</dd>
            <dt>API audience</dt>
            <dd>{status.audience}</dd>
          </dl>
        </details>
      </section>
    </>
  );
}
