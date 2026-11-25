/**
 * Who opened, clicked or bounced one broadcast (#504), collapsed until asked.
 *
 * `GET cms/mailing-list/broadcasts/{id}/recipients?type=` pages through
 * Resend's list for one event type; nothing is read until the section is
 * opened, so looking at an issue does not spend a Resend call on a list the
 * reader may not want. Only what the API projects is shown.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AlertCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { getJSON } from '@/lib/api';
import { describeResendError } from './resendFormat';

export const RECIPIENT_TYPE_OPTIONS = [
  { value: 'opened', label: 'Opened' },
  { value: 'clicked', label: 'Clicked' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'complained', label: 'Complained' },
];
const PAGE_SIZE = 25;

export function recipientsRoute(broadcastId, type, after) {
  const params = new URLSearchParams({ type, limit: String(PAGE_SIZE) });
  if (after) params.set('after', after);
  return `cms/mailing-list/broadcasts/${encodeURIComponent(broadcastId)}/recipients?${params.toString()}`;
}

function RecipientList({ rows }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nobody yet.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border text-sm">
      {rows.map((row, index) => (
        <li
          key={`${row.email}-${index}`}
          className="flex flex-wrap justify-between gap-2 px-3 py-2"
        >
          <span className="break-all">{row.email || '—'}</span>
          <span className="text-xs text-muted-foreground">
            {[row.count ? `${row.count}×` : null, row.bounce_type].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function useRecipients(broadcastId, type, enabled) {
  const [rows, setRows] = useState([]);
  const [nextAfter, setNextAfter] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const load = useCallback(
    async (after) => {
      const mine = after ? generation.current : ++generation.current;
      setLoading(true);
      setError('');
      // A new type starts empty, so one list never shows under another's label.
      if (!after) setRows([]);
      try {
        const res = await getJSON(recipientsRoute(broadcastId, type, after));
        if (mine !== generation.current) return;
        setRows((previous) => [...(after ? previous : []), ...(res.recipients || [])]);
        setNextAfter(res.has_more ? (res.next_after ?? null) : null);
      } catch (err) {
        if (mine === generation.current) setError(describeResendError(err));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [broadcastId, type]
  );

  useEffect(() => {
    if (!enabled) return;
    queueMicrotask(() => load(null));
  }, [enabled, load]);

  return { rows, nextAfter, loading, error, loadMore: () => load(nextAfter) };
}

// The list shows unless there is an error, or the first page is still loading.
function showsRecipientList(recipients) {
  const firstLoad = recipients.loading && recipients.rows.length === 0;
  return !recipients.error && !firstLoad;
}

export default function RecipientsViewer({ broadcastId }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('opened');
  const recipients = useRecipients(broadcastId, type, open);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-sm font-medium"
      >
        <Chevron className="h-4 w-4" /> Who opened / clicked / bounced
      </button>
      {open && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            Show
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              {RECIPIENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {recipients.error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {recipients.error}
            </p>
          )}
          {showsRecipientList(recipients) && <RecipientList rows={recipients.rows} />}
          {recipients.loading && <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />}
          {!recipients.loading && recipients.nextAfter && (
            <Button size="sm" variant="outline" onClick={recipients.loadMore}>
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
