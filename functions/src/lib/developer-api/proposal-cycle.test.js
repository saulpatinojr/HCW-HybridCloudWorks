/**
 * The yearly cycle of a talk proposal (#1777): which calendar year it belongs
 * to, when that year's clean-up is due (1 February of the next year, UTC),
 * and what a stripped proposal keeps.
 */
import { describe, it, expect } from 'vitest';
import {
  CYCLE_GRACE_MONTHS,
  STRIPPED_FIELDS,
  callClosedMs,
  callCycleYear,
  cycleCleanupDueMs,
  isCycleOver,
  isStripDue,
  latestFinishedCycle,
  proposalCycleYear,
  stripProposal,
} from './proposal-cycle.js';

const at = (iso) => Date.parse(iso);
const call = (fields = {}) => ({ docType: 'cfs-call', eventId: 'cloud-day', status: 'closed', ...fields });
const proposal = (fields = {}) => ({
  id: 'p1',
  eventId: 'cloud-day',
  docType: 'cfs-submission',
  status: 'pending',
  speakerName: 'Sam Speaker',
  speakerEmail: 'sam@example.com',
  speakerBio: 'Talks about clouds.',
  title: 'A talk',
  abstract: 'What it is about.',
  format: 'talk',
  level: 'beginner',
  submittedAt: '2026-06-01T00:00:00.000Z',
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: 'Not this year.',
  ...fields,
});

describe('when a year is over', () => {
  it('gives one month of grace: the clean-up of a year is due on 1 February, 00:00 UTC', () => {
    expect(CYCLE_GRACE_MONTHS).toBe(1);
    expect(new Date(cycleCleanupDueMs(2026)).toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(isCycleOver(2026, at('2026-12-31T23:59:59.999Z'))).toBe(false);
    expect(isCycleOver(2026, at('2027-01-01T00:00:00.000Z'))).toBe(false);
    expect(isCycleOver(2026, at('2027-01-31T23:59:59.999Z'))).toBe(false);
    expect(isCycleOver(2026, at('2027-02-01T00:00:00.000Z'))).toBe(true);
    expect(isCycleOver(null, at('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('reads the clock in UTC, whatever offset the moment is written with', () => {
    // 31 January 19:00 in a zone five hours behind UTC is already 1 February 00:00 UTC.
    expect(isCycleOver(2026, at('2027-01-31T19:00:00-05:00'))).toBe(true);
    // 1 February 03:00 in a zone five hours ahead is still 31 January 22:00 UTC.
    expect(isCycleOver(2026, at('2027-02-01T03:00:00+05:00'))).toBe(false);
  });

  it('names the newest finished year: the year before last through January, last year from 1 February', () => {
    expect(latestFinishedCycle(at('2027-01-31T23:59:59Z'))).toBe(2025);
    expect(latestFinishedCycle(at('2027-02-01T00:00:00Z'))).toBe(2026);
    expect(latestFinishedCycle(at('2027-12-31T23:59:59Z'))).toBe(2026);
  });
});

describe('which year a proposal belongs to', () => {
  const NOW = at('2027-03-01T00:00:00Z');

  it('goes by the day the organizer closed the call, to the minute around New Year (UTC)', () => {
    expect(callCycleYear(call({ closedAt: '2026-12-31T23:59:59.000Z' }), NOW)).toBe(2026);
    expect(callCycleYear(call({ closedAt: '2027-01-01T00:00:00.000Z' }), NOW)).toBe(2027);
    // A proposal sent in 2025 to a call closed in 2026 belongs to 2026.
    expect(proposalCycleYear(proposal({ submittedAt: '2025-11-01T00:00:00Z' }), call({ closedAt: '2026-02-01T00:00:00Z' }), NOW)).toBe(2026);
  });

  it('falls back to the deadline once it has passed, and prefers the close day when both exist', () => {
    expect(callCycleYear(call({ status: 'open', closedAt: null, closesAt: '2026-10-01T00:00:00Z' }), NOW)).toBe(2026);
    expect(callCycleYear(call({ closedAt: '2027-01-05T00:00:00Z', closesAt: '2026-12-20T00:00:00Z' }), NOW)).toBe(2027);
    // A deadline still ahead is not a close.
    expect(callClosedMs(call({ status: 'open', closedAt: null, closesAt: '2027-06-01T00:00:00Z' }), NOW)).toBeNull();
  });

  it('uses the year the proposal was sent when the call has no close day and is not open, or is missing', () => {
    const undated = call({ status: 'closed', closedAt: null, closesAt: null });
    expect(proposalCycleYear(proposal({ submittedAt: '2025-12-31T23:59:59Z' }), undated, NOW)).toBe(2025);
    expect(proposalCycleYear(proposal({ submittedAt: '2026-01-01T00:00:00Z' }), undated, NOW)).toBe(2026);
    expect(proposalCycleYear(proposal(), null, NOW)).toBe(2026);
  });

  it('has no year, so nothing is stripped, while the call is still open', () => {
    // Sent in December 2025 to a call that closes in March 2027: still being judged.
    const stillOpen = call({ status: 'open', closedAt: null, closesAt: '2027-03-01T00:00:00Z' });
    const noDeadline = call({ status: 'open', closedAt: null, closesAt: null });
    const sent = proposal({ submittedAt: '2025-12-01T00:00:00Z' });
    expect(proposalCycleYear(sent, stillOpen, at('2027-02-15T00:00:00Z'))).toBeNull();
    expect(isStripDue(sent, stillOpen, at('2027-02-15T00:00:00Z'))).toBe(false);
    expect(isStripDue(sent, noDeadline, at('2040-01-01T00:00:00Z'))).toBe(false);
    // Once the deadline has passed it belongs to that year, and is due the next February.
    expect(isStripDue(sent, stillOpen, at('2028-02-01T00:00:00Z'))).toBe(true);
  });

  it('has no year for a proposal with no readable date, so it is never due', () => {
    const open = call({ status: 'open', closedAt: 'not a date', closesAt: 42 });
    expect(proposalCycleYear(proposal({ submittedAt: 'soon' }), open, NOW)).toBeNull();
    expect(isStripDue(proposal({ submittedAt: null }), open, at('2040-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('isStripDue', () => {
  const closed2026 = call({ closedAt: '2026-11-30T00:00:00Z' });

  it('is false through 31 January and true from 1 February of the next year', () => {
    expect(isStripDue(proposal(), closed2026, at('2026-12-31T23:59:59Z'))).toBe(false);
    expect(isStripDue(proposal(), closed2026, at('2027-01-31T23:59:59Z'))).toBe(false);
    expect(isStripDue(proposal(), closed2026, at('2027-02-01T00:00:00Z'))).toBe(true);
  });

  it('counts every status but accepted as not accepted, a missing one included', () => {
    const now = at('2027-02-01T00:00:00Z');
    for (const status of ['pending', 'rejected', 'waitlisted', undefined, null]) {
      expect(isStripDue(proposal({ status }), closed2026, now), String(status)).toBe(true);
    }
    expect(isStripDue(proposal({ status: 'accepted' }), closed2026, now)).toBe(false);
  });

  it('never selects a stripped proposal, a call, or nothing', () => {
    const now = at('2027-02-01T00:00:00Z');
    expect(isStripDue(proposal({ strippedAt: '2027-02-01T00:00:00Z' }), closed2026, now)).toBe(false);
    expect(isStripDue(closed2026, closed2026, now)).toBe(false);
    expect(isStripDue(null, closed2026, now)).toBe(false);
  });
});

describe('stripProposal', () => {
  it('removes the four fields outright and keeps the talk, the decision, the dates and the version stamp', () => {
    const before = proposal({ status: 'rejected', reviewedAt: '2026-07-01T00:00:00Z', reviewedBy: 'key-1', _etag: '"v1"' });
    const after = stripProposal(before, '2027-02-01T04:00:00.000Z');
    for (const field of STRIPPED_FIELDS) expect(after, field).not.toHaveProperty(field);
    expect(STRIPPED_FIELDS).toEqual(['speakerName', 'speakerEmail', 'speakerBio', 'reviewNote']);
    expect(after).toEqual({
      id: 'p1',
      eventId: 'cloud-day',
      docType: 'cfs-submission',
      status: 'rejected',
      title: 'A talk',
      abstract: 'What it is about.',
      format: 'talk',
      level: 'beginner',
      submittedAt: '2026-06-01T00:00:00.000Z',
      reviewedAt: '2026-07-01T00:00:00Z',
      reviewedBy: 'key-1',
      _etag: '"v1"',
      strippedAt: '2027-02-01T04:00:00.000Z',
      strippedReason: 'cycle_ended',
    });
    // Nothing is written as undefined, and the record handed in is not changed.
    expect(Object.values(after)).not.toContain(undefined);
    expect(before.speakerEmail).toBe('sam@example.com');
  });
});
