/**
 * One status slot (#1010): every Health Hub card shows its status in the same
 * place, the top-right of its header, whatever its description says.
 *
 * Until 2026-10-08 the header row wrapped (`flex-wrap`) and the text block
 * had no `flex-1`, so any card whose description was longer than a line put
 * its badge on a line of its own, under the text. Only "Publishing failures",
 * the shortest description, kept it top-right. jsdom does no layout, so this
 * holds the structure that makes the position: the badge is in the header,
 * in a slot that cannot shrink, beside a text block that takes the rest, in a
 * row that cannot wrap. The browser check of the rendered offsets is
 * e2e/admin-authenticated.spec.js.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ getJSON: vi.fn(), postJSON: vi.fn(), sendJSON: vi.fn() }));
vi.mock('@/lib/adminSettings', () => ({
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/lib/publicApi', () => ({ fetchCloudPricing: vi.fn() }));
vi.mock('react-router', () => ({
  Link: ({ to, children, ...rest }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import ProbeGrid, { ProbeCard, summarizeProbes } from './ProbeCards';
import { PROBES } from './probeRegistry';
import {
  OperationalSignalsCard,
  PipelineReadinessCard,
  PublishingOpsCard,
  WorkflowAlertsCard,
} from './signals';

const byId = (id) => PROBES.find((probe) => probe.id === id);
const NOW = Date.parse('2026-10-08T12:00:00.000Z');

/** The structure that puts the badge top-right, asserted on one card element. */
function expectStatusTopRight(card) {
  const header = card.querySelector('[data-slot="header"]') ?? card.firstElementChild;
  expect(header, 'the card has a header').toBeTruthy();
  // The header is the card's first part, and the status is inside it.
  expect(card.firstElementChild).toBe(header);
  const slot = header.querySelector(':scope > [data-slot="status"]');
  expect(slot, 'the status slot is a direct child of the header').toBeTruthy();
  // Last in the row, so it sits at the right.
  expect(header.lastElementChild).toBe(slot);
  expect(slot.querySelector('[data-status]')).toBeTruthy();
  // The row never wraps, the slot never shrinks, the text takes the rest.
  expect(header.className).toMatch(/\bflex\b/);
  expect(header.className).toMatch(/\bflex-row\b|\bflex\b/);
  expect(header.className).not.toMatch(/flex-wrap|flex-col\b/);
  expect(slot.className).toMatch(/\bshrink-0\b/);
  const text = header.firstElementChild;
  expect(text).not.toBe(slot);
  expect(text.className).toMatch(/\bflex-1\b/);
  expect(text.className).toMatch(/\bmin-w-0\b/);
  return slot;
}

describe('a probe card', () => {
  it('keeps the badge in the header’s top-right slot under the real Batch inspect copy', () => {
    const probe = byId('batch-inspect');
    // The copy this bug was reported on: long enough to wrap the old header.
    expect(probe.label).toBe('Batch inspect job');
    expect(probe.covers).toBe('Runs the inspector on up to ten ingested items.');
    render(
      <ProbeCard
        probe={probe}
        result={{ status: 'critical', summary: 'Inspection failed.', checkedAt: null }}
        running={false}
        onRun={() => {}}
        now={NOW}
      />
    );
    const card = screen.getByRole('article', { name: 'Batch inspect job' });
    const slot = expectStatusTopRight(card);
    expect(within(slot).getByText('Critical')).toBeTruthy();
    // The heading and its sentence are in the text block, not beside the badge.
    const header = card.querySelector('[data-slot="header"]');
    expect(
      within(header.firstElementChild).getByRole('heading', { name: 'Batch inspect job' })
    ).toBeTruthy();
    expect(within(header.firstElementChild).getByText(probe.covers)).toBeTruthy();
  });

  it('has the same three parts on every card: header, body, then a footer pinned last', () => {
    render(
      <ProbeCard
        probe={byId('publer')}
        result={{
          status: 'healthy',
          summary: 'Connected — 2 social account(s).',
          checkedAt: new Date(NOW - 12 * 60 * 1000).toISOString(),
          checkedBy: 'pulse',
        }}
        running={false}
        onRun={() => {}}
        now={NOW}
      />
    );
    const card = screen.getByRole('article', { name: 'Publer' });
    expect([...card.children].map((child) => child.dataset.slot)).toEqual([
      'header',
      'body',
      'footer',
    ]);
    // The body grows, so footers line up across a row of equal-height cards.
    expect(card.className).toMatch(/\bh-full\b/);
    expect(card.querySelector('[data-slot="body"]').className).toMatch(/\bflex-1\b/);
    const footer = card.querySelector('[data-slot="footer"]');
    expect(within(footer).getByText('Checked')).toBeTruthy();
    expect(within(footer).getByTestId('probe-checked').textContent).toMatch(
      /^12 min ago · .+ · by the pulse$/
    );
    expect(within(footer).getByText('Impact')).toBeTruthy();
    expect(within(footer).getByText('Fix')).toBeTruthy();
    expect(within(footer).getByRole('button', { name: 'Test Publer' })).toBeTruthy();
  });

  it('shows a stale result as Unknown in the slot, with its last value and age in the body', () => {
    render(
      <ProbeCard
        probe={byId('lab-agents')}
        result={{
          status: 'unknown',
          stale: true,
          lastStatus: 'healthy',
          windowMs: 15 * 60 * 1000,
          summary: '1 agent online.',
          checkedAt: new Date(NOW - 40 * 60 * 1000).toISOString(),
          checkedBy: 'pulse',
        }}
        running={false}
        onRun={() => {}}
        now={NOW}
      />
    );
    const card = screen.getByRole('article', { name: 'Lab agents' });
    expect(within(expectStatusTopRight(card)).getByText('Unknown')).toBeTruthy();
    expect(within(card).getByTestId('probe-summary').textContent).toBe('1 agent online.');
    expect(within(card).getByTestId('probe-stale').textContent).toMatch(
      /Stale: last Healthy, older than its 15 min window/
    );
    expect(within(card).getByTestId('probe-checked').textContent).toMatch(/^40 min ago/);
  });

  it('puts every card in the grid in the same structure, and counts the five words', () => {
    const resolve = (probe) =>
      probe.id === 'cosmos'
        ? { status: 'offline', summary: 'down', checkedAt: null }
        : { status: 'unknown', summary: 'Not tested yet.', checkedAt: null };
    render(
      <ProbeGrid
        probes={PROBES}
        resolve={resolve}
        running={new Set()}
        runningAll={false}
        onRun={() => {}}
        onRunAll={() => {}}
        now={NOW}
      />
    );
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(PROBES.length);
    for (const card of cards) expectStatusTopRight(card);
    expect(summarizeProbes(PROBES, resolve)).toEqual({
      offline: 1,
      critical: 0,
      degraded: 0,
      healthy: 0,
      unknown: PROBES.length - 1,
    });
  });
});

describe('the Overview and Alerts cards', () => {
  const card = (title) => screen.getByRole('heading', { name: title }).closest('.rounded-lg');

  it('show their status in the same top-right slot as the probe cards', () => {
    const readiness = {
      functionsConfigured: false,
      unresolvedSecrets: ['RESEND-API-KEY'],
      configGeneration: 'run-7',
      configWriter: 'terraform',
      publishedItems: 3,
      missingSlugCount: 0,
      rssSources: 1,
    };
    render(
      <>
        <PipelineReadinessCard readiness={readiness} digestForDisplay={null} />
        <PublishingOpsCard publishingOps={null} publishingWatchdog={null} digestForDisplay={null} />
        <OperationalSignalsCard signals={{ queueBreachCount: 2 }} />
        <WorkflowAlertsCard
          alertFilter="open"
          setAlertFilter={() => {}}
          filteredAlerts={[]}
          alertActionId=""
          resolutionNotes={{}}
          setResolutionNotes={() => {}}
          handleAlertAction={() => {}}
          status="healthy"
        />
      </>
    );
    const expected = {
      'Pipeline Readiness': 'critical',
      'Publishing Operations': 'unknown',
      'Operational Signals': 'degraded',
      'Workflow Alerts': 'healthy',
    };
    for (const [title, status] of Object.entries(expected)) {
      const element = card(title);
      const slot = expectStatusTopRight(element);
      expect(slot.querySelector('[data-status]').getAttribute('data-status'), title).toBe(status);
    }
  });

  // A jobs read that failed must not leave the header saying Healthy over a
  // body that says the jobs could not be counted (#1491). Degraded, not
  // unknown: worstStatus ranks unknown only when nothing else is known.
  it('mark Operational Signals degraded when a jobs read failed or the day had a failed job', () => {
    const quiet = {
      queueBreachCount: 0,
      publishFailureCount: 0,
      orphanedGeneratedImages: 0,
      failedJobs: [],
    };
    const statusOf = (signals) => {
      const { unmount } = render(<OperationalSignalsCard signals={signals} />);
      const slot = expectStatusTopRight(card('Operational Signals'));
      const status = slot.querySelector('[data-status]').getAttribute('data-status');
      unmount();
      return status;
    };
    expect(statusOf({ ...quiet, jobs24h: { failed: 0, total: 3, unavailable: false } })).toBe(
      'healthy'
    );
    expect(statusOf({ ...quiet, failedJobsUnavailable: true })).toBe('degraded');
    expect(statusOf({ ...quiet, jobs24h: { failed: 0, total: 0, unavailable: true } })).toBe(
      'degraded'
    );
    expect(statusOf({ ...quiet, jobs24h: { failed: 2, total: 9, unavailable: false } })).toBe(
      'degraded'
    );
    // Items wait but none carries a time (#1516): the header agrees with the tile.
    expect(statusOf({ ...quiet, oldestStagedHours: null, stagedWaitingCount: 1 })).toBe('degraded');
  });
});
