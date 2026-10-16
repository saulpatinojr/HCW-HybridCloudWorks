import React, { useState } from 'react';
import RoleGate from '@/components/admin/RoleGate';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { postJSON } from '@/lib/api';
import TaxonomyPicker from '@/components/admin/shared/TaxonomyPicker';
import { formatPublishedDate, getRootDomain } from './itemHelpers';
import { Flame, Loader2, Trash2, XCircle } from 'lucide-react';

export function isValidHttpUrl(value = '') {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * "Forged today n/limit" against the autoForge daily budget (T-607). Renders
 * nothing until getForgeConfig has answered; the meter reads the same
 * forge_stats day bucket the scheduler's limit enforcement uses, so what the
 * page shows is exactly what the machine will honor.
 */
export function ForgedTodayMeter({ meter }) {
  if (!meter) return null;
  const atLimit = meter.limit >= 1 && meter.forged >= meter.limit;
  return (
    <p className="text-xs mt-1">
      <span className={atLimit ? 'text-amber-500 font-medium' : 'text-muted-foreground'}>
        Forged today: {meter.forged}
        {meter.limit >= 1 ? `/${meter.limit}` : ''}
      </span>
      {!meter.enabled && <span className="text-muted-foreground"> · auto-forge off</span>}
    </p>
  );
}

/**
 * The unattended paste-a-URL entry point (Blog Machine T-602). Its own
 * component so the enqueue state lives with the form rather than adding four
 * more hooks to QueuePage. Fire-and-forget on purpose: the forge runs for
 * minutes under the job budget, so this enqueues and lets the result land
 * back in the queue as forge_ready or editing rather than holding the page.
 */
export function ForgeFromUrlCard() {
  const [forgeUrl, setForgeUrl] = useState('');
  const [forgingUrl, setForgingUrl] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  // The classification of what the forge will write (ADR 0033 §4). A pasted
  // URL is an imported source by definition; what it becomes is the owner's call.
  const [taxonomy, setTaxonomy] = useState({ kind: 'article', ideaOrigin: 'imported-source' });

  const handleSubmit = async (event) => {
    event.preventDefault();
    const url = forgeUrl.trim();
    setNotice('');
    if (!isValidHttpUrl(url)) {
      setError('Enter a valid http(s) article URL.');
      return;
    }
    setError('');
    setForgingUrl(true);
    try {
      const accepted = await postJSON('enqueueJob', {
        type: 'forge-from-url',
        payload: { url, kind: taxonomy.kind, ideaOrigin: taxonomy.ideaOrigin },
      });
      if (!accepted?.ok || !accepted.jobId) {
        throw new Error(accepted?.error || 'Job was not accepted');
      }
      setForgeUrl('');
      setNotice(
        `Forge queued (job ${accepted.jobId}). The scraped source and its forged draft land in this queue as forge_ready or editing — refresh in a few minutes.`
      );
    } catch (err) {
      setError(err?.message || 'Failed to queue the forge.');
    } finally {
      setForgingUrl(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSubmit}>
          <Label htmlFor="forge-from-url" className="flex items-center gap-1 whitespace-nowrap">
            <Flame className="h-4 w-4 text-primary" /> Forge from URL
          </Label>
          <Input
            id="forge-from-url"
            type="text"
            inputMode="url"
            placeholder="https://… paste an article to forge into a post"
            value={forgeUrl}
            onChange={(event) => setForgeUrl(event.target.value)}
            disabled={forgingUrl}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={forgingUrl || !forgeUrl.trim()}>
            {forgingUrl ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Forge'}
          </Button>
        </form>
        <TaxonomyPicker
          className="mt-3"
          compact
          kind={taxonomy.kind}
          ideaOrigin={taxonomy.ideaOrigin}
          onChange={setTaxonomy}
          disabled={forgingUrl}
        />
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        {notice && <p className="mt-2 text-sm text-muted-foreground">{notice}</p>}
      </CardContent>
    </Card>
  );
}

/** One labelled select over a taxonomy list, with "All" first. */
export function TaxonomyFilterSelect({ id, label, value, entries, onChange }) {
  return (
    <div>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
      >
        <option value="all">All</option>
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The Forge Selected result banners, out of QueuePage for complexity's sake. */
export function ForgeFeedback({ error, message }) {
  return (
    <>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-md border border-green-500/50 bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
          {message}
        </div>
      )}
    </>
  );
}

/**
 * For bulk-reject confirmations, a top-10 preview inside the modal so the
 * user can verify scope. Items are looked up out of the current `items`
 * array (only currently-rendered items can be selected anyway).
 */
export function BulkRejectPreview({ confirmTarget, items }) {
  if (confirmTarget?.type !== 'bulkReject') return null;
  const ids = confirmTarget.ids || [];
  if (ids.length === 0) return null;
  const byId = new Map(items.map((it) => [it.id, it]));
  const previewItems = ids
    .slice(0, 10)
    .map((id) => byId.get(id))
    .filter(Boolean);
  const overflow = Math.max(ids.length - previewItems.length, 0);
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 max-h-72 overflow-y-auto text-sm">
      <ul className="space-y-2">
        {previewItems.map((it) => {
          const dateInfo = formatPublishedDate(it);
          const domain = getRootDomain(it);
          return (
            <li key={it.id} className="flex flex-col gap-0.5">
              <span className="font-medium leading-snug line-clamp-2">
                {it.Title || it.title || 'Untitled'}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {domain || ''}
                {dateInfo ? ` · ${dateInfo.label}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {overflow > 0 && (
        <p className="mt-2 text-xs text-muted-foreground italic">…and {overflow} more not shown.</p>
      )}
    </div>
  );
}

/** The header's bulk actions, out of QueuePage for complexity's sake. */
export function QueueHeaderActions({
  statusFilter,
  totalCount,
  selectedIds,
  bulkDeletingRejected,
  forgingSelected,
  bulkRejecting,
  handleDeleteRejectedNow,
  handleForgeSelected,
  handleBulkReject,
}) {
  return (
    <div className="flex flex-col items-end gap-2">
      <RoleGate minRole="publisher" reason="Deleting rejected content needs the publisher role.">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDeleteRejectedNow}
          disabled={bulkDeletingRejected || statusFilter !== 'rejected' || totalCount === 0}
          className="gap-1 text-destructive hover:text-destructive"
        >
          {bulkDeletingRejected ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          Delete Rejected Now
        </Button>
      </RoleGate>
      {selectedIds.size > 0 && statusFilter !== 'rejected' && statusFilter !== 'published_live' && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleForgeSelected}
          disabled={forgingSelected}
          className="gap-1"
        >
          {forgingSelected ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Flame className="h-4 w-4 text-primary" />
          )}
          Forge Selected ({selectedIds.size})
        </Button>
      )}
      {selectedIds.size > 1 && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleBulkReject}
          disabled={bulkRejecting}
          className="gap-1 text-destructive hover:text-destructive"
        >
          {bulkRejecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Reject Selected ({selectedIds.size})
        </Button>
      )}
    </div>
  );
}
