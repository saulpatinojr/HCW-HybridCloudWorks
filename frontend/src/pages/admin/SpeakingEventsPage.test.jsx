/**
 * The Speaking Events Hub page (#573). What must hold: the header names the
 * hub and its provider, `?tab=` picks the tab and moved or unknown ids land
 * where their content went, a tab click writes the URL, rows land on Upcoming
 * or Past by date, Sources says what a sync would change, and one read's
 * failure is shown on the tabs that use it without blanking the others.
 *
 * The data rules, the read guard and the writes are tested beside them in
 * components/admin/speaking-events.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import SpeakingEventsPage from './SpeakingEventsPage';

const getJSON = vi.fn();
const postJSON = vi.fn();
const fetchPublicSnapshotItems = vi.fn();
const setSearchParams = vi.fn();
let searchParams = '';

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: vi.fn(),
}));
vi.mock('@/lib/publicApi', () => ({
  fetchPublicSnapshotItems: (...args) => fetchPublicSnapshotItems(...args),
  // The Publishing tab reads the whole snapshot, fresh; the fixture answers
  // the same rows through both shapes.
  fetchPublicSnapshot: async (id) => {
    const items = await fetchPublicSnapshotItems(id);
    return { generatedAt: '2026-09-01T12:00:00Z', items, meta: { speakerId: 'speaker-42' } };
  },
}));
vi.mock('@/lib/adminSettings', () => ({
  getIntegrationSettings: async () => ({ sessionizeSpeakerId: 'speaker-42' }),
  saveIntegrationSettings: vi.fn(),
  getSessionizeSpeakerId: async () => 'speaker-42',
  DEFAULT_SESSIONIZE_SPEAKER_ID: 'default-speaker',
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router', () => ({
  useSearchParams: () => [new URLSearchParams(searchParams), setSearchParams],
  useLocation: () => ({ pathname: '/admin/speaking' }),
  Link: ({ to, children, ...rest }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const today = new Date();
const isoDaysFromToday = (days) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const SESSIONIZE = {
  events: [
    { id: 101, name: 'Future Conf', eventStartDate: isoDaysFromToday(30) },
    { id: 102, name: 'Old Conf', eventStartDate: isoDaysFromToday(-30) },
  ],
};
const STORED = {
  items: [
    {
      id: 'event-102',
      eventId: 102,
      sessionizeId: 102,
      eventName: 'Old Conf',
      name: 'Old Conf',
      date: isoDaysFromToday(-30),
      presentationUrl: 'https://slides.example/old',
      display: true,
    },
    { id: 'manual-1', eventName: 'Local Meetup', date: isoDaysFromToday(10), display: false },
  ],
};

let sessionizeResponse;

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  searchParams = '';
  setSearchParams.mockReset();
  postJSON.mockReset().mockResolvedValue({ ok: true });
  getJSON.mockReset().mockImplementation(async (route) => {
    if (route === 'cms/speakerevents') return STORED;
    throw new Error(`unexpected route ${route}`);
  });
  fetchPublicSnapshotItems.mockReset().mockResolvedValue([{ id: 'event-102' }]);
  sessionizeResponse = async () => ({ ok: true, json: async () => SESSIONIZE });
  vi.stubGlobal(
    'fetch',
    vi.fn((...args) => sessionizeResponse(...args))
  );
});

const hubTabs = () => within(screen.getByRole('tablist', { name: 'Speaking Events Hub' }));
const selectedTab = () => hubTabs().getByRole('tab', { selected: true }).textContent;
const panel = () => within(screen.getByRole('tabpanel'));

describe('the header and tabs', () => {
  it('names the hub and Sessionize in the header, and offers five tabs with Settings last', () => {
    render(<SpeakingEventsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Speaking' })).toBeTruthy();
    expect(screen.getByText('Sessionize', { selector: 'strong' })).toBeTruthy();
    expect(
      hubTabs()
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Upcoming', 'Past', 'Sources', 'Publishing', 'Settings']);
  });

  it.each([
    ['upcoming', 'Upcoming'],
    ['past', 'Past'],
    ['sources', 'Sources'],
    ['publishing', 'Publishing'],
    ['settings', 'Settings'],
  ])('deep-links ?tab=%s to the %s tab', (tab, label) => {
    searchParams = `tab=${tab}`;
    render(<SpeakingEventsPage />);
    expect(selectedTab()).toBe(label);
  });

  it.each([
    ['sessionize', 'Sources'],
    ['sync', 'Sources'],
    ['snapshot', 'Publishing'],
    ['speaker', 'Settings'],
    ['constructor', 'Upcoming'],
    ['no-such-tab', 'Upcoming'],
  ])('sends the moved or unknown tab id %s to %s', (tab, label) => {
    searchParams = `tab=${tab}`;
    render(<SpeakingEventsPage />);
    expect(selectedTab()).toBe(label);
  });

  it('writes the tab to the URL when one is clicked, and not for the active tab', () => {
    render(<SpeakingEventsPage />);
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Sources' }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: 'sources' });
    setSearchParams.mockClear();
    fireEvent.click(hubTabs().getByRole('tab', { name: 'Upcoming' }));
    expect(setSearchParams).not.toHaveBeenCalled();
  });
});

describe('Upcoming and Past', () => {
  it('shows a loading state, then future Sessionize and manual rows on Upcoming', async () => {
    render(<SpeakingEventsPage />);
    expect(panel().getByText(/Loading upcoming sessions/)).toBeTruthy();
    expect(await panel().findByText('Future Conf')).toBeTruthy();
    expect(panel().getByText('Local Meetup')).toBeTruthy();
    expect(panel().queryByText('Old Conf')).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://sessionize.com/api/speaker/json/speaker-42');
  });

  it('gives every delete control its own accessible name, naming its row', async () => {
    searchParams = 'tab=past';
    render(<SpeakingEventsPage />);
    await panel().findByText('Old Conf');
    const names = panel()
      .getAllByRole('button', { name: /^Delete / })
      .map((button) => button.getAttribute('aria-label'));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names.some((name) => name.includes('Old Conf'))).toBe(true);
  });

  it('shows delivered sessions on Past with their slides link', async () => {
    searchParams = 'tab=past';
    render(<SpeakingEventsPage />);
    expect(await panel().findByText('Old Conf')).toBeTruthy();
    expect(panel().queryByText('Future Conf')).toBeNull();
    expect(panel().getByRole('link', { name: 'Slides' }).getAttribute('href')).toBe(
      'https://slides.example/old'
    );
  });

  it('opens the enrich form from a row', async () => {
    render(<SpeakingEventsPage />);
    fireEvent.click(await panel().findByRole('button', { name: /Enrich/ }));
    expect(panel().getByText('New Override')).toBeTruthy();
    expect(panel().getByText(/Sessionize #101/)).toBeTruthy();
  });

  it('titles a manual entry as one, not as an override of a Sessionize row', async () => {
    searchParams = 'tab=sources';
    render(<SpeakingEventsPage />);
    fireEvent.click(await panel().findByRole('button', { name: /Manual Entry/ }));
    expect(panel().getByText('New Manual Entry')).toBeTruthy();
    expect(panel().queryByText('New Override')).toBeNull();
  });
});

describe('Sources', () => {
  it('says what a sync would create before it runs', async () => {
    searchParams = 'tab=sources';
    render(<SpeakingEventsPage />);
    expect(await panel().findByText(/A sync would create 1 record/)).toBeTruthy();
    expect(panel().getByText('Future Conf')).toBeTruthy();
    expect(panel().getByText(/Manual Entries — Stored Only \(1\)/)).toBeTruthy();
  });

  it('syncs the missing event and re-reads the store', async () => {
    searchParams = 'tab=sources';
    render(<SpeakingEventsPage />);
    await panel().findByText(/A sync would create/);
    fireEvent.click(panel().getByRole('button', { name: /Sync from Sessionize/ }));
    expect(await panel().findByText(/Sync complete/)).toBeTruthy();
    expect(postJSON).toHaveBeenCalledWith(
      'upsertSpeakerEvent',
      expect.objectContaining({ docId: 'event-101', merge: false })
    );
    expect(getJSON).toHaveBeenCalledTimes(2);
  });
});

describe('per-tab loading and error isolation', () => {
  it('shows a Sessionize failure with Try again on Upcoming, and recovers', async () => {
    sessionizeResponse = async () => ({ ok: false, status: 503 });
    render(<SpeakingEventsPage />);
    const alert = await panel().findByRole('alert');
    expect(alert.textContent).toContain('Failed to load Sessionize: Sessionize HTTP 503');

    sessionizeResponse = async () => ({ ok: true, json: async () => SESSIONIZE });
    fireEvent.click(within(alert).getByRole('button', { name: /Try again/ }));
    expect(await panel().findByText('Future Conf')).toBeTruthy();
    expect(panel().queryByRole('alert')).toBeNull();
  });

  it('keeps Publishing and Settings working when the stored overrides fail', async () => {
    getJSON.mockRejectedValue(new Error('store refused'));
    searchParams = 'tab=publishing';
    const { unmount } = render(<SpeakingEventsPage />);
    expect(await panel().findByText(/The public speaking page lists 1 event/)).toBeTruthy();
    expect((await panel().findByRole('alert')).textContent).toContain(
      'Failed to load stored event data: store refused'
    );
    expect(panel().getByRole('button', { name: /Publish snapshot/ })).toBeTruthy();
    unmount();

    searchParams = 'tab=settings';
    render(<SpeakingEventsPage />);
    expect(await panel().findByText('speaker-42')).toBeTruthy();
    expect(panel().queryByRole('alert')).toBeNull();
  });
});

describe('Upcoming when Sessionize is down, search, and the delete dialog', () => {
  it('still lists every stored row beside the Sessionize error', async () => {
    sessionizeResponse = async () => ({ ok: false, status: 503 });
    render(<SpeakingEventsPage />);
    expect((await panel().findByRole('alert')).textContent).toContain('Sessionize HTTP 503');
    expect(await panel().findByText('Local Meetup')).toBeTruthy();
  });

  it('filters the list by search text and by status', async () => {
    render(<SpeakingEventsPage />);
    await panel().findByText('Future Conf');
    fireEvent.change(panel().getByLabelText('Search sessions'), { target: { value: 'local' } });
    expect(panel().queryByText('Future Conf')).toBeNull();
    expect(panel().getByText('Local Meetup')).toBeTruthy();
    fireEvent.change(panel().getByLabelText('Search sessions'), { target: { value: '' } });
    fireEvent.change(panel().getByLabelText('Status'), { target: { value: 'accepted' } });
    expect(panel().getByText('Future Conf')).toBeTruthy();
    expect(panel().queryByText('Local Meetup')).toBeNull();
    fireEvent.change(panel().getByLabelText('Status'), { target: { value: 'declined' } });
    expect(panel().getByText('No sessions match these filters.')).toBeTruthy();
  });

  it('asks before a delete, through a dialog rather than window.confirm', async () => {
    searchParams = 'tab=past';
    render(<SpeakingEventsPage />);
    await panel().findByText('Old Conf');
    fireEvent.click(panel().getByRole('button', { name: /^Delete stored override for Old Conf/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete this stored event?')).toBeTruthy();
    expect(postJSON).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('deleteSpeakerEvent', { docId: 'event-102' })
    );
  });
});

describe('Publishing and Settings', () => {
  it('does not assert snapshot/store drift when the public snapshot returns no rows', async () => {
    fetchPublicSnapshotItems.mockResolvedValue([]);
    searchParams = 'tab=publishing';
    render(<SpeakingEventsPage />);
    expect(await panel().findByText(/Would publish 1 event; 1 stored row not shown/)).toBeTruthy();
    expect(
      await panel().findByText(/cannot confirm whether it differs from stored events/)
    ).toBeTruthy();
    expect(panel().queryByText(/The snapshot and the store differ/)).toBeNull();
    expect(fetchPublicSnapshotItems).toHaveBeenCalledWith('speakerevents');
  });

  it('shows drift when both reads land and the snapshot count differs', async () => {
    fetchPublicSnapshotItems.mockResolvedValue([{ id: 'one' }, { id: 'two' }]);
    searchParams = 'tab=publishing';
    render(<SpeakingEventsPage />);
    expect(await panel().findByText(/Would publish 1 event; 1 stored row not shown/)).toBeTruthy();
    expect(await panel().findByText(/The snapshot and the store differ/)).toBeTruthy();
    expect(fetchPublicSnapshotItems).toHaveBeenCalledWith('speakerevents');
  });

  it('shows the speaker ID read-only and links to its one editor on Integrations', async () => {
    searchParams = 'tab=settings';
    render(<SpeakingEventsPage />);
    expect(await panel().findByText('speaker-42')).toBeTruthy();
    // Shown, never editable here: no input carries the id.
    expect(panel().queryByDisplayValue('speaker-42')).toBeNull();
    expect(await panel().findByRole('form', { name: 'Speaker profile' })).toBeTruthy();
    expect(
      panel()
        .getByRole('link', { name: /Sessionize card in the Integrations Hub/ })
        .getAttribute('href')
    ).toBe('/admin/integrations?tab=services&group=content');
  });
});
