/**
 * Approved and forge-ready content with no publish time (ADR 0033 Amplify
 * slice). Each card drags onto a day on the grid, and each has a Schedule…
 * button that opens the same dialog — the keyboard route.
 */
import React from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { CalendarPlus, Clock, Loader2 } from 'lucide-react';
import { getPublishTargetForItem } from '@/lib/contentModel';
import { DRAG_TYPE } from './calendarModel';

const MAX_SHOWN = 12;

export default function UnscheduledPanel({ items, loading, error, onRetry, onSchedule }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4" aria-hidden="true" />
          Unscheduled ({items.length})
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Approved content with no publish time. Drag a card onto a day, or press Schedule.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        )}
        {!loading && error && (
          <EmptyState
            compact
            variant="error"
            title="Could not read unscheduled content"
            description={error}
            onRetry={onRetry}
          />
        )}
        {!loading && !error && items.length === 0 && (
          <EmptyState
            compact
            title="Nothing waiting"
            description="Approve content on the Review Queue and it appears here, ready for a date."
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/review-queue?status=needs_review">Open the Review Queue</Link>
              </Button>
            }
          />
        )}
        {items.slice(0, MAX_SHOWN).map((item) => (
          <div
            key={item.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                DRAG_TYPE,
                JSON.stringify({
                  source: 'unscheduled',
                  contentId: item.id,
                  publishTarget: getPublishTargetForItem(item),
                })
              );
              event.dataTransfer.effectAllowed = 'move';
            }}
            className="cursor-grab rounded-lg border border-border p-2 hover:bg-muted/40"
          >
            <p className="truncate text-xs font-medium" title={item.Title || item.title}>
              {item.Title || item.title || 'Untitled'}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusBadge content={item} size="xs" />
              <span className="text-[10px] text-muted-foreground">
                {item['Cloud Provider'] || item.cloudProvider || ''}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 gap-1 px-2 text-xs"
                onClick={() => onSchedule(item)}
              >
                <CalendarPlus className="h-3 w-3" aria-hidden="true" /> Schedule…
              </Button>
            </div>
          </div>
        ))}
        {items.length > MAX_SHOWN && (
          <p className="text-xs text-muted-foreground">
            +{items.length - MAX_SHOWN} more —{' '}
            <Link className="underline" to="/admin/review-queue?status=approved">
              see them on the Review Queue
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
