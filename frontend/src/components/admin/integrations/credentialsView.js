/**
 * What the Credentials tab says about each credential (#1026). Pure, so
 * every word and every colour is testable without a network or a DOM.
 *
 * The register and every computation behind it are the API's
 * (functions/src/lib/credentials): `cms/credentials` answers each credential
 * with where it lives, what uses it, its issuer, its age, its expiry, whether
 * anything renews it, and a state the API decided. This module only turns
 * those fields into the tab's words and groups them by store. It decides no
 * state of its own, so the tab and the reminders the API keeps can never
 * disagree about what is due.
 *
 * Nothing here receives a value: the answer carries names and dates only.
 */

import { statusTable } from '@/lib/status';

export const CREDENTIALS_ROUTE = 'cms/credentials';
export const REMINDERS_SYNC_ROUTE = 'cms/credentials/reminders';

/**
 * The API's four states as a StatusBadge reads them: word, tone and help.
 * Overdue is the `bad` tone, the admin's red.
 */
export const CREDENTIAL_STATE = statusTable({
  overdue: [
    'Overdue',
    'bad',
    'Past its expiry or rotation date, or signed out. Rotate it, then record the rotation here.',
  ],
  'due-soon': ['Due soon', 'warn', 'Inside its warning window: rotate it before the date.'],
  unknown: [
    'Unknown',
    'muted',
    'A rule applies but the date it runs from is not known, or its source could not be read.',
  ],
  ok: ['OK', 'ok', 'Nothing is due.'],
});

/** Worst first: the order the counts are shown in. */
export const STATE_ORDER = Object.freeze(['overdue', 'due-soon', 'unknown', 'ok']);

/** Whether anything renews it, in a word or two. */
export const RENEWAL_LABELS = Object.freeze({
  self: 'Renews itself',
  automation: 'Automation',
  hand: 'By hand',
  none: 'Not a credential',
});

/** Where the last rotation date came from. */
export const ROTATED_FROM = Object.freeze({
  'key-vault': 'Keys tab',
  'lab-host': 'lab host',
  oauth: 'sign-in',
  owner: 'recorded',
  azure: 'Activity Log',
});

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Today as the API's calendar sees it: the UTC day. */
export const todayIso = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const DAY_MS = 86_400_000;

/** This browser's own calendar day, as `YYYY-MM-DD`. */
export function localDateIso(now = Date.now()) {
  const date = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The Record form's date bounds (review of #1039). `max` is the API's own
 * limit: the UTC day plus the one day of grace `parseRotationBody` allows
 * (functions/src/lib/credentials/handlers.js), so an owner whose local day
 * is already tomorrow in UTC terms, or still yesterday, can pick it. The
 * default is the browser's own day, which is the day an owner means by
 * "rotated today", and always inside that bound.
 */
export function rotationDateBounds(now = Date.now()) {
  return { max: todayIso(now + DAY_MS), initial: localDateIso(now) };
}

/** The state's badge record; an unexpected state reads as Unknown, never as OK. */
export const stateOf = (credential) =>
  CREDENTIAL_STATE[credential?.state] ?? CREDENTIAL_STATE.unknown;

/** "Today", "1 day", "214 days"; "Unknown" when no rotation date is known. */
export function describeAge(credential) {
  const days = credential?.ageDays;
  if (!Number.isInteger(days)) return 'Unknown';
  return days === 0 ? 'Today' : plural(days, 'day');
}

/**
 * The line under the age: where it was read from, and the date the owner
 * recorded whenever one is stored. Null when neither is known.
 *
 * The recorded date is named even when another source is newer and the age
 * comes from that one (a Key Vault write after the recorded rotation): left
 * out, a stored date was invisible on the tab, and an owner who had recorded
 * it read that as the save not having landed (2026-10-11, every PUT a 200).
 */
export function describeAgeSource(credential) {
  const from = ROTATED_FROM[credential?.lastRotatedSource] ?? null;
  const recorded = credential?.recordedOn ? `recorded ${credential.recordedOn}` : null;
  if (credential?.lastRotatedSource === 'owner') return recorded ?? from;
  return [from, recorded].filter(Boolean).join('; ') || null;
}

/**
 * The Expiry column: the date and what kind of date it is.
 *
 *   an expiry the lab host reported       "2027-01-07"           "expires"
 *   one estimated from a rotation rule    "2027-10-01"           "rotation due"
 *   a rule with no date to run from       "Unknown"
 *   no rule at all                        "None"
 */
export function describeExpiry(credential) {
  if (credential?.expiresAt) {
    return {
      text: String(credential.expiresAt).slice(0, 10),
      kind: credential.expiryEstimated ? 'rotation due' : 'expires',
    };
  }
  if (credential?.renewal === 'none' || credential?.renewal === 'self')
    return { text: '—', kind: null };
  return { text: Number.isInteger(credential?.lifetimeDays) ? 'Unknown' : 'None', kind: null };
}

/** The rule, in words: "every 90 days", or null. */
export function describeRule(credential) {
  return Number.isInteger(credential?.lifetimeDays)
    ? `every ${plural(credential.lifetimeDays, 'day')}`
    : null;
}

/**
 * The reminder line: whether the credential's reminder is on the reminders
 * sheet with the date the register expects. Null for one that has none.
 */
export function describeReminder(credential) {
  const reminder = credential?.reminder;
  if (!reminder) return null;
  // A credential with a rule and no known date has a reminder too: one that
  // asks for the date (#1026), due the day it was added.
  const what =
    reminder.kind === 'record' ? 'Reminder to record its rotation date' : 'Rotation reminder';
  if (reminder.inSheet === true) return { text: `${what}, due ${reminder.dueDate}`, inStep: true };
  if (reminder.inSheet === false) {
    return { text: `${what}, due ${reminder.dueDate}, not on the sheet yet`, inStep: false };
  }
  return { text: 'Reminder state unknown: the sheet could not be read', inStep: null };
}

/** How many reminders the sheet does not have yet: what Update reminders fixes. */
export function remindersOutOfStep(credentials) {
  return (credentials ?? []).filter((c) => c?.reminder?.inSheet === false).length;
}

/**
 * The credentials grouped by store, in the API's store order, keeping only
 * the chosen store when `filter` names one. A store the answer does not
 * list still gets a group, headed by its id, rather than leaving the page.
 */
export function groupByStore(credentials, stores, filter = 'all') {
  const known = (stores ?? []).map((store) => ({ id: store.id, label: store.label }));
  const ids = new Set(known.map((store) => store.id));
  for (const credential of credentials ?? []) {
    if (!ids.has(credential.store)) {
      ids.add(credential.store);
      known.push({ id: credential.store, label: credential.store });
    }
  }
  return known
    .filter((store) => filter === 'all' || store.id === filter)
    .map((store) => ({
      store,
      credentials: (credentials ?? []).filter((c) => c.store === store.id),
    }))
    .filter((group) => group.credentials.length > 0);
}

/** The counts the answer carries, in STATE_ORDER, with a zero for any it left out. */
export function stateCounts(counts) {
  return STATE_ORDER.map((state) => ({
    state,
    count: Number.isInteger(counts?.[state]) ? counts[state] : 0,
  }));
}

/**
 * The toast after a write, from the reminders summary the answer carries.
 * Recorded is recorded: a sync that did not run is a sentence, not a failure.
 */
export function describeSync(reminders) {
  if (!reminders) return null;
  if (reminders.synced) {
    return reminders.changed
      ? 'The reminders sheet was updated.'
      : 'The reminders sheet was already in step.';
  }
  const why = {
    invalid:
      'the reminders sheet does not validate or is full; fix it on Platform Settings → Reminders',
    unreadable: 'a source its dates come from could not be read',
    conflict: 'the reminders sheet kept changing',
  }[reminders.reason];
  return `The reminders sheet was not updated${why ? `: ${why}` : ''}. Update reminders tries again.`;
}
