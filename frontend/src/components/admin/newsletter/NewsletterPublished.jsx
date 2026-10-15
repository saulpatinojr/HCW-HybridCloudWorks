/**
 * NewsletterPublished — the Published tab (ADR 0033 §2: the hub keeps its
 * month view as a FILTERED EMBED of the shared Calendar, not a calendar of
 * its own). Scheduled, sent and failed issues on the grid; choosing one shows
 * it as it was (or will be) sent, with Resend's metrics for it, and the
 * actions an approved issue has from here:
 *
 *   scheduled  Cancel (the broadcast is deleted in Resend; the issue returns
 *              to Drafts) · Reschedule (a new time; Resend's refusal is shown
 *              in its own words when it refuses) · Duplicate
 *   failed     Retry (back to a draft for a fresh approval) · Duplicate
 *   sent       Duplicate
 *
 * A scheduled issue becomes sent by asking Resend, which the server does on
 * each read of it; Check Resend now asks for every scheduled issue at once.
 * The preview iframe has an EMPTY sandbox, as on the review panel.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ConfirmModal from '@/components/admin/ConfirmModal';
import RoleGate from '@/components/admin/RoleGate';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import {
  AlertCircle,
  CalendarClock,
  Copy,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { getJSON, postJSON } from '@/lib/api';
import SharedCalendar from '@/components/admin/calendar/SharedCalendar';
import { itemStatus } from '@/components/admin/calendar/calendarModel';
import NewsletterMetrics from './NewsletterMetrics';
import { formatWhen } from './issueFormat';

const ISSUE_ROUTE = (id) => `cms/newsletters/${encodeURIComponent(id)}`;

function localInputValue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function RescheduleDialog({ issue, busy, onSubmit, onClose }) {
  const [when, setWhen] = useState(localInputValue(issue.scheduledAt));
  const [error, setError] = useState('');
  const submit = (event) => {
    event.preventDefault();
    const date = new Date(when);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now() + 60_000) {
      setError('Pick a time at least a minute ahead.');
      return;
    }
    setError('');
    onSubmit(date.toISOString());
  };
  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Move the send</DialogTitle>
            <DialogDescription>
              Resend has no “move”: the current broadcast is canceled and a new one is created at
              this time with the same content.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="nl-reschedule">
              Sends at ({Intl.DateTimeFormat().resolvedOptions().timeZone})
            </Label>
            <Input
              id="nl-reschedule"
              type="datetime-local"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
              required
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Back
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** When the issue went, goes, or was meant to go. */
function describeWhen(issue) {
  if (issue.status === 'sent') return `Sent ${formatWhen(issue.sentAt)}`;
  if (issue.status === 'scheduled') return `Sends ${formatWhen(issue.scheduledAt)}`;
  if (issue.scheduledAt) return `Was due ${formatWhen(issue.scheduledAt)}`;
  return '';
}

/** One sent, scheduled or failed issue, the actions that touch its Resend broadcast gated at publisher and Duplicate left at the page's role. */
function IssuePanel({ detail, busy, notice, onCancel, onReschedule, onRetry, onDuplicate }) {
  const { issue } = detail;
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [moving, setMoving] = useState(false);
  const when = describeWhen(issue);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={itemStatus({ status: issue.status })} />
        <span className="font-medium">{issue.subject}</span>
        <span className="text-muted-foreground">{when}</span>
        {issue.broadcastStatus === 'queued' && (
          <span className="text-xs text-muted-foreground">Resend is delivering it now.</span>
        )}
      </div>
      {issue.lastError && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {issue.lastError}
        </p>
      )}
      {detail.reconcileWarning && (
        <p role="status" className="text-xs text-muted-foreground">
          Resend could not confirm this issue’s state: {detail.reconcileWarning}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* Cancel, reschedule and retry touch the Resend broadcast, so all
            three routes are publisher (lib/newsletter/issue-actions.js);
            Duplicate below is a draft write and stays at the page's role. */}
        {issue.status === 'scheduled' && (
          <RoleGate
            minRole="publisher"
            reason="Moving or canceling a scheduled send needs the publisher role."
          >
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setMoving(true)}
              disabled={Boolean(busy)}
            >
              <CalendarClock className="h-3.5 w-3.5" /> Reschedule
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-destructive"
              onClick={() => setConfirmCancel(true)}
              disabled={Boolean(busy)}
            >
              <XCircle className="h-3.5 w-3.5" /> Cancel send
            </Button>
          </RoleGate>
        )}
        {issue.status === 'failed' && (
          <RoleGate minRole="publisher" reason="Retrying a send needs the publisher role.">
            <Button size="sm" className="gap-1.5" onClick={onRetry} disabled={Boolean(busy)}>
              {busy === 'retry' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}{' '}
              Retry as a draft
            </Button>
          </RoleGate>
        )}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onDuplicate}
          disabled={Boolean(busy)}
        >
          {busy === 'duplicate' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}{' '}
          Duplicate
        </Button>
      </div>
      {notice && (
        <p
          role={notice.ok ? 'status' : 'alert'}
          className={`text-sm ${notice.ok ? 'text-emerald-600' : 'text-destructive'}`}
        >
          {notice.message}
          {notice.link && (
            <>
              {' '}
              <Link className="underline" to={notice.link.to}>
                {notice.link.label}
              </Link>
            </>
          )}
        </p>
      )}
      <NewsletterMetrics issue={issue} />
      <iframe
        title="Published newsletter"
        sandbox=""
        srcDoc={detail.preview.html}
        className="w-full rounded-lg border bg-white"
        style={{ height: 720 }}
      />
      <ConfirmModal
        open={confirmCancel}
        title="Cancel this send?"
        description="The scheduled broadcast is deleted in Resend and nothing goes to subscribers. The issue returns to Drafts, where it can be approved again."
        confirmLabel="Cancel the send"
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          onCancel();
        }}
      />
      {moving && (
        <RescheduleDialog
          issue={issue}
          busy={busy === 'reschedule'}
          onClose={() => setMoving(false)}
          onSubmit={async (scheduledAt) => {
            const ok = await onReschedule(scheduledAt);
            if (ok) setMoving(false);
          }}
        />
      )}
    </Card>
  );
}

/**
 * The Newsletter Hub's Published tab (see the header): the filtered calendar of
 * scheduled, sent and failed issues, the chosen issue as sent with its metrics,
 * and its actions.
 */
export default function NewsletterPublished({ initialIssueId = null, today }) {
  const [selectedId, setSelectedId] = useState(initialIssueId);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [checking, setChecking] = useState(false);
  const [checkNotice, setCheckNotice] = useState('');
  // Bumped after every write, so the embedded calendar refetches.
  const [calendarKey, setCalendarKey] = useState(0);

  const loadDetail = useCallback(async (id) => {
    setDetailError('');
    try {
      setDetail(await getJSON(ISSUE_ROUTE(id)));
    } catch (err) {
      setDetail(null);
      setDetailError(err.message);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return undefined;
    let current = true;
    queueMicrotask(() => {
      setDetail(null);
      setDetailError('');
      getJSON(ISSUE_ROUTE(selectedId))
        .then((res) => current && setDetail(res))
        .catch((err) => current && setDetailError(err.message));
    });
    return () => {
      current = false;
    };
  }, [selectedId]);

  const act = async (label, call, after) => {
    setBusy(label);
    setNotice(null);
    try {
      const res = await call();
      after?.(res);
      setCalendarKey((k) => k + 1);
      return true;
    } catch (err) {
      setNotice({ ok: false, message: err.message });
      if (err?.status === 409 && selectedId) await loadDetail(selectedId);
      return false;
    } finally {
      setBusy('');
    }
  };

  const etag = detail?.issue?.etag;
  /**
   * Cancel the chosen issue's scheduled send under the detail's ETag; the issue
   * returns to Drafts.
   */
  const handleCancel = () =>
    act(
      'cancel',
      () => postJSON(`${ISSUE_ROUTE(selectedId)}/cancel`, { etag }),
      (res) => {
        setDetail(res);
        setNotice({
          ok: true,
          message: 'The send is canceled. The issue is back in Drafts.',
          link: { to: '/admin/newsletter-hub?tab=drafts', label: 'Open Drafts' },
        });
      }
    );
  const handleReschedule = (scheduledAt) =>
    act(
      'reschedule',
      () => postJSON(`${ISSUE_ROUTE(selectedId)}/reschedule`, { etag, scheduledAt }),
      (res) => {
        setDetail(res);
        setNotice({
          ok: true,
          message: `Moved — it now sends ${formatWhen(res.issue.scheduledAt)}.`,
        });
      }
    );
  /**
   * Send a failed issue back to Drafts as a draft, under the detail's ETag, to
   * be approved again.
   */
  const handleRetry = () =>
    act(
      'retry',
      () => postJSON(`${ISSUE_ROUTE(selectedId)}/retry`, { etag }),
      (res) => {
        setDetail(res);
        setNotice({
          ok: true,
          message: 'Back in Drafts as a draft. Approve it again to send.',
          link: { to: '/admin/newsletter-hub?tab=drafts', label: 'Open Drafts' },
        });
      }
    );
  /** Copy the chosen issue into a new draft, with a link to Drafts where it lands. */
  const handleDuplicate = () =>
    act(
      'duplicate',
      () => postJSON(`${ISSUE_ROUTE(selectedId)}/duplicate`, {}),
      (res) => {
        setNotice({
          ok: true,
          message: `Duplicated as ${res.issue.id}, saved in Drafts.`,
          link: { to: '/admin/newsletter-hub?tab=drafts', label: 'Open Drafts' },
        });
      }
    );

  const checkResend = async () => {
    setChecking(true);
    setCheckNotice('');
    try {
      const res = await postJSON('cms/newsletter-reconcile', {});
      setCheckNotice(
        res.reconciled === 0
          ? 'Nothing is scheduled, so there was nothing to check.'
          : `Checked ${res.reconciled} scheduled issue(s); ${res.changed.length} changed.${res.warnings.length ? ` ${res.warnings.join('; ')}` : ''}`
      );
      setCalendarKey((k) => k + 1);
      if (selectedId) await loadDetail(selectedId);
    } catch (err) {
      setCheckNotice(err.message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Published</h3>
          <p className="text-xs text-muted-foreground">
            Sent, scheduled and failed issues, on the shared calendar. Choose one to see the email
            and its numbers.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={checkResend}
          disabled={checking}
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}{' '}
          Check Resend now
        </Button>
      </div>
      {checkNotice && (
        <p role="status" className="text-xs text-muted-foreground">
          {checkNotice}
        </p>
      )}

      <SharedCalendar
        key={calendarKey}
        kinds={['newsletter']}
        today={today}
        onSelectItem={(item) => setSelectedId(item.sourceId)}
      />

      {detailError && (
        <EmptyState
          compact
          variant="error"
          title="The issue could not be read"
          description={detailError}
          onRetry={() => loadDetail(selectedId)}
        />
      )}

      {selectedId && !detail && !detailError && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the newsletter…
        </p>
      )}

      {detail?.issue && detail.issue.id === selectedId && (
        <IssuePanel
          detail={detail}
          busy={busy}
          notice={notice}
          onCancel={handleCancel}
          onReschedule={handleReschedule}
          onRetry={handleRetry}
          onDuplicate={handleDuplicate}
        />
      )}
    </div>
  );
}
