/**
 * One chapter on the Review tab: what it says, whether it has audio, and the
 * approval. The Library's ChapterRow carries the fuller set of actions; this
 * card is the reviewer's view, with the one recovery it needs — a failed
 * regeneration's Retry and Keep current (ADR 0033 §4).
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import RoleGate from '@/components/admin/RoleGate';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { Loader2, VolumeX } from 'lucide-react';
import useLinkedItem from '@/hooks/useLinkedItem';
import { LINK_PARAMS } from '@/lib/itemLinks';
import { EpisodeSources } from '@/pages/admin/SourceGroundingPanel';
import ChapterPlayer from './ChapterPlayer';
import RegenerationNotice from './RegenerationNotice';
import Transcript from './Transcript';
import { KIND_LABEL, chapterStatus, versionSummary } from './episodeView';

/**
 * The player, or an honest explanation of why there isn't one.
 *
 * Its own component because a missing key is a normal state here rather than an
 * error, so both branches carry real content.
 */
function EpisodeAudio({ episode }) {
  if (!episode.audioUrl) {
    // Not a failure: the script generated and the transcript is reviewable.
    // Saying which setting is missing turns "no player" into a task.
    if (!episode.audioError) return null;
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <VolumeX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        No audio — {episode.audioError}
      </p>
    );
  }
  return (
    <>
      <ChapterPlayer
        positionKey={`listen-and-learn:${episode.setId}/${episode.id}`}
        audioUrl={episode.audioUrl}
        title={episode.title || episode.areaName}
        durationSeconds={episode.durationSeconds}
        audioBytes={episode.audioBytes}
      />
      {/* Which voice read it. Provenance for AI-generated study content, and
          the only thing that answers "why does this one sound different"
          after a provider or model change. */}
      <p className="text-xs text-muted-foreground">
        {versionSummary(episode) || episode.speechModel || episode.speechProvider}
      </p>
    </>
  );
}

function EpisodeBadges({ episode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <StatusBadge status={chapterStatus(episode.status)} />
      {episode.kind && (
        <Badge variant="outline" className="text-xs">
          {KIND_LABEL[episode.kind] || episode.kind}
        </Badge>
      )}
      {episode.droppedFromGuide && (
        <Badge variant="secondary" className="text-xs">
          Not in current guide
        </Badge>
      )}
    </div>
  );
}

/** The reviewer's card for one chapter, its approval gated at publisher only when it publishes, since withdrawing is an editor write. */
export default function EpisodeCard({ episode, busy, onReview, onRetry, onKeepCurrent }) {
  const published = episode.status === 'published';
  const failedOnly = episode.status === 'failed' && episode.error && !episode.lastError;
  // `?chapter=<id>` (the dashboard's Decision Center) scrolls to this card and rings it.
  const { ref, linkedProps, linkedClassName } = useLinkedItem(LINK_PARAMS.chapter, episode.id);

  return (
    <div
      ref={ref}
      {...linkedProps}
      className={`space-y-3 rounded-lg border border-border p-4 ${linkedClassName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{episode.title || episode.areaName}</p>
          <p className="text-xs text-muted-foreground">
            {episode.areaName}
            {episode.weightLabel ? ` · ${episode.weightLabel} of exam` : ''}
          </p>
        </div>
        <EpisodeBadges episode={episode} />
      </div>

      {episode.summary && <p className="text-xs text-muted-foreground">{episode.summary}</p>}

      <EpisodeSources episode={episode} />

      <RegenerationNotice
        chapter={episode}
        busy={busy}
        onRetry={onRetry}
        onKeepCurrent={onKeepCurrent}
      />
      {failedOnly && <p className="text-xs text-destructive">{episode.error}</p>}

      <EpisodeAudio episode={episode} />

      <Transcript transcript={episode.transcript} />

      {episode.status !== 'failed' && (
        <div className="flex items-center gap-2">
          {/* Publisher only when the review publishes (speech-handlers.js). */}
          <RoleGate minRole={published ? 'editor' : 'publisher'}>
            <Button
              size="sm"
              variant={published ? 'outline' : 'default'}
              disabled={busy}
              onClick={() => onReview(episode, published ? 'draft' : 'published')}
            >
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {published ? 'Withdraw to draft' : 'Approve and publish'}
            </Button>
          </RoleGate>
          {published && episode.approvedAt && (
            <span className="text-xs text-muted-foreground">
              Approved {new Date(episode.approvedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
