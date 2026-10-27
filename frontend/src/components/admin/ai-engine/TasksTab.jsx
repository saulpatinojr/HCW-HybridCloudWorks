/**
 * Tasks — one row per AI task (ADR 0034 §4, slice 4, #859): what it is,
 * what kind of answer it needs, its mode (Recommended with the registry's
 * reason, Global — the Priority list, P1 first — or Custom with its own
 * chain), and the model a call will actually get. That last column is the
 * resolver's own answer (`GET cms/ai-routing/effective`), so this page can
 * never disagree with production; nothing here computes a chain.
 *
 * A row is a draft until Save: the mode, the chain, "then the Priority
 * list" and the exclusions change together, and a document the API refuses
 * ("this task would have no model") is said on the row with the API's own
 * sentence. The per-task Test runs the effective chain with the card Test's
 * limits and says which candidate answered and why the ones above did not.
 */
import React, { useState } from 'react';
import { ListChecks, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import EmptyState from '@/components/admin/shared/EmptyState';
import { aiEngine } from '@/lib/aiEngine';
import TaskChainEditor from './TaskChainEditor';
import useSelection from './useSelection';
import {
  chainProvidersFor,
  describeEffective,
  draftEntry,
  firstRejection,
  isDirty,
  providerLabel,
  taskBadges,
  toggleExclude,
  updateChain,
  withTaskEntry,
} from './selectionModel';

const BADGE = 'rounded border px-1.5 py-0.5 text-xs uppercase tracking-wide';
const BADGE_TONE = {
  public: 'border-sky-200 bg-sky-50 text-sky-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-700',
};

/** The mode radios, with the recommendation's reason and date beside the first. */
function ModeRadios({ task, draft, resolved, disabled, onMode }) {
  const name = `mode-${task}`;
  const rec = resolved.recommended;
  const options = [
    {
      value: 'recommended',
      label: 'Recommended',
      disabled: !rec,
      note: rec
        ? `${rec.model} — ${rec.reason} (as of ${rec.asOf})`
        : 'No recommendation for this task.',
    },
    { value: 'global', label: 'Global (P1)', note: 'The Priority list, P1 first.' },
    {
      value: 'custom',
      label: 'Custom',
      note: 'Its own chain, then the Priority list if you say so.',
    },
  ];
  return (
    <fieldset className="min-w-0 space-y-3" disabled={disabled}>
      <legend className="sr-only">Mode for {resolved.label}</legend>
      {options.map((o) => {
        const id = `${name}-${o.value}`;
        return (
          <div key={o.value} className="flex items-start gap-2">
            <input
              type="radio"
              id={id}
              name={name}
              value={o.value}
              checked={draft.mode === o.value}
              disabled={o.disabled}
              onChange={() => onMode(o.value)}
              className="mt-0.5"
            />
            <label htmlFor={id} className="min-w-0 text-sm">
              <span className="font-medium">{o.label}</span>
              <span className="mt-1 block break-words text-xs leading-relaxed text-muted-foreground">
                {o.note}
              </span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** The exclusions: one checkbox per implemented provider. */
function ExcludeControls({ task, label, draft, providers, disabled, onToggle }) {
  return (
    <fieldset className="min-w-0 space-y-3 rounded-lg bg-muted/30 p-3" disabled={disabled}>
      <legend className="text-xs text-muted-foreground">Never use for {label}:</legend>
      {providers.length === 0 && (
        <p className="text-xs text-muted-foreground">No supported provider for this task.</p>
      )}
      {providers.map((p) => {
        const id = `exclude-${task}-${p.id}`;
        return (
          <label key={p.id} htmlFor={id} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              id={id}
              checked={draft.exclude.includes(p.id)}
              onChange={(e) => onToggle(p.id, e.target.checked)}
            />
            {p.name || p.id}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * The per-task Test's result: who answered, how fast, and who did not, with
 * why. A media task's Test is a dry run (ADR 0034 slice 5): the candidate
 * the task would use and the resolver's reason, and no audio or image made.
 */
function TestResult({ result, providers }) {
  if (!result) return null;
  if (result.dryRun) {
    return (
      <div
        className="rounded border border-border/60 bg-muted/30 p-2 text-xs"
        data-testid="task-test-result"
      >
        {result.wouldUse ? (
          <p>
            Would use <span className="font-medium">{result.wouldUse.model}</span> via{' '}
            {providerLabel(result.wouldUse.provider, providers)}
            {result.wouldUse.why ? ` — ${result.wouldUse.why}` : ''}. No audio or image was made.
          </p>
        ) : (
          <p className="text-destructive">
            {result.error || 'No candidate is eligible.'} No audio or image was made.
          </p>
        )}
      </div>
    );
  }
  return (
    <div
      className="rounded border border-border/60 bg-muted/30 p-2 text-xs"
      data-testid="task-test-result"
    >
      {result.answeredBy ? (
        <p>
          Answered by <span className="font-medium">{result.answeredBy.model}</span> via{' '}
          {providerLabel(result.answeredBy.provider, providers)} in {result.answeredBy.latencyMs}{' '}
          ms.
        </p>
      ) : (
        <p className="text-destructive">{result.error || 'No candidate answered.'}</p>
      )}
      {result.skipped?.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {result.skipped.map((s) => (
            <li key={`${s.provider}-${s.model}`}>
              {providerLabel(s.provider, providers)}
              {s.model ? ` (${s.model})` : ''}: {s.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One task: the registry's words, the effective model, the mode and the
 * editors. The row's `key` (below) carries the stored entry and the
 * document's `updatedAt`, so a save elsewhere, or a 409 reload, remounts
 * it on what is stored rather than keeping a stale draft.
 */
function PlannedTaskRow({ task, resolved }) {
  return (
    <div
      className="min-w-0 space-y-2 rounded-xl border border-dashed border-border p-4 sm:p-5"
      data-task={task}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{resolved.label}</h3>
        <span className={`${BADGE} border-border text-muted-foreground`}>planned</span>
      </div>
      <p className="text-xs text-muted-foreground">{resolved.description}</p>
      <p className="text-sm" data-testid={`effective-${task}`}>
        Not connected yet
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        This task has no connected implementation. Model routing and tests become available when it
        is connected.
      </p>
    </div>
  );
}

function TaskRow({ task, resolved, selection, providers, availability, catalog, saving, onSave }) {
  const [draft, setDraft] = useState(() => draftEntry(resolved.entry));
  const [error, setError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const dirty = isDirty(draft, resolved.entry);
  const badges = taskBadges(resolved, catalog);
  const rejection = firstRejection(resolved, providers);
  // The providers that can serve this task: the cards and, for a media task,
  // the media providers, by what each carries (ADR 0034 slice 5).
  const chainProviders = chainProvidersFor(resolved, providers, availability);
  const media = resolved.media === true;
  let testTitle = 'Run the effective chain with the Test’s limits';
  if (dirty) testTitle = 'Save first; the Test runs the stored chain';
  else if (media)
    testTitle = 'Resolve the chain and say which model would serve; makes no audio or image';

  const handleSave = async () => {
    setError(null);
    try {
      await onSave(withTaskEntry(selection, task, draft));
    } catch (err) {
      if (err?.status !== 409) setError(err?.message || 'The change could not be saved.');
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await aiEngine.testAiTask(task));
    } catch (err) {
      setTestResult({ ok: false, error: err?.message || 'The test did not run.', skipped: [] });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="min-w-0 space-y-4 rounded-xl border border-border bg-background p-4 sm:p-5"
      data-task={task}
    >
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{resolved.label}</span>
            <span className={`${BADGE} border-border text-muted-foreground`}>
              {resolved.modality}
            </span>
            {resolved.public && <span className={`${BADGE} ${BADGE_TONE.public}`}>public</span>}
            {badges.map((b) => (
              <span key={b} className={`${BADGE} ${BADGE_TONE.warn}`}>
                {b}
              </span>
            ))}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{resolved.description}</div>
        </div>
        <div className="min-w-0 space-y-1 break-words rounded-lg bg-muted/30 p-3 lg:text-right">
          <p className="text-xs font-medium" data-testid={`effective-${task}`}>
            {describeEffective(resolved, providers)}
          </p>
          {rejection && (
            <p className="text-xs text-muted-foreground" data-testid={`rejected-${task}`}>
              {rejection}
            </p>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <ModeRadios
          task={task}
          draft={draft}
          resolved={resolved}
          disabled={saving}
          onMode={(mode) => setDraft((d) => ({ ...d, mode }))}
        />
        <ExcludeControls
          task={task}
          label={resolved.label}
          draft={draft}
          providers={chainProviders}
          disabled={saving}
          onToggle={(id, excluded) => setDraft((d) => toggleExclude(d, id, excluded))}
        />
      </div>

      {draft.mode === 'custom' && (
        <TaskChainEditor
          task={task}
          label={resolved.label}
          needs={resolved.needs}
          chain={draft.chain}
          thenGlobal={draft.thenGlobal}
          providers={chainProviders}
          catalog={catalog}
          disabled={saving}
          onChain={(change) => setDraft((d) => ({ ...d, chain: updateChain(d.chain, change) }))}
          onThenGlobal={(thenGlobal) => setDraft((d) => ({ ...d, thenGlobal }))}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={!dirty || saving}
          onClick={handleSave}
          aria-label={`Save ${resolved.label}`}
        >
          {saving && dirty ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          Save
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={saving}
            onClick={() => {
              setDraft(draftEntry(resolved.entry));
              setError(null);
            }}
            aria-label={`Discard changes to ${resolved.label}`}
          >
            Discard
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={testing || dirty}
          onClick={handleTest}
          aria-label={`Test ${resolved.label}`}
          title={testTitle}
        >
          {testing ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <Play className="mr-1 h-3 w-3" />
          )}
          Test
        </Button>
        {media && (
          <span className="text-xs text-muted-foreground">
            Test resolves the chain only; it makes no audio or image.
          </span>
        )}
        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid={`save-error-${task}`}>
            {error}
          </p>
        )}
      </div>
      {(resolved.rejected?.length > 0 || resolved.flags?.length > 0) && (
        <details className="min-w-0 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">Routing details</summary>
          <ul className="mt-2 space-y-2 break-words leading-relaxed">
            {(resolved.flags || []).map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
            {(resolved.rejected || []).map((item, index) => (
              <li key={`${item.provider}-${index}`}>
                {providerLabel(item.provider, providers)}
                {item.model ? ` (${item.model})` : ''}: {item.why}
              </li>
            ))}
          </ul>
        </details>
      )}
      <TestResult result={testResult} providers={providers} />
    </div>
  );
}

/**
 * @param {{ providers: Array<{id: string, name?: string}>, catalog: object|null, onOpenCatalog?: () => void }} props
 */
export default function TasksTab({ providers = [], catalog = null, onOpenCatalog }) {
  const { state, saving, reload, save } = useSelection(catalog);

  if (state.status === 'error') {
    return (
      <EmptyState
        variant="error"
        title="The AI routing could not be read"
        description={state.error}
        onRetry={reload}
      />
    );
  }

  const tasks = Object.entries(state.effective?.tasks || {});
  const cards = providers.length ? providers : state.providers.map((id) => ({ id }));
  const stamp = state.selection?.updatedAt || '';

  let rows;
  if (state.status === 'loading') {
    rows = (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading settings…
      </div>
    );
  } else if (tasks.length === 0) {
    rows = (
      <EmptyState
        title="No AI tasks"
        description="The API sent no tasks; every task is listed in functions/src/lib/ai/tasks.js."
        onRetry={reload}
      />
    );
  } else {
    rows = tasks.map(([task, resolved]) =>
      resolved.planned ? (
        <PlannedTaskRow key={task} task={task} resolved={resolved} />
      ) : (
        <TaskRow
          key={`${task}:${stamp}:${JSON.stringify(resolved.entry)}`}
          task={task}
          resolved={resolved}
          selection={state.selection}
          providers={cards}
          availability={state.effective?.availability || {}}
          catalog={catalog}
          saving={saving}
          onSave={save}
        />
      )
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ListChecks className="h-5 w-5 text-primary" aria-hidden="true" /> Tasks
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {state.status === 'loading'
              ? 'Reading the AI routing…'
              : 'Choose a model for each task. Recommendations include their reason and review date; provider defaults can vary by operation.'}
          </p>
        </div>
        {onOpenCatalog && (
          <Button size="sm" variant="outline" onClick={onOpenCatalog}>
            Model catalogue
          </Button>
        )}
      </div>

      {state.migrated && state.status === 'ready' && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          These settings were derived from the previous controls and are not stored yet; the first
          save keeps them.
        </p>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What serves each task</CardTitle>
          <CardDescription>
            Recommended uses the model the site recommends for the task when it is live and priced;
            Global follows the Priority list; Custom names a chain of its own. A provider with no
            key or switched off never serves, and the public tasks never reach a trial tier,
            whatever the list says. The audio and image tasks are chosen here too: the Priority list
            is a chat list, so they default to Recommended, and ElevenLabs and Replicate are
            switched on by their key alone — they have no card.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{rows}</CardContent>
      </Card>
    </div>
  );
}
