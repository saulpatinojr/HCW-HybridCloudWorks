/**
 * An open book (ADR 0033 §4): its cover and metadata, the actions on the
 * book itself, and the ordered list of chapters with everything a chapter
 * can do. Reordering is a drag between rows or the Move buttons on each; the
 * server is told the whole order once (chapterOrder.js), and writes only what
 * moved.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import EmptyState from '@/components/admin/shared/EmptyState';
import ConfirmModal from '@/components/admin/ConfirmModal';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookOpen,
  GraduationCap,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { safeUrl } from '@/lib/safeUrl';
import BookDialog from './BookDialog';
import ChapterDialog from './ChapterDialog';
import ChapterRow from './ChapterRow';
import VersionsDialog from './VersionsDialog';
import { moveChapter, orderedChapters } from './chapterOrder';
import {
  BOOK_KIND_LABEL,
  bookSummary,
  chapterNoun,
  statusCounts,
  voiceSummary,
} from './episodeView';

function PublishedList({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
      {items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  );
}

/** The cover, the metadata and the book-level actions. */
function BookHeader({ book, onAdd, onEdit, onArchive, onDelete }) {
  const Icon = book.kind === 'course' ? GraduationCap : BookOpen;
  const guide = book.studyGuideUrl ? safeUrl(book.studyGuideUrl) : null;
  return (
    <section
      className="flex flex-wrap gap-4 rounded-xl border border-border bg-card p-4"
      aria-labelledby="book-heading"
    >
      {book.coverImageUrl ? (
        <img
          src={resolveMediaUrl(book.coverImageUrl)}
          alt=""
          className="h-36 w-36 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-10 w-10" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-xs">
            {BOOK_KIND_LABEL[book.kind] || book.kind}
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {book.provider}
          </Badge>
          {book.kind === 'course' && (
            <Badge variant="secondary" className="text-xs uppercase">
              {book.examCode}
            </Badge>
          )}
          {book.archivedAt && (
            <Badge variant="outline" className="text-xs">
              Archived
            </Badge>
          )}
          {(book.tags || []).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              #{tag}
            </Badge>
          ))}
        </div>
        <h2 id="book-heading" className="text-lg font-semibold">
          {book.title}
        </h2>
        {book.author && (
          <p className="text-sm text-muted-foreground">
            {book.kind === 'course' ? 'Instructor' : 'Author'}: {book.author}
          </p>
        )}
        {book.description && <p className="text-sm text-muted-foreground">{book.description}</p>}
        <p className="text-xs text-muted-foreground">
          {bookSummary(book)} · voice: {voiceSummary(book.voice)}
          {guide && (
            <>
              {' · '}
              <a
                href={guide}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                study guide
              </a>
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" onClick={onAdd}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> Add {chapterNoun(book)}
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="mr-1.5 h-4 w-4" aria-hidden="true" /> Edit book
          </Button>
          <Button size="sm" variant="outline" onClick={onArchive}>
            {book.archivedAt ? (
              <ArchiveRestore className="mr-1.5 h-4 w-4" aria-hidden="true" />
            ) : (
              <Archive className="mr-1.5 h-4 w-4" aria-hidden="true" />
            )}
            {book.archivedAt ? 'Restore book' : 'Archive book'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" /> Delete book
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The chapters, or the honest state that stands in for them. */
function ChapterList({ hub, book, chapters, actions, dragIndex, setDragIndex, applyOrder, onAdd }) {
  const noun = chapterNoun(book, 2);
  if (hub.loading && hub.episodes.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading {noun}…
      </p>
    );
  }
  if (chapters.length === 0) {
    return (
      <EmptyState
        title={`No ${noun} yet`}
        description={
          book.kind === 'course'
            ? 'Run the study guide on the Generate tab, or add a lesson from text.'
            : 'Add a chapter from pasted text or from a content item.'
        }
        action={
          <Button size="sm" onClick={onAdd}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" /> Add {chapterNoun(book)}
          </Button>
        }
      />
    );
  }
  return (
    <ol className="space-y-3" aria-label={`${noun}, in listening order`}>
      {chapters.map((chapter, index) => (
        <ChapterRow
          key={chapter.id}
          chapter={chapter}
          book={book}
          index={index}
          count={chapters.length}
          busy={hub.busySlugs.has(chapter.id)}
          progress={hub.chapterProgress[chapter.id] || null}
          actions={actions}
          drag={{
            dragging: dragIndex === index,
            onDragStart: (i) => setDragIndex(i),
            onDragOver: () => {},
            onDrop: async (i) => {
              const from = dragIndex;
              setDragIndex(null);
              if (from !== null) await applyOrder(from, i);
            },
          }}
        />
      ))}
    </ol>
  );
}

/** The three confirmations a delete can need, driven by one `confirm` state. */
function DeleteDialogs({ confirm, onCancel, onDeleteBook, onDeleteChapter }) {
  const chapter = confirm?.chapter;
  return (
    <>
      <ConfirmModal
        open={confirm?.kind === 'book'}
        title="Delete this book and its published chapters?"
        description="These chapters are live on the site and will go off it. The book and its chapters are kept for recovery by an administrator; their audio files stay in storage."
        preview={<PublishedList items={confirm?.published} />}
        confirmLabel="Delete book"
        onCancel={onCancel}
        onConfirm={onDeleteBook}
      />
      <ConfirmModal
        open={confirm?.kind === 'chapter'}
        title="Delete a published chapter?"
        description="It is live on the site and will go off it. The chapter is kept for recovery by an administrator; its audio stays in storage."
        preview={<PublishedList items={confirm?.published} />}
        confirmLabel="Delete chapter"
        onCancel={onCancel}
        onConfirm={() => onDeleteChapter(chapter)}
      />
      <ConfirmModal
        open={confirm?.kind === 'chapter-confirm'}
        title={`Delete "${chapter?.title || chapter?.areaName || ''}"?`}
        description="The chapter leaves the Library. It is kept for recovery by an administrator; its audio stays in storage."
        confirmLabel="Delete"
        onCancel={onCancel}
        onConfirm={() => onDeleteChapter(chapter)}
      />
    </>
  );
}

/** The book is not open yet, or could not be read. */
function BookUnavailable({ hub }) {
  const { selected, loading } = hub;
  if (loading) {
    return (
      <p className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading the book…
      </p>
    );
  }
  return (
    <div className="space-y-4 pt-6">
      <Button variant="ghost" size="sm" onClick={hub.closeBook}>
        <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" /> Back to the Library
      </Button>
      <EmptyState
        variant="error"
        title={`Could not open ${selected?.platform}/${selected?.examCode}`}
        description={hub.error || 'The book could not be read.'}
        onRetry={() => hub.openSet(selected.platform, selected.examCode)}
      />
    </div>
  );
}

export default function BookDetail({ hub }) {
  if (!hub.book) return <BookUnavailable hub={hub} />;
  return <OpenBook hub={hub} />;
}

function OpenBook({ hub }) {
  const { book, episodes, busySlugs, catalog } = hub;
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [versionsFor, setVersionsFor] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind, chapter?, published? }
  const [dragIndex, setDragIndex] = useState(null);

  const chapters = orderedChapters(episodes);
  const counts = statusCounts(episodes);
  const noun = chapterNoun(book, 2);
  const versionsChapter = versionsFor ? episodes.find((e) => e.id === versionsFor) || null : null;

  const applyOrder = async (fromIndex, toIndex) => {
    const ids = moveChapter(chapters, fromIndex, toIndex);
    if (ids) await hub.reorder(ids);
  };

  // A published chapter is refused without force (409) and the server names
  // what would go off the site; anything else asks once, plainly.
  const askDelete = async (chapter) => {
    if (chapter.status !== 'published') {
      setConfirm({ kind: 'chapter-confirm', chapter });
    } else {
      const result = await hub.deleteChapter(chapter.id, { force: false });
      if (result?.status === 409) {
        const fallback = [{ id: chapter.id, title: chapter.title || chapter.areaName }];
        setConfirm({ kind: 'chapter', chapter, published: result.detail?.published || fallback });
      }
    }
  };

  const askDeleteBook = async () => {
    const result = await hub.deleteBook({ force: false });
    if (result?.status === 409) {
      setConfirm({ kind: 'book', published: result.detail?.published || [] });
    }
  };

  const actions = {
    review: (chapter, status) => hub.review(chapter, status),
    regenerate: (chapter) => hub.regenerate(chapter.id),
    rename: (chapter, title) => hub.patchChapter(chapter.id, { title }),
    move: (index, delta) => applyOrder(index, index + delta),
    archive: (chapter, archived) => hub.patchChapter(chapter.id, { archived }),
    remove: askDelete,
    versions: (chapter) => setVersionsFor(chapter.id),
    keepCurrent: (chapter) => hub.patchChapter(chapter.id, { clearError: true }),
  };

  return (
    <div className="space-y-6 pt-6">
      <Button variant="ghost" size="sm" onClick={hub.closeBook}>
        <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" /> Back to the Library
      </Button>

      <BookHeader
        book={book}
        onAdd={() => setAdding(true)}
        onEdit={() => setEditing(true)}
        onArchive={() => hub.patchBook({ archived: !book.archivedAt })}
        onDelete={askDeleteBook}
      />

      <section aria-labelledby="chapters-heading" className="space-y-3">
        <h3 id="chapters-heading" className="flex items-center gap-2 text-sm font-semibold">
          {noun.charAt(0).toUpperCase() + noun.slice(1)}
          <span className="text-xs font-normal text-muted-foreground">
            {counts.published || 0} published · {counts.draft || 0} draft · {counts.failed || 0}{' '}
            failed
            {counts.archived ? ` · ${counts.archived} archived` : ''}
          </span>
        </h3>
        <ChapterList
          hub={hub}
          book={book}
          chapters={chapters}
          actions={actions}
          dragIndex={dragIndex}
          setDragIndex={setDragIndex}
          applyOrder={applyOrder}
          onAdd={() => setAdding(true)}
        />
      </section>

      <BookDialog
        open={editing}
        book={book}
        catalog={catalog}
        onSave={(fields) => hub.patchBook(fields)}
        onClose={() => setEditing(false)}
      />
      <ChapterDialog
        open={adding}
        book={book}
        onCreate={(fields) => hub.createChapter(fields)}
        onClose={() => setAdding(false)}
      />
      <VersionsDialog
        open={Boolean(versionsChapter)}
        chapter={versionsChapter}
        busy={versionsChapter ? busySlugs.has(versionsChapter.id) : false}
        onActivate={(versionId) =>
          hub.patchChapter(versionsChapter.id, { activeVersionId: versionId })
        }
        onDelete={(versionId) => hub.deleteVersion(versionsChapter.id, versionId)}
        onClose={() => setVersionsFor(null)}
      />
      <DeleteDialogs
        confirm={confirm}
        onCancel={() => setConfirm(null)}
        onDeleteBook={async () => {
          setConfirm(null);
          await hub.deleteBook({ force: true });
        }}
        onDeleteChapter={async (chapter) => {
          setConfirm(null);
          if (chapter) await hub.deleteChapter(chapter.id, { force: true });
        }}
      />
    </div>
  );
}
