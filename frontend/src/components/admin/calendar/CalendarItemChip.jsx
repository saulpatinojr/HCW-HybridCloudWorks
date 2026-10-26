/**
 * One item on the grid: its kind's colour AND icon AND word, the time, and a
 * failure or conflict mark when it has one (ADR 0033: colour is never the
 * only signal). A button, so it opens from the keyboard; draggable when it is
 * content that can move, with the Reschedule action in the preview as the
 * keyboard route to the same change.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { DRAG_TYPE, formatTime, isReschedulable, kindMeta } from './calendarModel';

export default function CalendarItemChip({ item, conflict = false, compact = false, onSelect }) {
  const meta = kindMeta(item.kind);
  const { Icon } = meta;
  const failed = item.status === 'failed';
  const draggable = isReschedulable(item);
  const time = item.allDay ? 'All day' : formatTime(item.start);
  const label = `${meta.label}: ${item.title}, ${time}${failed ? ', failed' : ''}${conflict ? ', shares a slot with another item' : ''}`;

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={
        draggable
          ? (event) => {
              event.dataTransfer.setData(
                DRAG_TYPE,
                JSON.stringify({
                  source: 'calendar',
                  contentId: item.sourceId,
                  start: item.start,
                  publishTarget: item.meta?.publishTarget || null,
                })
              );
              event.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(item);
      }}
      aria-label={label}
      title={label}
      data-kind={item.kind}
      data-status={item.status}
      className={`flex w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left text-xs leading-tight hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${meta.chip} ${
        failed ? 'border-dashed' : ''
      } ${['published', 'sent', 'done'].includes(item.status) ? 'opacity-80' : ''} ${draggable ? 'cursor-grab' : ''}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {!compact && (
        <span className="shrink-0 tabular-nums text-xs opacity-80">
          {item.allDay ? '' : formatTime(item.start)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {(failed || conflict) && (
        <AlertTriangle
          className={`h-3 w-3 shrink-0 ${failed ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
