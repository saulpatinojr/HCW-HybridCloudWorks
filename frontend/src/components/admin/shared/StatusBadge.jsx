/**
 * StatusBadge — the one way a status is shown in the admin (ADR 0033 §2).
 *
 * Colour plus an icon plus the word, so the state reads without colour, and
 * a `title` carrying the help sentence so an unfamiliar word explains itself
 * on hover. Pass a system status (`toSystemStatus`), a content status id or
 * item (`contentStatusInfo`), or any `{ label, tone, help }`.
 */
import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleOff,
  Unplug,
  XCircle,
} from 'lucide-react';
import { contentStatusInfo, toSystemStatus } from '@/lib/status';

const TONES = {
  ok: {
    className:
      'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  warn: {
    className:
      'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    Icon: AlertTriangle,
  },
  bad: {
    className:
      'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    Icon: XCircle,
  },
  // Offline: a solid dark chip with an unplugged icon, so it reads apart from
  // Critical's rose at a glance and without colour. Critical answered and
  // said no; offline did not answer at all, and the fix is a different one.
  down: {
    className:
      'border-zinc-600 bg-zinc-700 text-zinc-50 dark:border-zinc-300 dark:bg-zinc-200 dark:text-zinc-900',
    Icon: Unplug,
  },
  off: {
    className: 'border-border bg-muted text-muted-foreground',
    Icon: CircleOff,
  },
  muted: {
    className: 'border-border bg-background text-muted-foreground',
    Icon: CircleDashed,
  },
};

export function statusFromProps({ system, content, status }) {
  if (system !== undefined) return toSystemStatus(system);
  if (content !== undefined) return contentStatusInfo(content);
  return status || toSystemStatus(undefined);
}

export default function StatusBadge({
  system,
  content,
  status,
  size = 'sm',
  className = '',
  showIcon = true,
}) {
  const info = statusFromProps({ system, content, status });
  const tone = TONES[info.tone] || TONES.muted;
  const { Icon } = tone;
  const sizing = size === 'xs' ? 'px-1.5 py-0 text-xs gap-1' : 'px-2 py-0.5 text-xs gap-1.5';
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium whitespace-nowrap transition-colors duration-300 motion-reduce:transition-none ${sizing} ${tone.className} ${className}`}
      title={info.help || undefined}
      data-status={info.id}
    >
      {showIcon && (
        <Icon className={size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3'} aria-hidden="true" />
      )}
      {info.label}
    </span>
  );
}
