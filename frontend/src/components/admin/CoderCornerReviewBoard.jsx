import React from 'react';
import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ADMIN_ROUTES } from '@/config/admin';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { canApproveIn, canRejectIn } from '@/components/admin/TypedReviewList';
import {
  CheckCircle,
  XCircle,
  Eye,
  Edit3,
  Loader2,
  Undo2,
  Code2,
  Tag,
  BarChart2,
} from 'lucide-react';

function getEditorPath(id) {
  return ADMIN_ROUTES.EDITOR.replace(':id', id);
}

function getReviewPath(id) {
  return `${ADMIN_ROUTES.REVIEW.replace(':id', id)}?source=content`;
}

const DIFFICULTY_COLORS = {
  beginner: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  intermediate: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
  advanced: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
};

function renderSummary(summary) {
  if (!summary) return null;
  return <p className="text-sm text-muted-foreground line-clamp-2">{summary}</p>;
}

function renderTags(tags = []) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 items-center">
      <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
      {tags.slice(0, 6).map((tag) => (
        <span key={tag} className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
          {tag}
        </span>
      ))}
      {tags.length > 6 && (
        <span className="text-xs text-muted-foreground">+{tags.length - 6} more</span>
      )}
    </div>
  );
}

function renderCodePreview(codePreview, language) {
  if (!codePreview) return null;
  return (
    <div className="rounded-md bg-slate-950 border border-slate-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs text-slate-400 font-mono">{language || 'code'}</span>
        <span className="text-xs text-slate-500">preview</span>
      </div>
      <pre className="text-xs text-slate-300 font-mono p-3 overflow-x-auto leading-relaxed max-h-32 overflow-y-hidden">
        {codePreview}
      </pre>
    </div>
  );
}

function renderBreakdown(sidebarContent) {
  if (!sidebarContent) return null;
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Breakdown</p>
      <p className="text-xs text-muted-foreground line-clamp-2">{sidebarContent}</p>
    </div>
  );
}

function CoderCornerHeader({ item, title, language, difficulty }) {
  const provider = item['Cloud Provider'];
  const difficultyColor = DIFFICULTY_COLORS[difficulty];

  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-base line-clamp-2">{title}</h3>
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          <StatusBadge content={item} />
          {provider && <Badge variant="outline">{provider}</Badge>}
          {language && (
            <Badge className="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200 gap-1">
              <Code2 className="h-3 w-3" />
              {language}
            </Badge>
          )}
          {difficultyColor && (
            <Badge className={`gap-1 ${difficultyColor}`}>
              <BarChart2 className="h-3 w-3" />
              {difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}
            </Badge>
          )}
          <TaxonomyChips item={item} />
        </div>
      </div>
    </div>
  );
}

function CoderCornerActions({
  item,
  statusFilter,
  canApprove,
  isLoading,
  navigate,
  handleApprove,
  handleReject,
  handleRestore,
}) {
  const showReject = canRejectIn(statusFilter, item);

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

      {canApprove && !item.Live && (
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

      {showReject && (
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

/**
 * CoderCornerReviewBoard
 *
 * A card for coder_corner content items that surfaces code-specific metadata:
 *   - language / technology tags
 *   - difficulty level
 *   - code snippet preview (first ~10 lines from blogDraft or content)
 *   - breakdown and use-cases from Summary / sidebarContent
 *
 * Props match QueueItemCard pattern for consistency. On the review page
 * (ReviewPage) the same card is the Coder Corner board, with `statusFilter`
 * set from the item's own status.
 */
export function CoderCornerReviewBoard({
  item,
  statusFilter,
  isLoading,
  itemError,
  handleApprove,
  handleReject,
  handleRestore,
}) {
  const navigate = useNavigate();

  const title = item.Title || item.title || 'Untitled Coder Corner';
  const summary = item.Summary || item.summary || '';
  const language = item.language || item.Language || '';
  const difficulty = (item.difficulty || item.Difficulty || '').toLowerCase();
  const tags = item.Tags || item.keyTopics || item.tags || [];
  const sidebarContent = item.sidebarContent || '';

  // Extract a code preview from the draft — find first fenced code block
  const rawDraft = item.blogDraft || item.content || item.Content || '';
  const codeMatch = rawDraft.match(/```[\w]*\n([\s\S]*?)```/);
  const codePreview = codeMatch ? codeMatch[1].split('\n').slice(0, 10).join('\n') : null;

  const canApprove = canApproveIn(statusFilter);

  return (
    <Card className="overflow-hidden border-l-4 border-l-amber-500/60">
      <CardContent className="p-4 space-y-3">
        <CoderCornerHeader item={item} title={title} language={language} difficulty={difficulty} />

        {renderSummary(summary)}
        {renderTags(tags)}
        {renderCodePreview(codePreview, language)}
        {renderBreakdown(sidebarContent)}
        <CoderCornerActions
          item={item}
          statusFilter={statusFilter}
          canApprove={canApprove}
          isLoading={isLoading}
          navigate={navigate}
          handleApprove={handleApprove}
          handleReject={handleReject}
          handleRestore={handleRestore}
        />

        {itemError && <p className="text-xs text-destructive">{itemError}</p>}
      </CardContent>
    </Card>
  );
}
