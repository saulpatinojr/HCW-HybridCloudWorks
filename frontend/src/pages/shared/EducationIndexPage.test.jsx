/**
 * `/education` renders the nine catalogues and nothing it was not given.
 *
 * The page is built entirely out of `src/data/**`, so every assertion below
 * recomputes its expectation from those files rather than pinning a number.
 * A pinned "16 AWS certifications" would go quietly wrong the next time the
 * catalogue is synced, which is the failure mode #461 was about: a claim with
 * no date attached that nothing ever checked.
 *
 * The one thing that IS pinned is the shape of a hole. Terraform publishes no
 * Foundational exam and FinOps publishes no Associate one; the page must say
 * so with an explicit empty cell rather than borrow a neighbour's, so the
 * empty cells are asserted to exist and to carry a readable explanation.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { HelmetProvider } from 'react-helmet-async';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveStatus, isIsoDate, todayIso, useToday } from '@/lib/certStatus';
import { VALID_PROVIDERS } from '@/context/ProviderContext';
import EducationIndexPage, {
  AVAILABLE_STATUS_WORD,
  LEVEL_TIERS,
  PROVIDER_CATALOGUES,
  availableCertifications,
  buildEquivalenceRows,
  countByStatus,
  earliestDataAsOf,
  entryCertification,
  summarizeCatalogue,
  tierForLevel,
} from './EducationIndexPage';

/**
 * The instant the page renders at. `useToday` uses the earliest `DATA_AS_OF`
 * for the server snapshot and the viewer's date after hydration; jsdom's
 * `useSyncExternalStore` takes the client snapshot, so the rendered page reads
 * the clock (`todayIso()`) at render time, and every expectation here must be
 * computed on the day that read returns.
 *
 * WHICH IS WHY THE CLOCK IS FROZEN. Reading the real clock for the
 * expectations while the component reads it again at render time is two
 * reads of a moving value, and a suite that crosses midnight between them
 * computes its expectations for one day and renders another. Rare, real, and
 * exactly the kind of failure nobody can reproduce the next morning — this
 * repository spent an evening on the same midnight boundary when `DATA_AS_OF`
 * was written from the UTC date while `todayIso()` reads the local one.
 *
 * `vi.useFakeTimers` with `shouldAdvanceTime` keeps timers working for
 * Testing Library while pinning the wall clock the render reads. (Copilot
 * review of 033aaa85.)
 */
const FROZEN_NOW = new Date('2026-09-10T12:00:00Z');

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

/**
 * The day every expectation is computed on: the frozen instant on the
 * runner's own calendar, worked out from the constant, never read from the
 * clock.
 *
 * It used to be `todayIso()`, under a comment saying it ran after the clock
 * was pinned. It ran before. A test file's body runs while Vitest collects
 * it and `beforeAll` runs later, when the suite starts, so `today` was the
 * runner's real date while the page rendered on 2026-09-10. The two agreed
 * only while no row's status differed between those days. AB-400 was the
 * first that did: `availableDate` 2026-10-16 and `statusReadDate` 2026-10-12
 * make it `upcoming` on 2026-09-10 and `active` from 2026-10-16. From
 * midnight UTC that day the Linux runners expected 49 bookable Azure exams
 * and rendered 48, while a machine on Central time still read 2026-10-15 and
 * passed.
 *
 * `todayIso` reads the local calendar here and in the page, so the day itself
 * moves with the zone (noon UTC is already 2026-09-11 from UTC+12 eastward).
 * The expectations and the render move together, so the suite passes in
 * every zone. `the day this file renders on`, below, holds them to one day.
 */
const today = todayIso(FROZEN_NOW);

function renderPage() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/education']}>
        <EducationIndexPage />
      </MemoryRouter>
    </HelmetProvider>
  );
}

describe('the day this file renders on', () => {
  it('is the day its expectations are computed on', () => {
    // The hook the page calls, with the argument the page passes, under this
    // file's clock. Were `today` taken from any other clock than the one the
    // render reads, this would fail on every day the two differ, rather than
    // waiting for the day a catalogue row happens to change status between
    // them, which is how the module-load read went unnoticed for five weeks.
    /** Prints the day `useToday` gives the page, so the test can read it. */
    function RenderDay() {
      return <output data-testid="render-day">{useToday(earliestDataAsOf())}</output>;
    }
    render(<RenderDay />);
    expect(screen.getByTestId('render-day').textContent).toBe(today);
  });
});

describe('the level table can describe every catalogue', () => {
  it('maps every level word the nine catalogues use onto a tier', () => {
    const unmapped = new Set();
    for (const { provider, catalogue } of PROVIDER_CATALOGUES) {
      for (const cert of catalogue.certifications) {
        if (!tierForLevel(cert.level)) unmapped.add(`${provider}: ${cert.level}`);
      }
    }
    expect(
      [...unmapped],
      'a level word in src/data/** that LEVEL_TIERS does not claim would drop those ' +
        'rows off the comparison table. Add it to the tier it belongs to.'
    ).toEqual([]);
  });

  it('claims no level word twice', () => {
    const seen = LEVEL_TIERS.flatMap((row) => row.levels);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('EducationIndexPage', () => {
  it('links to the browser labs page (#681)', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'browser labs' })).toHaveAttribute(
      'href',
      '/education/labs'
    );
  });

  it('lists a catalogue for every provider the router serves, in its order (#778)', () => {
    // Docker was the one provider missing until its catalogue had rows.
    expect(PROVIDER_CATALOGUES.map((entry) => entry.provider)).toEqual(VALID_PROVIDERS);
  });

  it('shows Docker’s two credentials at the levels their issuers give them (#778)', () => {
    const { container } = renderPage();
    const tile = container.querySelector('li[data-provider="docker"]');
    expect(within(tile).getByRole('link', { name: 'Docker' })).toHaveAttribute(
      'href',
      '/docker/education'
    );
    const rows = buildEquivalenceRows(
      PROVIDER_CATALOGUES.map((entry) => summarizeCatalogue(entry, today))
    );
    const dockerCodes = (tier) =>
      rows
        .find((row) => row.tier === tier)
        .cells.find((cell) => cell.provider === 'docker')
        .shown.map((cert) => cert.code);
    expect(dockerCodes('Foundational')).toEqual(['Docker Foundations']);
    expect(dockerCodes('Associate')).toEqual(['DCA']);
    expect(dockerCodes('Professional')).toEqual([]);
  });

  it('renders a tile and a table column for all nine providers', () => {
    const { container } = renderPage();

    const tiles = container.querySelectorAll('li[data-provider]');
    expect([...tiles].map((tile) => tile.dataset.provider)).toEqual(
      PROVIDER_CATALOGUES.map((entry) => entry.provider)
    );

    for (const { name, provider } of PROVIDER_CATALOGUES) {
      // Once in the tile, once as the column header — both link to the hub.
      const links = screen.getAllByRole('link', { name });
      expect(links.length, `${provider} links`).toBeGreaterThanOrEqual(2);
      for (const link of links) {
        expect(link.getAttribute('href')).toBe(`/${provider}/education`);
      }
    }
  });

  it('shows a count that matches the catalogue it came from', () => {
    const { container } = renderPage();

    for (const entry of PROVIDER_CATALOGUES) {
      const expected = entry.catalogue.certifications.filter(
        (cert) => AVAILABLE_STATUS_WORD[deriveStatus(cert, today)] !== undefined
      );
      const tile = container.querySelector(`li[data-provider="${entry.provider}"]`);
      expect(
        within(tile).getByTestId('available-count').textContent,
        `${entry.provider} bookable count`
      ).toBe(String(expected.length));
      expect(tile.textContent, `${entry.provider} catalogue total`).toContain(
        `${entry.catalogue.certifications.length} in the catalogue`
      );
    }
  });

  it('names an entry-level certification that really is the lowest rung available', () => {
    const { container } = renderPage();

    for (const entry of PROVIDER_CATALOGUES) {
      const expected = entryCertification(
        availableCertifications(entry.catalogue.certifications, today)
      );
      const tile = container.querySelector(`li[data-provider="${entry.provider}"]`);
      expect(expected, `${entry.provider} has no bookable exam at all`).not.toBeNull();
      expect(tile.textContent, `${entry.provider} entry cert`).toContain(expected.cert.code);
      expect(tile.textContent).toContain(expected.cert.title);
    }
  });

  it('carries a freshness line per provider, dated from that catalogue', () => {
    const { container } = renderPage();

    for (const entry of PROVIDER_CATALOGUES) {
      const tile = container.querySelector(`li[data-provider="${entry.provider}"]`);
      const line = tile.querySelector('[data-catalogue-as-of]');
      expect(line, `${entry.provider} CatalogueFreshness`).not.toBeNull();
      expect(line.dataset.catalogueAsOf).toBe(entry.catalogue.DATA_AS_OF);
      // Azure exports no DATA_SOURCE; the page still has to name a vendor.
      expect(line.textContent).not.toContain('the vendor');
    }
  });
});

describe('the comparison table', () => {
  it('has one row per tier and one cell per provider, in provider order', () => {
    const { container } = renderPage();

    const rows = container.querySelectorAll('tbody tr[data-tier]');
    expect([...rows].map((row) => row.dataset.tier)).toEqual(LEVEL_TIERS.map((t) => t.tier));

    for (const row of rows) {
      const cells = row.querySelectorAll('td[data-provider]');
      expect([...cells].map((cell) => cell.dataset.provider)).toEqual(
        PROVIDER_CATALOGUES.map((entry) => entry.provider)
      );
    }
  });

  it('renders an explicit empty cell where a catalogue has no row at a level', () => {
    const { container } = renderPage();

    const holes = [...container.querySelectorAll('td[data-empty="true"]')];
    // Not an arbitrary number: at least Terraform has no Foundational exam and
    // FinOps no Associate one, and the page must say so rather than guess.
    expect(holes.length).toBeGreaterThan(0);
    for (const cell of holes) {
      expect(cell.textContent).toContain('—');
      expect(cell.textContent).toMatch(/No .+ certification at this level\./);
    }

    const foundational = container.querySelector('tr[data-tier="Foundational"]');
    expect(
      foundational.querySelector('td[data-provider="terraform"]').dataset.empty,
      'HashiCorp publishes no Foundational exam'
    ).toBe('true');
    const associate = container.querySelector('tr[data-tier="Associate"]');
    expect(
      associate.querySelector('td[data-provider="finops"]').dataset.empty,
      'the FinOps Foundation publishes no Associate exam'
    ).toBe('true');
  });

  it('drops no exam from a cell, however many that provider has at that level', () => {
    const { container } = renderPage();

    for (const { provider, catalogue } of PROVIDER_CATALOGUES) {
      for (const { tier } of LEVEL_TIERS) {
        const expected = availableCertifications(catalogue.certifications, today)
          .filter((cert) => tierForLevel(cert.level) === tier)
          .map((cert) => cert.code);
        const cell = container.querySelector(
          `tr[data-tier="${tier}"] td[data-provider="${provider}"]`
        );
        const printed = [...cell.querySelectorAll('li > span:first-child')].map((span) =>
          span.textContent.trim()
        );
        expect(printed, `${provider} at ${tier}`).toEqual(expected);
      }
    }
  });

  it('shows the counterparts the page exists for: AZ-104 and SOA-C03 in one row', () => {
    // The reason the overflow is a <details> and not a truncation. Azure has
    // more than thirty bookable Associate exams and AZ-104 is not in the first
    // six of them, so a cell that simply stopped at six would have left the
    // one comparison this table was built to make off the page entirely.
    const { container } = renderPage();
    const associate = container.querySelector('tr[data-tier="Associate"]');
    expect(associate.querySelector('td[data-provider="azure"]').textContent).toContain('AZ-104');
    expect(associate.querySelector('td[data-provider="aws"]').textContent).toContain('SOA-C03');
  });

  it('lists only exams that can actually be booked, and says which are not plain active', () => {
    const { container } = renderPage();

    const printed = new Set(
      [...container.querySelectorAll('tbody td[data-provider] li')].map((li) =>
        li.querySelector('span').textContent.trim()
      )
    );
    for (const { catalogue } of PROVIDER_CATALOGUES) {
      for (const cert of catalogue.certifications) {
        const status = deriveStatus(cert, today);
        if (status === 'retired' || status === 'upcoming') {
          // Codes are not globally unique — Azure and GitHub both list GH-900
          // — so absence is only asserted where no other catalogue has it.
          const elsewhere = PROVIDER_CATALOGUES.some((other) =>
            other.catalogue.certifications.some(
              (row) =>
                row.code === cert.code &&
                row !== cert &&
                AVAILABLE_STATUS_WORD[deriveStatus(row, today)] !== undefined
            )
          );
          if (!elsewhere) expect(printed.has(cert.code), `${cert.code} is ${status}`).toBe(false);
        }
      }
    }
  });

  it('is a real table: a caption, scoped headers, and a scroll container of its own', () => {
    const { container } = renderPage();

    const table = container.querySelector('table');
    expect(table.querySelector('caption')).not.toBeNull();
    for (const th of table.querySelectorAll('thead th')) {
      expect(th.getAttribute('scope')).toBe('col');
    }
    for (const th of table.querySelectorAll('tbody th')) {
      expect(th.getAttribute('scope')).toBe('row');
    }
    // The table is wider than a phone on purpose; the wrapper is what scrolls,
    // so the page itself never scrolls sideways.
    const wrapper = table.parentElement;
    expect(wrapper.className).toContain('overflow-x-auto');
    expect(wrapper.getAttribute('role')).toBe('region');
    expect(wrapper.getAttribute('aria-labelledby')).toBe('equivalence-heading');
  });

  it('marks decorative rules aria-hidden and signals nothing by colour alone', () => {
    const { container } = renderPage();
    for (const bar of container.querySelectorAll('h2 > span')) {
      expect(bar.getAttribute('aria-hidden')).toBe('true');
    }
    // Every qualifier next to a code is a word, not a hue.
    expect(Object.values(AVAILABLE_STATUS_WORD).filter(Boolean)).toEqual(['retiring', 'beta']);
  });

  it('keeps every heading legible in light mode', () => {
    const { container } = renderPage();
    for (const heading of container.querySelectorAll('h1, h2, h3')) {
      expect(heading.className, heading.textContent).not.toMatch(/(^|\s)text-white(\s|$)/);
    }
  });
});

describe('the derivation, on data the catalogues do not happen to contain', () => {
  const EMPTY = { provider: 'azure', name: 'Nothing At All', catalogue: { certifications: [] } };

  it('summarises an empty catalogue without throwing', () => {
    const summary = summarizeCatalogue(EMPTY, today);
    expect(summary.available).toEqual([]);
    expect(summary.total).toBe(0);
    expect(summary.entry).toBeNull();
    expect(summary.counts).toEqual({});
  });

  it('gives every tier an empty cell when a provider has nothing anywhere', () => {
    const rows = buildEquivalenceRows([summarizeCatalogue(EMPTY, today)]);
    expect(rows).toHaveLength(LEVEL_TIERS.length);
    for (const row of rows) {
      expect(row.cells[0].total).toBe(0);
      expect(row.cells[0].shown).toEqual([]);
      expect(row.cells[0].rest).toEqual([]);
    }
  });

  it('skips a tier the catalogue has nothing at when choosing the entry exam', () => {
    // No Foundational row, so the Associate one is the way in.
    const available = availableCertifications(
      [
        { code: 'X-200', title: 'Second', level: 'Professional', status: 'active' },
        { code: 'X-100', title: 'First', level: 'Associate', status: 'active' },
      ],
      today
    );
    expect(entryCertification(available)).toMatchObject({
      tier: 'Associate',
      cert: { code: 'X-100' },
    });
  });

  it('puts a featured row first and otherwise keeps catalogue order', () => {
    const ordered = availableCertifications(
      [
        { code: 'A', level: 'Associate', status: 'active' },
        { code: 'B', level: 'Associate', status: 'active' },
        { code: 'C', level: 'Associate', status: 'active', featured: true },
      ],
      today
    );
    expect(ordered.map((cert) => cert.code)).toEqual(['C', 'A', 'B']);
  });

  it('drops retired and not-yet-available rows and keeps the retiring ones', () => {
    const kept = availableCertifications(
      [
        { code: 'GONE', level: 'Associate', status: 'active', expiryDate: '2000-01-01' },
        { code: 'SOON', level: 'Associate', status: 'upcoming', availableDate: '2999-01-01' },
        { code: 'LAST-CHANCE', level: 'Associate', status: 'active', expiryDate: '2999-01-01' },
        { code: 'BETA', level: 'Associate', status: 'beta', gaDate: '2999-01-01' },
      ],
      today
    );
    expect(kept.map((cert) => cert.code)).toEqual(['LAST-CHANCE', 'BETA']);
  });

  it('counts one row per derived status', () => {
    expect(
      countByStatus(
        [
          { code: 'A', status: 'active' },
          { code: 'B', status: 'active', expiryDate: '2000-01-01' },
          { code: 'C', status: 'active', expiryDate: '2999-01-01' },
        ],
        today
      )
    ).toEqual({ active: 1, retired: 1, expiring: 1 });
  });

  it('hands useToday a real calendar day, so the pre-render and hydration agree', () => {
    const earliest = earliestDataAsOf();
    expect(isIsoDate(earliest)).toBe(true);
    for (const { catalogue } of PROVIDER_CATALOGUES) {
      expect(earliest <= catalogue.DATA_AS_OF).toBe(true);
    }
    expect(earliestDataAsOf([{ catalogue: { DATA_AS_OF: 'not-a-date' } }])).toBeUndefined();
  });
});
