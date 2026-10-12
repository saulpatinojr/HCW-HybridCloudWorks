import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CERT_DATE_FIELDS,
  CERT_STATUSES,
  daysUntil,
  deriveStatus,
  describeCertStatus,
  findStaleStatuses,
  findStatusesDueWithin,
  formatIsoDate,
  isIsoDate,
  isPastDate,
  todayIso,
  UNDATED_FALLBACK_ISO,
  useToday,
} from './certStatus';

const TODAY = '2026-09-09';

describe('viewer offset', () => {
  // The timeline used to compare `new Date(ev.date)` (a bare YYYY-MM-DD, so
  // UTC midnight) against `new Date(`${today}T00:00:00`)` (local midnight).
  // For a viewer west of Greenwich — the owner is in Chicago, UTC-5 — local
  // midnight is later than UTC midnight, so on the day of an event the old
  // comparison already said "past", and the build runner (UTC) disagreed
  // with the browser. The string helpers cannot see an offset at all.
  const DAY = '2026-09-30';
  const oldIsPast = (offset) => new Date(DAY) < new Date(`${DAY}T00:00:00${offset}`);

  it('shows the old Date comparison flipping with the offset', () => {
    expect(oldIsPast('Z')).toBe(false);
    expect(oldIsPast('-05:00')).toBe(true);
  });

  it('keeps isPastDate and daysUntil at the calendar answer regardless of offset', () => {
    expect(isPastDate(DAY, DAY)).toBe(false);
    expect(daysUntil(DAY, DAY)).toBe(0);
    expect(isPastDate(DAY, '2026-10-01')).toBe(true);
    expect(daysUntil(DAY, '2026-10-01')).toBe(-1);
  });
});

describe('isIsoDate', () => {
  it('accepts only real YYYY-MM-DD days', () => {
    expect(isIsoDate('2026-09-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-28')).toBe(false);
    expect(isIsoDate('Sep 28, 2026')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(20260928)).toBe(false);
  });
});

describe('formatIsoDate', () => {
  it('prints the calendar day itself, never the day before', () => {
    expect(formatIsoDate('2026-06-30')).toBe('Jun 30, 2026');
    expect(formatIsoDate('2026-01-01')).toBe('Jan 1, 2026');
    // The local-format path this replaces shows the previous day when the
    // viewer's offset is negative.
    expect(
      new Date('2026-06-30').toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Chicago',
      })
    ).toBe('Jun 29, 2026');
  });

  it('returns anything that is not YYYY-MM-DD unchanged', () => {
    expect(formatIsoDate(undefined)).toBeUndefined();
    expect(formatIsoDate('June 30, 2026')).toBe('June 30, 2026');
  });
});

describe('daysUntil', () => {
  it('counts calendar days: zero today, positive ahead, negative once past', () => {
    expect(daysUntil('2026-09-09', TODAY)).toBe(0);
    expect(daysUntil('2026-09-30', TODAY)).toBe(21);
    expect(daysUntil('2026-06-30', TODAY)).toBe(-71);
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
  });

  it('is unaffected by a spring-forward boundary (US, 2026-03-08; EU, 2026-03-29)', () => {
    // A local-midnight subtraction across the 23-hour day rounds or ceils to
    // the wrong side; the calendar answer is exactly the day count.
    expect(daysUntil('2026-03-09', '2026-03-07')).toBe(2);
    expect(daysUntil('2026-03-08', '2026-03-07')).toBe(1);
    expect(daysUntil('2026-03-30', '2026-03-28')).toBe(2);
    expect(daysUntil('2026-04-01', '2026-03-01')).toBe(31);
  });

  it('is unaffected by a fall-back boundary (US, 2026-11-01; EU, 2026-10-25)', () => {
    expect(daysUntil('2026-11-02', '2026-10-31')).toBe(2);
    expect(daysUntil('2026-11-01', '2026-10-31')).toBe(1);
    expect(daysUntil('2026-10-26', '2026-10-24')).toBe(2);
    expect(daysUntil('2026-11-30', '2026-10-01')).toBe(60);
  });

  it('returns null, not NaN, for a missing or malformed date', () => {
    expect(daysUntil(undefined, TODAY)).toBeNull();
    expect(daysUntil('June 30, 2026', TODAY)).toBeNull();
    expect(daysUntil('2026-06-30', 'today')).toBeNull();
  });
});

describe('useToday', () => {
  const FALLBACK = '2000-01-01';

  it('pre-renders with the fallback, hydrates against it, then switches to the local date', async () => {
    // What scripts/prerender.mjs does at build time, then what main.jsx does
    // in the browser: the HTML and the hydrating render must agree (both see
    // the fallback), and only then may "today" move to the viewer's date.
    const seen = [];
    function Probe() {
      const today = useToday(FALLBACK);
      seen.push(today);
      return createElement('p', null, today);
    }
    const html = renderToString(createElement(Probe));
    expect(html).toContain(FALLBACK);
    expect(seen).toEqual([FALLBACK]);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    let root;
    await act(async () => {
      root = hydrateRoot(container, createElement(Probe), { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(seen[1]).toBe(FALLBACK);
    expect(seen[seen.length - 1]).toBe(todayIso());
    expect(container.textContent).toBe(todayIso());
    await act(async () => root.unmount());
    container.remove();
  });

  it('uses the local date straight away on a client-only render', () => {
    // A client-side navigation has no HTML to agree with, so nothing waits.
    const seen = [];
    function Probe() {
      seen.push(useToday(FALLBACK));
      return null;
    }
    render(createElement(Probe));
    expect(seen[0]).toBe(todayIso());
  });

  it('pins a fixed day, never the clock, when the fallback is missing or malformed', async () => {
    // A page that forgot its DATA_AS_OF must still pre-render and hydrate on
    // the same string; an undefined server snapshot would hydrate on the
    // viewer's date and mismatch the HTML (#465 review).
    const seen = [];
    function Probe({ fallback }) {
      const today = useToday(fallback);
      seen.push(today);
      return createElement('p', null, today);
    }
    for (const fallback of [undefined, null, '', 'not a date', '2026-02-30']) {
      seen.length = 0;
      const html = renderToString(createElement(Probe, { fallback }));
      expect(html).toContain(UNDATED_FALLBACK_ISO);
      expect(seen).toEqual([UNDATED_FALLBACK_ISO]);

      const container = document.createElement('div');
      container.innerHTML = html;
      document.body.appendChild(container);
      const onRecoverableError = vi.fn();
      let root;
      await act(async () => {
        root = hydrateRoot(container, createElement(Probe, { fallback }), { onRecoverableError });
      });
      expect(onRecoverableError, `fallback ${String(fallback)}`).not.toHaveBeenCalled();
      expect(seen[1]).toBe(UNDATED_FALLBACK_ISO);
      expect(container.textContent).toBe(todayIso());
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('isPastDate', () => {
  it('compares ISO dates as text, strictly before today', () => {
    expect(isPastDate('2026-09-08', TODAY)).toBe(true);
    expect(isPastDate('2026-09-09', TODAY)).toBe(false);
    expect(isPastDate('2026-09-10', TODAY)).toBe(false);
  });

  it('never treats a missing, malformed or impossible date as past', () => {
    expect(isPastDate(undefined, TODAY)).toBe(false);
    expect(isPastDate(null, TODAY)).toBe(false);
    expect(isPastDate('June 30, 2026', TODAY)).toBe(false);
    expect(isPastDate('2026-06-30', 'not-a-date')).toBe(false);
    // Right shape, no such day: shape-only checks let this through.
    expect(isPastDate('2026-02-30', TODAY)).toBe(false);
    expect(isPastDate('2026-06-30', '2026-02-30')).toBe(false);
  });
});

describe('todayIso', () => {
  it('formats the local calendar date with zero padding', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('deriveStatus', () => {
  it('knows the five statuses', () => {
    expect([...CERT_STATUSES]).toEqual(['active', 'beta', 'upcoming', 'expiring', 'retired']);
  });

  it('retires an "expiring" certification once its expiryDate has passed', () => {
    expect(deriveStatus({ status: 'expiring', expiryDate: '2026-06-30' }, TODAY)).toBe('retired');
  });

  it('keeps "expiring" while the expiryDate is still ahead', () => {
    expect(deriveStatus({ status: 'expiring', expiryDate: '2026-09-30' }, TODAY)).toBe('expiring');
    expect(deriveStatus({ status: 'expiring', expiryDate: '2026-09-09' }, TODAY)).toBe('expiring');
  });

  it('retires an "active" certification whose expiryDate has passed (MB-240 on 2026-09-09)', () => {
    expect(deriveStatus({ status: 'active', expiryDate: '2026-06-30' }, TODAY)).toBe('retired');
  });

  it('reads a future expiryDate on an "active" entry as expiring', () => {
    expect(deriveStatus({ status: 'active', expiryDate: '2026-11-30' }, TODAY)).toBe('expiring');
  });

  it('promotes a beta to active once its betaEndDate has passed', () => {
    expect(deriveStatus({ status: 'beta', betaEndDate: '2026-06-30' }, TODAY)).toBe('active');
  });

  it('reads a closed beta as coming, not active, when the vendor opens GA later', () => {
    // Google closes the beta window before GA (PAA, #770): nothing can be booked in between.
    const closed = { status: 'beta', betaEndDate: '2026-09-30', betaClosesBeforeGa: true };
    expect(deriveStatus(closed, '2026-09-30')).toBe('beta');
    expect(deriveStatus(closed, '2026-10-01')).toBe('upcoming');
    expect(deriveStatus({ ...closed, gaDate: '2026-11-02' }, '2026-10-15')).toBe('upcoming');
    expect(deriveStatus({ ...closed, gaDate: '2026-11-02' }, '2026-11-02')).toBe('active');
    // Only an explicit true changes the rule: Microsoft's betas go live as they end.
    expect(deriveStatus({ ...closed, betaClosesBeforeGa: 'yes' }, '2026-10-01')).toBe('active');
  });

  it('promotes a beta to active on its gaDate', () => {
    expect(deriveStatus({ status: 'beta', gaDate: '2026-09-09' }, TODAY)).toBe('active');
    expect(deriveStatus({ status: 'beta', gaDate: '2026-10-01' }, TODAY)).toBe('beta');
  });

  it('keeps a beta with no dates as beta', () => {
    expect(deriveStatus({ status: 'beta' }, TODAY)).toBe('beta');
  });

  it('turns an upcoming exam active on its first available day (SAP-C03 on 2026-11-17)', () => {
    const cert = { status: 'upcoming', availableDate: '2026-11-17' };
    expect(deriveStatus(cert, TODAY)).toBe('upcoming');
    expect(deriveStatus(cert, '2026-11-16')).toBe('upcoming');
    expect(deriveStatus(cert, '2026-11-17')).toBe('active');
    expect(deriveStatus({ status: 'upcoming' }, TODAY)).toBe('upcoming');
  });

  it('holds a re-read stored ahead of the vendor day until that day (AB-400, PL-400; #1091)', () => {
    const readOn = '2026-10-12';
    const ab400 = { status: 'active', availableDate: '2026-10-16', statusReadDate: readOn };
    expect(deriveStatus(ab400, '2026-09-10')).toBe('upcoming');
    expect(deriveStatus(ab400, '2026-10-15')).toBe('upcoming');
    expect(deriveStatus(ab400, '2026-10-16')).toBe('active');
    const pl400 = { status: 'retired', expiryDate: '2026-10-30', statusReadDate: readOn };
    expect(deriveStatus(pl400, '2026-09-10')).toBe('expiring');
    expect(deriveStatus(pl400, '2026-10-30')).toBe('expiring');
    expect(deriveStatus(pl400, '2026-10-31')).toBe('retired');
    // A read on the last day to test is still ahead of the retirement.
    expect(deriveStatus({ ...pl400, statusReadDate: '2026-10-30' }, '2026-10-30')).toBe('expiring');
  });

  it('keeps a row stored after its day as stored, on every clock (AZ-800)', () => {
    // AZ-800 was set `retired` once 2026-09-30 had passed. The education index
    // pre-renders with the earliest DATA_AS_OF (2026-09-10 at the time), and
    // must not show it bookable there.
    const az800 = { status: 'retired', retiredDate: '2026-09-30', expiryDate: '2026-09-30' };
    expect(deriveStatus(az800, '2026-09-10')).toBe('retired');
    expect(deriveStatus({ ...az800, statusReadDate: '2026-10-01' }, '2026-09-10')).toBe('retired');
    const sapC03 = { status: 'active', availableDate: '2026-11-17' };
    expect(deriveStatus(sapC03, '2026-09-10')).toBe('active');
    expect(deriveStatus({ ...sapC03, statusReadDate: '2026-11-17' }, '2026-09-10')).toBe('active');
  });

  it('holds back only those two dates, never the beta dates an active row ignores', () => {
    const readOn = { statusReadDate: '2026-09-01' };
    expect(deriveStatus({ status: 'active', gaDate: '2026-12-01', ...readOn }, TODAY)).toBe(
      'active'
    );
    expect(deriveStatus({ status: 'active', betaEndDate: '2026-12-01', ...readOn }, TODAY)).toBe(
      'active'
    );
    expect(deriveStatus({ status: 'expiring', expiryDate: '2026-12-01', ...readOn }, TODAY)).toBe(
      'expiring'
    );
  });

  it('never lets an impossible day decide a status', () => {
    // 2026-02-30 matches the YYYY-MM-DD shape; only a real-calendar check
    // stops it flipping a status (#465 review).
    const past = '2027-01-01';
    expect(deriveStatus({ status: 'beta', gaDate: '2026-02-30' }, past)).toBe('beta');
    expect(deriveStatus({ status: 'beta', betaEndDate: '2026-02-30' }, past)).toBe('beta');
    expect(deriveStatus({ status: 'upcoming', availableDate: '2026-02-30' }, past)).toBe(
      'upcoming'
    );
    expect(
      deriveStatus(
        { status: 'upcoming', availableDate: '2027-06-01', registrationOpens: '2026-02-30' },
        past
      )
    ).toBe('upcoming');
    expect(deriveStatus({ status: 'expiring', expiryDate: '2026-02-30' }, past)).toBe('expiring');
    expect(deriveStatus({ status: 'active', expiryDate: '2026-02-30' }, past)).toBe('active');
    const readOn = { statusReadDate: '2026-01-01' };
    expect(deriveStatus({ status: 'retired', expiryDate: '2027-02-30', ...readOn }, past)).toBe(
      'retired'
    );
    expect(deriveStatus({ status: 'active', availableDate: '2027-02-30', ...readOn }, past)).toBe(
      'active'
    );
    const badRead = { statusReadDate: '2026-02-30' };
    expect(deriveStatus({ status: 'active', availableDate: '2027-06-01', ...badRead }, past)).toBe(
      'active'
    );
    // And an impossible "today" decides nothing either.
    expect(deriveStatus({ status: 'upcoming', availableDate: '2026-01-01' }, '2026-02-30')).toBe(
      'upcoming'
    );
    const ahead = { status: 'retired', expiryDate: '2026-12-31', ...readOn };
    expect(deriveStatus(ahead, '2026-02-30')).toBe('retired');
  });

  it('keeps a stored "retired" and an "active" with no dates', () => {
    expect(deriveStatus({ status: 'retired' }, TODAY)).toBe('retired');
    expect(deriveStatus({ status: 'active' }, TODAY)).toBe('active');
  });

  it('treats an unknown or missing status as active', () => {
    expect(deriveStatus({}, TODAY)).toBe('active');
    expect(deriveStatus({ status: 'bogus' }, TODAY)).toBe('active');
    expect(deriveStatus(null, TODAY)).toBe('active');
  });

  it('defaults today to the local date', () => {
    expect(deriveStatus({ status: 'expiring', expiryDate: '2000-01-01' })).toBe('retired');
    expect(deriveStatus({ status: 'expiring', expiryDate: '2999-01-01' })).toBe('expiring');
  });
});

describe('describeCertStatus', () => {
  it('says nothing for an active exam', () => {
    expect(describeCertStatus({ status: 'active' }, TODAY)).toEqual({
      status: 'active',
      label: null,
      detail: null,
    });
  });

  it('names the last test day and the replacement while expiring', () => {
    const cert = {
      status: 'expiring',
      expiryDate: '2026-11-16',
      replacement: { code: 'SAP-C03' },
    };
    expect(describeCertStatus(cert, TODAY)).toEqual({
      status: 'expiring',
      label: 'Retiring',
      detail: 'last day to test Nov 16, 2026 · replaced by SAP-C03',
    });
  });

  it('switches to Retired with the date once the last test day has passed', () => {
    const cert = {
      status: 'expiring',
      expiryDate: '2026-11-16',
      replacement: { code: 'SAP-C03' },
    };
    expect(describeCertStatus(cert, '2026-11-17')).toEqual({
      status: 'retired',
      label: 'Retired',
      detail: 'Nov 16, 2026 · replaced by SAP-C03',
    });
  });

  it('describes a retired row from retiredDate without a replacement', () => {
    expect(describeCertStatus({ status: 'retired', retiredDate: '2026-07-15' }, TODAY)).toEqual({
      status: 'retired',
      label: 'Retired',
      detail: 'Jul 15, 2026',
    });
    expect(describeCertStatus({ status: 'retired' }, TODAY).detail).toBeNull();
  });

  it('describes a beta by its start date until it starts, then by GA', () => {
    const cert = { status: 'beta', betaStartDate: '2026-09-29', gaDate: '2027-01-14' };
    expect(describeCertStatus(cert, TODAY)).toEqual({
      status: 'beta',
      label: 'Beta',
      detail: 'from Sep 29, 2026',
    });
    expect(describeCertStatus(cert, '2026-10-01')).toEqual({
      status: 'beta',
      label: 'Beta',
      detail: 'GA Jan 14, 2027',
    });
    expect(describeCertStatus({ status: 'beta' }, TODAY)).toEqual({
      status: 'beta',
      label: 'Beta',
      detail: null,
    });
  });

  it('describes an upcoming exam by its first available day', () => {
    expect(describeCertStatus({ status: 'upcoming', availableDate: '2026-12-01' }, TODAY)).toEqual({
      status: 'upcoming',
      label: 'Coming',
      detail: 'available Dec 1, 2026',
    });
  });

  it('describes a re-read stored ahead of its day by the status it still has (#1091)', () => {
    const readOn = { statusReadDate: '2026-10-12' };
    const ab400 = { status: 'active', availableDate: '2026-10-16', ...readOn };
    expect(describeCertStatus(ab400, '2026-10-12')).toEqual({
      status: 'upcoming',
      label: 'Coming',
      detail: 'available Oct 16, 2026',
    });
    const pl400 = { status: 'retired', expiryDate: '2026-10-30', ...readOn };
    expect(describeCertStatus(pl400, '2026-10-12')).toEqual({
      status: 'expiring',
      label: 'Retiring',
      detail: 'last day to test Oct 30, 2026',
    });
  });

  it('describes a beta that closed ahead of GA, with the GA date when there is one', () => {
    const closed = { status: 'beta', betaEndDate: '2026-09-30', betaClosesBeforeGa: true };
    expect(describeCertStatus(closed, '2026-10-01')).toEqual({
      status: 'upcoming',
      label: 'Coming',
      detail: 'beta closed · GA date not announced',
    });
    expect(describeCertStatus({ ...closed, gaDate: '2026-11-02' }, '2026-10-01')).toEqual({
      status: 'upcoming',
      label: 'Coming',
      detail: 'beta closed · GA Nov 2, 2026',
    });
  });

  it('defaults today to the local date', () => {
    expect(describeCertStatus({ status: 'expiring', expiryDate: '2000-01-01' }).status).toBe(
      'retired'
    );
  });
});

describe('findStaleStatuses', () => {
  it('names every stored status its own dates contradict', () => {
    const problems = findStaleStatuses(
      [
        { code: 'A', status: 'expiring', expiryDate: '2026-06-30' },
        { code: 'B', status: 'beta', betaEndDate: '2026-05-07' },
        { code: 'C', status: 'beta', gaDate: '2026-06-01' },
        { code: 'D', status: 'active', expiryDate: '2026-06-30' },
        { code: 'E', status: 'expiring', expiryDate: '2026-09-30' },
        { code: 'F', status: 'beta' },
        { code: 'G', status: 'retired', expiryDate: '2026-06-30' },
      ],
      TODAY
    );
    expect(problems).toEqual([
      "A: status 'expiring' but expiryDate 2026-06-30 has passed",
      "B: status 'beta' but betaEndDate 2026-05-07 has passed",
      "C: status 'beta' but gaDate 2026-06-01 has been reached",
      "D: status 'active' but expiryDate 2026-06-30 has passed",
    ]);
  });

  it('names an upcoming exam whose available day has arrived', () => {
    const rows = [{ code: 'SAP-C03', status: 'upcoming', availableDate: '2026-11-17' }];
    expect(findStaleStatuses(rows, '2026-11-16')).toEqual([]);
    expect(findStaleStatuses(rows, '2026-11-17')).toEqual([
      "SAP-C03: status 'upcoming' but availableDate 2026-11-17 has been reached",
    ]);
  });

  it('has nothing to name for a re-read stored ahead of its day, before or after it (#1091)', () => {
    const rows = [
      {
        code: 'AB-400',
        status: 'active',
        availableDate: '2026-10-16',
        statusReadDate: '2026-10-12',
      },
      { code: 'PL-400', status: 'retired', expiryDate: '2026-10-30', statusReadDate: '2026-10-12' },
    ];
    for (const day of ['2026-10-12', '2026-10-16', '2026-10-30', '2026-10-31']) {
      expect(findStaleStatuses(rows, day), day).toEqual([]);
    }
    expect(findStatusesDueWithin(rows, '2026-10-12', 21)).toEqual([]);
  });

  it('names an unknown status, a malformed date, and a dateless expiring row', () => {
    const problems = findStaleStatuses(
      [
        { code: 'X', status: 'expiring', expiryDate: 'Nov 16 2026' },
        { code: 'Y', status: 'expiring' },
        { code: 'Z', status: 'sunset' },
        { code: 'W', status: 'beta', gaDate: '2027-02-30' },
      ],
      TODAY
    );
    expect(problems).toEqual([
      "X: expiryDate 'Nov 16 2026' is not YYYY-MM-DD",
      "Y: status 'expiring' but no expiryDate",
      "Z: unknown status 'sunset'",
      "W: gaDate '2027-02-30' is not YYYY-MM-DD",
    ]);
  });

  it('reports an impossible day exactly once, as a shape problem', () => {
    // Before isPastDate validated the calendar, 2026-02-30 was reported both
    // as "not YYYY-MM-DD" and as "has passed" (#465 review).
    const past = '2027-01-01';
    expect(
      findStaleStatuses([{ code: 'A', status: 'expiring', expiryDate: '2026-02-30' }], past)
    ).toEqual(["A: expiryDate '2026-02-30' is not YYYY-MM-DD"]);
    expect(findStaleStatuses([{ code: 'B', status: 'beta', gaDate: '2026-02-30' }], past)).toEqual([
      "B: gaDate '2026-02-30' is not YYYY-MM-DD",
    ]);
    expect(
      findStaleStatuses([{ code: 'C', status: 'upcoming', availableDate: '2026-02-30' }], past)
    ).toEqual(["C: availableDate '2026-02-30' is not YYYY-MM-DD"]);
  });

  it('validates every field in CERT_DATE_FIELDS, registrationOpens included', () => {
    // The list is the contract: a malformed value in any listed field is
    // reported, and the list names every dated field the catalogues use.
    expect(CERT_DATE_FIELDS).toContain('registrationOpens');
    for (const field of CERT_DATE_FIELDS) {
      const row = { code: 'R', status: 'active', [field]: 'Oct 27 2026' };
      expect(findStaleStatuses([row], TODAY)).toEqual([
        `R: ${field} 'Oct 27 2026' is not YYYY-MM-DD`,
      ]);
    }
    expect(
      findStaleStatuses(
        [
          {
            code: 'SAP-C03',
            status: 'upcoming',
            availableDate: '2026-11-17',
            registrationOpens: '2026-10-27',
          },
        ],
        TODAY
      )
    ).toEqual([]);
  });

  it('returns nothing for a consistent list', () => {
    expect(findStaleStatuses([{ code: 'A', status: 'active' }], TODAY)).toEqual([]);
    expect(findStaleStatuses([{ code: 'B' }], TODAY)).toEqual([]);
    expect(findStaleStatuses(undefined, TODAY)).toEqual([]);
  });
});

describe('findStatusesDueWithin — the warning ahead of the alarm (#818)', () => {
  const rows = [
    { code: 'EXP', status: 'expiring', expiryDate: '2026-09-20' },
    { code: 'GA', status: 'upcoming', availableDate: '2026-09-12' },
    { code: 'LATE', status: 'expiring', expiryDate: '2026-12-31' },
    { code: 'STALE', status: 'expiring', expiryDate: '2026-09-01' },
    { code: 'FINE', status: 'active' },
  ];

  it('names each row on the first day the alarm will, soonest first', () => {
    expect(findStatusesDueWithin(rows, TODAY, 21)).toEqual([
      {
        due: '2026-09-12',
        problem: "GA: status 'upcoming' but availableDate 2026-09-12 has been reached",
      },
      { due: '2026-09-21', problem: "EXP: status 'expiring' but expiryDate 2026-09-20 has passed" },
    ]);
  });

  it('agrees with findStaleStatuses on the due day itself, and not the day before', () => {
    for (const { due, problem } of findStatusesDueWithin(rows, TODAY, 21)) {
      expect(findStaleStatuses(rows, due)).toContain(problem);
      const dayBefore = new Date(Date.parse(`${due}T00:00:00Z`) - 86400000)
        .toISOString()
        .slice(0, 10);
      expect(findStaleStatuses(rows, dayBefore)).not.toContain(problem);
    }
  });

  it('leaves out rows already stale today, which the alarm already names', () => {
    const problems = findStatusesDueWithin(rows, TODAY, 21).map((d) => d.problem);
    expect(problems.some((p) => p.startsWith('STALE:'))).toBe(false);
  });

  it('looks exactly as far ahead as asked', () => {
    expect(findStatusesDueWithin(rows, TODAY, 3).map((d) => d.due)).toEqual(['2026-09-12']);
    expect(findStatusesDueWithin(rows, TODAY, 2)).toEqual([]);
  });

  it('counts calendar days across a month end', () => {
    const due = findStatusesDueWithin(
      [{ code: 'X', status: 'expiring', expiryDate: '2026-09-30' }],
      '2026-09-29',
      5
    );
    expect(due.map((d) => d.due)).toEqual(['2026-10-01']);
  });

  it('answers nothing for a bad date or window rather than guessing', () => {
    expect(findStatusesDueWithin(rows, '2026-9-9', 21)).toEqual([]);
    expect(findStatusesDueWithin(rows, TODAY, 0)).toEqual([]);
    expect(findStatusesDueWithin(rows, TODAY, 1.5)).toEqual([]);
    expect(findStatusesDueWithin(undefined, TODAY, 21)).toEqual([]);
  });
});
