/**
 * The parts every Overview card on the Health page shares: the time format, the footer with when the block was read, and the header with the status slot. Moved out of signals.jsx, which re-exports the first two, when that file grew
 * too long; the card rules at the top of signals.jsx apply here too.
 */
import React from 'react';
import { Link } from 'react-router';
import { CardHeader, CardTitle } from '@/components/ui/card';
import { describeAge } from '@/lib/status';
import StatusSlot from './StatusSlot';

/**
 * A Cosmos timestamp is an ISO string; a migrated one may still be a
 * Firestore-shaped `{ toDate }` or `{ seconds }`. Until 2026-10-03 only the
 * first shape was read, so every time on this page said "Not available"
 * (ADR 0033 §1 Platform).
 */
export function formatTimestamp(value) {
  let date = null;
  if (typeof value?.toDate === 'function') date = value.toDate();
  else if (value && typeof value === 'object' && typeof value.seconds === 'number')
    date = new Date(value.seconds * 1000);
  else if (typeof value === 'string' || typeof value === 'number') date = new Date(value);
  if (!date || Number.isNaN(date.getTime())) return 'Not available';

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Every Overview card ends the same way (ADR 0033 §1 Platform): when the
 * block it shows was read — its age as well as its time (#1010) — and where
 * its probes, impacts and fixes live. Pinned to the bottom of the card.
 */
export function CheckedFooter({ at, probeLabel }) {
  const age = describeAge(typeof at === 'string' ? at : null);
  return (
    <p className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 text-xs text-muted-foreground">
      <span>
        Checked {age ? `${age} · ` : ''}
        {formatTimestamp(at)}
      </span>
      <Link
        to="/admin/health?tab=checks"
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        {probeLabel ?? 'Impact, fixes and tests on Checks'}
      </Link>
    </p>
  );
}

/**
 * A signal card's header: the title, and the card's status in the slot every
 * Health Hub card keeps in the same place (StatusSlot.jsx).
 */
export function SignalCardHeader({ icon = null, title, status }) {
  return (
    <CardHeader className="flex-row items-start gap-3 space-y-0" data-slot="header">
      <CardTitle className="flex min-w-0 flex-1 items-center gap-2 text-lg">
        {icon}
        {title}
      </CardTitle>
      <StatusSlot status={status} size="sm" />
    </CardHeader>
  );
}

export const ALERT_FILTERS = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'resolved', label: 'Resolved' },
];

export function getAlertActionLabel(action) {
  if (action === 'resolve') return 'Resolved';
  if (action === 'acknowledge') return 'Acknowledged';
  return 'Updated';
}

export function getAlertStatus(alert) {
  return alert.status || (alert.active === false ? 'resolved' : 'open');
}

export function getBadgeVariantByCount(count, positiveVariant) {
  if (count > 0) return positiveVariant;
  return 'secondary';
}

/** One label/value row of the card, in the shape the sibling cards use. */
export function CardRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function getDigestDocLabel(digestDate) {
  if (!digestDate) return '';
  return ` (digest doc: ${digestDate})`;
}

/**
 * The waiting-to-go-live tile's word, and its share of the card's header:
 * degraded past three days, and degraded when items wait but none carries a
 * time (#1516). Not unknown: worstStatus counts unknown only when nothing
 * else is known, so the header would read Healthy over the tile, and
 * "unknown" there means "never checked", which this is not (the #1491 rule
 * for a read that could not count).
 */
export function stagedAgeStatus(hours) {
  if (hours === null) return 'degraded';
  return (hours || 0) > 72 ? 'degraded' : 'healthy';
}

export function formatHours(value) {
  if (!value) return '0h';
  return `${value}h`;
}
