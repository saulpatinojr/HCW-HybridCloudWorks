/**
 * Sent to your phone — the last alerts the platform sent to Telegram, with a
 * "Send again" button on each (owner request 2026-11-10).
 *
 * Until then an alert went to the owner's phone and nowhere else, so one that
 * was missed could not be read again. The server now keeps the newest 50
 * (functions lib/notify.js, `system/notify_log`); this card reads them
 * (`GET cms/alerts/recent`, viewer) and sends one again on request
 * (`POST cms/alerts/resend`, editor). Koda reads the same list; it cannot
 * send one again.
 *
 * Each alert shows when it was sent, its title, and its full text, folded
 * away so a long job failure does not push the rest of the list off screen.
 */
import React, { useCallback, useState } from 'react';
import { BellRing, Loader2, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { getJSON, postJSON } from '@/lib/api';
import { agoLabel } from '@/lib/cost';

export const ALERTS_RECENT_ROUTE = 'cms/alerts/recent';
export const ALERTS_RESEND_ROUTE = 'cms/alerts/resend';

const SEVERITY = Object.freeze({
  critical: { label: 'Critical', className: 'text-rose-700 dark:text-rose-400' },
  warning: { label: 'Warning', className: 'text-amber-700 dark:text-amber-400' },
  info: { label: 'Info', className: 'text-muted-foreground' },
});

/** "2026-11-10 00:42 UTC" for an ISO time, or null. */
export function utcMinute(iso) {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The server's own sentence after "code — ", as lib/api.js joins them, or the whole message. */
export function refusalSentence(error) {
  const text = String(error?.message ?? '');
  const at = text.indexOf(' — ');
  return (
    (at >= 0 ? text.slice(at + 3) : text).replace(/ \(reference [^)]*\)$/, '').trim() ||
    'The request failed.'
  );
}

function AlertRow({ alert, sending, onResend }) {
  const severity = SEVERITY[alert.severity] ?? SEVERITY.info;
  const exact = utcMinute(alert.at);
  return (
    <li className="border-b border-border/60 py-3 last:border-0" data-testid="sent-alert">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium [overflow-wrap:anywhere]">
            <span className={`mr-2 text-xs font-semibold ${severity.className}`}>
              {severity.label}
            </span>
            {alert.title || 'Untitled alert'}
          </p>
          <p className="text-xs text-muted-foreground">
            {exact ? (
              <time dateTime={alert.at} title={exact}>
                {agoLabel(alert.at) ?? exact} ({exact})
              </time>
            ) : (
              'Time not recorded'
            )}
            {alert.resentOf ? ' · a repeat of an earlier alert' : null}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onResend(alert)}
          disabled={sending}
          aria-label={`Send again: ${alert.title || 'alert'}`}
        >
          {sending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          )}
          Send again
        </Button>
      </div>
      {alert.message ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-primary">Show the text</summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {alert.message}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/** The log, newest first; a module-level read, as useGuardedLoad needs a stable one. */
const loadAlerts = async () => {
  const answer = await getJSON(ALERTS_RECENT_ROUTE);
  return Array.isArray(answer?.alerts) ? answer.alerts : [];
};

export default function SentAlertsCard() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const guarded = useGuardedLoad(loadAlerts, {
    enabled: authReady,
    // null, not []: the hook re-reads when `empty` changes, and a new array
    // on every render is a change every render (it read in a loop).
    empty: null,
    describeError: refusalSentence,
  });
  const { refresh } = guarded;
  const alerts = guarded.data ?? [];
  const [sendingId, setSendingId] = useState(null);

  const resend = useCallback(
    async (alert) => {
      setSendingId(alert.id);
      try {
        await postJSON(ALERTS_RESEND_ROUTE, { id: alert.id });
        toast({ title: 'Sent again', description: `"${alert.title}" went to Telegram again.` });
        await refresh();
      } catch (error) {
        toast({
          title: 'It could not be sent again',
          description: refusalSentence(error),
          variant: 'destructive',
        });
      } finally {
        setSendingId(null);
      }
    },
    [refresh, toast]
  );

  let body;
  if (guarded.loading) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the alerts sent to
        your phone
      </p>
    );
  } else if (guarded.error) {
    body = <p className="text-sm text-red-600">The alert log could not be read: {guarded.error}</p>;
  } else if (alerts.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        None yet. The log starts with the first alert sent after this change was deployed; earlier
        alerts were not kept.
      </p>
    );
  } else {
    body = (
      <ul aria-label="Alerts sent to your phone">
        {alerts.map((alert) => (
          <AlertRow
            key={alert.id}
            alert={alert}
            sending={sendingId === alert.id}
            onResend={resend}
          />
        ))}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-4 w-4 text-primary" aria-hidden="true" />
              Sent to your phone
            </CardTitle>
            <CardDescription>
              The last 50 alerts sent to Telegram, newest first. Missed one? Press Send again.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => refresh()}
            disabled={guarded.pending}
            aria-label="Read the alerts again"
          >
            <RefreshCw
              className={`h-4 w-4 ${guarded.pending ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
