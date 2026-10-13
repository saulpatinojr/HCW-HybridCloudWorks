/**
 * The Overview tab. What must hold: every service is on the grid, broken and
 * not-configured first; Test all runs each service's own test one at a time,
 * leaves YouTube out, records when each ran and survives a failing test; and
 * a failed status read still leaves the grid and Test all usable.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import IntegrationsOverview from './IntegrationsOverview';
import useServiceTests from './useServiceTests';
import { SERVICES } from './serviceRegistry';

const getJSON = vi.fn();
const postJSON = vi.fn();

const sendJSON = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/lib/adminSettings', () => ({
  getIntegrationSettings: async () => ({}),
  saveIntegrationSettings: vi.fn(),
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
// The pricing cache's test reads the public API rather than a proxy (#613);
// mocked so `fetch` below stays Sessionize's alone.
const fetchCloudPricing = vi.fn();
vi.mock('@/lib/publicApi', () => ({
  fetchCloudPricing: (...args) => fetchCloudPricing(...args),
}));

const item = (overrides = {}) => ({
  secret: 'PUBLER-API-KEY',
  section: 'communication',
  label: 'Publer — API key',
  help: 'h',
  state: 'live',
  ...overrides,
});

const onOpenGroup = vi.fn();

function Harness() {
  const tests = useServiceTests();
  return <IntegrationsOverview tests={tests} onOpenGroup={onOpenGroup} />;
}

const tileNames = () =>
  screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('[data-service]').getAttribute('data-service'));
const tile = (id) => document.querySelector(`[data-service="${id}"]`);

const fetchMock = vi.fn();

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue({ success: true, sections: [], secrets: [] });
  postJSON.mockReset().mockResolvedValue({ ok: true, status: 200, data: {} });
  onOpenGroup.mockReset();
  fetchMock
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => ({ events: [{ id: 1 }] }) });
  vi.stubGlobal('fetch', fetchMock);
  fetchCloudPricing.mockReset().mockResolvedValue({
    refreshedAt: '2026-09-14T06:00:00.000Z',
    ageMinutes: 30,
    stale: false,
    counts: { live: 24, baseline: 0, unavailable: 0 },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the grid', () => {
  it('shows every service in the registry', async () => {
    render(<Harness />);
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith('cms/secrets'));
    expect(tileNames().sort()).toEqual(SERVICES.map((service) => service.id).sort());
  });

  it('puts a rejected service first and an unset one next', async () => {
    getJSON.mockResolvedValue({
      success: true,
      sections: [],
      secrets: [
        item({ secret: 'RESEND-API-KEY', state: 'never' }),
        item({ secret: 'TELEGRAM-BOT-TOKEN', state: 'failing' }),
      ],
    });
    render(<Harness />);
    await waitFor(() => expect(tileNames()[0]).toBe('telegram'));
    expect(tileNames()[1]).toBe('resend');
    // The shared vocabulary (ADR 0033 §2), not this page's own words.
    expect(within(tile('telegram')).getByText('Critical')).toBeTruthy();
    expect(within(tile('resend')).getByText('Critical')).toBeTruthy();
  });

  it('reads the recorded last verdicts and sorts a service that last failed first (ADR 0033)', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'cms/integration-status') {
        return {
          success: true,
          services: {
            linkie: {
              lastOkAt: '2026-10-01T00:00:00.000Z',
              lastFailAt: '2026-10-02T00:00:00.000Z',
              lastError: 'Unauthorized',
            },
            publer: { lastOkAt: '2026-10-02T00:00:00.000Z', lastFailAt: null, lastError: null },
          },
        };
      }
      return { success: true, sections: [], secrets: [] };
    });
    render(<Harness />);
    await waitFor(() => expect(tileNames()[0]).toBe('linkie'));
    expect(within(tile('linkie')).getByText('Critical')).toBeTruthy();
    expect(within(tile('linkie')).getByText(/Unauthorized/)).toBeTruthy();
    expect(within(tile('linkie')).getByText(/last tested/)).toBeTruthy();
    expect(within(tile('publer')).getByText('Healthy')).toBeTruthy();
    expect(getJSON).toHaveBeenCalledWith('cms/integration-status');
  });

  it('opens a service’s group on the Services tab', async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Credly' }));
    expect(onOpenGroup).toHaveBeenCalledWith('education');
  });

  it('keeps the grid and Test all when key status cannot be read', async () => {
    getJSON.mockRejectedValue(new Error('HTTP 500'));
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 500/));
    expect(tileNames()).toHaveLength(SERVICES.length);
    expect(screen.getByRole('button', { name: /Test all/ }).disabled).toBe(false);
  });
});

describe('Test all', () => {
  it(
    'runs every testable service one at a time, never two at once',
    { timeout: 20000 },
    async () => {
      let active = 0;
      let peak = 0;
      const slow = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ok: true, status: 200, data: {} };
      };
      postJSON.mockImplementation(slow);
      fetchMock.mockImplementation(async () => {
        await slow();
        return { ok: true, json: async () => ({ events: [] }) };
      });

      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: /Test all/ }));
      // The registry now holds many more services (ADR 0033), each run one
      // after the other with a 5 ms pause, and the coverage job instruments
      // every render: 3 s was the wall this test hit there. Generous on
      // purpose; what is asserted is the peak concurrency, not the speed.
      await waitFor(
        () => expect(screen.getByRole('button', { name: /Test all/ }).disabled).toBe(false),
        {
          timeout: 15000,
        }
      );

      expect(peak).toBe(1);
      const probes = postJSON.mock.calls.map(([route, body]) => body?.probe ?? route);
      // Every testable service once, in registry order, and no YouTube: its
      // test spends daily quota.
      expect(probes).toEqual([
        'publerProxy',
        'resend',
        'linkieProxy',
        'telegram',
        'podbean',
        'mcpProxy',
        // ADR 0033: the four language models, then the two AI-service probes.
        'testAiProvider',
        'testAiProvider',
        'testAiProvider',
        'testAiProvider',
        'firecrawl',
        'replicate',
        'qlty',
      ]);
      expect(probes).not.toContain('youtube');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('speaker-42');
      // The pricing cache is in Test all too: it is a read, and spends nothing.
      expect(fetchCloudPricing).toHaveBeenCalledTimes(1);
    }
  );

  it('records a result and a time on each tile, and says YouTube was left out', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Test all/ }));
    await waitFor(() => expect(within(tile('publer')).getByText(/tested just now/)).toBeTruthy());
    await waitFor(() => expect(within(tile('sessionize')).getByText('Healthy')).toBeTruthy());
    expect(within(tile('youtube')).getByText(/Not in Test all/)).toBeTruthy();
    expect(within(tile('youtube')).queryByText(/^tested /)).toBeNull();
    expect(within(tile('youtube')).getByText('Unknown')).toBeTruthy();
    // Each verdict is recorded for the next visit (ADR 0033).
    expect(sendJSON).toHaveBeenCalledWith(
      'cms/integration-status',
      'PUT',
      expect.objectContaining({ service: 'sessionize', ok: true })
    );
  });

  it('keeps going past a refusal and shows it as broken with the provider’s words', async () => {
    postJSON.mockImplementation(async (route, body) =>
      body?.probe === 'telegram'
        ? { ok: false, status: 401, error: 'Unauthorized', data: { description: 'Unauthorized' } }
        : { ok: true, status: 200, data: {} }
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Test all/ }));

    await waitFor(() => expect(within(tile('sessionize')).getByText('Healthy')).toBeTruthy());
    expect(within(tile('telegram')).getByText('Critical')).toBeTruthy();
    expect(within(tile('telegram')).getByText(/Unauthorized/)).toBeTruthy();
    expect(tileNames()[0]).toBe('telegram');
  });

  it('ignores a second press while it is still running', async () => {
    let release;
    postJSON.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, data: {} })))
    );
    render(<Harness />);
    const button = screen.getByRole('button', { name: /Test all/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Test all/ }).disabled).toBe(false)
    );
    expect(postJSON.mock.calls.filter(([route]) => route === 'publerProxy')).toHaveLength(1);
  });
});
