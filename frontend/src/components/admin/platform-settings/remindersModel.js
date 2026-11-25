/**
 * The Reminders tab's plain rules: when a reminder is due and how that is
 * said, what a new one looks like, what is wrong with one, their order, and
 * what Telegram's answers mean. RemindersTab.jsx re-exports the public ones.
 */
import { relativeTime } from './settingShared';

export const DEFAULT_LEAD_DAYS = 7;
export const MAX_LEAD_DAYS = 365;
export const TELEGRAM_TEST_ROUTE = 'cms/platform-settings/reminders/test';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today as the server's calendar sees it: the UTC day. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** Whole days from today to `dueDate`; null when the date is not yet a date. */
export function daysUntil(dueDate, today = todayIso()) {
  if (!DATE_PATTERN.test(dueDate || '')) return null;
  const due = Date.parse(`${dueDate}T00:00:00.000Z`);
  const from = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(due) || !Number.isFinite(from)) return null;
  return Math.round((due - from) / DAY_MS);
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Where a reminder stands, as the badge says it. `tone` picks the colour:
 * muted for nothing to do yet, warning inside the Telegram window or on the
 * day, destructive once past.
 */
export function describeDue(reminder, today = todayIso()) {
  const days = reminder.done ? null : daysUntil(reminder.dueDate, today);
  const lead = Number(reminder.leadDays);
  let label = 'No date yet';
  let tone = 'muted';
  if (reminder.done) {
    label = 'Done';
  } else if (days !== null && days < 0) {
    label = `${plural(-days, 'day')} overdue`;
    tone = 'destructive';
  } else if (days === 0) {
    label = 'Due today';
    tone = 'warning';
  } else if (days !== null && Number.isFinite(lead) && days <= lead) {
    label = `In ${plural(days, 'day')} · Telegram window open`;
    tone = 'warning';
  } else if (days !== null) {
    label = `In ${plural(days, 'day')}`;
  }
  return { label, tone };
}

/** A fresh row; the id is the server's identity for the stamps, never shown. */
export const newReminder = () => ({
  id: crypto.randomUUID(),
  title: '',
  dueDate: '',
  leadDays: DEFAULT_LEAD_DAYS,
  notes: '',
  url: '',
  done: false,
  notified: {},
});

/** Why a row cannot be saved as it stands, or null. The server refuses the same. */
export function rowProblem(reminder) {
  if (!String(reminder.title ?? '').trim()) return 'Title needed';
  if (!DATE_PATTERN.test(reminder.dueDate || '')) return 'Date needed';
  const lead = Number(reminder.leadDays);
  if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_DAYS) {
    return `Days before must be 0 to ${MAX_LEAD_DAYS}`;
  }
  return null;
}

/** Display order over the stored list: undated, then open by date, then done; as indices. */
export function displayOrder(reminders) {
  const rank = (r) => {
    if (r.done) return 2;
    return DATE_PATTERN.test(r.dueDate || '') ? 1 : 0;
  };
  return reminders
    .map((reminder, index) => ({ reminder, index }))
    .sort((a, b) => {
      const byRank = rank(a.reminder) - rank(b.reminder);
      if (byRank !== 0) return byRank;
      const byDate = String(a.reminder.dueDate).localeCompare(String(b.reminder.dueDate));
      return byDate !== 0 ? byDate : a.index - b.index;
    })
    .map((entry) => entry.index);
}

export const TONE_CLASS = {
  muted: 'border-border text-muted-foreground',
  warning: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  destructive: 'border-destructive/40 bg-destructive/5 text-destructive',
};

/** "Telegram said: coming up · on the day · last 3 d ago", or nothing when never said. */
export function describeNotified(notified) {
  const stages = [
    ['ahead', 'coming up'],
    ['due', 'on the day'],
    ['overdue', 'overdue'],
  ].filter(([stage]) => notified?.[stage]);
  if (stages.length === 0) return null;
  const latest = stages
    .map(([stage]) => notified[stage])
    .sort()
    .at(-1);
  return `Telegram said: ${stages.map(([, word]) => word).join(' · ')} · last ${relativeTime(latest)}`;
}

/** What the test route's answer means, in the words the owner needs. */
const TEST_OUTCOMES = {
  sent: { ok: true, text: 'Sent. Check Telegram for "Test from Platform Settings".' },
  cooldown: {
    ok: true,
    text: 'A test went out less than fifteen minutes ago; that one is the proof. Try again later for a fresh one.',
  },
  not_configured: {
    ok: false,
    text: 'Telegram is not configured on the app: the bot token or the chat id is missing.',
  },
  exception: { ok: false, text: 'Telegram could not be reached. Try again in a minute.' },
};

/** Telegram's status decides the sentence on a refusal. */
const TELEGRAM_REFUSALS = {
  403: 'Telegram refused (403): the bot is blocked. Open its chat and press Unblock or Restart.',
  400: 'Telegram refused (400): it cannot find the chat; the stored chat id is not yours.',
  401: 'Telegram refused (401): the stored bot token is not valid.',
};

export function describeTestResult(result) {
  if (result?.sent) return TEST_OUTCOMES.sent;
  if (result?.reason === 'telegram_error') {
    const status = Number(result?.status);
    const fallback = `Telegram refused${Number.isFinite(status) ? ` (${status})` : ''}.`;
    return { ok: false, text: TELEGRAM_REFUSALS[status] ?? fallback };
  }
  return TEST_OUTCOMES[result?.reason] ?? TEST_OUTCOMES.exception;
}
