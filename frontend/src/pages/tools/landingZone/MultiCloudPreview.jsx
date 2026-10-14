import React, { useMemo } from 'react';
import { Link } from 'react-router';
import {
  addComponent,
  estimateMonthlyBaseline,
  MULTI_CLOUD_PRESETS,
  removeWithDependents,
} from '@/lib/landingZone';
import { activePresetForState } from '@/lib/landingZone/presets';
import { LzDiagram } from './LzDiagram';
import { LzFiles } from './LzFiles';

/**
 * Architecture Presets bar with active badge and direct blueprint links.
 */
function PresetBar({ presets, activePreset, onSelectPreset, shortLabel }) {
  if (!presets || presets.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-background/80 p-3">
      <div className="text-[10px] font-mono font-bold uppercase text-slate-500 tracking-wider">
        Architecture Presets ({shortLabel})
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((preset) => {
          const isActive = activePreset?.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              data-testid={`lz-preset-${preset.id}`}
              onClick={() => onSelectPreset(preset)}
              aria-pressed={isActive}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-all ${
                isActive
                  ? 'border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500 font-semibold'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:border-sky-500 hover:text-sky-600 dark:hover:text-sky-400'
              }`}
            >
              <span>{preset.label}</span>
              <span className="text-[10px] opacity-75 font-mono">({preset.badge})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Live FinOps Standing Cost Floor Strip strictly aligned with FOCUS 1.4.
 */
function FinopsCard({ finops, selectedCount }) {
  const hasItems = finops.items && finops.items.length > 0;
  const hasAdvisories = finops.finopsAdvisories && finops.finopsAdvisories.length > 0;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="rounded bg-emerald-600 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
            FOCUS 1.4 Floor
          </span>
          <span className="font-semibold text-slate-900 dark:text-white">
            Est. Standing Baseline:
          </span>
          <span className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-400">
            ${finops.totalMonthlyUsd.toLocaleString()}/mo
          </span>
        </div>
        <div className="text-[11px] text-slate-600 dark:text-slate-300">
          {finops.totalSpokes} Connected Spoke{finops.totalSpokes === 1 ? '' : 's'} ·{' '}
          {selectedCount} Platform Components Active
        </div>
      </div>

      {hasItems && (
        <div
          className="rounded-lg border border-slate-200/80 dark:border-slate-800 bg-background/80 p-3 mt-1"
          data-testid="lz-finops-bom"
        >
          <div className="text-[10px] font-mono font-bold uppercase text-slate-500 dark:text-slate-400 mb-2">
            Itemized Baseline Breakdown (FOCUS 1.4 Specification)
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {finops.items.map((item, idx) => (
              <div key={idx} className="py-1.5 flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {item.label}
                  </span>
                  {item.note && (
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {item.note}
                    </span>
                  )}
                </div>
                <span className="font-mono font-semibold text-slate-800 dark:text-slate-200 shrink-0">
                  ${item.monthlyUsd}/mo
                </span>
              </div>
            ))}
          </div>
          {hasAdvisories && (
            <div
              className="mt-2.5 pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-1.5"
              data-testid="lz-finops-advisories"
            >
              {finops.finopsAdvisories.map((adv, idx) => (
                <p
                  key={idx}
                  className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 px-2.5 py-1 rounded border border-amber-500/20"
                >
                  {adv}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Spoke capacity scaling and region knobs.
 */
function SpokeKnobs({ state, cloudId, onSpokeCountChange }) {
  const corpDesc = cloudId === 'aws' ? 'Private Workload VPCs' : 'Private Service Projects';
  const onlineDesc = cloudId === 'aws' ? 'Public Ingress VPCs' : 'Public Service Projects';
  const defaultRegion = cloudId === 'aws' ? 'us-east-1' : 'us-central1';
  const region = state.options?.location || defaultRegion;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-background/80 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-3">
        Workload Spoke Capacity & Topology Knobs
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lz-multi-corp" className="font-medium text-slate-700 dark:text-slate-300">
            Private Corp Spokes (1..5):
          </label>
          <div className="flex items-center gap-2">
            <input
              id="lz-multi-corp"
              type="number"
              min="0"
              max="5"
              value={state.options?.corpCount ?? 1}
              onChange={(e) => onSpokeCountChange('corpCount', e.target.value)}
              className="w-20 rounded-md border border-slate-300 dark:border-slate-700 bg-background px-2.5 py-1 text-xs font-mono font-bold text-slate-900 dark:text-slate-100"
            />
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{corpDesc}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="lz-multi-online"
            className="font-medium text-slate-700 dark:text-slate-300"
          >
            Public Online Spokes (1..5):
          </label>
          <div className="flex items-center gap-2">
            <input
              id="lz-multi-online"
              type="number"
              min="0"
              max="5"
              value={state.options?.onlineCount ?? 1}
              onChange={(e) => onSpokeCountChange('onlineCount', e.target.value)}
              className="w-20 rounded-md border border-slate-300 dark:border-slate-700 bg-background px-2.5 py-1 text-xs font-mono font-bold text-slate-900 dark:text-slate-100"
            />
            <span className="text-[11px] text-slate-500 dark:text-slate-400">{onlineDesc}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="lz-multi-region"
            className="font-medium text-slate-700 dark:text-slate-300"
          >
            Primary Cloud Region:
          </label>
          <div className="font-mono text-xs font-semibold px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
            {region}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 8 Canonical Components Grid with Interactive Toggles.
 */
function ComponentsGrid({ pack, state, onToggleComponent }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-3">
        Universal 8-Component Architecture ({pack.shortLabel})
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {pack.componentsMapping?.map((comp) => {
          const isTicked = state.selected?.includes(comp.id);
          return (
            <button
              key={comp.id}
              type="button"
              onClick={() => onToggleComponent(comp.id)}
              className={`text-left w-full cursor-pointer rounded-xl border p-3 flex flex-col justify-between transition-all ${
                isTicked
                  ? 'border-sky-500/50 bg-sky-50/50 dark:bg-sky-950/20 shadow-sm'
                  : 'border-slate-200 dark:border-slate-800 bg-background/80 opacity-60 hover:opacity-100'
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[10px] font-mono uppercase text-sky-600 dark:text-sky-400 font-semibold">
                    {comp.id}
                  </div>
                  <span
                    className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded ${
                      isTicked
                        ? 'bg-sky-600 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {isTicked ? 'ENABLED' : 'OPTIONAL'}
                  </span>
                </div>
                <div className="text-xs font-bold text-slate-900 dark:text-white mb-1">
                  {comp.name}
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                  {comp.desc}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Multi-Cloud Landing Zone Architecture Preview & Workbench component.
 */
export function MultiCloudPreview({
  pack,
  onReturn,
  state: parentState,
  write,
  focusedId = 'management-groups',
  setFocusedId,
}) {
  const cloudId = pack?.id;
  const state = useMemo(
    () => ({
      ...(parentState || {}),
      cloud: cloudId,
    }),
    [parentState, cloudId]
  );

  const activePreset = useMemo(() => activePresetForState(state), [state]);
  const finops = useMemo(() => estimateMonthlyBaseline(state), [state]);

  if (!pack) return null;

  const presets = MULTI_CLOUD_PRESETS[cloudId] || [];

  const handleToggleComponent = (compKey) => {
    if (!write) return;
    const isCurrentlySelected = state.selected?.includes(compKey);
    const nextState = isCurrentlySelected
      ? removeWithDependents(state, compKey)
      : addComponent(state, compKey);
    write({ ...nextState, cloud: cloudId });
  };

  const handleSelectPreset = (preset) => {
    if (!write) return;
    write({ ...preset.state, cloud: cloudId });
  };

  const handleSpokeCountChange = (optionKey, count) => {
    if (!write) return;
    const val = Math.max(0, Math.min(5, Number(count) || 0));
    const nextOptions = { ...(state.options || {}), [optionKey]: val };
    const currentSelected = new Set(state.selected || []);
    const compId = optionKey === 'corpCount' ? 'corp' : 'online';
    if (val > 0) {
      currentSelected.add(compId);
    } else {
      currentSelected.delete(compId);
    }
    write({
      ...state,
      cloud: cloudId,
      selected: [...currentSelected],
      options: nextOptions,
    });
  };

  return (
    <div
      className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/60 p-6 flex flex-col gap-6"
      data-testid="lz-cloud-preview"
    >
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">
              Multi-Cloud Architecture Workbench
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Universal 8-Component Mapping
            </span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
            {pack.label} Landing Zone Architecture
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{pack.description}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Link
            to={pack.blueprintSlug}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow hover:bg-primary/90 transition-colors"
          >
            Explore Blueprints →
          </Link>
          <button
            type="button"
            onClick={onReturn}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-background px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            Return to Azure Workbench
          </button>
        </div>
      </div>

      {/* Blueprint Context Banner when build matches a known preset */}
      {activePreset && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-xs"
          data-testid="lz-preset-banner"
        >
          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200">
            <span className="rounded bg-sky-600 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
              {activePreset.badge}
            </span>
            <span className="font-semibold">{activePreset.label}:</span>
            <span className="text-slate-600 dark:text-slate-300">{activePreset.summary}</span>
          </div>
          <Link
            to={activePreset.blueprintSlug}
            className="font-semibold text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-white"
          >
            {`Read Blueprint: ${activePreset.blueprintTitle} →`}
          </Link>
        </div>
      )}

      {/* Architecture Presets Bar */}
      <PresetBar
        presets={presets}
        activePreset={activePreset}
        onSelectPreset={handleSelectPreset}
        shortLabel={pack.shortLabel}
      />

      {/* FinOps Standing Cost Floor Strip with FOCUS 1.4 */}
      <FinopsCard finops={finops} selectedCount={state.selected?.length || 0} />

      {/* Workload Spokes Scaling & Region Knobs */}
      <SpokeKnobs state={state} cloudId={cloudId} onSpokeCountChange={handleSpokeCountChange} />

      {/* 8 Canonical Components Grid with Interactive Toggles */}
      <ComponentsGrid pack={pack} state={state} onToggleComponent={handleToggleComponent} />

      {/* Interactive Topology Diagram */}
      <LzDiagram
        state={state}
        focusedId={focusedId}
        onFocus={(id) => setFocusedId && setFocusedId(id)}
      />

      {/* Generated Multi-Cloud Terraform HCL Files */}
      <LzFiles state={state} />

      {/* Pinned Modules Specs */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-2">
          Pinned Terraform Registry Modules
        </h3>
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-background/50">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[10px] uppercase font-mono text-slate-500">
                <th className="p-2.5">Module Source</th>
                <th className="p-2.5">Pinned Version</th>
                <th className="p-2.5">Platform Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 font-mono text-[11px]">
              {pack.pinnedModules?.map((mod) => (
                <tr key={mod.name}>
                  <td className="p-2.5 font-semibold text-slate-900 dark:text-slate-100">
                    {mod.name}
                  </td>
                  <td className="p-2.5 text-sky-600 dark:text-sky-400">{mod.version}</td>
                  <td className="p-2.5 font-sans text-slate-600 dark:text-slate-400">{mod.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
