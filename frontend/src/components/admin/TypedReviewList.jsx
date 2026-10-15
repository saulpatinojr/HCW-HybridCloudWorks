/**
 * TypedReviewList — the Frameworks and Coder Corner hubs' list: one content
 * type, a status filter, approve / reject / restore per row (ADR 0033 §2).
 *
 * The two pages were the same 250-430 lines twice, each with its own copy of
 * the transitions and a `published_blog` filter that matched nothing. This is
 * the one copy: the list fetch, the status chips, the confirm modal and the
 * shared transitions hook. Each hub keeps its own card (`renderCard`) and its
 * own words (`help`, `nouns`); the title is the registry's label for the route.
 *
 * Statuses are the canonical ones. "Needs review" is draft + ingested +
 * inspected + in_review, the same set the queue and the dashboard count
 * (content-status.js REVIEW_DECISION_STATUSES), so neither a draft nor an
 * item sent to review hides from these hubs; "Ready / Published" is approved,
 * forge_ready and published — the statuses that are actually stored.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Filter, Loader2, RefreshCw } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getJSON } from '@/lib/api';
import { byNewest } from '@/lib/dateUtils';
import { useContentTransitions } from '@/pages/admin/queue/useContentTransitions';

/** Chip label by `status=` value, in the order the chips are shown. */
const TYPED_STATUS_LABELS = {
  needs_review: 'Needs review',
  in_review: 'In review',
  editing: 'Editing',
  approved: 'Approved',
  needs_rework: 'Needs rework',
  'approved,forge_ready,published': 'Ready / Published',
  rejected: 'Rejected',
};

export const TYPED_STATUS_FILTERS = Object.freeze(
  Object.entries(TYPED_STATUS_LABELS).map(([value, label]) => ({ value, label }))
);

/** The `status=` the list route gets for a chip. */
export function statusParamFor(statusFilter) {
  return statusFilter === 'needs_review' ? 'draft,ingested,inspected,in_review' : statusFilter;
}

/** May a row in this filter be approved? Rejected and live rows cannot. */
export function canApproveIn(statusFilter) {
  return ['needs_review', 'in_review', 'inspected', 'editing', 'needs_rework'].includes(
    statusFilter
  );
}

/** May a row in this filter be rejected? Not from Rejected, not a live page. */
export function canRejectIn(statusFilter, item) {
  return statusFilter !== 'rejected' && !item?.Live && !String(statusFilter).includes('published');
}

const sortByDate = byNewest('fetchedAt', 'createdAt');

export async function fetchTypedContent(type, statusFilter) {
  const params = new URLSearchParams({
    type,
    status: statusParamFor(statusFilter),
    limit: '200',
  });
  const res = await getJSON(`cms/content?${params.toString()}`);
  return (res.items || []).sort(sortByDate);
}

/**
 * @param {{
 *   type: 'framework' | 'coder_corner',
 *   icon: React.ComponentType, help: string[],
 *   nouns: { singular: string, plural: string },
 *   renderCard: (props: {
 *     item, statusFilter, isLoading, itemError, navigate,
 *     handleApprove, handleReject, handleRestore,
 *   }) => React.ReactNode,
 * }} props
 */
export default function TypedReviewList({ type, icon, help, nouns, renderCard }) {
  const navigate = useNavigate();
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'needs_review');
  const [confirmTarget, setConfirmTarget] = useState(null);

  const transitions = useContentTransitions({
    onTransitioned: (contentId) => setItems((prev) => prev.filter((item) => item.id !== contentId)),
  });

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await fetchTypedContent(type, statusFilter);
        if (!cancelled) setItems(data);
      } catch (err) {
        console.error(`Error loading ${nouns.plural}:`, err);
        if (!cancelled) setLoadError(err.message || `Failed to load ${nouns.plural}.`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, statusFilter, type, nouns.plural, reloadKey]);

  useEffect(() => {
    const next = new URLSearchParams();
    next.set('status', statusFilter);
    setSearchParams(next, { replace: true });
  }, [statusFilter, setSearchParams]);

  const handleApprove = (contentId) =>
    transitions.approve(items.find((item) => item.id === contentId) || contentId, {
      reviewNotes: `Approved in ${nouns.plural} queue`,
    });
  const handleReject = (contentId) => setConfirmTarget({ type: 'reject', id: contentId });
  const handleRestore = (contentId) => setConfirmTarget({ type: 'restore', id: contentId });

  const handleConfirm = useCallback(async () => {
    const target = confirmTarget;
    setConfirmTarget(null);
    if (!target) return;
    if (target.type === 'reject') {
      await transitions.reject(target.id, { reviewNotes: `Rejected from ${nouns.plural} queue` });
    } else if (target.type === 'restore') {
      await transitions.restore(target.id, { reviewNotes: 'Restored from rejected' });
    }
  }, [confirmTarget, transitions, nouns.plural]);

  const reload = () => setReloadKey((n) => n + 1);

  return (
    <div className="space-y-6 max-w-5xl">
      <PageHeader
        icon={icon}
        help={help}
        actions={
          <Button variant="outline" size="sm" onClick={reload} className="gap-1">
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Filter className="h-4 w-4" /> Filter by status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Status filter">
            {TYPED_STATUS_FILTERS.map(({ value, label }) => (
              <Button
                key={value}
                variant={statusFilter === value ? 'default' : 'outline'}
                size="sm"
                aria-pressed={statusFilter === value}
                onClick={() => setStatusFilter(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {loading && (
        <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
          <Loader2 className="h-8 w-8 animate-spin text-slate-blue" />
          <span className="sr-only">Loading {nouns.plural}…</span>
        </div>
      )}
      {!loading && loadError && (
        <EmptyState
          variant="error"
          title={`Could not load ${nouns.plural}`}
          description={loadError}
          onRetry={reload}
        />
      )}
      {!loading && !loadError && items.length === 0 && (
        <EmptyState
          variant="filtered"
          title={`No ${nouns.plural} in this status`}
          description={`${nouns.plural[0].toUpperCase()}${nouns.plural.slice(1)} arrive from Submit URLs with the matching content type and from the Review Queue. Try another status.`}
        />
      )}
      {!loading && !loadError && items.length > 0 && (
        <div className="space-y-4">
          {items.map((item) =>
            renderCard({
              item,
              statusFilter,
              isLoading: transitions.loading[item.id],
              itemError: transitions.errors[item.id],
              navigate,
              handleApprove,
              handleReject,
              handleRestore,
            })
          )}
        </div>
      )}

      <ConfirmModal
        open={Boolean(confirmTarget)}
        title={
          confirmTarget?.type === 'reject'
            ? `Reject this ${nouns.singular}?`
            : `Restore this ${nouns.singular}?`
        }
        description={
          confirmTarget?.type === 'reject'
            ? 'Rejected items stay recoverable for about eight days (24 h grace, then a 7-day soft-delete window) before they are removed.'
            : 'This returns it to the review queue as Inspected.'
        }
        confirmLabel={confirmTarget?.type === 'reject' ? 'Reject' : 'Restore'}
        destructive={confirmTarget?.type === 'reject'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
