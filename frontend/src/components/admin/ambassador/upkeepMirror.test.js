/**
 * The quarterly (or yearly) upkeep count exists twice: here for the cards
 * (ambassadorModel.js) and on the server for the Dashboard and the Telegram
 * reminders (functions/src/lib/ambassador/upkeep.js, #1886). Both are run on
 * the same inputs across a year of days, and must agree, so a card never
 * says "met" while the phone still says "not yet met".
 */
import { describe, it, expect } from 'vitest';
import * as server from '../../../../../functions/src/lib/ambassador/upkeep.js';
import { daysUntil, upkeepProgress, upkeepWindow } from './ambassadorModel';

const PROGRAM = {
  id: 'program-example',
  upkeep: { period: 'quarter', minCount: 2, evidenceTypes: [], note: 'Log each piece.' },
};
const EVIDENCE = [
  { id: 'a', date: '2026-01-15', programIds: ['program-example'], sourceModule: 'content' },
  { id: 'b', date: '2026-03-31', programIds: ['program-example'], sourceModule: 'speaking' },
  { id: 'c', date: '2026-04-01', programIds: ['program-example'], sourceModule: 'content' },
  { id: 'd', date: '2026-08-09', programIds: [], sourceModule: 'content' },
  { id: 'e', date: '2026-11-20', programIds: ['program-example'], sourceModule: 'content' },
  {
    id: 'f',
    date: '2026-11-21',
    programIds: ['program-example'],
    sourceModule: 'content',
    softDeletedAt: '2026-11-22T00:00:00Z',
  },
];

const everyDayOf2026 = () => {
  const days = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
};

describe('the browser and the server count upkeep the same way', () => {
  it('agree on the window, for both periods and both offsets, every day of a year', () => {
    for (const day of everyDayOf2026()) {
      for (const period of ['quarter', 'year']) {
        for (const offset of [0, -1]) {
          expect(server.upkeepWindow(day, period, offset), `${day} ${period} ${offset}`).toEqual(
            upkeepWindow(day, period, offset)
          );
        }
      }
    }
  });

  it('agree on the count, for any program rule, every day of a year', () => {
    const rules = [
      PROGRAM,
      { ...PROGRAM, upkeep: { ...PROGRAM.upkeep, period: 'year', minCount: 3 } },
      { ...PROGRAM, upkeep: { ...PROGRAM.upkeep, evidenceTypes: ['content'] } },
      { ...PROGRAM, upkeep: null },
    ];
    for (const day of everyDayOf2026()) {
      for (const program of rules) {
        expect(server.upkeepProgress(program, EVIDENCE, day), day).toEqual(
          upkeepProgress(program, EVIDENCE, day)
        );
      }
    }
  });

  it('agree on days until', () => {
    expect(server.daysUntil('2026-12-31', '2026-11-25')).toBe(
      daysUntil('2026-12-31', '2026-11-25')
    );
    expect(server.daysUntil(null, '2026-11-25')).toBe(daysUntil(null, '2026-11-25'));
  });
});
