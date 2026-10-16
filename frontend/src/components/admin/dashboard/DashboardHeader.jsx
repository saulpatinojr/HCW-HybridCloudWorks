import React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, RefreshCw, Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import RoleGate from '@/components/admin/RoleGate';

function pluralize(n, word) {
  return `${n} ${word}${n !== 1 ? 's' : ''}`;
}

export function CountLink({
  to,
  children,
  className,
  onClick,
  'aria-disabled': ariaDisabled,
  'aria-describedby': ariaDescribedBy,
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-disabled={ariaDisabled}
      aria-describedby={ariaDescribedBy}
      className={cn(
        'underline-offset-2 hover:text-primary hover:underline focus-visible:underline',
        className
      )}
    >
      {children}
    </Link>
  );
}

/**
 * The headline, the three header counts, and the honest line beneath them:
 * the load error with a stale badge and Retry when a re-read failed, the
 * Recount and New Content actions beside.
 */
export default function DashboardHeader({
  today,
  counts,
  loadError,
  stale,
  onRetry,
  recalculating,
  onRecalculate,
  onNewContent,
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {today}
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          {counts.queue > 0 ? (
            <RoleGate minRole="editor" reason="Opening the review queue needs the editor role.">
              <CountLink to="/admin/review-queue?status=needs_review">
                {`${pluralize(counts.queue, 'item')} waiting for you`}
              </CountLink>
            </RoleGate>
          ) : (
            "You're all caught up 🎉"
          )}
        </h1>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">
          <RoleGate minRole="editor" reason="Opening these lists needs the editor role.">
            <CountLink to="/admin/live-pages">{counts.live} pieces live</CountLink>
            {' · '}
            <CountLink to="/admin/editor">{counts.editor} in editor</CountLink>
            {counts.rejected > 0 && ' · '}
            {counts.rejected > 0 && (
              <CountLink to="/admin/review-queue?status=rejected">
                {counts.rejected} rejected
              </CountLink>
            )}
          </RoleGate>
        </p>
        {loadError && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive"
            role="alert"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{loadError}</span>
            {stale && (
              <Badge variant="outline" className="border-destructive/50 text-destructive">
                Numbers may be stale
              </Badge>
            )}
            {onRetry && (
              <Button variant="outline" size="sm" className="h-7" onClick={onRetry}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <RoleGate minRole="editor" reason="Recounting needs the editor role.">
          <Button
            variant="outline"
            size="sm"
            onClick={onRecalculate}
            disabled={recalculating}
            title="Recount every item from the content store. Use it when a number here looks wrong."
          >
            {recalculating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            )}
            {recalculating ? 'Recounting…' : 'Recount'}
          </Button>
        </RoleGate>
        <RoleGate minRole="editor" reason="Creating content needs the editor role.">
          <Button size="sm" onClick={onNewContent}>
            <Zap className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            New Content
          </Button>
        </RoleGate>
      </div>
    </div>
  );
}
