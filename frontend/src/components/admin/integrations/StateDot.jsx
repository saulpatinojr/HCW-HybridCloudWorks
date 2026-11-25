/**
 * The credential lights, shared by every Integrations Hub tab (#570).
 *
 * ## Four lights, not three
 *
 * Gray, green and red were the ask. Amber exists because App Service caches
 * Key Vault references for up to 24 hours: for a little while after you paste,
 * the vault has the new value and the running worker does not. Showing green
 * there would claim a rotation had taken effect when it had not; showing gray
 * would say "never inserted" one second after inserting it.
 */

import React from 'react';

/**
 * How each credential state reads to someone scanning the page.
 *
 * `tone` drives the dot; `label` is the words. Both matter — a colour alone is
 * no use to anyone reading this without colour vision, and the dot carries a
 * title attribute for the same reason.
 */
export const STATE_PRESENTATION = Object.freeze({
  live: {
    tone: 'bg-emerald-500',
    ring: 'ring-emerald-500/30',
    label: 'Live',
    hint: 'Resolved and working.',
  },
  pending: {
    tone: 'bg-amber-500',
    ring: 'ring-amber-500/30',
    label: 'Stored — going live',
    hint: 'In the vault. This worker still holds the previous value until it recycles.',
  },
  failing: {
    tone: 'bg-red-500',
    ring: 'ring-red-500/30',
    label: 'Rejected',
    hint: 'A real value is configured and the upstream service refused it.',
  },
  never: {
    tone: 'bg-slate-400',
    ring: 'ring-slate-400/20',
    label: 'Not set',
    hint: 'Never seeded, or the Key Vault reference is not resolving.',
  },
});

// Kept exported from here: the Integrations tabs import it from this file.
export { relativeTime } from '@/components/admin/shared/relativeTime';

export function StateDot({ state }) {
  const presentation = STATE_PRESENTATION[state] ?? STATE_PRESENTATION.never;
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ring-4 ${presentation.tone} ${presentation.ring}`}
      role="img"
      aria-label={presentation.label}
      title={`${presentation.label} — ${presentation.hint}`}
    />
  );
}

/** The four counts, in words and lights, for a list of credential rows. */
export function StateCounts({ secrets }) {
  const counts = { live: 0, pending: 0, failing: 0, never: 0 };
  for (const item of secrets ?? []) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
      <span className="flex items-center gap-2">
        <StateDot state="live" /> {counts.live} live
      </span>
      <span className="flex items-center gap-2">
        <StateDot state="pending" /> {counts.pending} going live
      </span>
      <span className="flex items-center gap-2">
        <StateDot state="failing" /> {counts.failing} rejected
      </span>
      <span className="flex items-center gap-2">
        <StateDot state="never" /> {counts.never} not set
      </span>
    </div>
  );
}
