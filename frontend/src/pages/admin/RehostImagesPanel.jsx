/**
 * "Images: re-host hotlinked" — the #374 backfill, on the Publish page.
 *
 * Articles published before the publish-time step existed still load their
 * body images from the site they were ingested from, and at least one of
 * those sites refuses cross-site hotlinks: the reader sees empty boxes. The
 * publish step re-hosts on republish, but sixteen manual republishes from a
 * phone is not a plan, so this panel lists the candidates the API finds
 * (GET cms/content/rehost-images — counts and hosts, never a body), lets the
 * owner deselect any, and runs the rest through the narrow re-host republish
 * (POST, `reason: 'rehost-images'` server-side: body fields and their summary
 * only, no triggers, no status, no dates).
 *
 * WHY BATCHES OF FIVE WHEN THE ROUTE TAKES TWENTY-FIVE. The fetcher gives
 * each image fifteen seconds and runs four at a time, the Function host caps
 * a request at 230 s, and today's sixteen candidates carry 135 images, eleven
 * apiece at the top. Twenty-five articles whose CDN has gone quiet would run
 * past the cap and the browser would learn nothing about the ones that did
 * finish; five keeps the worst case under it, and the table fills in as each
 * batch returns. Every article's write is its own conditional patch, so a
 * batch that dies mid-way leaves the finished ones finished and the rest
 * still listed on the next refresh.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { Images, Loader2, RefreshCw } from 'lucide-react';
import CollapsiblePanel, { PanelLoading } from '@/components/admin/CollapsiblePanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import RoleGate from '@/components/admin/RoleGate';
import { getJSON, postJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';

export const REHOST_ROUTE = 'cms/content/rehost-images';
export const REHOST_BATCH_SIZE = 5;

/** `ids` in consecutive slices of `size`; the last one shorter. */
export function splitBatches(ids, size = REHOST_BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

/** Distinct hostnames of the failed URLs, sorted; an unparsable one reads as 'invalid-url'. */
export function failedHostsOf(failedUrls = []) {
  const hosts = new Set();
  for (const url of failedUrls) {
    try {
      hosts.add(new URL(String(url)).hostname);
    } catch {
      hosts.add('invalid-url');
    }
  }
  return [...hosts].sort();
}

/** One row of the result table from one entry of the route's `results`. */
export function toResultRow(result, titleById = new Map()) {
  const { contentId } = result;
  const title = titleById.get(contentId) || contentId;
  if (result.error) {
    return {
      contentId,
      title,
      rewritten: null,
      failed: null,
      failedHosts: [],
      outcome: `Error: ${result.error}`,
    };
  }
  if (result.skipped) {
    return {
      contentId,
      title,
      rewritten: null,
      failed: null,
      failedHosts: [],
      outcome: `Skipped: ${result.reason || 'no reason given'}`,
    };
  }
  const summary = result.inlineImages || {};
  const rewritten = Number(summary.rewritten) || 0;
  const failed = Number(summary.failed) || 0;
  return {
    contentId,
    title,
    rewritten,
    failed,
    failedHosts: failedHostsOf(summary.failedUrls),
    outcome: failed > 0 ? 'Re-hosted with failures' : 'Re-hosted',
  };
}

/**
 * `YYYY-MM-DD` of an ISO timestamp, or a dash. Guarded before `Date` sees the
 * value: `new Date(null)` is the epoch, not invalid, and the API's `lastRun.at`
 * can be null, so an unguarded version rendered `1970-01-01` for "unknown".
 */
export function shortDate(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return '—';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toISOString().slice(0, 10);
}

/** The backfill's panel: listing the candidates is an editor read, and the run republishes, so only the run is gated at publisher. */
export default function RehostImagesPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [scanned, setScanned] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await getJSON(REHOST_ROUTE);
      const rows = Array.isArray(res?.candidates) ? res.candidates : [];
      setCandidates(rows);
      setScanned(Number(res?.scanned) || 0);
      // Everything selected by default: the backfill is "all of them", and
      // the checkboxes exist to take one out, not to put them in one by one.
      setSelected(new Set(rows.map((row) => row.id)));
    } catch (err) {
      setError(`Could not list candidates: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // The list is read when the panel is opened, not when the page mounts: the
  // Publish page is visited far more often than this backfill is run.
  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) load();
  };

  const titleById = useMemo(
    () => new Map(candidates.map((row) => [row.id, row.title])),
    [candidates]
  );
  const selectedIds = candidates.filter((row) => selected.has(row.id)).map((row) => row.id);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runSelected = async () => {
    const ids = selectedIds;
    if (ids.length === 0) return;
    setRunning(true);
    setError('');
    setResults([]);
    const rows = [];
    const batches = splitBatches(ids);
    try {
      for (let i = 0; i < batches.length; i += 1) {
        setProgress(`Re-hosting batch ${i + 1} of ${batches.length}…`);
        const res = await postJSON(REHOST_ROUTE, { contentIds: batches[i] });
        for (const result of res?.results || []) rows.push(toResultRow(result, titleById));
        setResults([...rows]);
      }
      await logAdminAction('content_images_rehosted', {
        requested: ids.length,
        rehosted: rows.filter((row) => row.rewritten !== null).length,
        failed: rows.filter((row) => row.outcome.startsWith('Error')).length,
        skipped: rows.filter((row) => row.outcome.startsWith('Skipped')).length,
      });
      await load();
    } catch (err) {
      setError(`Re-host failed: ${err.message}`);
    } finally {
      setProgress('');
      setRunning(false);
    }
  };

  return (
    <CollapsiblePanel
      title="Hotlinked images"
      description="Published articles whose body still loads images from another site. Re-hosting copies each image to this site and rewrites the article; nothing else about it changes."
      icon={Images}
      toggleLabel="Images: re-host hotlinked"
      open={open}
      onToggle={toggleOpen}
      error={error}
    >
      {loading && <PanelLoading>Scanning published articles…</PanelLoading>}
      {!loading && candidates.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Every published article&apos;s body images are already served from hybridcloudworks.com (
          {scanned} scanned).
        </p>
      )}
      {!loading && candidates.length > 0 && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              {candidates.length} of {scanned} published articles hotlink third-party images.
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set(candidates.map((row) => row.id)))}
                disabled={running}
              >
                Select all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set())}
                disabled={running}
              >
                Select none
              </Button>
              <Button variant="ghost" size="sm" onClick={load} disabled={running}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>
          </div>

          <ul className="space-y-2">
            {candidates.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-3 rounded-lg border p-2 text-sm hover:bg-muted/40"
              >
                <input
                  id={`rehost-${row.id}`}
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                  disabled={running}
                  aria-label={`Select ${row.title}`}
                  className="mt-1 h-4 w-4 rounded border-border accent-primary"
                />
                {/* The label covers the title and its facts only: a link
                          inside it would toggle the checkbox on every click. */}
                <label htmlFor={`rehost-${row.id}`} className="flex-1 min-w-0 cursor-pointer">
                  <span className="block font-medium truncate">{row.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {row.urlCount} {row.urlCount === 1 ? 'image' : 'images'} ·{' '}
                    {(row.hosts || []).join(', ')} · in {(row.fields || []).join(', ')}
                  </span>
                  {row.lastRun && (
                    <span className="block text-xs text-muted-foreground">
                      Last run {shortDate(row.lastRun.at)}: {row.lastRun.rewritten} re-hosted,{' '}
                      {row.lastRun.failed} failed
                      {row.lastRun.failedHosts?.length
                        ? ` (${row.lastRun.failedHosts.join(', ')})`
                        : ''}
                    </span>
                  )}
                </label>
                {row.live ? (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
                    Live
                  </Badge>
                ) : (
                  <Badge variant="outline">Staged</Badge>
                )}
                {row.publicUrl && (
                  <a
                    href={row.publicUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View ${row.title}`}
                    className="text-xs underline shrink-0"
                  >
                    View
                  </a>
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-3">
            {/* Listing candidates is editor; the re-host itself republishes
                each page and is publisher (lib/cms/rehost-images.js). */}
            <RoleGate
              minRole="publisher"
              reason="Re-hosting republishes each page, which needs the publisher role."
            >
              <Button
                size="sm"
                onClick={runSelected}
                disabled={running || selectedIds.length === 0}
              >
                {running && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Re-host selected ({selectedIds.length})
              </Button>
            </RoleGate>
            {progress && <span className="text-xs text-muted-foreground">{progress}</span>}
          </div>
        </>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Re-host results">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b">
                <th className="py-1 pr-3 font-medium">Article</th>
                <th className="py-1 pr-3 font-medium">Rewritten</th>
                <th className="py-1 pr-3 font-medium">Failed</th>
                <th className="py-1 pr-3 font-medium">Failed hosts</th>
                <th className="py-1 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row) => (
                <tr key={row.contentId} className="border-b last:border-0 align-top">
                  <td className="py-1 pr-3 max-w-[20rem] truncate">{row.title}</td>
                  <td className="py-1 pr-3">{row.rewritten ?? '—'}</td>
                  <td className="py-1 pr-3">{row.failed ?? '—'}</td>
                  <td className="py-1 pr-3">
                    {row.failedHosts.length ? row.failedHosts.join(', ') : '—'}
                  </td>
                  <td
                    className={`py-1 ${row.outcome.startsWith('Error') ? 'text-destructive' : ''}`}
                  >
                    {row.outcome}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CollapsiblePanel>
  );
}
