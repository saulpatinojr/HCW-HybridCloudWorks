/**
 * The Services tab. The card tests moved from IntegrationsPage.test.jsx (#570);
 * what changed is that a card now shows its keys by name and light only, and
 * the paste box lives on the Keys tab. What must hold: the test button and the
 * key names share a card, tests go server-side by NAME and read the envelope,
 * a group is picked by `?group=`, and a failed status read leaves the cards up.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import IntegrationsServices from './IntegrationsServices';
import useServiceTests from './useServiceTests';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const postJSON = vi.fn();
const toast = vi.fn();
const getIntegrationSettings = vi.fn();
const saveIntegrationSettings = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/lib/adminSettings', () => ({
  getIntegrationSettings: (...args) => getIntegrationSettings(...args),
  saveIntegrationSettings: (...args) => saveIntegrationSettings(...args),
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
const runJob = vi.fn();
vi.mock('@/lib/jobs', () => ({ runJob: (...args) => runJob(...args) }));
const fetchCloudPricing = vi.fn();
vi.mock('@/lib/publicApi', () => ({
  fetchCloudPricing: (...args) => fetchCloudPricing(...args),
}));

const item = (overrides = {}) => ({
  secret: 'RESEND-API-KEY',
  section: 'communication',
  label: 'Resend — API key',
  help: 'API key.',
  state: 'live',
  generatable: false,
  hasLivenessCheck: false,
  ...overrides,
});

const payload = (secrets) => ({
  success: true,
  sections: [{ id: 'communication', title: 'Communication', blurb: 'b' }],
  secrets,
});

const onGroupChange = vi.fn();
const onOpenKeys = vi.fn();

function Harness({ group }) {
  const tests = useServiceTests();
  return (
    <IntegrationsServices
      group={group}
      onGroupChange={onGroupChange}
      onOpenKeys={onOpenKeys}
      tests={tests}
    />
  );
}

const cardFor = (name) => screen.getByText(name).closest('.p-4');

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue(payload([item()]));
  sendJSON.mockReset();
  postJSON.mockReset();
  toast.mockReset();
  onGroupChange.mockReset();
  onOpenKeys.mockReset();
  getIntegrationSettings.mockReset().mockResolvedValue({ sessionizeSpeakerId: 'speaker-42' });
  saveIntegrationSettings.mockReset().mockResolvedValue({ success: true });
  runJob.mockReset();
  fetchCloudPricing.mockReset();
});

describe('the Cloud pricing cache card (#613)', () => {
  const cached = (over = {}) => ({
    region: 'us-east-1',
    regions: [],
    refreshedAt: '2026-09-14T06:00:00.000Z',
    ttlMinutes: 1440,
    ageMinutes: 30,
    stale: false,
    counts: { live: 22, baseline: 0, unavailable: 2 },
    services: [],
    ...over,
  });

  it('enqueues refresh-tool-pricing with an empty payload, then re-reads the cache', async () => {
    let finish;
    runJob.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    fetchCloudPricing.mockResolvedValue(cached());
    render(<Harness group="cloud" />);
    await waitFor(() => expect(screen.getByText('Cloud pricing cache')).toBeTruthy());
    const card = cardFor('Cloud pricing cache');

    const refresh = within(card).getByRole('button', { name: /Refresh now/ });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh.disabled).toBe(true));
    // THE BODY THE SERVER SEES: `enqueueJob` is sent `{ type, payload }` by
    // runJob, and this is the type and payload it is given.
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob.mock.calls[0][0]).toBe('refresh-tool-pricing');
    expect(runJob.mock.calls[0][1]).toEqual({});

    finish({ id: 'j1', status: 'succeeded', result: { regions: 3 } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Prices refreshed' }))
    );
    // The re-read is the card's own test, so its line is the refreshed cache.
    await waitFor(() =>
      expect(within(card).getByText(/Fresh: refreshed 30 minutes ago/)).toBeTruthy()
    );
    expect(fetchCloudPricing).toHaveBeenCalledWith('us-east-1', { fresh: true });
    await waitFor(() => expect(refresh.disabled).toBe(false));
  });

  it('reports a job that ended failed as a failure, and does not re-read', async () => {
    runJob.mockResolvedValue({ id: 'j2', status: 'failed', error: 'AWS refused the key' });
    render(<Harness group="cloud" />);
    await waitFor(() => expect(screen.getByText('Cloud pricing cache')).toBeTruthy());
    fireEvent.click(
      within(cardFor('Cloud pricing cache')).getByRole('button', { name: /Refresh now/ })
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Refresh failed', description: 'AWS refused the key' })
      )
    );
    expect(fetchCloudPricing).not.toHaveBeenCalled();
  });

  it('shows a stale cache as Failed with the age, from the beaker', async () => {
    fetchCloudPricing.mockResolvedValue(cached({ stale: true, ageMinutes: 26 * 60 }));
    render(<Harness group="cloud" />);
    await waitFor(() => expect(screen.getByText('Cloud pricing cache')).toBeTruthy());
    const card = cardFor('Cloud pricing cache');
    fireEvent.click(within(card).getByRole('button', { name: /^Test Cloud pricing cache$/ }));
    await waitFor(() =>
      expect(within(card).getByText(/Stale: last refreshed 26 hours ago/)).toBeTruthy()
    );
    expect(within(card).getByText('Critical')).toBeTruthy();
  });
});

describe('the service cards', () => {
  it('carries the test button and the names of its keys on one card, with no paste box', async () => {
    render(<Harness group="communication" />);
    await waitFor(() => expect(cardFor('Resend').textContent).toContain('RESEND-API-KEY'));

    const card = cardFor('Resend');
    expect(within(card).getByRole('button', { name: /^Test Resend$/ })).toBeTruthy();
    expect(within(card).getByText('Live')).toBeTruthy();
    // Writing a key happens on the Keys tab only: one write path per key.
    expect(card.querySelector('input')).toBeNull();
  });

  it('runs the service test server-side and reports the result', async () => {
    // THE REAL ENVELOPE: connectionProbe answers `{ ok, status, data }` where
    // `data` is Resend's own `{ object: 'list', data: [...] }` body.
    postJSON.mockResolvedValue({
      ok: true,
      status: 200,
      data: { object: 'list', data: [{ id: 'd-1' }, { id: 'd-2' }] },
    });
    render(<Harness group="communication" />);
    fireEvent.click(within(cardFor('Resend')).getByRole('button', { name: /^Test Resend$/ }));

    await waitFor(() => expect(screen.getByText(/2 sending domain\(s\)/)).toBeTruthy());
    // A name, never a path: the probe builds the call on the server.
    expect(postJSON).toHaveBeenCalledWith('connectionProbe', { probe: 'resend' });
    expect(within(cardFor('Resend')).getByText(/tested just now/)).toBeTruthy();
  });

  it('says a working Resend key with no domain yet cannot send anything', async () => {
    postJSON.mockResolvedValue({ ok: true, status: 200, data: { object: 'list', data: [] } });
    render(<Harness group="communication" />);
    fireEvent.click(within(cardFor('Resend')).getByRole('button', { name: /^Test Resend$/ }));

    await waitFor(() =>
      expect(screen.getByText(/no sending domain has been added to Resend yet/)).toBeTruthy()
    );
  });

  it('shows Resend refusing a sending-only key instead of a green tick', async () => {
    postJSON.mockResolvedValue({
      ok: false,
      status: 401,
      data: {
        name: 'restricted_api_key',
        message: 'This API key is restricted to only send emails',
      },
      error: 'This API key is restricted to only send emails',
    });
    render(<Harness group="communication" />);
    fireEvent.click(within(cardFor('Resend')).getByRole('button', { name: /^Test Resend$/ }));

    await waitFor(() => expect(screen.getByText(/restricted to only send emails/)).toBeTruthy());
    expect(screen.queryByText(/sending domain\(s\)/)).toBeNull();
    expect(within(cardFor('Resend')).getByText('Critical')).toBeTruthy();
    // And the failure is recorded with the provider's sentence (ADR 0033).
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(
        'cms/integration-status',
        'PUT',
        expect.objectContaining({ service: 'resend', ok: false, error: expect.stringMatching(/./) })
      )
    );
  });

  it('does not call YouTube a placeholder, because its key has a live consumer', async () => {
    // lib/listen-and-learn/videos.js calls the Data API v3 with
    // YOUTUBE_API_KEY to pick the "watch next" videos beside every episode.
    render(<Harness group="content" />);
    await waitFor(() => expect(screen.getByText('YouTube')).toBeTruthy());

    const card = cardFor('YouTube');
    expect(card.textContent).toContain('watch next');
    expect(screen.queryByText('Placeholder')).toBeNull();
    expect(card.textContent).not.toContain('not wired up');
  });

  it('puts the Sessionize speaker id on the Sessionize card, beside the test that uses it', async () => {
    render(<Harness group="content" />);
    const speakerInput = await screen.findByLabelText('Sessionize Speaker ID');
    await waitFor(() => expect(speakerInput.value).toBe('speaker-42'));
    expect(within(cardFor('Sessionize')).getByLabelText('Sessionize Speaker ID')).toBe(
      speakerInput
    );
  });

  it('tests Sessionize with the trimmed speaker id, and a blank one falls back to the default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sessions: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<Harness group="content" />);
      const input = await screen.findByLabelText('Sessionize Speaker ID');
      await waitFor(() => expect(input.disabled).toBe(false));
      const test = within(cardFor('Sessionize')).getByRole('button', { name: /^Test Sessionize$/ });

      fireEvent.change(input, { target: { value: '  speaker-7  ' } });
      fireEvent.click(test);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0][0]).toBe('https://sessionize.com/api/speaker/json/speaker-7');

      await waitFor(() => expect(test.disabled).toBe(false));
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.click(test);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://sessionize.com/api/speaker/json/default-speaker'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('saves the speaker id once, however fast Save is pressed', async () => {
    let finish;
    saveIntegrationSettings.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<Harness group="content" />);
    const input = await screen.findByLabelText('Sessionize Speaker ID');
    await waitFor(() => expect(input.disabled).toBe(false));

    const save = within(cardFor('Sessionize')).getByRole('button', { name: /Save/ });
    fireEvent.click(save);
    fireEvent.click(save);
    finish({ success: true });

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(saveIntegrationSettings).toHaveBeenCalledTimes(1);
    expect(saveIntegrationSettings).toHaveBeenCalledWith({ sessionizeSpeakerId: 'speaker-42' });
  });

  it('still reports a failed save when the rejection carries no Error', async () => {
    saveIntegrationSettings.mockRejectedValue(undefined);
    render(<Harness group="content" />);
    const input = await screen.findByLabelText('Sessionize Speaker ID');
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.click(within(cardFor('Sessionize')).getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Save failed', variant: 'destructive' })
      )
    );
  });

  it('says why Plaud has no credential row rather than showing none and explaining nothing', async () => {
    render(<Harness group="content" />);
    await waitFor(() => expect(screen.getByText('Plaud')).toBeTruthy());
    const card = cardFor('Plaud');
    // The note must explain the OTHER sign-in without naming a database
    // document, an issue number or a file path.
    expect(card.textContent).toContain('12 hours');
    expect(card.textContent).toContain('Recording Hub');
    expect(card.textContent).not.toMatch(/mcp_servers|#\d{3}|\.js\b/);
  });
});

describe('the group picker', () => {
  it('shows only the group in `?group=`, and the first group when there is none', async () => {
    const { rerender } = render(<Harness group="education" />);
    await waitFor(() => expect(screen.getByText('Credly')).toBeTruthy());
    expect(screen.queryByText('Publer')).toBeNull();

    rerender(<Harness group={null} />);
    await waitFor(() => expect(screen.getByText('Publer')).toBeTruthy());
    expect(screen.queryByText('Credly')).toBeNull();
  });

  it('asks for a group change rather than keeping it to itself, so it deep-links', async () => {
    render(<Harness group="communication" />);
    fireEvent.click(await screen.findByRole('button', { name: /Education/ }));
    expect(onGroupChange).toHaveBeenCalledWith('education');
  });

  it('points at the Keys tab for keys in the group that no card uses', async () => {
    getJSON.mockResolvedValue({
      success: true,
      sections: [],
      secrets: [item({ secret: 'LOOSE-ONE', section: 'communication', label: 'Loose' })],
    });
    render(<Harness group="communication" />);
    fireEvent.click(await screen.findByRole('button', { name: /See them on the Keys tab/ }));
    expect(onOpenKeys).toHaveBeenCalled();
  });
});

describe('what a card says about itself (ADR 0033)', () => {
  it('shows the recorded last verdicts, the facts, and how to disconnect', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'cms/integration-status') {
        return {
          success: true,
          services: {
            resend: {
              lastOkAt: '2026-10-01T00:00:00.000Z',
              lastFailAt: '2026-10-02T00:00:00.000Z',
              lastError: 'restricted_api_key',
            },
          },
        };
      }
      return payload([item()]);
    });
    render(<Harness group="communication" />);
    const card = await waitFor(() => cardFor('Resend'));
    await waitFor(() => expect(within(card).getByTestId('persisted-status')).toBeTruthy());
    expect(within(card).getByTestId('persisted-status').textContent).toMatch(
      /Last worked .* Last failed .* restricted_api_key/
    );
    // The most recent verdict is the badge, with nothing tested this session.
    expect(within(card).getByText('Critical')).toBeTruthy();
    expect(within(card).getByText('Used in')).toBeTruthy();
    expect(within(card).getByText('Newsletter Hub')).toBeTruthy();
    expect(within(card).getByText(/cannot delete from it/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /Rotate or replace the key/ }));
    expect(onOpenKeys).toHaveBeenCalled();
  });

  it('offers Reconnect only on Plaud, and sends it to the Recording Hub', async () => {
    render(<Harness group="content" />);
    const plaud = await waitFor(() => cardFor('Plaud'));
    const link = within(plaud).getByRole('link', { name: /Reconnect in Recording Hub/ });
    expect(link.getAttribute('href')).toBe('/admin/recording-hub?tab=settings');
    expect(within(cardFor('Podbean')).queryByText(/Reconnect/)).toBeNull();
  });

  it('says why a card has no test instead of showing no beaker and explaining nothing', async () => {
    render(<Harness group="ai-services" />);
    const card = await waitFor(() => cardFor('Azure AI Speech'));
    expect(within(card).getByText(/No test: Not set up on purpose/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Test Azure AI Speech/ })).toBeNull();
  });
});

describe('the Hybrid Lab card: everything Coder in one box (2026-10-08)', () => {
  const labsPayload = {
    success: true,
    sections: [{ id: 'labs', title: 'Hybrid Lab', blurb: 'b' }],
    secrets: [
      item({ secret: 'CODER-URL', section: 'labs', label: 'Coder address' }),
      item({ secret: 'CODER-STATUS-TOKEN', section: 'labs', label: 'Coder status token' }),
      item({ secret: 'TURNSTILE-SECRET-KEY', section: 'labs', label: 'Turnstile', state: 'never' }),
    ],
  };
  const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  const report = (over = {}) => ({
    agentId: 'vps-hostinger-01',
    reportedAt: inDays(-0.01),
    checkedAt: inDays(-0.01),
    statusTokenRotatedAt: '2026-10-08T04:30:00.000Z',
    statusTokenExpiresAt: inDays(365),
    rotationTokenExpiresAt: '2099-04-01T00:00:00.000Z',
    templatePushedAt: '2026-10-07T21:00:00.000Z',
    templateVersion: 'brave_turing4',
    lastError: null,
    ...over,
  });
  /** The key status for the card, and `automation` for the report read. */
  const answering = (automation) => async (route) => {
    if (route !== 'cms/labs/coder-automation') return labsPayload;
    if (automation instanceof Error) throw automation;
    return automation;
  };
  const coderBox = () => waitFor(() => screen.getByRole('region', { name: 'Coder' }));
  const automationBox = async () => {
    const box = await waitFor(() => screen.getByTestId('coder-automation'));
    await waitFor(() => expect(box.textContent).not.toMatch(/Reading what the lab host/));
    return box;
  };

  it('puts both Coder keys and the automatic renewal under Coder, and Turnstile in a box of its own', async () => {
    getJSON.mockImplementation(answering({ report: report(), warningDays: 30 }));
    render(<Harness group="labs" />);

    const coder = await coderBox();
    await waitFor(() => expect(within(coder).getByText('CODER-STATUS-TOKEN')).toBeTruthy());
    expect(within(coder).getByText('CODER-URL')).toBeTruthy();
    expect(within(coder).queryByText('TURNSTILE-SECRET-KEY')).toBeNull();
    expect(within(coder).getByTestId('coder-automation')).toBeTruthy();

    const turnstile = screen.getByRole('region', { name: 'Turnstile' });
    expect(within(turnstile).getByText('TURNSTILE-SECRET-KEY')).toBeTruthy();
    expect(within(turnstile).queryByTestId('coder-automation')).toBeNull();
    expect(getJSON).toHaveBeenCalledWith('cms/labs/coder-automation');
  });

  it('lists the renewal, the rotation credential, the template and the last check, healthy', async () => {
    getJSON.mockImplementation(answering({ report: report(), warningDays: 30 }));
    render(<Harness group="labs" />);
    const box = await automationBox();

    const rows = [...box.querySelectorAll('li')].map((li) => li.textContent);
    expect(rows[0]).toMatch(
      /^Status token renewed on 2026-10-08 \(by the lab host\); it expires on \d{4}-\d{2}-\d{2}\.$/
    );
    expect(rows[1]).toBe('Rotation credential expires on 2099-04-01.');
    expect(rows[2]).toBe('Template last published 2026-10-07 (brave_turing4).');
    expect(rows[3]).toMatch(/^Last automation check \d{4}-\d{2}-\d{2}, reported \d+ min ago\.$/);
    expect(box.querySelector('[data-status]').getAttribute('data-status')).toBe('healthy');
    expect(within(box).queryByTestId('coder-automation-problem')).toBeNull();
  });

  it('says "Automatic renewal not set up yet" before any report, with no badge and no error styling', async () => {
    getJSON.mockImplementation(answering({ report: null, warningDays: 30 }));
    render(<Harness group="labs" />);
    const box = await automationBox();

    expect(within(box).getByText('Automatic renewal not set up yet')).toBeTruthy();
    expect(within(box).getByText('Automatic renewal not set up yet').className).toMatch(
      /text-muted-foreground/
    );
    expect(box.querySelector('[data-status]')).toBeNull();
    expect(box.querySelector('li')).toBeNull();
    expect(box.innerHTML).not.toMatch(/destructive|amber/);
  });

  it('shows lastError amber while the token is far from expiry', async () => {
    getJSON.mockImplementation(
      answering({ report: report({ lastError: 'template push failed' }), warningDays: 30 })
    );
    render(<Harness group="labs" />);
    const box = await automationBox();

    const problem = within(box).getByTestId('coder-automation-problem');
    expect(problem.textContent).toBe('Last check failed: template push failed');
    expect(problem.getAttribute('data-status')).toBe('degraded');
    expect(problem.className).toMatch(/amber/);
    expect(box.querySelector('[data-status]').getAttribute('data-status')).toBe('degraded');
  });

  it('shows lastError red once the token is inside the renewal window', async () => {
    getJSON.mockImplementation(
      answering({
        report: report({
          lastError: 'Coder refused the token (HTTP 401); the token was not stored',
          statusTokenExpiresAt: inDays(10),
        }),
        warningDays: 30,
      })
    );
    render(<Harness group="labs" />);
    const box = await automationBox();

    const problem = within(box).getByTestId('coder-automation-problem');
    expect(problem.getAttribute('data-status')).toBe('critical');
    expect(problem.className).toMatch(/text-destructive/);
    expect(box.querySelector('[data-status]').getAttribute('data-status')).toBe('critical');
  });

  it('keeps the keys, and the way to paste one by hand, when the report cannot be read', async () => {
    getJSON.mockImplementation(answering(new Error('HTTP 403')));
    render(<Harness group="labs" />);
    const box = await automationBox();

    expect(box.textContent).toMatch(/could not be read: HTTP 403/);
    expect(box.querySelector('[data-status]')).toBeNull();
    const coder = await coderBox();
    await waitFor(() => expect(within(coder).getByText('CODER-STATUS-TOKEN')).toBeTruthy());
    const card = cardFor('Hybrid Lab (Coder and Turnstile)');
    fireEvent.click(within(card).getByRole('button', { name: /Rotate or replace the key/ }));
    expect(onOpenKeys).toHaveBeenCalled();
  });
});

describe('loading on its own', () => {
  it('keeps the cards and their tests when the key status cannot be read', async () => {
    getJSON.mockRejectedValue(new Error('HTTP 503'));
    render(<Harness group="communication" />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/HTTP 503/));
    expect(within(cardFor('Resend')).getByRole('button', { name: /^Test Resend$/ })).toBeTruthy();
    expect(cardFor('Resend').textContent).not.toContain('RESEND-API-KEY');
  });
});
