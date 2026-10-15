/**
 * Forge Studio (/admin/forge-studio) — the creative workspace (ADR 0033 §7
 * slice 2; the configuration form it grew from is Blog Machine T-604).
 *
 * Five tabs (components/admin/forge-studio/tabs.js), selected by `?tab=`:
 *   Start            how a piece begins: idea, template, existing content,
 *                    URL, blank
 *   Brief            the creative brief, kind and idea origin
 *   Draft            the document, the forge job that writes the first
 *                    draft, the editable text and the AI actions
 *   Finish           where it goes next: Drafts, review, Editor, Publish,
 *                    Social Hub, Image Prompts, Listen & Learn
 *   Queue            the Forge Studio Queue: many URLs, their "From a URL"
 *                    fields completed singly or in bulk, each sent into
 *                    the forge-from-url job with its brief
 *   Voice & profile  the forge's configuration, moved here whole
 *
 * The session (useForgeSession) is held here so the four workspace tabs
 * share it; `?contentId=` on the URL names the document so a reload comes
 * back to it. The configuration is loaded once for the formats Start offers
 * and the Voice tab edits.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Flame, Loader2 } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getJSON } from '@/lib/api';
import HubTabs from '@/components/admin/HubTabs';
import PageHeader from '@/components/admin/shared/PageHeader';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import StartTab from '@/components/admin/forge-studio/StartTab';
import BriefTab from '@/components/admin/forge-studio/BriefTab';
import DraftTab from '@/components/admin/forge-studio/DraftTab';
import FinishTab from '@/components/admin/forge-studio/FinishTab';
import QueueTab from '@/components/admin/forge-studio/QueueTab';
import VoiceProfileTab from '@/components/admin/forge-studio/VoiceProfileTab';
import { TABS, resolveTab } from '@/components/admin/forge-studio/tabs';
import { useForgeQueue } from '@/components/admin/forge-studio/useForgeQueue';
import { useForgeSession } from '@/components/admin/forge-studio/useForgeSession';

const HELP = [
  'Start: pick how the piece begins. An idea, one of the forge’s formats, a piece already in the pipeline, a URL to scrape, or nothing at all.',
  'Brief: say what it is for, who reads it, what it becomes (kind) and how it started (idea origin), plus tone, length, topics, sources and the channel it publishes to.',
  'Draft: the document is created on the Drafts page first (Drafting), the brief is saved on it, then the forge writes, scrubs and grades the first draft. Edit the text; each AI action is one call to the router and is recorded on the document.',
  'Finish: send it to review, open it in the Editor, schedule it on Publish, or hand it to the Social Hub, Image Prompts or Listen & Learn with its id.',
  'Queue: several URLs at once. Paste them or import .html files under From a URL; each becomes an entry whose fields you complete one at a time or together, and Save sends the selected entries into the forge with their brief.',
  'Voice & profile: the voice the forge writes in, the guardrails, the publish threshold and Auto-Forge. Calibration only suggests; you accept each chip.',
];

/** The Voice & profile panel: the configuration read, its failure, or the form. */
function VoicePanel({ config, configError, onRetry, onConfig }) {
  if (configError) {
    return (
      <EmptyState
        variant="error"
        title="The forge configuration could not be read"
        description={configError}
        onRetry={onRetry}
      />
    );
  }
  if (!config) {
    return (
      <div
        className="flex items-center justify-center py-12"
        role="status"
        aria-label="Loading configuration"
      >
        <Loader2 className="h-8 w-8 animate-spin text-slate-blue" />
      </div>
    );
  }
  return <VoiceProfileTab config={config} onConfig={onConfig} />;
}

/** The header's status line: the open document, else the brief in progress. */
function SessionStatus({ session }) {
  if (session.doc) {
    return (
      <>
        <span className="text-muted-foreground">Working on</span>
        <span className="font-medium">{session.text.title || 'Untitled'}</span>
        <StatusBadge content={session.doc} size="xs" />
      </>
    );
  }
  return <span className="text-muted-foreground">Brief in progress: {session.title}</span>;
}

export default function ForgeStudioPage() {
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);

  const setParams = useCallback(
    (changes) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      setSearchParams(next);
    },
    [searchParams, setSearchParams]
  );

  const session = useForgeSession({
    initialContentId: searchParams.get('contentId') || '',
    onContentId: (id) => setParams({ contentId: id || '' }),
  });
  const queue = useForgeQueue({ enabled: authReady });

  const loadConfig = useCallback(() => {
    getJSON('getForgeConfig')
      .then((answer) => {
        setConfig(answer);
        setConfigError(null);
      })
      .catch((err) => setConfigError(err?.message || 'Failed to load forge configuration.'));
  }, []);

  useEffect(() => {
    if (!authReady) return;
    loadConfig();
  }, [authReady, loadConfig]);

  // A `?contentId=` on arrival (a bookmark, a reload) reopens that document.
  const { contentId, doc, loading, loadDoc } = session;
  useEffect(() => {
    if (!authReady || !contentId || doc || loading) return;
    loadDoc(contentId);
    // loadDoc is stable per contentId; re-running on `doc`/`loading` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, contentId]);

  const setTab = (id) => {
    if (id === activeTab) return;
    setParams({ tab: id });
  };

  const formats = config?.formats || [];

  const start = (mode, extras) => {
    session.start(mode, extras);
    setTab('brief');
  };

  const retryConfig = () => {
    setConfigError(null);
    loadConfig();
  };

  const openDocument = (contentId) => {
    setParams({ tab: 'draft', contentId });
  };

  const panels = {
    start: () => (
      <StartTab
        formats={formats}
        onStart={start}
        onQueueAdd={queue.add}
        onOpenQueue={() => setTab('queue')}
        queueCount={queue.items.filter((entry) => entry.status !== 'forged').length}
        queueBusy={Boolean(queue.busy)}
      />
    ),
    queue: () => (
      <QueueTab queue={queue} onOpenDocument={openDocument} onStart={() => setTab('start')} />
    ),
    brief: () => (
      <BriefTab
        session={session}
        formats={formats}
        onBack={() => setTab('start')}
        onNext={() => setTab('draft')}
      />
    ),
    draft: () => (
      <DraftTab
        session={session}
        formats={formats}
        onBrief={() => setTab('brief')}
        onFinish={() => setTab('finish')}
      />
    ),
    finish: () => (
      <FinishTab
        session={session}
        onDraft={() => setTab('draft')}
        onStart={() => {
          session.reset();
          setTab('start');
        }}
      />
    ),
    voice: () => (
      <VoicePanel
        config={config}
        configError={configError}
        onRetry={retryConfig}
        onConfig={setConfig}
      />
    ),
  };
  // Elements, not component types: a map of arrow components rebuilt each
  // render would remount the panel on every state change and lose its
  // local state (a notice, an AI result, the form being edited).
  const panel = panels[activeTab]();

  const headerStatus = session.doc || session.title ? <SessionStatus session={session} /> : null;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader icon={Flame} status={headerStatus} help={HELP} />

      {session.error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {session.error}
        </div>
      )}
      {session.notice && (
        <div
          role="status"
          className="rounded-md border border-green-500/50 bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-950 dark:text-green-300"
        >
          {session.notice}
        </div>
      )}

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="forge-studio"
        label="Forge Studio"
      >
        <div className="pt-4">{panel}</div>
      </HubTabs>
    </div>
  );
}
