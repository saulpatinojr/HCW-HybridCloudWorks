/**
 * The pieces of a calendar alert both screens draw: how it reads (title, when
 * it is due, note), the Snooze buttons, and the button that opens its link.
 * The sign-in pop-up (CalendarAlertsPrompt), the alerts panel on the Calendar
 * page (CalendarAlertsPanel) and an alert chip's preview (AlertPreviewBody)
 * put these together differently and share
 * the words, so an alert says the same thing in both.
 *
 * Every button's accessible name says which alert it acts on ("Snooze
 * “Renew the domain” for 3 days"), because a list of identical "Done" buttons
 * is a list a screen reader cannot tell apart. Its visible text stays inside
 * that name (WCAG 2.5.3).
 */
import React from 'react';
import { AlarmClock, CalendarClock, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SNOOZE_CHOICES, describeDue, describeWhen, safeAlertLink } from '@/lib/calendarAlerts';

const TONE_CLASS = {
  overdue: 'text-destructive',
  today: 'text-amber-700 dark:text-amber-400',
  soon: 'text-amber-700 dark:text-amber-400',
  later: 'text-muted-foreground',
  snoozed: 'text-muted-foreground',
  done: 'text-muted-foreground',
};

/** "3 days overdue · Fri, 30 Oct 2026, 14:30 UTC", in a colour that also has words. */
export function DueText({ alert }) {
  const { text, tone } = describeDue(alert);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className={`inline-flex items-center gap-1 font-medium ${TONE_CLASS[tone]}`}>
        <CalendarClock className="h-4 w-4 shrink-0" aria-hidden="true" />
        {text}
      </span>
      <span className="text-muted-foreground">{describeWhen(alert)}</span>
    </p>
  );
}

/** The title, when it is due and the note. The note keeps the owner's line breaks. */
export function AlertBody({ alert, titleAs: Title = 'p' }) {
  return (
    <div className="min-w-0 space-y-1">
      <Title className="break-words text-base font-semibold leading-snug">{alert.title}</Title>
      <DueText alert={alert} />
      {alert.note && (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {alert.note}
        </p>
      )}
    </div>
  );
}

/**
 * Snooze for 1 day, 3 days or until next week. Hidden for a finished alert,
 * which the server refuses to snooze.
 */
export function SnoozeButtons({ alert, busy, onSnooze }) {
  return (
    <div
      role="group"
      aria-label={`Snooze “${alert.title}”`}
      className="flex flex-wrap items-center gap-1"
    >
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        aria-hidden="true"
      >
        <AlarmClock className="h-3.5 w-3.5" />
        Snooze:
      </span>
      {SNOOZE_CHOICES.map(({ days, label, long }) => (
        <Button
          key={days}
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`Snooze “${alert.title}” ${long}`}
          onClick={() => onSnooze(days)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

/**
 * The alert's link as a button. A web address opens in a new tab; a page in
 * this portal opens through `onOpenAdmin` so the router, not the browser,
 * moves there. Nothing when the link is empty or is not one the portal opens.
 */
export function AlertLinkButton({ alert, onOpenAdmin }) {
  const link = safeAlertLink(alert.link);
  if (!link) return null;
  if (link.kind === 'external') {
    return (
      <Button asChild variant="outline" size="sm">
        <a href={link.href} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Open link ({link.host}){' '}
          <span className="sr-only">for “{alert.title}” (opens in a new tab)</span>
        </a>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Open page: “${alert.title}”`}
      onClick={() => onOpenAdmin?.(link.href)}
    >
      <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      Open page
    </Button>
  );
}
