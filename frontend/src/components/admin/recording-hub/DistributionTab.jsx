/**
 * Distribution — what this hub has sent to Podbean, and how it went (#576),
 * and what Podbean says about it now (#1115).
 *
 * The host record used to be one line tucked under each transcript, so
 * "did anything fail to publish" meant scrolling the whole list and reading
 * every row. Here the same records are grouped by state, failures first, with
 * the retry beside them.
 *
 * It renders no state of its own: the transcripts come from the hub read that
 * Transcripts also uses, because approving a transcript there is exactly what
 * creates a record here. Two reads could disagree about one transcript, and a
 * publish that a stale list says never happened is the worst thing this tab
 * could say.
 *
 * The Podbean overview (`cms/podcast/host/overview`) is the one thing this
 * tab asks the hub to read for it, on first mount: Podbean's live status for
 * each published episode, its page, and thirty days of downloads — plus the
 * episodes the show has that this hub never sent. The record says what the
 * publish job saw; the overview says what is true now. They are drawn apart
 * on purpose: the record line stays as it was, and the live line under it is
 * labelled Podbean, so a draft that was published at the time reads as
 * "published then, draft now" rather than as a contradiction.
 */
import React, { useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import {
  describeDownloads,
  fmtDate,
  fmtWhen,
  hostState,
  liveRowFor,
  liveStatusLabel,
  sparklineBars,
  unmatchedLiveRows,
  overviewNotes,
} from './recordingView';
import { HostLine, ReadState } from './shared';

/**
 * The groups, worst first: a failure needs a decision, a pending publish needs
 * only patience, and `none` is every transcript nobody has approved yet — the
 * largest group and the least interesting, so it is last and collapsed.
 */
const GROUPS = Object.freeze([
  { state: 'error', title: 'Failed to publish', tone: 'text-red-700 dark:text-red-300' },
  { state: 'skipped', title: 'Skipped', tone: 'text-slate-600 dark:text-slate-300' },
  { state: 'pending', title: 'Publishing now', tone: 'text-slate-600 dark:text-slate-300' },
  {
    state: 'published',
    title: 'Published to Podbean',
    tone: 'text-emerald-700 dark:text-emerald-300',
  },
  { state: 'none', title: 'Not sent', tone: 'text-slate-500' },
]);

/** The episode's page on Podbean, https only — the same rule HostLine applies to the record. */
function liveHref(row) {
  const url = typeof row?.permalinkUrl === 'string' ? row.permalinkUrl.trim() : '';
  return /^https:\/\//i.test(url) ? url : null;
}

/** Thirty bars, one per day, scaled to the busiest; decorative beside the number that says it. */
function Sparkline({ byDay }) {
  const bars = sparklineBars(byDay);
  if (bars.length === 0) return null;
  return (
    <span className="inline-flex items-end gap-px h-4 align-middle" aria-hidden="true">
      {bars.map((bar) => (
        <span
          key={bar.date}
          className="inline-block w-1 bg-emerald-500/70 rounded-sm"
          style={{ height: `${Math.max(bar.height, 6)}%` }}
          title={`${bar.date}: ${bar.count}`}
        />
      ))}
    </span>
  );
}

/**
 * What Podbean says now about one episode: its status, its page, and its
 * downloads. `row.error` is a read that failed for this row alone (or the
 * listing that failed for all of them); it reads as the sentence and nothing
 * else, so a failed count is never mistaken for zero.
 */
function LiveLine({ row, days }) {
  if (!row) return null;
  const href = liveHref(row);
  const downloads = describeDownloads(row, days);
  return (
    <p className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2 flex-wrap">
      <span>Podbean:</span>
      <Badge variant={row.hostStatus === 'publish' ? 'default' : 'outline'} className="text-xs">
        {liveStatusLabel(row.hostStatus)}
      </Badge>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 hover:underline"
        >
          Episode page <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {downloads && <span>{downloads}</span>}
      {downloads && <Sparkline byDay={row.downloads?.byDay} />}
      {row.error && <span className="text-amber-700 dark:text-amber-300">{row.error.message}</span>}
    </p>
  );
}

function TranscriptHostCard({ item, onRetry, retrying, overview }) {
  const live = hostState(item) === 'published' ? liveRowFor(overview?.data, item) : null;
  return (
    <Card>
      <CardContent className="p-3 space-y-1">
        <p className="text-sm font-medium">{item.title || item.id}</p>
        <HostLine item={item} onRetry={onRetry} retrying={retrying} />
        <LiveLine row={live} days={overview?.data?.days} />
      </CardContent>
    </Card>
  );
}

function Group({ group, items, onRetry, busyKey, overview }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={group.title}>
      <h3 className={`font-semibold text-sm flex items-center gap-2 ${group.tone}`}>
        {group.title}
        <Badge variant="secondary" className="text-xs">
          {items.length}
        </Badge>
      </h3>
      {group.state === 'none' ? (
        <p className="text-xs text-slate-500">
          {items.length} transcript{items.length === 1 ? '' : 's'} nothing has been asked to publish
          yet. Approve one on the Transcripts tab to send it.
        </p>
      ) : (
        items.map((item) => (
          <TranscriptHostCard
            key={item.id}
            item={item}
            onRetry={onRetry}
            retrying={busyKey === `retry:${item.id}`}
            overview={overview}
          />
        ))
      )}
    </section>
  );
}

/** The episodes Podbean lists that no transcript here names — published by hand, before this path. */
function AlsoOnPodbean({ overview }) {
  const rows = unmatchedLiveRows(overview?.data);
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Also on Podbean">
      <h3 className="font-semibold text-sm flex items-center gap-2 text-slate-600 dark:text-slate-300">
        Also on Podbean
        <Badge variant="secondary" className="text-xs">
          {rows.length}
        </Badge>
      </h3>
      <p className="text-xs text-slate-500">
        Episodes the show has that were not sent from this hub.
      </p>
      {rows.map((row) => (
        <Card key={row.episodeId}>
          <CardContent className="p-3 space-y-1">
            <p className="text-sm font-medium">
              {row.title || row.episodeId}
              {row.publishTime ? (
                <span className="text-xs text-slate-500 font-normal">
                  {' '}
                  · {fmtDate(row.publishTime)}
                </span>
              ) : null}
            </p>
            <LiveLine row={row} days={overview?.data?.days} />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

/**
 * One line about the overview read: when Podbean was last read and a Refresh,
 * or why there is nothing — not configured, still reading, or a failed read.
 * `role="status"` so a screen reader hears the fetched-at line change.
 */
function OverviewLine({ overview, onRefresh }) {
  const { data, loading, error } = overview;
  if (error) {
    return (
      <p className="text-xs text-red-700 dark:text-red-300" role="alert">
        Could not read Podbean: {error}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="text-xs text-slate-500 flex items-center gap-1" role="status">
        <Loader2 className="h-3 w-3 animate-spin" /> Reading Podbean…
      </p>
    );
  }
  if (data.configured === false) {
    return (
      <p className="text-xs text-slate-500" role="status">
        {data.reason || 'Podbean is not configured, so there is nothing live to show.'}
      </p>
    );
  }
  const notes = overviewNotes(data);
  return (
    <p className="text-xs text-slate-500 flex items-center gap-2 flex-wrap" role="status">
      <span>
        Podbean read {fmtWhen(data.fetchedAt) || 'just now'}
        {data.cached ? ' (cached)' : ''}
        {notes.coverage ? `; ${notes.coverage}` : ''}.
      </span>
      {notes.failures.map((line) => (
        <span key={line} className="text-amber-700 dark:text-amber-300">
          {line}
        </span>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 text-xs px-2"
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh from Podbean"
      >
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
        ) : (
          <RefreshCw className="h-3 w-3 mr-1" />
        )}
        Refresh
      </Button>
    </p>
  );
}

/** The feed link and the reload, beside the heading. */
function Header({ feedUrl, loading, onReload }) {
  return (
    <div className="flex items-baseline justify-between gap-4 flex-wrap">
      <div>
        <h3 className="font-semibold text-sm">Podbean</h3>
        <p className="text-xs text-slate-500">
          Approving a transcript queues its publish; this is what happened next.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {feedUrl && (
          <a
            href={feedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 hover:underline inline-flex items-center gap-1"
          >
            Feed <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onReload}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

export default function DistributionTab({ hub }) {
  const {
    items,
    loading,
    loadError,
    feedUrl,
    busyKey,
    reload,
    retryHost,
    hostOverview,
    loadHostOverview,
    refreshHostOverview,
  } = hub;

  // Ask once; the hub reads when auth is ready and never again until Refresh.
  useEffect(() => {
    loadHostOverview();
  }, [loadHostOverview]);

  const byState = new Map(GROUPS.map((group) => [group.state, []]));
  for (const item of items) byState.get(hostState(item))?.push(item);

  return (
    <div className="space-y-6">
      <Header feedUrl={feedUrl} loading={loading} onReload={reload} />
      <OverviewLine overview={hostOverview} onRefresh={refreshHostOverview} />
      <ReadState
        loading={loading}
        loadError={loadError}
        empty={items.length === 0}
        emptyMessage="No transcripts yet, so nothing has been distributed."
      />

      {GROUPS.map((group) => (
        <React.Fragment key={group.state}>
          <Group
            group={group}
            items={byState.get(group.state) || []}
            onRetry={retryHost}
            busyKey={busyKey}
            overview={hostOverview}
          />
          {group.state === 'published' && <AlsoOnPodbean overview={hostOverview} />}
        </React.Fragment>
      ))}
    </div>
  );
}
