import React, { useMemo } from 'react';
import { Link } from 'react-router';
import {
  addComponent,
  estimateMonthlyBaseline,
  MULTI_CLOUD_PRESETS,
  removeWithDependents,
} from '@/lib/landingZone';
import { LzDiagram } from './LzDiagram';
import { LzFiles } from './LzFiles';

/**
 * Multi-Cloud Landing Zone Architecture Preview & Workbench component.
 * Features:
 *  - Universal 8-component mapping for AWS and Google Cloud
 *  - Interactive component toggles with dependency handling
 *  - Live FinOps standing cost floor calculation
 *  - Architecture Presets bar
 *  - Interactive SVG architecture diagram
 *  - Generated Terraform HCL inspection and download
 *  - Pinned registry module references
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
              Multi-Cloud Architecture Preview
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

      {/* Architecture Presets Bar */}
      {presets.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-background/80 p-3">
          <div className="text-[10px] font-mono font-bold uppercase text-slate-500 tracking-wider">
            Architecture Presets ({pack.shortLabel})
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 hover:border-sky-500 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
              >
                <span className="font-semibold">{preset.label}</span>
                <span className="text-[10px] text-slate-500 font-mono">({preset.badge})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* FinOps Standing Cost Floor Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-xs">
        <div className="flex items-center gap-3">
          <span className="rounded bg-emerald-600 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
            FinOps Floor
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
          {state.selected?.length || 0} Platform Components Active
        </div>
      </div>

      {/* 8 Canonical Components Grid with Interactive Toggles */}
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
                onClick={() => handleToggleComponent(comp.id)}
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
