/**
 * The Priority list (ADR 0034 §4, slice 4, #859): the providers a call may
 * reach, Priority 1 first, each with the model the list will use or the
 * provider's default, moved with keyboard-reachable Up and Down. The rows
 * are the document's `global.priority`; what a null model resolves to and
 * which providers are reachable come from the resolver's answer, so the
 * list never computes a chain of its own. Every change saves the whole
 * document.
 */
import React from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { selectableModelsFor } from '@/lib/aiEngine/catalog';
import {
  PROVIDER_DEFAULT,
  addToPriority,
  describePriorityRow,
  movePriority,
  providerLabel,
  setPriorityModel,
  splitPriority,
} from './selectionModel';

const SELECT_CLASS = 'h-7 min-w-40 rounded-md border border-border bg-transparent px-2 text-xs';

/** One reorderable row: its rank, the model select, the "will use" line, Up and Down. */
function PriorityRow({ step, index, count, row, name, models, busy, onMove, onModel }) {
  const selectId = `priority-${step.provider}-model`;
  const unlisted = Boolean(step.model) && !models.includes(step.model);
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border/60 py-2 last:border-b-0"
      data-provider={step.provider}
    >
      <span
        className={`shrink-0 rounded-full border px-2 py-0.5 text-xs tabular-nums ${
          index === 0
            ? 'border-primary/40 bg-primary/5 font-medium text-primary'
            : 'border-border text-muted-foreground'
        }`}
      >
        {index === 0 ? 'P1 — default' : `P${index + 1}`}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          <label htmlFor={selectId} className="sr-only">
            Model for {name}
          </label>
          <select
            id={selectId}
            className={SELECT_CLASS}
            value={step.model || PROVIDER_DEFAULT}
            disabled={busy}
            onChange={(e) => onModel(step.provider, e.target.value)}
          >
            <option value={PROVIDER_DEFAULT}>Provider default</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {unlisted && <option value={step.model}>{step.model} (not listed)</option>}
          </select>
        </div>
        <p
          className="mt-0.5 text-xs text-muted-foreground"
          data-testid={`priority-will-use-${step.provider}`}
        >
          {describePriorityRow(row)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={index === 0 || busy}
          onClick={() => onMove(step.provider, -1)}
          aria-label={`Move ${name} up`}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={index === count - 1 || busy}
          onClick={() => onMove(step.provider, 1)}
          aria-label={`Move ${name} down`}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * @param {{
 *   providers: Array<{id: string, name?: string}>,
 *   catalog: object|null,
 *   selection: object|null,
 *   effective: object|null,
 *   status: 'loading'|'ready'|'error',
 *   error?: string|null,
 *   saving: boolean,
 *   onSave: (next: object) => Promise<unknown>,
 *   onRetry: () => void,
 * }} props
 */
export default function PriorityList({
  providers = [],
  catalog = null,
  selection,
  effective,
  status,
  error = null,
  saving,
  onSave,
  onRetry,
}) {
  const availability = effective?.availability;
  const { listed, unlisted } = splitPriority(selection, availability, providers);
  const rowsByProvider = new Map((effective?.priority || []).map((r) => [r.provider, r]));
  const name = (id) => providerLabel(id, providers);

  // A refused save is reported by the caller's toast; the list re-renders
  // from the document the hook still holds, so a failed move stays put.
  const apply = (next) => onSave(next).catch(() => {});

  let body;
  if (status === 'loading') {
    body = (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading the Priority list…
      </div>
    );
  } else if (status === 'error') {
    body = (
      <div className="py-2 text-sm text-destructive" role="alert">
        {error}{' '}
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        {listed.length === 0 && (
          <p className="py-2 text-sm text-amber-600">
            No provider is both switched on and holding a key, so AI calls will fail.
          </p>
        )}
        {listed.map((step, index) => (
          <PriorityRow
            key={step.provider}
            step={step}
            index={index}
            count={listed.length}
            row={rowsByProvider.get(step.provider)}
            name={name(step.provider)}
            models={selectableModelsFor(catalog, step.provider)}
            busy={saving}
            onMove={(provider, delta) =>
              apply(movePriority(selection, availability, provider, delta))
            }
            onModel={(provider, model) => apply(setPriorityModel(selection, provider, model))}
          />
        ))}
        {unlisted.length > 0 && (
          <div className="mt-2 text-xs text-muted-foreground" data-testid="priority-unlisted">
            <span className="font-medium">Not in the list:</span>{' '}
            {unlisted.map((u, i) => (
              <span key={u.provider}>
                {i > 0 && ' · '}
                {name(u.provider)} ({u.reason})
                {u.add && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-1 h-auto p-0 text-xs"
                    disabled={saving}
                    onClick={() => apply(addToPriority(selection, u.provider))}
                    aria-label={`Add ${name(u.provider)} to the Priority list`}
                  >
                    <Plus className="mr-0.5 h-3 w-3" /> add
                  </Button>
                )}
              </span>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Priority</CardTitle>
        <CardDescription>
          Every task on the Priority list goes to P1 first and falls through in order. A row’s model
          is used for every task it serves; Provider default lets the provider’s own default per
          purpose decide. A task can leave this list on the Tasks tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">{body}</CardContent>
    </Card>
  );
}
