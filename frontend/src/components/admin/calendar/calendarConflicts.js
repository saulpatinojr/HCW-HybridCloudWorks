/**
 * The Calendar's collision rule (ADR 0033 §4, split out of calendarModel.js
 * in PR #841): two timed publishes in one quarter hour crowd the audience and,
 * for social, can trip a platform's rate limit. The page warns; it does not
 * forbid.
 */

export const SLOT_MS = 15 * 60 * 1000;

/** The quarter-hour slot an instant falls in, or null when it does not parse. */
export function slotOf(start) {
  const t = Date.parse(start);
  return Number.isFinite(t) ? Math.floor(t / SLOT_MS) : null;
}

/**
 * Only items still to go out can collide: not all-day ones, not those already
 * published or sent, and not an owner's alert, which publishes nothing.
 */
const canCollide = (item) =>
  !item.allDay && item.kind !== 'alert' && !['published', 'sent'].includes(item.status);

/** Ids of timed items sharing a fifteen-minute slot with another. */
export function findConflicts(items) {
  const bySlot = new Map();
  for (const item of (items || []).filter(canCollide)) {
    const slot = slotOf(item.start);
    if (slot === null) continue;
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(item.id);
  }
  const crowded = [...bySlot.values()].filter((ids) => ids.length > 1);
  return new Set(crowded.flat());
}
