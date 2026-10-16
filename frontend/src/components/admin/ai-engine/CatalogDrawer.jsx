/**
 * The model catalogue drawer (ADR 0034 §4, slice 4, #859), reachable from
 * the AI Services and Tasks tabs: every provider's models with capabilities,
 * price or "unpriced", status and first / last seen, Hide and Show per
 * model, each provider's refresh age with "refresh now", and a banner
 * naming the retired models the Priority list or a custom chain still
 * names — read from the resolver's rejections, so it is what a call sees.
 */
import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { aiEngine } from '@/lib/aiEngine';
import { catalogEntries, describeRefresh } from '@/lib/aiEngine/catalog';
import { providerLabel, retiredInUse } from './selectionModel';

const BADGE = 'rounded border px-1.5 py-0.5 text-xs uppercase tracking-wide';
const STATUS_TONE = {
  live: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  retired: 'border-slate-200 bg-slate-100 text-slate-500',
  unknown: 'border-amber-200 bg-amber-50 text-amber-700',
};

/**
 * "$0.25 / $2.00 per 1M" from the catalogue's pricing, or "unpriced". A row
 * priced in another unit says so (ADR 0034 slice 5): ElevenLabs per 1M
 * characters, Replicate per image.
 */
export function describePrice(model) {
  if (model?.unpriced || !model?.pricing) return 'unpriced';
  const { inputPer1M, outputPer1M, perUnitUsd, unit } = model.pricing;
  if (typeof perUnitUsd === 'number') return `$${perUnitUsd} per ${unit || 'unit'}`;
  if (typeof inputPer1M !== 'number' || typeof outputPer1M !== 'number') return 'unpriced';
  return `$${inputPer1M} / $${outputPer1M} per ${unit || '1M'}`;
}

function ModelRow({ provider, model, busy, onHide }) {
  return (
    <tr className="border-b border-border/40 last:border-b-0">
      <td className="py-1 pr-2 font-mono text-xs">
        <span
          className={
            model.hidden || model.status === 'retired' ? 'line-through text-muted-foreground' : ''
          }
        >
          {model.id}
        </span>
        {model.hidden && (
          <span className={`${BADGE} ml-1 border-slate-200 bg-slate-100 text-slate-500`}>
            hidden
          </span>
        )}
      </td>
      <td className="py-1 pr-2 text-xs text-muted-foreground">
        {(model.capabilities || []).join(', ') || '—'}
      </td>
      <td className="py-1 pr-2 text-xs">{describePrice(model)}</td>
      <td className="py-1 pr-2">
        <span className={`${BADGE} ${STATUS_TONE[model.status] || STATUS_TONE.unknown}`}>
          {model.status || 'unknown'}
        </span>
      </td>
      <td className="py-1 pr-2 text-xs text-muted-foreground tabular-nums">
        {model.firstSeen || '—'} / {model.lastSeen || '—'}
      </td>
      <td className="py-1 text-right">
        <button
          type="button"
          className="text-xs text-primary hover:underline disabled:opacity-50"
          disabled={busy}
          onClick={() => onHide(provider.id, model.id, !model.hidden)}
          aria-label={`${model.hidden ? 'Show' : 'Hide'} ${model.id} for ${provider.name || provider.id}`}
        >
          {model.hidden ? 'Show' : 'Hide'}
        </button>
      </td>
    </tr>
  );
}

/**
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void,
 *   catalog: object|null, providers: Array<{id: string, name?: string}>,
 *   onHideModel: (provider: string, model: string, hidden: boolean) => Promise<unknown>,
 *   onRefresh: () => Promise<unknown>, refreshing: boolean,
 * }} props
 */
export default function CatalogDrawer({
  open,
  onOpenChange,
  catalog,
  providers = [],
  onHideModel,
  onRefresh,
  refreshing = false,
}) {
  const [busy, setBusy] = useState(null);
  const [retired, setRetired] = useState([]);

  // The banner reads the resolver's answer when the drawer opens, and again
  // after a refresh or a hide, so it names what a call would turn away now.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    aiEngine
      .getEffectiveRouting()
      .then((effective) => !cancelled && setRetired(retiredInUse(effective)))
      .catch(() => !cancelled && setRetired([]));
    return () => {
      cancelled = true;
    };
  }, [open, catalog]);

  const hide = async (provider, model, hidden) => {
    setBusy(`${provider}/${model}`);
    try {
      await onHideModel(provider, model, hidden);
    } finally {
      setBusy(null);
    }
  };

  const entries = Object.entries(catalog?.providers || {});

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Model catalogue</DialogTitle>
          <DialogDescription>
            Every model the providers list, refreshed weekly or on demand. Hidden models leave the
            dropdowns and stay here so they can be shown again. ElevenLabs and Replicate list here
            too: they have no card, and a key is what switches them on.
          </DialogDescription>
        </DialogHeader>

        {retired.length > 0 && (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
            role="status"
            data-testid="retired-banner"
          >
            <span className="font-medium">Retired but still named:</span>{' '}
            {retired
              .map(
                (r) =>
                  `${r.model} on ${providerLabel(r.provider, providers)} (${r.where.join(', ')})`
              )
              .join(' · ')}
            . A call skips a retired model and falls through; pick another where it is named.
          </div>
        )}

        <div className="flex items-center justify-end">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            Refresh now
          </Button>
        </div>

        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground">The catalogue could not be read.</p>
        )}
        {entries.map(([id, entry]) => {
          const provider = providers.find((p) => p.id === id) || { id };
          const rows = catalogEntries(entry);
          return (
            <section
              key={id}
              className="space-y-1"
              aria-label={`Models for ${provider.name || id}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{provider.name || id}</h3>
                <span
                  className={`text-xs ${entry?.stale ? 'text-amber-600' : 'text-muted-foreground'}`}
                >
                  {describeRefresh(entry)}
                  {entry?.refresh?.lastError
                    ? ` · last refresh failed: ${entry.refresh.lastError}`
                    : ''}
                </span>
              </div>
              {rows.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">No models listed yet.</p>
              ) : (
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Model</th>
                      <th className="py-1 pr-2 font-medium">Capabilities</th>
                      <th className="py-1 pr-2 font-medium">Price</th>
                      <th className="py-1 pr-2 font-medium">Status</th>
                      <th className="py-1 pr-2 font-medium">First / last seen</th>
                      <th className="py-1 font-medium">
                        <span className="sr-only">Hide or show</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((m) => (
                      <ModelRow
                        key={m.id}
                        provider={provider}
                        model={m}
                        busy={busy === `${id}/${m.id}`}
                        onHide={hide}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </DialogContent>
    </Dialog>
  );
}
