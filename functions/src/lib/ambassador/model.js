/**
 * Ambassador model (ADR 0033 §4, the Spotlight slice): the container, the
 * status machine and the two primitives every other ambassador module reads
 * a date or a URL with. No I/O here; lib/ambassador.js re-exports it all.
 */

export const CONTAINER = 'ambassador';

export const NOT_PROVISIONED = Object.freeze({
  code: 'NOT_PROVISIONED',
  message: 'Run terraform apply for the ambassador container',
});

export const APPLICATION_STATUSES = Object.freeze([
  'interested',
  'preparing',
  'ready',
  'submitted',
  'under_review',
  'accepted',
  'active',
  'renewal_due',
  'renewed',
  'denied',
  'expired',
  'withdrawn',
]);

/**
 * Allowed status moves. Forward through the funnel, back one step while
 * still preparing, out to withdrawn from anywhere before a decision, and a
 * terminal state can start over as a fresh pursuit for the next cycle.
 */
export const APPLICATION_TRANSITIONS = Object.freeze({
  interested: ['preparing', 'withdrawn'],
  preparing: ['ready', 'interested', 'withdrawn'],
  ready: ['submitted', 'preparing', 'withdrawn'],
  submitted: ['under_review', 'accepted', 'denied', 'withdrawn'],
  under_review: ['accepted', 'denied', 'withdrawn'],
  accepted: ['active', 'expired'],
  active: ['renewal_due', 'expired', 'withdrawn'],
  renewal_due: ['renewed', 'expired', 'denied', 'withdrawn'],
  renewed: ['active', 'renewal_due', 'expired'],
  denied: ['interested', 'preparing'],
  expired: ['interested', 'preparing'],
  withdrawn: ['interested', 'preparing'],
});

export function canTransition(from, to) {
  return Array.isArray(APPLICATION_TRANSITIONS[from]) && APPLICATION_TRANSITIONS[from].includes(to);
}

/**
 * Where the owner stands with a program, as a fact about the PROGRAM rather
 * than a step of an application (owner request 2026-10-05): `working` while
 * qualifying or applying, `active` while holding it, `denied` after a
 * refusal, `none` otherwise. Separate from the application status machine
 * above, which tracks one pursuit; this is the one-word answer the Programs
 * tab and the Dashboard show.
 */
export const MEMBERSHIP_STATUSES = Object.freeze(['none', 'working', 'active', 'denied']);

/**
 * A program may be additional to another (`parentProgramId`): MCT Regional
 * Lead to Microsoft Certified Trainer (owner request 2026-10-05). The child's
 * requirements and questions are the extra ones, and they apply — its card
 * shows, its application may start — only while the parent's membership is
 * this status. A Regional Lead is an MCT first; nothing about the role makes
 * sense before that.
 */
export const UNLOCKING_MEMBERSHIP = 'active';

/**
 * Whether `program` is gated behind a parent and, if so, whether the parent
 * unlocks it today. `parent` is the stored parent program, or null when the
 * id names nothing (the gate then stays shut and says why).
 */
export function programGate(program, parent) {
  if (!program?.parentProgramId) return { gated: false, unlocked: true, parent: null };
  const membershipStatus = MEMBERSHIP_STATUSES.includes(parent?.membershipStatus)
    ? parent.membershipStatus
    : 'none';
  return {
    gated: true,
    unlocked: Boolean(parent) && membershipStatus === UNLOCKING_MEMBERSHIP,
    parent: {
      id: program.parentProgramId,
      name: parent?.name || null,
      membershipStatus,
    },
  };
}

export const EVIDENCE_SOURCES = Object.freeze([
  'speaking',
  'certifications',
  'content',
  'listen-and-learn',
  'labs',
  'newsletter',
  'manual',
]);

export const VERIFICATION_STATUSES = Object.freeze(['unverified', 'verified']);

/**
 * How a program's official application question is answered, so the guided
 * workspace renders each the way the form asks it: a profile field (typed by
 * hand, never prefilled), free text with a limit, one choice, yes or no, a
 * URL, a frequency grid (one choice per row), repeatable network + URL rows,
 * or activities tagged from the application's attached evidence.
 */
export const QUESTION_KINDS = Object.freeze([
  'profile',
  'text',
  'choice',
  'yesno',
  'url',
  'scale',
  'links',
  'activities',
]);

/** Readiness units: a requirement counts evidence items, or sums their `metrics.credits`. */
export const SCORING_UNITS = Object.freeze(['credits']);

/**
 * The periods a program's `upkeep` counts in: a calendar quarter or a
 * calendar year. Upkeep is what keeps a membership active once it is held,
 * apart from the requirements an application is scored against.
 */
export const UPKEEP_PERIODS = Object.freeze(['quarter', 'year']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` naming a real day, or null. A full ISO timestamp keeps its day. */
export function toCalendarDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const head = text.slice(0, 10);
  if (!ISO_DATE.test(head)) return null;
  const [y, m, d] = head.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return new Date(ms).toISOString().slice(0, 10) === head ? head : null;
}

export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
