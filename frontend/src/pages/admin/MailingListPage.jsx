/**
 * Newsletter Hub (route `/admin/newsletter-hub`) — the weekly newsletter and its provider, Resend (ADR 0030, ADR 0033).
 *
 * Resend replaced Klaviyo, which this page used to read through `klaviyoProxy`:
 * lists, profiles and campaigns, and nothing was ever written. The tabs follow
 * an issue's life (components/admin/newsletter):
 *
 *   Newsletter  build this week's issue, review it, delete it or keep it
 *   Drafts      kept issues, edited and approved; approval schedules it
 *               through Resend only when a publisher confirms
 *   Published   the shared Calendar filtered to newsletter sends, each email
 *               viewable with Resend's metrics; cancel, reschedule, retry and
 *               duplicate live here beside the preview
 *   Audience    the Newsletter segment in Resend: counts, the contacts a page
 *               at a time, search across the whole list, CSV export, adding a
 *               subscriber, and (publisher) unsubscribe, resubscribe, remove
 *   Settings    what every issue needs (postal address, reply-to, send slot),
 *               the sender address, the Resend connection check, and Resend
 *               itself: sending domains (records, verify, tracking), recent
 *               emails and API logs
 *
 * The test posts a NAME to `connectionProbe` and the server builds the call,
 * so `RESEND_API_KEY` never reaches the browser.
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import HubTabs from '@/components/admin/HubTabs';
import { Mail, Loader2, RefreshCw, CheckCircle, AlertCircle, ExternalLink } from 'lucide-react';
import { postJSON } from '@/lib/api';
import { LINK_PARAMS } from '@/lib/itemLinks';
import { countList, unwrapProxy } from '@/lib/proxyEnvelope';
import NewsletterIssues from '@/components/admin/newsletter/NewsletterIssues';
import NewsletterPublished from '@/components/admin/newsletter/NewsletterPublished';
import NewsletterAudience from '@/components/admin/newsletter/NewsletterAudience';
import NewsletterSettingsCard from '@/components/admin/newsletter/NewsletterSettingsCard';
import SenderCard from '@/components/admin/newsletter/settings/SenderCard';
import ResendDomains from '@/components/admin/newsletter/settings/ResendDomains';
import ResendEmails from '@/components/admin/newsletter/settings/ResendEmails';
import ResendLogs from '@/components/admin/newsletter/settings/ResendLogs';

const TABS = [
  { id: 'newsletter', label: 'Newsletter' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'published', label: 'Published' },
  { id: 'audience', label: 'Audience' },
  { id: 'settings', label: 'Settings' },
];
const TAB_IDS = new Set(TABS.map((tab) => tab.id));
/** Tabs that moved: a bookmark to one lands where its content went. */
const MOVED_TABS = { connection: 'settings' };

/** The words this hub uses, once (ADR 0033): Resend's and this page's. */
const GLOSSARY = [
  <span key="publication">
    <strong>Publication</strong> — this newsletter: one list of subscribers, one sender, one weekly
    rhythm.
  </span>,
  <span key="issue">
    <strong>Issue</strong> (Resend calls it a <strong>Campaign</strong> or{' '}
    <strong>Broadcast</strong>) — one send: a subject, an intro, sections of items, to everyone on
    the list at one time.
  </span>,
  <span key="template">
    <strong>Template</strong> — the design the email is laid out in: the built-in one, or a Resend
    template chosen on Settings.
  </span>,
  <span key="audience">
    <strong>Audience</strong> — the confirmed subscribers, kept in Resend as the “Newsletter”
    segment. Nothing here stores an address.
  </span>,
  <span key="send">
    <strong>Send</strong> — Approve on Drafts schedules the issue through Resend for the next send
    slot (or its own send time); Published shows it as scheduled, then sent once Resend confirms.
  </span>,
  'Newsletter builds this week’s issue from what the site published. Drafts holds the ones you kept; approve one there. Published is the calendar of what went out. Audience is who gets it. Settings is everything set once.',
];

// ── Resend connection ─────────────────────────────────────────────────────────

/**
 * A human sentence for a working key, or a thrown Error with Resend's own.
 *
 * GET /domains on the server. A key minted with sending access only is refused
 * there, which is the failure worth catching before anything is built on it.
 */
export async function checkResend() {
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'resend' }), 'Resend');
  const count = countList(body);
  if (count === null) return 'Connected to Resend.';
  return count === 0
    ? 'Connected, but no sending domain has been added to Resend yet.'
    : `Connected to Resend — ${count} sending domain(s).`;
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

/**
 * Everything that is set once rather than per issue. The issue tabs mount
 * fresh when opened, so they read saved settings without being told.
 *
 * The Resend cards mount only with this tab, and each loads and fails on its
 * own, so Resend being slow or unconfigured never holds up the settings card.
 */
function SettingsTab({ onStatusChange }) {
  return (
    <div className="max-w-3xl space-y-6">
      <NewsletterSettingsCard />
      <SenderCard />
      <ConnectionCard onStatusChange={onStatusChange} />
      <ResendDomains />
      <ResendEmails />
      <ResendLogs />
    </div>
  );
}

function ConnectionCard({ onStatusChange }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult({ ok: true, message: await checkResend() });
      onStatusChange?.(true);
    } catch (err) {
      setResult({ ok: false, message: err.message });
      onStatusChange?.(false);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Resend API Connection</CardTitle>
        <CardDescription>
          The Resend API key is stored in Azure Key Vault and used only on the server — it is never
          sent to the browser. It must be created with Full access; a key with Sending access only
          cannot manage the mailing list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
            THE BUTTON AND THE LINKS SHARE A FLEX ROW, because `space-y-4` on
            this CardContent cannot separate them: it sets margin-top on a
            following sibling, and inline-flex siblings land on one line.
            `flex-wrap` lets the links drop below the button on a narrow card.
            The result panel stays outside the row as its own block.
          */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button onClick={handleTest} disabled={testing} className="gap-2">
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Test Connection
          </Button>
          <a
            href="https://resend.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            API keys in Resend <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a
            href="https://resend.com/domains"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            Sending domains <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        {result && (
          <div
            className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
              result.ok
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {result.ok ? (
              <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <p>{result.message}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The header's Resend line: the shared vocabulary for a dependency's state, and its sentence. */
function connectionStatus(connected) {
  if (connected === 'checking') return { system: 'unknown', text: 'Checking Resend…' };
  if (connected) return { system: 'healthy', text: 'Resend connected' };
  return { system: 'offline', text: 'Resend not reachable — test it on Settings' };
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MailingListPage() {
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  // A bookmark to a tab that no longer exists (`lists`, `campaigns`) lands on
  // the newsletter rather than on a blank page.
  const requested = MOVED_TABS[searchParams.get('tab')] ?? searchParams.get('tab');
  const activeTab = TAB_IDS.has(requested) ? requested : 'newsletter';
  // The Calendar links an issue as `?tab=published&issue=<id>`; the
  // dashboard's Decision Center as `?tab=newsletter` or `?tab=drafts`.
  const issueParam = searchParams.get(LINK_PARAMS.issue) || null;
  const [connected, setConnected] = useState('checking');

  useEffect(() => {
    if (!authReady) return;
    // The header dot uses the same check as Test Connection, so the two cannot
    // disagree. GET /domains spends nothing on either Resend meter.
    checkResend()
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, [authReady]);

  const setTab = (id) => setSearchParams({ tab: id });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Mail}
        help={GLOSSARY}
        helpTitle="What the words mean"
        status={
          <>
            <StatusBadge system={connectionStatus(connected).system} />
            <span className="text-muted-foreground">{connectionStatus(connected).text}</span>
          </>
        }
      />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="newsletter"
        label="Newsletter Hub"
      >
        {activeTab === 'newsletter' && (
          <NewsletterIssues view="review" linkedIssueId={issueParam} />
        )}
        {activeTab === 'drafts' && <NewsletterIssues view="drafts" linkedIssueId={issueParam} />}
        {activeTab === 'published' && <NewsletterPublished initialIssueId={issueParam} />}
        {activeTab === 'audience' && <NewsletterAudience />}
        {activeTab === 'settings' && <SettingsTab onStatusChange={setConnected} />}
      </HubTabs>
    </div>
  );
}
