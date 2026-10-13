/**
 * The pieces more than one Recording Hub tab renders (#576).
 *
 * `HostLine` is why this file exists: it is the Podbean record for one
 * transcript, and it now appears both under a transcript on **Transcripts**
 * and grouped by state on **Distribution**. One component, so the two cannot
 * describe the same record differently.
 */
import React from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Mic,
  RefreshCw,
} from 'lucide-react';
import { describeSkip, fmtDate, hostErrorMessage, hostState } from './recordingView';

/** Where a transcript came from, as a chip and a link when there is one. */
export function SourceChip({ item }) {
  if (item.sourceKind === 'article') {
    const publicPath =
      item.sourceProvider && item.sourceSlug
        ? `/${item.sourceProvider}/blog/${item.sourceSlug}`
        : null;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <Badge variant="secondary">article</Badge>
        {item.sourceId && (
          <Link to={`/admin/editor/${encodeURIComponent(item.sourceId)}`} className="underline">
            {item.sourceTitle || item.sourceSlug || item.sourceId}
          </Link>
        )}
        {publicPath && (
          <a
            href={publicPath}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-slate-500 hover:underline"
            aria-label={`Open ${item.sourceTitle || item.sourceSlug} on the site`}
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Badge variant="secondary">{item.sourceKind || 'recording'}</Badge>
      <span className="text-slate-600 dark:text-slate-300">
        {item.sourceTitle || item.sourceId || 'Untitled recording'}
      </span>
    </span>
  );
}

export function StatusBadge({ status }) {
  if (status === 'published') return <Badge>published</Badge>;
  if (status === 'failed') return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="outline">{status || 'draft'}</Badge>;
}

/** Approval queued publish-podcast-transcript (#437 slice 2); it says so until the job writes. */
function HostPending({ host }) {
  return (
    <p className="text-xs text-slate-600 dark:text-slate-300 flex items-center gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> Host: publishing…
      {host.jobId ? ` (job ${host.jobId})` : ''}
    </p>
  );
}

/** The episode's Podbean page, when the record carries an https one; never any other scheme. */
function episodeHref(host) {
  const url = typeof host?.permalinkUrl === 'string' ? host.permalinkUrl.trim() : '';
  return /^https:\/\//i.test(url) ? url : null;
}

function HostPublished({ host }) {
  const href = episodeHref(host);
  return (
    <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
      <CheckCircle className="h-3 w-3" /> Host: Published to Podbean
      {host.publishedAt ? ` (${fmtDate(host.publishedAt)})` : ''}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 hover:underline"
          aria-label="Open the episode on Podbean"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </p>
  );
}

function HostError({ host, item, onRetry, retrying }) {
  return (
    <p className="text-xs text-red-700 dark:text-red-300 flex items-center gap-2 flex-wrap">
      <span>Host: {hostErrorMessage(host)}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 text-xs px-2"
        onClick={() => onRetry(item)}
        disabled={retrying}
      >
        {retrying ? (
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
        ) : (
          <RefreshCw className="h-3 w-3 mr-1" />
        )}
        Retry
      </Button>
    </p>
  );
}

function HostSkipped({ host }) {
  return <p className="text-xs text-slate-500">Host: skipped — {describeSkip(host)}</p>;
}

/** One renderer per state `hostState` names. `none` has none, and renders nothing. */
const HOST_LINES = Object.freeze({
  pending: HostPending,
  published: HostPublished,
  error: HostError,
  skipped: HostSkipped,
});

/**
 * The `host.podbean` record as one line. Rendered only when the record exists,
 * so a transcript nothing has tried to publish shows no host line at all.
 *
 * The state is `hostState`'s, not a second `if` chain of its own: Distribution
 * groups by that function, and two orderings of the same four tests would
 * eventually disagree about one record. It also took this component from six
 * returns to one.
 */
export function HostLine({ item, onRetry, retrying }) {
  const Line = HOST_LINES[hostState(item)];
  return Line ? (
    <Line host={item.host.podbean} item={item} onRetry={onRetry} retrying={retrying} />
  ) : null;
}

/**
 * Readable fallbacks for the skip codes `publish-transcript.js` records
 * (`HOST_SKIP`), used only when the record carries no `reason` sentence.
 */

export function TranscriptToggleIcon({ loading, expanded }) {
  if (loading) return <Loader2 className="h-3 w-3 animate-spin" />;
  if (expanded) return <ChevronDown className="h-3 w-3" />;
  return <ChevronRight className="h-3 w-3" />;
}

/**
 * Spinner, error or empty — whichever the read left, or nothing.
 *
 * Transcripts and Distribution render the same list from the same read, so
 * they had the same three-branch block; Qlty counted it as 16 duplicated lines
 * across two files before this became one component. `empty` is the caller's
 * sentence because that is the only part that genuinely differs: one tab tells
 * you where transcripts come from, the other that nothing has been sent.
 */
export function ReadState({ loading, loadError, empty, emptyMessage }) {
  if (loading && empty) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  if (loadError) {
    return (
      <p className="text-xs text-red-700 dark:text-red-300" role="alert">
        Could not load transcripts: {loadError}
      </p>
    );
  }
  if (empty) {
    return <p className="text-sm text-slate-400 py-6 text-center">{emptyMessage}</p>;
  }
  return null;
}

/**
 * "Script this" — queues a ContentForge job for one recording.
 *
 * The same button sits on a live Plaud recording and on a stored one, and they
 * differ only in what identifies the recording: Qlty counted 16 duplicated
 * lines across the two files. `payload` and `busyKey` are what the two callers
 * genuinely disagree about, so they are the props.
 */
export function ScriptThisButton({ label, payload, busyKey, busy, onScriptThis, className = '' }) {
  return (
    <Button
      size="sm"
      variant="outline"
      className={`h-7 text-xs px-2 border-violet-300 text-violet-700 dark:text-violet-300 ${className}`}
      onClick={() => onScriptThis(payload, busyKey)}
      disabled={busy}
      aria-label={`Script this: ${label}`}
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Mic className="h-3 w-3 mr-1" />}
      Script this
    </Button>
  );
}
