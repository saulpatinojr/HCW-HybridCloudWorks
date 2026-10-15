/**
 * Transcripts — review and approval (#576).
 *
 * The podcast pipeline's output from published articles (#435) and from
 * recordings (#434), each row carrying where it came from and what the Podbean
 * host has done with it. Approving one here is what queues that publish, which
 * is why the list is the hub's, not this tab's: Distribution shows the other
 * side of the same record.
 *
 * Opening a transcript replaces the list with its detail view, as it did on
 * the Podcast tab — the source sits beside the transcript there, with the
 * attribution warning.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Download,
  FileText,
  Loader2,
  Mic,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { safeUrl } from '@/lib/safeUrl';
import { LINK_PARAMS } from '@/lib/itemLinks';
import useLinkedItem from '@/hooks/useLinkedItem';
import RoleGate from '@/components/admin/RoleGate';
import { fmtDate } from './recordingView';
import { HostLine, ReadState, SourceChip, StatusBadge } from './shared';

function TranscriptRow({ item, onOpen, onReview, onRetry, busy }) {
  const audio = safeUrl(item.audioUrl);
  // `?transcript=<id>` (the dashboard's Decision Center) scrolls to this row and rings it.
  const { ref, linkedProps, linkedClassName } = useLinkedItem(LINK_PARAMS.transcript, item.id);
  return (
    <Card ref={ref} {...linkedProps} className={linkedClassName}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-violet-100 dark:bg-violet-900/40 p-2 mt-0.5 shrink-0">
            <Mic className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <p className="font-semibold text-sm truncate">{item.title || item.id}</p>
            <div className="flex flex-wrap items-center gap-2">
              <SourceChip item={item} />
              <StatusBadge status={item.status} />
              {item.truncated && (
                <Badge variant="outline" className="border-amber-400 text-amber-700">
                  truncated
                </Badge>
              )}
              {item.audioError && (
                <Badge variant="destructive" title={item.audioError}>
                  audio failed
                </Badge>
              )}
              <span className="text-xs text-slate-500">{fmtDate(item.generatedAt)}</span>
            </div>
            {item.audioError && (
              <p className="text-xs text-red-700 dark:text-red-300">{item.audioError}</p>
            )}
            {item.error && item.status === 'failed' && (
              <p className="text-xs text-red-700 dark:text-red-300">{item.error}</p>
            )}
            <HostLine item={item} onRetry={onRetry} retrying={busy === `retry:${item.id}`} />
          </div>
          <div className="flex gap-1.5 shrink-0">
            {audio && (
              <Button size="sm" variant="outline" className="h-7 text-xs px-2" asChild>
                <a href={audio} download={`${item.id}.mp3`}>
                  <Download className="h-3 w-3 mr-1" /> Download MP3
                </a>
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs px-2"
              onClick={() => onOpen(item.id)}
            >
              <FileText className="h-3 w-3 mr-1" /> Review
            </Button>
            {/* The review route is publisher either way (lib/podcast/handlers.js
                reviewTranscript): approving queues the host publish and
                returning to draft withdraws it. */}
            <RoleGate
              minRole="publisher"
              reason="Approving a transcript for the host needs the publisher role."
            >
              {item.status === 'published' ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs px-2"
                  onClick={() => onReview(item, 'draft')}
                  disabled={busy === `review:${item.id}`}
                >
                  <Undo2 className="h-3 w-3 mr-1" /> Return to draft
                </Button>
              ) : (
                item.status !== 'failed' && (
                  <Button
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => onReview(item, 'published')}
                    disabled={busy === `review:${item.id}`}
                  >
                    <CheckCircle className="h-3 w-3 mr-1" /> Approve
                  </Button>
                )
              )}
            </RoleGate>
          </div>
        </div>
        {audio && (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio
            controls
            preload="none"
            src={audio}
            className="w-full h-8"
            aria-label={`Audio: ${item.title || item.id}`}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The review view: the dialogue beside its source. */

export function TranscriptDetail({ item, onBack }) {
  const isArticle = item.sourceKind === 'article';
  const leaks = Array.isArray(item.attributionLeaks) ? item.attributionLeaks : [];
  return (
    <div className="space-y-4">
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onBack}>
        <ArrowLeft className="h-3 w-3 mr-1" /> Back to transcripts
      </Button>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardContent className="p-4 space-y-3">
            <div>
              <h3 className="font-semibold text-base">{item.title}</h3>
              {item.summary && (
                <p className="text-sm text-slate-600 dark:text-slate-300">{item.summary}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={item.status} />
              {item.truncated && (
                <Badge variant="outline" className="border-amber-400 text-amber-700">
                  truncated
                </Badge>
              )}
              <span className="text-xs text-slate-500">{fmtDate(item.generatedAt)}</span>
            </div>
            {safeUrl(item.audioUrl) && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <audio
                controls
                preload="metadata"
                src={safeUrl(item.audioUrl)}
                className="w-full h-8"
              />
            )}
            {item.audioError && (
              <p className="text-xs text-red-700 dark:text-red-300">Audio: {item.audioError}</p>
            )}
            <ol className="space-y-2 text-sm" aria-label="Transcript">
              {(item.transcript || []).map((turn, i) => (
                <li key={i} className="grid grid-cols-[6rem_1fr] gap-2">
                  <span className="font-semibold text-violet-700 dark:text-violet-300">
                    {turn.speaker}
                  </span>
                  <span>{turn.text}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 space-y-3 text-sm">
            <h4 className="font-semibold">Source</h4>
            <SourceChip item={item} />
            {isArticle ? (
              <>
                <p>
                  <span className="text-slate-500">Title:</span> {item.sourceTitle || '—'}
                </p>
                <p>
                  <span className="text-slate-500">Slug:</span>{' '}
                  <code className="text-xs">{item.sourceSlug || '—'}</code>
                </p>
                {Array.isArray(item.keyTakeaways) && item.keyTakeaways.length > 0 && (
                  <div>
                    <p className="text-slate-500">Key takeaways</p>
                    <ul className="list-disc pl-5 space-y-1">
                      {item.keyTakeaways.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <>
                <p>
                  <span className="text-slate-500">Recording id:</span>{' '}
                  <code className="text-xs">{item.sourceId || '—'}</code>
                </p>
                <p>
                  <span className="text-slate-500">Title:</span> {item.sourceTitle || '—'}
                </p>
                {item.source?.durationMs > 0 && (
                  <p>
                    <span className="text-slate-500">Duration:</span>{' '}
                    {Math.round(item.source.durationMs / 60000)} min
                    {Number.isFinite(item.source.segmentsIncluded) &&
                    Number.isFinite(item.source.segmentCount)
                      ? ` · ${item.source.segmentsIncluded}/${item.source.segmentCount} segments used`
                      : ''}
                  </p>
                )}
                {leaks.length > 0 ? (
                  <div
                    role="alert"
                    className="p-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 text-xs space-y-1"
                  >
                    <p className="font-semibold flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Attribution check
                    </p>
                    <p>
                      The dialogue repeats {leaks.length} speaker label
                      {leaks.length === 1 ? '' : 's'} from the transcript verbatim. The episode is a
                      retelling and must not name or quote anyone who was in the room; fix the lines
                      before approving.
                    </p>
                    <ul className="list-disc pl-5">
                      {leaks.map((l, i) => (
                        <li key={i}>
                          <code>{typeof l === 'string' ? l : JSON.stringify(l)}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    Attribution check: no transcript speaker label appears in the dialogue.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function TranscriptsTab({ hub }) {
  const {
    items,
    loading,
    loadError,
    detail,
    busyKey,
    reload,
    open,
    closeDetail,
    review,
    retryHost,
  } = hub;

  if (detail) return <TranscriptDetail item={detail} onBack={closeDetail} />;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-sm">Transcripts</h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={reload}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </Button>
      </div>
      <ReadState
        loading={loading}
        loadError={loadError}
        empty={items.length === 0}
        emptyMessage="No transcripts yet. Generate one from a live article on the Publish page, or from a recording on the Recordings tab."
      />
      <div className="space-y-2">
        {items.map((item) => (
          <TranscriptRow
            key={item.id}
            item={item}
            onOpen={open}
            onReview={review}
            onRetry={retryHost}
            busy={busyKey}
          />
        ))}
      </div>
    </div>
  );
}
