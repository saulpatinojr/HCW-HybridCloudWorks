/**
 * /admin/frameworks — framework content (matrices, pillars, structured
 * guides), listed by status with approve / reject / restore. The list, the
 * filters and the transitions are TypedReviewList (ADR 0033 §2); this file
 * is the framework card and the page's words.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import TypedReviewList, { canApproveIn, canRejectIn } from '@/components/admin/TypedReviewList';
import { getCoverImageUrl } from '@/lib/blogUtils';
import { ADMIN_ROUTES } from '@/config/admin';
import { CheckCircle, XCircle, Eye, Edit3, Loader2, ListChecks, Undo2 } from 'lucide-react';

const FRAMEWORKS_HELP = [
  'What arrives here: content created with the Framework type on Submit URLs, or classified as a framework on the review page.',
  'A framework is a structured guide: pillars, maturity scores, patterns, an IaC example and official sources. Its board on the review page has a tab for each.',
  'What to do: View opens the review board; Approve sends it to the Editor and Publish stages; Reject removes it (recoverable for about eight days).',
  'Where it goes next: approved frameworks are polished in the Editor and go live from the Publish page under /<provider>/frameworks.',
];

function getReviewPath(id) {
  return `${ADMIN_ROUTES.REVIEW.replace(':id', id)}?source=content`;
}

function getEditorPath(id) {
  return ADMIN_ROUTES.EDITOR.replace(':id', id);
}

function FrameworkActions({
  item,
  statusFilter,
  isLoading,
  handleApprove,
  handleReject,
  handleRestore,
  navigate,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Button
        variant="outline"
        size="sm"
        onClick={() => navigate(getReviewPath(item.id))}
        className="gap-1"
      >
        <Eye className="h-4 w-4" /> View
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate(getEditorPath(item.id))}
        className="gap-1"
      >
        <Edit3 className="h-4 w-4" /> Edit
      </Button>

      {canApproveIn(statusFilter) && !item.Live && (
        <Button
          variant="default"
          size="sm"
          onClick={() => handleApprove(item.id)}
          disabled={Boolean(isLoading)}
          className="gap-1"
        >
          {isLoading === 'approving' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle className="h-4 w-4" />
          )}
          Approve
        </Button>
      )}
      {canRejectIn(statusFilter, item) && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleReject(item.id)}
          disabled={Boolean(isLoading)}
          className="gap-1 text-destructive hover:text-destructive"
        >
          {isLoading === 'rejecting' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          Reject
        </Button>
      )}

      {statusFilter === 'rejected' && (
        <Button
          variant="default"
          size="sm"
          onClick={() => handleRestore(item.id)}
          disabled={Boolean(isLoading)}
          className="gap-1"
        >
          {isLoading === 'restoring' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Undo2 className="h-4 w-4" />
          )}
          Restore
        </Button>
      )}
    </div>
  );
}

export function FrameworkCard({ item, itemError, ...actions }) {
  const coverUrl = getCoverImageUrl(item);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col sm:flex-row gap-4 p-4">
        {coverUrl && (
          <img
            src={coverUrl}
            alt=""
            className="w-full sm:w-32 h-24 object-cover rounded-md shrink-0"
            loading="lazy"
          />
        )}
        <div className="flex-1 space-y-2">
          <div>
            <h3 className="font-semibold text-base line-clamp-2">
              {item.Title || item.title || 'Untitled Framework'}
            </h3>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <StatusBadge content={item} />
              <Badge variant="outline">
                {item['Cloud Provider'] || item.cloudProvider || 'Unknown'}
              </Badge>
              {item.category && <Badge variant="secondary">{item.category}</Badge>}
              <TaxonomyChips item={item} />
            </div>
          </div>

          <p className="text-sm text-muted-foreground line-clamp-2">
            {item.Summary || item.summary || 'No summary available'}
          </p>

          {item.sourceUrl && (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline"
            >
              View source
            </a>
          )}

          <FrameworkActions item={item} {...actions} />
          {itemError && <p className="text-xs text-destructive mt-1">{itemError}</p>}
        </div>
      </div>
    </Card>
  );
}

export default function FrameworksPage() {
  return (
    <TypedReviewList
      type="framework"
      icon={ListChecks}
      help={FRAMEWORKS_HELP}
      nouns={{ singular: 'framework', plural: 'frameworks' }}
      renderCard={(props) => <FrameworkCard key={props.item.id} {...props} />}
    />
  );
}
