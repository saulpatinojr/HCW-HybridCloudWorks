/**
 * The pipeline smoke tests on the Health page: fetch RSS, inspect a batch,
 * build the digest. Their settings, their card and the hook that runs them.
 * Moved out of probes.jsx, which re-exports them.
 */
import React, { useState } from 'react';
import { postJSON } from '@/lib/api';
import { runJob } from '@/lib/jobs';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FileText, Info, Play, Workflow, Wrench } from 'lucide-react';

// ── Pipeline smoke tests ──────────────────────────────────────────────────────

export const ACTION_CONFIG = {
  rss: {
    id: 'rss',
    title: 'RSS Fetch',
    subtitle: 'Pulls latest feed entries and creates new content candidates.',
    icon: Play,
    buttonLabel: 'Run Now',
    runningLabel: 'Fetching RSS...',
    details: 'Pulls the latest RSS feed entries and creates new content candidates for review.',
    // A platform job, not an RPC: the fetch takes minutes and Flex Consumption
    // cuts HTTP responses at 230 s (T-322). runJob enqueues and polls.
    runner: async () => {
      const job = await runJob('fetch-rss-feeds', {});
      if (job.status !== 'succeeded') {
        throw new Error(job.error || `RSS fetch ${job.status}`);
      }
      const r = job.result || {};
      const errors = r.errors?.length ? ` ${r.errors.length} feed(s) failed.` : '';
      return `RSS fetch complete: ${r.processed || 0} feeds, ${r.newContent || 0} new content drafts, ${r.duplicates || 0} duplicates skipped.${errors}`;
    },
  },
  inspect: {
    id: 'inspect',
    title: 'Batch Inspect',
    subtitle: 'Queues metadata inspection for recent ingested items.',
    icon: Wrench,
    buttonLabel: 'Run Now',
    runningLabel: 'Inspecting...',
    details:
      'Queues inspection for up to 10 ingested items so metadata is populated before review.',
    // A platform job (T-322): selects ingested documents and runs the inspector
    // on each — scrape, analyse, critique — instead of flagging them for a
    // trigger that does not exist on Azure yet (T-324).
    runner: async () => {
      const job = await runJob('batch-inspect', { limit: 10 });
      if (job.status !== 'succeeded') {
        throw new Error(job.error || `Inspection ${job.status}`);
      }
      const r = job.result || {};
      const rework = r.needsRework ? `, ${r.needsRework} need rework` : '';
      const failed = r.failed ? `, ${r.failed} failed` : '';
      return `Inspection complete: ${r.inspected || 0}/${r.total || 0} documents inspected${rework}${failed}.`;
    },
  },
  digest: {
    id: 'digest',
    title: 'Reviewer Digest',
    subtitle: 'Builds the reviewer summary from queued and recent RSS entries.',
    icon: FileText,
    buttonLabel: 'Run Now',
    runningLabel: 'Generating Digest...',
    details:
      'Generates digest metrics for reviewer operations. If the Azure backend reports a query or index configuration error, check the Cosmos DB indexing policy and Azure Function logs before retrying.',
    runner: async () => {
      const result = await postJSON('generateReviewerDigestManual', {});
      return `Reviewer digest generated: ${result.totalQueued || 0} queued items, ${result.recentRssCount || 0} recent RSS entries.`;
    },
  },
};

/**
 * A digest failure that is really a Cosmos indexing failure, said plainly.
 *
 * The retry sentence used to end "then retry S3.3" — a migration stage that no
 * longer names anything an operator can act on. What to retry is the button
 * they just pressed.
 */
export function normalizeDigestError(message) {
  if (message.includes('FAILED_PRECONDITION') && message.toLowerCase().includes('index')) {
    return 'Reviewer digest query or index configuration is not ready in the Azure backend. Check the Cosmos DB indexing policy and Azure Function logs, then run this action again.';
  }
  return message;
}

function ActionTile({ config, runningAction, actionInfoOpen, onRun, onToggleInfo }) {
  const Icon = config.icon;
  return (
    <div className="h-full rounded-lg border p-3 flex flex-col gap-3">
      <div>
        <p className="text-sm font-semibold">{config.title}</p>
        <p className="text-xs text-muted-foreground mt-1">{config.subtitle}</p>
      </div>
      {actionInfoOpen[config.id] && (
        <div className="rounded-md border border-slate-300/60 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:bg-slate-900/40 dark:text-slate-200">
          {config.details}
        </div>
      )}
      <div className="mt-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="w-full gap-1"
          onClick={() => onRun(config.id)}
          disabled={runningAction !== ''}
        >
          <Icon className="h-4 w-4" />
          {runningAction === config.id ? config.runningLabel : config.buttonLabel}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => onToggleInfo(config.id)}
          title="What this action does"
          aria-label={`Toggle ${config.title} explanation`}
        >
          <Info className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function SmokeActionsCard({
  runningAction,
  actionInfoOpen,
  actionMessage,
  actionError,
  onRunAction,
  onToggleActionInfo,
}) {
  const actionList = [ACTION_CONFIG.rss, ACTION_CONFIG.inspect, ACTION_CONFIG.digest];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Workflow className="h-4 w-4 text-sky-500" /> Pipeline Smoke Tests
        </CardTitle>
        <CardDescription>
          Each of these does real work — fetches feeds, inspects documents, writes a digest. They
          are checks, not simulations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {actionList.map((config) => (
            <ActionTile
              key={config.id}
              config={config}
              runningAction={runningAction}
              actionInfoOpen={actionInfoOpen}
              onRun={onRunAction}
              onToggleInfo={onToggleActionInfo}
            />
          ))}
        </div>
        {actionMessage && <p className="text-xs text-emerald-600">{actionMessage}</p>}
        {actionError && <p className="text-xs text-red-600">{actionError}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Local state for the three smoke actions, kept out of the page component.
 * `lastRuns` keeps each action's latest outcome by id, so the probe registry
 * can show "RSS fetch: Healthy, 3 min ago" after the shared message line has
 * moved on to another action (ADR 0033).
 */
export function useSmokeActions(onAfterRun) {
  const [runningAction, setRunningAction] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [lastRuns, setLastRuns] = useState({});
  const [actionInfoOpen, setActionInfoOpen] = useState({
    rss: false,
    inspect: false,
    digest: false,
  });

  const runAction = async (actionId) => {
    const config = ACTION_CONFIG[actionId];
    if (!config) return;
    setActionError('');
    setActionMessage('');
    setRunningAction(actionId);
    try {
      const nextMessage = await config.runner();
      await onAfterRun?.();
      setActionMessage(nextMessage);
      setLastRuns((prev) => ({
        ...prev,
        [actionId]: { ok: true, message: nextMessage, at: new Date().toISOString() },
      }));
    } catch (error) {
      const rawMessage = error.message || `Failed to run ${config.title}.`;
      const message = actionId === 'digest' ? normalizeDigestError(rawMessage) : rawMessage;
      setActionError(message);
      setLastRuns((prev) => ({
        ...prev,
        [actionId]: { ok: false, message, at: new Date().toISOString() },
      }));
    } finally {
      setRunningAction('');
    }
  };

  const toggleActionInfo = (key) => {
    setActionInfoOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return {
    runningAction,
    actionMessage,
    actionError,
    actionInfoOpen,
    lastRuns,
    runAction,
    toggleActionInfo,
    setActionMessage,
    setActionError,
  };
}
