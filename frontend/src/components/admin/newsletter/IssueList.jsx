/**
 * The issues panel's list half (ADR 0030 §2a; split out of
 * NewsletterIssues.jsx in PR #841): the heading and its actions, the notice,
 * and the cards, each with a red X where the server allows a delete. Nothing
 * here requests anything; every press is reported upward.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, Loader2, PenTool, RefreshCw, X } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { STATUS_LABELS } from './issueFormat';
import { DELETABLE, issueLabel } from './issuesModel';

export function Notice({ notice }) {
  if (!notice) return null;
  return (
    <p
      role={notice.ok ? 'status' : 'alert'}
      className={`text-sm flex items-start gap-2 ${notice.ok ? 'text-emerald-600' : 'text-destructive'}`}
    >
      {notice.ok ? (
        <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
      ) : (
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
      )}
      {notice.message}
    </p>
  );
}

function BuildButton({ busy, onClick }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 h-8"
      onClick={onClick}
      disabled={Boolean(busy)}
    >
      {busy === 'build' ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <PenTool className="h-3.5 w-3.5" />
      )}
      Build this week&apos;s issue
    </Button>
  );
}

/** The heading and the actions over the list; only the review tab builds. */
export function IssuesHeader({ view, busy, onBuild, onRefresh }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{view === 'drafts' ? 'Drafts' : 'Weekly issues'}</h3>
      <div className="flex gap-2">
        {view === 'review' && <BuildButton busy={busy} onClick={onBuild} />}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-8"
          onClick={onRefresh}
          disabled={Boolean(busy)}
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
    </div>
  );
}

const EMPTY_COPY = {
  drafts: {
    title: 'Nothing in Drafts',
    description: 'Keep an issue from the Newsletter tab and it appears here.',
  },
  review: {
    title: 'No issues to review',
    description: "Build this week's issue to draft one from what was published.",
  },
};

/** One issue: the card selects it; the red X asks to delete it, where the server allows. */
function IssueCard({ row, selected, busy, onSelect, onDelete }) {
  const label = issueLabel(row.id);
  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        // Not while an action runs: its late response would land on
        // whichever issue had been selected in the meantime.
        disabled={busy}
        aria-pressed={selected}
        className={`rounded-lg border px-3 py-2 text-left text-sm ${selected ? 'border-primary' : 'border-border'}`}
      >
        <span className="block font-medium">{label}</span>
        <Badge variant="secondary" className="mt-1 text-xs">
          {STATUS_LABELS[row.status] || row.status}
        </Badge>
      </button>
      {DELETABLE.has(row.status) && (
        <button
          type="button"
          onClick={() => onDelete(row)}
          disabled={busy}
          aria-label={`Delete ${label}`}
          title="Delete"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-white shadow hover:bg-red-700 disabled:opacity-50"
        >
          <X className="h-3 w-3" strokeWidth={3} />
        </button>
      )}
    </li>
  );
}

/** The cards for this view, or what to do when there are none. */
export function IssueList({ view, rows, selectedId, busy, onSelect, onDelete }) {
  if (rows.length === 0) {
    const copy = EMPTY_COPY[view] || EMPTY_COPY.review;
    return <EmptyState compact title={copy.title} description={copy.description} />;
  }
  return (
    <ul className="flex flex-wrap gap-3 pt-2" aria-label="Issues">
      {rows.map((row) => (
        <IssueCard
          key={row.id}
          row={row}
          selected={row.id === selectedId}
          busy={Boolean(busy)}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}
