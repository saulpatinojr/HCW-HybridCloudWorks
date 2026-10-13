/**
 * StreamYardOnAirPanel — interactive control panel on the StreamYard On-Air
 * card in Admin → Integrations → Services (Content group).
 *
 * Shows:
 *   1. Inbound webhook endpoint (`/api/streamyard/webhook`) and public website
 *      registration endpoint (`/api/public/webinars/register`).
 *   2. A 1-click "Send test registration" button (`POST cms/streamyard/test-event`)
 *      that verifies `STREAMYARD_API_KEY`, sends a Telegram alert, and records a
 *      synthetic registrant event.
 *   3. Stored webinar registration / attendance counters and recent masked
 *      registrant rows from `GET cms/streamyard/status`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getJSON, postJSON } from '@/lib/api';

function formatStatusLabel(status) {
  if (status === 'attended_live') return 'Attended live';
  if (status === 'watched_on_demand') return 'On demand';
  return 'Registered';
}

function EndpointRow({ label, value }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API unavailable in some non-HTTPS test environments
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs">
      <div className="min-w-0">
        <span className="font-medium text-foreground">{label}: </span>
        <code className="break-all font-mono text-[11px] text-muted-foreground">{value}</code>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={handleCopy}
        className="h-6 px-2 text-xs"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        <span className="ml-1">{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}

function RecentRegistrantsList({ items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No webinar registrations recorded yet. Send a test event above to verify the pipeline.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">Recent webinar activity</p>
      <ul className="divide-y divide-border/50 rounded-md border border-border/60 text-xs">
        {items.slice(0, 5).map((item, idx) => (
          <li
            key={`${item.maskedEmail}-${item.recordedAt || idx}`}
            className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <span className="font-mono font-medium text-foreground">{item.maskedEmail}</span>
              <span className="mx-1.5 text-muted-foreground">·</span>
              <span className="text-muted-foreground">{item.webinarTitle}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                {formatStatusLabel(item.status)}
              </span>
              {item.newsletterInvited ? <span>Newsletter invited</span> : null}
              {item.telegramSent ? <span>Telegram sent</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StreamYardOnAirPanel({ onTested }) {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const [state, setState] = useState(null);
  const [sending, setSending] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!authReady) return undefined;
    const mine = ++generation.current;
    getJSON('cms/streamyard/status')
      .then((res) => {
        if (mine === generation.current) setState(res);
      })
      .catch(() => {
        // Status read is optional enrichment; the card's beaker surfaces errors
      });
    return () => {
      generation.current += 1;
    };
  }, [authReady]);

  const handleSendTest = async () => {
    if (sending) return;
    setSending(true);
    try {
      const res = await postJSON('cms/streamyard/test-event', {
        webinarTitle: 'HCW On-Air Test Webinar',
        status: 'registered',
      });
      if (!res?.ok) {
        toast({
          title: 'StreamYard test event refused',
          description: res?.error || 'Set STREAMYARD-API-KEY on the Keys tab first.',
          variant: 'destructive',
        });
        return;
      }
      setState((prev) => ({ ...(prev || {}), ...res, configured: true }));
      toast({
        title: 'Test registration recorded',
        description: res.event?.telegramSent
          ? 'Recorded test registrant and sent Telegram alert.'
          : 'Recorded test registrant.',
      });
      onTested?.();
    } catch (err) {
      toast({
        title: 'StreamYard test failed',
        description: err?.message || 'Could not send test webinar event.',
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  };

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://hybridcloudworks.com';

  return (
    <div className="mt-3 space-y-3 border-t border-border/60 pt-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <EndpointRow label="Webhook URL" value={`${origin}/api/streamyard/webhook`} />
        <EndpointRow label="Public Form API" value={`${origin}/api/public/webinars/register`} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleSendTest}
            disabled={sending}
            className="shrink-0 gap-1.5"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? 'Sending test…' : 'Send test registration'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Simulates an On-Air webinar registration and sends a Telegram alert.
          </p>
        </div>
        {state ? (
          <p className="text-xs font-medium text-muted-foreground">
            Total registrants:{' '}
            <span className="text-foreground">{state.totalRegistrants ?? 0}</span>
            {' · '}Attended: <span className="text-foreground">{state.totalAttended ?? 0}</span>
          </p>
        ) : null}
      </div>

      {state ? <RecentRegistrantsList items={state.recentRegistrants} /> : null}
    </div>
  );
}
