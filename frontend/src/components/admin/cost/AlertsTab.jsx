/**
 * Alerts — the signals the server worked out from the snapshot, worst first,
 * each opening the tab that explains it; the rules in plain words, so the
 * reader knows what will and will not raise one; and the settings those rules
 * read (the AI budget, how many days before a renewal to say so, whether
 * Telegram and the monthly digest are on, how often Azure is re-read).
 *
 * The words and an icon always go with the colour of a severity.
 */
import React, { useState } from 'react';
import { Link } from 'react-router';
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, Loader2, Save } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SEVERITIES, saveCostSettings } from '@/lib/cost';
import { SectionCard } from './costShared';

export const REMINDERS_HREF = '/admin/platform-settings?tab=reminders';

/** The icon and colours of each severity; the word is printed beside them. */
const SEVERITY_LOOK = Object.freeze({
  critical: {
    Icon: AlertOctagon,
    className:
      'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  },
  warning: {
    Icon: AlertTriangle,
    className:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  },
  info: {
    Icon: Info,
    className:
      'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  },
});

/** The server's rules, said once in plain words (the contract's signal rules). */
export const RULES = Object.freeze([
  'An Azure budget at 50% of its amount is information, at 75% a warning, at 90% or over critical; a forecast past 100% is a warning.',
  'Azure not readable at all is a warning; a snapshot older than 36 hours is information.',
  'ElevenLabs under 20% of its credits is a warning, under 5% critical; its read failing is information.',
  'The Replicate image budget at 80% is a warning, at 100% critical.',
  'AI spend at 80% of the monthly AI budget below is a warning, at 100% critical. With no budget set, nothing is raised.',
  'A service renewal within the lead days below is information; due today or tomorrow a warning; overdue and not renewing on its own, a warning.',
  'New warnings and criticals go to Telegram once each, from the daily check; nothing is sent twice for the same signal.',
]);

function Signal({ signal }) {
  const look = SEVERITY_LOOK[signal.severity] ?? SEVERITY_LOOK.info;
  const word = SEVERITIES.find((s) => s.id === signal.severity)?.label ?? signal.severity;
  return (
    <li>
      <Link
        to={signal.href}
        className={`flex items-start gap-2 rounded-md border p-3 text-sm hover:underline ${look.className}`}
      >
        <look.Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          <span className="font-medium">{signal.title}</span>
          <span className="block text-xs opacity-90">
            {word}
            {signal.detail ? ` · ${signal.detail}` : ''}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function SignalsList({ signals }) {
  if (!signals.length) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="Nothing to act on"
        description="Every budget is under its first threshold, every read worked and no renewal is close."
        compact
      />
    );
  }
  return (
    <div className="space-y-4">
      {SEVERITIES.map((severity) => {
        const rows = signals.filter((s) => s.severity === severity.id);
        if (!rows.length) return null;
        return (
          <section key={severity.id} aria-label={severity.label} className="space-y-2">
            <p className="text-sm font-medium" title={severity.help}>
              {severity.label} ({rows.length})
            </p>
            <ul className="space-y-2">
              {rows.map((signal) => (
                <Signal key={signal.id} signal={signal} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** The settings as the inputs hold them. */
const draftOf = (settings) => ({
  aiMonthlyBudgetUsd:
    settings.aiMonthlyBudgetUsd === null || settings.aiMonthlyBudgetUsd === undefined
      ? ''
      : String(settings.aiMonthlyBudgetUsd),
  renewalLeadDays: String(settings.renewalLeadDays ?? 7),
  telegram: Boolean(settings.telegram),
  monthlyDigest: Boolean(settings.monthlyDigest),
  refreshHours: String(settings.refreshHours ?? 6),
});

/** The draft as the server takes it: numbers, or null for an empty AI budget. */
export function settingsOf(draft) {
  const budget = String(draft.aiMonthlyBudgetUsd).trim();
  return {
    aiMonthlyBudgetUsd: budget === '' ? null : Number(budget),
    renewalLeadDays: Number(draft.renewalLeadDays),
    telegram: Boolean(draft.telegram),
    monthlyDigest: Boolean(draft.monthlyDigest),
    refreshHours: Number(draft.refreshHours),
  };
}

export function SettingsForm({ settings, onSaved, save = saveCostSettings }) {
  const [draft, setDraft] = useState(() => draftOf(settings));
  const [state, setState] = useState({ phase: 'idle' });
  const edit = (patch) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event) => {
    event.preventDefault();
    setState({ phase: 'saving' });
    try {
      const saved = await save(settingsOf(draft));
      setDraft(draftOf(saved));
      setState({ phase: 'saved' });
      onSaved?.(saved);
    } catch (err) {
      setState({ phase: 'failed', message: err?.message || 'The save was refused.' });
    }
  };

  const saving = state.phase === 'saving';
  return (
    <form onSubmit={submit} aria-label="Alert settings" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="cost-ai-budget" className="text-xs text-muted-foreground">
            Monthly AI budget (USD)
          </Label>
          <Input
            id="cost-ai-budget"
            type="number"
            min={0}
            step="0.01"
            value={draft.aiMonthlyBudgetUsd}
            disabled={saving}
            placeholder="empty: no budget"
            onChange={(e) => edit({ aiMonthlyBudgetUsd: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cost-lead-days" className="text-xs text-muted-foreground">
            Say a renewal is coming, days before (1 to 60)
          </Label>
          <Input
            id="cost-lead-days"
            type="number"
            min={1}
            max={60}
            step={1}
            value={draft.renewalLeadDays}
            disabled={saving}
            onChange={(e) => edit({ renewalLeadDays: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cost-refresh-hours" className="text-xs text-muted-foreground">
            Re-read Azure every (hours, 1 to 24)
          </Label>
          <Input
            id="cost-refresh-hours"
            type="number"
            min={1}
            max={24}
            step={1}
            value={draft.refreshHours}
            disabled={saving}
            onChange={(e) => edit({ refreshHours: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="flex items-center gap-2">
          <Switch
            id="cost-telegram"
            checked={draft.telegram}
            disabled={saving}
            onCheckedChange={(telegram) => edit({ telegram })}
          />
          <Label htmlFor="cost-telegram" className="text-sm">
            Send new warnings and criticals to Telegram
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="cost-digest"
            checked={draft.monthlyDigest}
            disabled={saving}
            onCheckedChange={(monthlyDigest) => edit({ monthlyDigest })}
          />
          <Label htmlFor="cost-digest" className="text-sm">
            Send last month&apos;s closing figures on the 1st
          </Label>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Telegram messages go out through the same bot as the reminders sheet; test it or re-pair
        your phone under{' '}
        <Link to={REMINDERS_HREF} className="underline">
          Platform Settings, Reminders
        </Link>
        .
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          )}
          Save settings
        </Button>
        {state.phase === 'saved' ? (
          <span role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
            Saved. The next check uses these.
          </span>
        ) : null}
        {state.phase === 'failed' ? (
          <span role="alert" className="text-xs text-destructive">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export default function AlertsTab({ summary, onRefresh }) {
  return (
    <div className="space-y-6 pt-4">
      <SignalsList signals={summary.signals} />
      <SectionCard
        title="Rules"
        description="What raises an alert. The server applies these on every read; this page only shows the result."
      >
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </SectionCard>
      <SectionCard
        title="Settings"
        description="The numbers the rules read, and where the messages go."
      >
        <SettingsForm
          key={JSON.stringify(summary.settings)}
          settings={summary.settings}
          onSaved={() => onRefresh?.(false)}
        />
      </SectionCard>
    </div>
  );
}
