/**
 * One chapter in an open book (ADR 0033 §4): its position controls, its
 * status, what it was made from, the active take with a player, and every
 * action — approve or withdraw, regenerate, versions, rename, archive or
 * restore, delete — plus the recovery a failed regeneration needs: Retry and
 * Keep current, on the row, while the published take keeps playing.
 *
 * Reordering has two paths and both change the same list: a drag handle
 * for a pointer, and Move up / Move down buttons for a keyboard. The row is
 * the drop target, so dropping anywhere on it lands before that chapter.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import RoleGate from '@/components/admin/RoleGate';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { EpisodeSources } from '@/pages/admin/SourceGroundingPanel';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Layers,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  VolumeX,
} from 'lucide-react';
import ChapterPlayer from './ChapterPlayer';
import RegenerationNotice from './RegenerationNotice';
import Transcript from './Transcript';
import { KIND_LABEL, chapterStatus, versionSummary } from './episodeView';

/** Drag handle plus the keyboard path: Move up / Move down. */
function ReorderControls({ name, index, count, busy, onMove, onDragStart }) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5">
      <button
        type="button"
        draggable
        onDragStart={() => onDragStart(index)}
        aria-label={`Drag to reorder ${name}`}
        title="Drag to reorder"
        className="cursor-grab rounded p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onMove(index, -1)}
        disabled={index === 0 || busy}
        aria-label={`Move ${name} up`}
        className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronUp className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onMove(index, 1)}
        disabled={index === count - 1 || busy}
        aria-label={`Move ${name} down`}
        className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The status, the kind, and the two badges that only sometimes apply. */
function ChapterBadges({ chapter }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={chapterStatus(chapter.status)} />
      <Badge variant="outline" className="text-[10px]">
        {KIND_LABEL[chapter.kind] || chapter.kind}
      </Badge>
      {chapter.droppedFromGuide && (
        <Badge
          variant="secondary"
          className="text-[10px]"
          title="The current study guide no longer lists this area; the lesson stays as it is until you archive it"
        >
          Not in current guide
        </Badge>
      )}
      {chapter.versionCount > 1 && (
        <Badge variant="secondary" className="text-[10px]">
          {chapter.versionCount} takes
        </Badge>
      )}
    </div>
  );
}

/** The title, or the rename form in its place. Focus moves into the field when it opens. */
function ChapterTitle({ chapter, index, name, renaming, busy, onRename, onDone }) {
  const [title, setTitle] = useState(chapter.title || chapter.areaName || '');
  const inputRef = useRef(null);
  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  if (!renaming) {
    return (
      <p className="text-sm font-semibold">
        <span className="mr-2 font-mono text-xs text-muted-foreground">{index + 1}.</span>
        {name}
      </p>
    );
  }
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const next = title.trim();
        if (next && next !== (chapter.title || chapter.areaName)) await onRename(chapter, next);
        onDone();
      }}
      className="flex items-center gap-2"
    >
      <Input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label={`New title for ${name}`}
        maxLength={160}
        className="h-8"
      />
      <Button type="submit" size="sm" disabled={busy || !title.trim()}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

/** The active take's player, or the reason there is none. */
function ChapterAudio({ chapter, name }) {
  if (chapter.audioUrl) {
    return (
      <ChapterPlayer
        positionKey={`listen-and-learn:${chapter.setId}/${chapter.id}`}
        audioUrl={chapter.audioUrl}
        title={name}
        durationSeconds={chapter.durationSeconds}
        audioBytes={chapter.audioBytes}
      />
    );
  }
  if (chapter.audioError) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <VolumeX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        No audio — {chapter.audioError}
      </p>
    );
  }
  return null;
}

function ChapterActions({ chapter, noun, busy, progress, renaming, onRenameStart, actions }) {
  const published = chapter.status === 'published';
  const archived = chapter.status === 'archived';
  const failed = chapter.status === 'failed';
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* The review route asks for publisher only when the review publishes
          (lib/listen-and-learn/speech-handlers.js); withdrawing is editor. */}
      {!failed && !archived && (
        <RoleGate minRole={published ? 'editor' : 'publisher'}>
          <Button
            size="sm"
            variant={published ? 'outline' : 'default'}
            disabled={busy || (!chapter.audioUrl && !published)}
            onClick={() => actions.review(chapter, published ? 'draft' : 'published')}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {published ? 'Withdraw to draft' : 'Approve and publish'}
          </Button>
        </RoleGate>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy || Boolean(progress)}
        onClick={() => actions.regenerate(chapter)}
        title={`Read this ${noun} again as a new take; the current one stays until the new one lands`}
      >
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Regenerate
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.versions(chapter)}>
        <Layers className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Versions (
        {chapter.versionCount || 0})
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || renaming} onClick={onRenameStart}>
        <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Rename
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => actions.archive(chapter, !archived)}
      >
        {archived ? (
          <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Archive className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        )}
        {archived ? 'Restore' : 'Archive'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => actions.remove(chapter)}
      >
        <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Delete
      </Button>
      {published && chapter.approvedAt && (
        <span className="text-[11px] text-muted-foreground">
          Approved {new Date(chapter.approvedAt).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}

/** `Area name · 20% of exam · Take 2 of 2 · …` under the title. */
function subtitle(chapter) {
  const parts = [];
  if (chapter.title && chapter.areaName && chapter.title !== chapter.areaName) {
    parts.push(chapter.areaName);
  }
  if (chapter.weightLabel) parts.push(`${chapter.weightLabel} of exam`);
  parts.push(versionSummary(chapter) || 'No audio yet');
  return parts.join(' · ');
}

/**
 * @param {object} props
 * @param {object} props.chapter the chapter view the server returned
 * @param {object} props.book
 * @param {number} props.index position in the list
 * @param {number} props.count list length
 * @param {boolean} props.busy a write on this chapter is in flight
 * @param {string|null} props.progress the running job's line, if any
 * @param {object} props.actions { review, regenerate, rename, move, archive, remove, versions, keepCurrent }
 * @param {object} props.drag { onDragStart, onDragOver, onDrop, dragging }
 */
export default function ChapterRow({ chapter, book, index, count, busy, progress, actions, drag }) {
  const [renaming, setRenaming] = useState(false);
  const name = chapter.title || chapter.areaName || chapter.id;
  const noun = book?.kind === 'course' ? 'lesson' : 'chapter';
  const failedOnly = chapter.status === 'failed' && chapter.error && !chapter.lastError;

  return (
    <li
      className={`rounded-lg border bg-card p-4 ${drag.dragging ? 'border-primary/60 opacity-70' : 'border-border'}`}
      onDragOver={(e) => {
        e.preventDefault();
        drag.onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag.onDrop(index);
      }}
    >
      <div className="flex items-start gap-3">
        <ReorderControls
          name={name}
          index={index}
          count={count}
          busy={busy}
          onMove={actions.move}
          onDragStart={drag.onDragStart}
        />

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <ChapterTitle
                chapter={chapter}
                index={index}
                name={name}
                renaming={renaming}
                busy={busy}
                onRename={actions.rename}
                onDone={() => setRenaming(false)}
              />
              <p className="text-xs text-muted-foreground">{subtitle(chapter)}</p>
            </div>
            <ChapterBadges chapter={chapter} />
          </div>

          {chapter.summary && <p className="text-xs text-muted-foreground">{chapter.summary}</p>}
          <EpisodeSources episode={chapter} />

          <RegenerationNotice
            chapter={chapter}
            busy={busy}
            onRetry={actions.regenerate}
            onKeepCurrent={actions.keepCurrent}
          />
          {failedOnly && <p className="text-xs text-destructive">{chapter.error}</p>}

          <ChapterAudio chapter={chapter} name={name} />

          {progress && (
            <p
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {progress}
            </p>
          )}

          <Transcript transcript={chapter.transcript} />

          <ChapterActions
            chapter={chapter}
            noun={noun}
            busy={busy}
            progress={progress}
            renaming={renaming}
            onRenameStart={() => setRenaming(true)}
            actions={actions}
          />
        </div>
      </div>
    </li>
  );
}
