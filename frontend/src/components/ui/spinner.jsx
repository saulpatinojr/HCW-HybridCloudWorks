import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Spinner — a loading state that says so (AP-F12, #936).
 *
 * The admin pages drew a bare `animate-spin` div while a read ran: visible,
 * and silent, so a screen reader was left on an empty page with nothing to
 * announce. This is the same ring with `role="status"` and a label, which
 * is announced once when it appears, and a `findByRole('status')` for a test.
 *
 * `label` names what is loading, in the page's own words ("Checking your
 * access", "Loading published articles"); the text is visually hidden and the
 * ring is decoration.
 */
const SIZES = {
  sm: 'h-5 w-5 border-t-2 border-b-2',
  md: 'h-8 w-8 border-t-2 border-b-2',
  lg: 'h-12 w-12 border-t-2 border-b-2',
};

export function Spinner({ label = 'Loading', size = 'md', className }) {
  return (
    <div role="status" className={cn('flex items-center justify-center', className)}>
      <span
        aria-hidden="true"
        className={cn('animate-spin rounded-full border-slate-blue', SIZES[size] || SIZES.md)}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
