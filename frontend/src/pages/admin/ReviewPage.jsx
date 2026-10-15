/**
 * /admin/review-queue/:id — one item, on the board its type calls for (ADR 0033).
 *
 *   architecture  → ArchitectureReviewBoard
 *   framework     → FrameworkReviewBoard
 *   coder_corner  → the Coder Corner card with its approve / reject / restore
 *                   (it was shown on the Blog board, which knows nothing of
 *                   languages, difficulty or code previews)
 *   everything else → BlogReviewBoard
 *
 * Every save and publish here reports its outcome: a toast, an inline
 * message on the board, a real `saving` state on the buttons, and no
 * navigation after a save that did not land. Until 2026-10-03 the handlers
 * swallowed every error to console.error, passed `saving={false}` and
 * navigated regardless (ADR 0033 §1, bug 7). The writes are
 * review/useReviewActions; the page is one return over a view table.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeft, Eye, Loader2 } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { usePublicData } from '@/hooks/usePublicData';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import ArchitectureReviewBoard from '@/components/admin/ArchitectureReviewBoard';
import FrameworkReviewBoard from '@/components/admin/FrameworkReviewBoard';
import BlogReviewBoard from '@/components/admin/BlogReviewBoard';
import { CoderCornerReviewBoard } from '@/components/admin/CoderCornerReviewBoard';
import PipelineStepper from '@/components/admin/PipelineStepper';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import TaxonomyPicker from '@/components/admin/shared/TaxonomyPicker';
import { postJSON, getJSON } from '@/lib/api';
import { contentStatusInfo } from '@/lib/status';
import { resolveIdeaOrigin, resolveKind } from '@/lib/taxonomy';
import { useContentTransitions } from './queue/useContentTransitions';
import { useReviewActions } from './review/useReviewActions';

const REVIEW_HELP = [
  'What arrives here: one item from the Review Queue, on the board its type calls for (blog, framework, architecture blueprint or Coder Corner).',
  'What to do: read it, fix the metadata and the kind / idea origin, then Save, Approve (Send to Publish) or Reject. A framework or blueprint is saved from its own board.',
  'Kind says what the item will become; idea origin says how it started. They decide which downstream tools fit, so set them before approving.',
  'Where it goes next: an approved item appears in the Editor for polishing and then on the Publish page; a rejected one decays unless restored from the queue.',
];

const BOARD_LABEL = {
  architecture: 'Architecture Studio',
  framework: 'Framework Studio',
  coder_corner: 'Coder Corner',
};

/** The Coder Corner card's `statusFilter`, from the item's own status. */
function coderCornerFilterFor(blog) {
  const info = contentStatusInfo(blog);
  if (info.id === 'live') return 'approved,forge_ready,published';
  if (['draft', 'ingested', 'inspected'].includes(info.id)) return 'needs_review';
  return info.id;
}

/** Kind and idea origin, editable in the header and saved through updateContentItem. */
function TaxonomyEditor({ blog, blogId, onSaved }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => ({
    kind: resolveKind(blog),
    ideaOrigin: resolveIdeaOrigin(blog),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await postJSON('updateContentItem', { contentId: blogId, updates: draft });
      toast({ title: 'Classification saved', description: 'Kind and idea origin updated.' });
      setOpen(false);
      onSaved?.(draft);
    } catch (err) {
      setError(err?.message || 'The classification could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <span className="inline-flex items-center gap-2">
        <TaxonomyChips item={{ ...blog, ...draft }} />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setOpen(true)}
        >
          Change
        </Button>
      </span>
    );
  }

  return (
    <Card className="w-full">
      <CardContent className="space-y-3 pt-4">
        <TaxonomyPicker
          kind={draft.kind}
          ideaOrigin={draft.ideaOrigin}
          onChange={setDraft}
          disabled={saving}
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Save classification
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The Coder Corner board on the review page: the card, with the shared transitions. */
function CoderCornerReviewPanel({ blog, blogId, onTransitioned }) {
  const [confirmTarget, setConfirmTarget] = useState(null);
  const transitions = useContentTransitions({ onTransitioned });
  const statusFilter = coderCornerFilterFor(blog);

  const handleConfirm = async () => {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (!target) return;
    if (target.type === 'reject') {
      await transitions.reject(blogId, { reviewNotes: 'Rejected from the review page' });
    } else if (target.type === 'restore') {
      await transitions.restore(blogId, { reviewNotes: 'Restored from rejected' });
    }
  };

  return (
    <>
      <CoderCornerReviewBoard
        item={blog}
        statusFilter={statusFilter}
        isLoading={transitions.loading[blogId]}
        itemError={transitions.errors[blogId]}
        handleApprove={() =>
          transitions.approve(blog, { reviewNotes: 'Approved from the review page' })
        }
        handleReject={() => setConfirmTarget({ type: 'reject' })}
        handleRestore={() => setConfirmTarget({ type: 'restore' })}
      />
      <ConfirmModal
        open={Boolean(confirmTarget)}
        title={
          confirmTarget?.type === 'reject' ? 'Reject this coder corner item?' : 'Restore this item?'
        }
        description={
          confirmTarget?.type === 'reject'
            ? 'Rejected items stay recoverable for about eight days before they are removed.'
            : 'This returns it to the review queue as Inspected.'
        }
        confirmLabel={confirmTarget?.type === 'reject' ? 'Reject' : 'Restore'}
        destructive={confirmTarget?.type === 'reject'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmTarget(null)}
      />
    </>
  );
}

/** The board the item's type calls for, wired to the page's writes. */
function ReviewBoard({ blog, blogId, refresh, boardError, actions }) {
  if (blog.type === 'architecture') {
    return (
      <ArchitectureReviewBoard
        blog={blog}
        saving={actions.saving}
        error={boardError}
        onSave={(formData) => actions.saveFields(formData, 'Blueprint')}
        onPublish={(formData) => actions.publishFields(formData, 'architecture', 'Blueprint')}
      />
    );
  }
  if (blog.type === 'framework') {
    return (
      <>
        <FrameworkReviewBoard
          blog={blog}
          saving={actions.saving}
          error={boardError}
          onSave={(formData) => actions.saveFields(formData, 'Framework')}
          onPublish={(formData) => actions.publishFields(formData, 'framework', 'Framework')}
          onDelete={() => actions.setFrameworkDeleteOpen(true)}
        />
        <ConfirmModal
          open={actions.frameworkDeleteOpen}
          title="Delete this framework?"
          description="This content item will be permanently deleted. This cannot be undone."
          confirmLabel="Delete"
          onConfirm={actions.doFrameworkDelete}
          onCancel={() => actions.setFrameworkDeleteOpen(false)}
        />
      </>
    );
  }
  if (blog.type === 'coder_corner') {
    return <CoderCornerReviewPanel blog={blog} blogId={blogId} onTransitioned={refresh} />;
  }
  return <BlogReviewBoard blog={blog} blogId={blogId} onChanged={refresh} />;
}

function ReviewLoading() {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground" role="status">
      <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" /> Loading content…
    </div>
  );
}

/** The review page when its item cannot be read: the reason, Try again, and a way back. */
function ReviewUnavailable({ error, refresh, navigate }) {
  return (
    <EmptyState
      variant="error"
      title="This item could not be loaded"
      description={error?.message || 'It may have been deleted, or the request failed.'}
      onRetry={refresh}
      action={
        <Button variant="outline" size="sm" onClick={() => navigate('/admin/review-queue')}>
          Back to Queue
        </Button>
      }
    />
  );
}

/**
 * The review page for a loaded item: its header, the board for its type and the
 * sidebar of workflow actions, with the board's last refusal shown.
 */
function ReviewContent({ blog, blogId, refresh, navigate, transitions, actions }) {
  const boardLabel = BOARD_LABEL[blog.type] || 'Blog review';
  const boardError = actions.boardError || transitions.errors[blogId] || null;
  return (
    <div className="space-y-6">
      <PageHeader
        icon={Eye}
        title={blog.Title || blog.title || 'Untitled'}
        eyebrow="Pipeline · Review"
        description={`Reviewing on the ${boardLabel} board.`}
        help={REVIEW_HELP}
        status={
          <>
            <StatusBadge content={blog} />
            <Badge variant="outline">{boardLabel}</Badge>
            <TaxonomyEditor blog={blog} blogId={blogId} onSaved={refresh} />
          </>
        }
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate('/admin/review-queue')}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Queue
          </Button>
        }
      >
        <PipelineStepper item={blog} />
      </PageHeader>

      <ReviewBoard
        blog={blog}
        blogId={blogId}
        refresh={refresh}
        boardError={boardError}
        actions={actions}
      />
    </div>
  );
}

/** Loading, unavailable, or the item on its board — first match wins. */
const REVIEW_VIEWS = [
  [(p) => p.loading && !p.blog, ReviewLoading],
  [(p) => Boolean(p.error) || !p.blog, ReviewUnavailable],
  [() => true, ReviewContent],
];

export default function ReviewPage() {
  const { blogId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);
  const {
    data: blog,
    error,
    loading,
  } = usePublicData(
    () =>
      getJSON(`cms/content/item?contentId=${encodeURIComponent(blogId)}`).then((res) => res.item),
    blogId ? `review:${blogId}:${version}` : ''
  );

  const transitions = useContentTransitions({
    onTransitioned: (_id, result) => {
      toast({
        title: result?.to ? `Moved to ${contentStatusInfo(result.to).label}` : 'Status updated',
      });
      refresh();
    },
  });
  const actions = useReviewActions({ blogId, transitions, navigate, toast });

  const view = useMemo(() => ({ blog, error, loading }), [blog, error, loading]);
  const [, View] = REVIEW_VIEWS.find(([when]) => when(view));
  return (
    <View
      blog={blog}
      blogId={blogId}
      error={error}
      loading={loading}
      refresh={refresh}
      navigate={navigate}
      transitions={transitions}
      actions={actions}
    />
  );
}
