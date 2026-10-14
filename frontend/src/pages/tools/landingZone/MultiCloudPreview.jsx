import React from 'react';
import { Link } from 'react-router';

/**
 * Multi-Cloud Landing Zone Architecture Preview component (#Phase4).
 * Displays the universal 8-component mapping and pinned Terraform modules
 * for AWS and Google Cloud foundation architectures.
 */
export function MultiCloudPreview({ pack, onReturn }) {
  if (!pack) return null;

  return (
    <div
      className="rounded-2xl border border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/60 p-6 flex flex-col gap-6"
      data-testid="lz-cloud-preview"
    >
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

      {/* 8 Canonical Components Grid */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-3">
          Universal 8-Component Architecture ({pack.shortLabel})
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {pack.componentsMapping?.map((comp) => (
            <div
              key={comp.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-background/80 p-3 flex flex-col justify-between"
            >
              <div>
                <div className="text-[10px] font-mono uppercase text-sky-600 dark:text-sky-400 font-semibold mb-1">
                  {comp.id}
                </div>
                <div className="text-xs font-bold text-slate-900 dark:text-white mb-1">
                  {comp.name}
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-snug">
                  {comp.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

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
