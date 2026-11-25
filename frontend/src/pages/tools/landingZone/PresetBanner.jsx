/**
 * The strip above the landing zone builder that names the preset the
 * current selection matches, with a link to that preset's blueprint. Shown
 * by the Azure workbench and by the AWS and Google Cloud preview alike.
 */
import React from 'react';
import { Link } from 'react-router';

export function PresetBanner({ preset }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-xs"
      data-testid="lz-preset-banner"
    >
      <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200">
        <span className="rounded bg-sky-600 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
          {preset.badge}
        </span>
        <span className="font-semibold">{preset.label}:</span>
        <span className="text-slate-600 dark:text-slate-300">{preset.summary}</span>
      </div>
      <Link
        to={preset.blueprintSlug}
        className="font-semibold text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-white"
      >
        {`Read Blueprint: ${preset.blueprintTitle} →`}
      </Link>
    </div>
  );
}
