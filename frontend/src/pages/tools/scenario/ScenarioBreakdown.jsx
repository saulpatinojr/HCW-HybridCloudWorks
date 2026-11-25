/**
 * The scenario's breakdown table (#613, Phase 2; its own module since Phase
 * 3): every line of every provider — the quantity, the factor, the unit
 * price and the product — which is what "the maths is visible" means. The
 * second reading of the numbers the bars in ScenarioResults.jsx draw.
 */
import React from 'react';
import ColumnHeads from '@/pages/shared/ColumnHeads';
import { formatPrice, providerLabel } from '@/lib/cloudPricing';
import { formatCost, formatQuantity, serviceMeta } from '@/lib/pricingScenarios';

/** The columns of the breakdown table. */
const BREAKDOWN_COLUMNS = [
  ['Item', 'p-2'],
  ['Line', 'p-2'],
  ['Quantity', 'p-2 text-right'],
  ['Unit price', 'p-2 text-right'],
  ['Cost / month', 'p-2 text-right'],
];

function LineRow({ provider, item, line }) {
  const unit = serviceMeta(line.serviceId).shortUnit;
  const factor = line.factor === 1 ? '' : ` × ${line.factor}`;
  return (
    <tr data-line={`${provider}:${line.serviceId}`}>
      <td className="p-2">{item}</td>
      <td className="p-2">{line.label}</td>
      <td className="p-2 text-right tabular-nums whitespace-nowrap">
        {formatQuantity(line.quantity)} {unit}
        {factor}
      </td>
      <td className="p-2 text-right tabular-nums whitespace-nowrap">
        {line.unitPrice === null ? '—' : formatPrice(line.unitPrice)}
        {line.source === 'baseline' ? ' (catalogue)' : ''}
      </td>
      <td className="p-2 text-right tabular-nums whitespace-nowrap">
        {line.cost === null ? 'unavailable' : formatCost(line.cost)}
      </td>
    </tr>
  );
}

function ProviderGroup({ p }) {
  return (
    <tbody data-breakdown={p.provider}>
      <tr>
        <th
          scope="rowgroup"
          colSpan={5}
          className="border-t border-slate-200 bg-slate-50 p-2 text-sm font-bold text-slate-950 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
        >
          {providerLabel(p.provider)}
          {p.total === null
            ? ` — unavailable: ${p.unavailable.map((id) => serviceMeta(id).label).join(', ')}`
            : ''}
        </th>
      </tr>
      {p.base.lines.map((line) => (
        <LineRow key={`base:${line.serviceId}`} provider={p.provider} item="Base" line={line} />
      ))}
      {p.segments.map((s) =>
        s.lines.map((line, index) => (
          <LineRow key={`${s.extraId}:${index}`} provider={p.provider} item={s.label} line={line} />
        ))
      )}
      <tr className="font-semibold">
        <td className="p-2" colSpan={4}>
          Total
        </td>
        <td className="p-2 text-right tabular-nums">
          {p.total === null ? 'unavailable' : formatCost(p.total)}
        </td>
      </tr>
    </tbody>
  );
}

export function ScenarioBreakdown({ providers, id }) {
  return (
    <div
      id={id}
      className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700"
    >
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">
          Every line of the scenario, per provider: the quantity and factor, the unit price it was
          multiplied by, and the product.
        </caption>
        <ColumnHeads
          className="text-xs uppercase tracking-wider text-slate-600 dark:text-slate-400"
          columns={BREAKDOWN_COLUMNS}
        />
        {providers.map((p) => (
          <ProviderGroup key={p.provider} p={p} />
        ))}
      </table>
    </div>
  );
}
