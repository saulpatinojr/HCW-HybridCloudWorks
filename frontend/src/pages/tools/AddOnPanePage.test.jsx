/**
 * `/tools/<id>` (ADR 0035): the pane opens only when the status proxy says
 * the AddOn is configured and reachable; the frame loads the AddOn's own
 * origin with exactly the sandbox and `allow` the row's capabilities grant;
 * the page hears the AddOn's state and nothing else, acts on an allow-listed
 * `navigate` only when the row grants it, treats a frame that never loads
 * as unavailable; a `coming` row renders its explainer and fetches nothing;
 * and every way the tool can be missing reads as one sentence, never an
 * error. The harness is LabPanePage.test.jsx's.
 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addonById, addonFrameUrl, addons, availableAddons } from '@/data/addons/catalogue';
import { staticRoutes } from '@/lib/routeFactory';

const fetchAddonStatus = vi.fn();
vi.mock('@/lib/publicApi', () => ({
  fetchAddonStatus: (id) => fetchAddonStatus(id),
}));

import AddOnPanePage, {
  ADDON_MESSAGE_TYPE,
  ADDON_NAVIGATION_TARGETS,
  ADDON_OPENING_SENTENCE,
  ADDON_PANE_LOAD_TIMEOUT_MS,
  ADDON_PANE_STATES,
  ADDON_PANE_STATE_WORDS,
  ADDON_UNAVAILABLE_SENTENCE,
  addonMessageNavigate,
  addonMessageState,
  addonService,
  allowFor,
  sandboxFor,
  siteTheme,
} from './AddOnPanePage';

const MIGRATION = addonById('migration');
const REACHABLE = {
  configured: true,
  reachable: true,
  version: '0.3.0',
  edition: 'demo',
  capabilities: ['assessments', 'sample-csv', 'bundle-download'],
  asOf: '2026-10-10T11:59:40.000Z',
};

/** Backend words a visitor must not read on this page, in any state. */
const BEHIND_THE_SITE =
  /\bcoder\b|oauth|code-server|\bvps\b|callback|caddy|hostinger|turnstile|cloudflare|docker|\bapi\b/i;

/** Render the page for one row inside a router and the shared providers. */
function renderPane(addonId = MIGRATION.id, addonOverride) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[`/tools/${addonId}`]}>
        <Routes>
          <Route
            path="/tools/:id"
            element={<AddOnPanePage addonId={addonId} addon={addonOverride} />}
          />
          <Route path="/" element={<p>home</p>} />
          <Route path={staticRoutes.contact} element={<p>contact page</p>} />
          <Route path={staticRoutes.landingZone} element={<p>landing zone page</p>} />
          <Route path={staticRoutes.labs} element={<p>labs page</p>} />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>
  );
}

/** Everything on the page a visitor reads: text, and the names assistive technology reads out. */
function visibleWords(container) {
  const named = [...container.querySelectorAll('[title], [aria-label]')].map(
    (el) => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`
  );
  return [container.textContent, ...named].join(' ');
}

/** Let React run the effects of a commit that arrived outside `act` (the status read resolving). */
async function flushEffects() {
  await act(async () => {});
}

/** A `message` event as the browser delivers one to this page; the fields the listener reads are set directly. */
function messageFrom({ origin = MIGRATION.origin, source, data }) {
  return Object.assign(new Event('message'), { origin, source, data });
}

/** The AddOn in the pane posting its state, as it does (apps/lab-web/src/pane.ts). */
async function addonSays(state, overrides = {}) {
  await flushEffects();
  const frame = document.querySelector('iframe');
  const event = messageFrom({
    source: frame.contentWindow,
    data: { type: ADDON_MESSAGE_TYPE, id: MIGRATION.id, state },
    ...overrides,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

beforeEach(() => {
  fetchAddonStatus.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('addonService', () => {
  it.each([
    [{ data: null, loading: true, error: null }, 'checking'],
    [{ data: REACHABLE, loading: false, error: null }, 'available'],
    [{ data: { ...REACHABLE, reachable: false }, loading: false, error: null }, 'unavailable'],
    [{ data: { configured: false }, loading: false, error: null }, 'unavailable'],
    [{ data: null, loading: false, error: null }, 'unavailable'],
    [{ data: null, loading: false, error: new Error('x') }, 'unavailable'],
  ])('%j is %s', (query, expected) => {
    expect(addonService(query)).toBe(expected);
  });
});

describe('sandboxFor and allowFor', () => {
  it('grants the migration row the base flags plus allow-downloads (ADR 0035 decision 9, confirmed 2026-10-10)', () => {
    expect(sandboxFor(MIGRATION).split(/\s+/).sort()).toEqual([
      'allow-downloads',
      'allow-forms',
      'allow-same-origin',
      'allow-scripts',
    ]);
    expect(
      sandboxFor({ ...MIGRATION, capabilities: ['navigate'] })
        .split(/\s+/)
        .sort()
    ).toEqual(['allow-forms', 'allow-same-origin', 'allow-scripts']);
    expect(allowFor(MIGRATION)).toBe('');
  });

  it('adds a flag per capability, and never top navigation', () => {
    const row = (capabilities) => ({ ...MIGRATION, capabilities });
    expect(sandboxFor(row([]))).toBe('allow-scripts allow-same-origin allow-forms');
    expect(sandboxFor(row(['popups']))).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups'
    );
    expect(sandboxFor(row(['downloads', 'popups']))).toBe(
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups'
    );
    for (const addon of addons) expect(sandboxFor(addon)).not.toMatch(/top-navigation|modals/);
    expect(allowFor(row(['clipboard']))).toBe(
      `clipboard-read ${MIGRATION.origin}; clipboard-write ${MIGRATION.origin}`
    );
    expect(allowFor(row(['fullscreen']))).toBe(`fullscreen ${MIGRATION.origin}`);
    expect(allowFor(row(['clipboard', 'fullscreen']))).toBe(
      `clipboard-read ${MIGRATION.origin}; clipboard-write ${MIGRATION.origin}; fullscreen ${MIGRATION.origin}`
    );
  });

  it('grants clipboard-write alone when a row names only that, and never read with it', () => {
    const row = (capabilities) => ({ ...MIGRATION, capabilities });
    expect(allowFor(row(['clipboard-write']))).toBe(`clipboard-write ${MIGRATION.origin}`);
    expect(allowFor(row(['clipboard-write', 'fullscreen']))).toBe(
      `clipboard-write ${MIGRATION.origin}; fullscreen ${MIGRATION.origin}`
    );
    // both named: read and write once each, never doubled
    expect(allowFor(row(['clipboard', 'clipboard-write']))).toBe(
      `clipboard-read ${MIGRATION.origin}; clipboard-write ${MIGRATION.origin}`
    );
    for (const id of ['network-assessment', 'cloud-assessment', 'cloud-crawler']) {
      const addon = addonById(id);
      expect(allowFor(addon), id).toBe(`clipboard-write ${addon.origin}`);
      expect(allowFor(addon), id).not.toMatch(/clipboard-read/);
      expect(sandboxFor(addon), id).toBe(
        'allow-scripts allow-same-origin allow-forms allow-downloads'
      );
    }
  });
});

describe('AddOnPanePage before the pane', () => {
  it('says it is opening while the status read is in flight, and shows no frame', () => {
    fetchAddonStatus.mockReturnValue(new Promise(() => {}));
    const { container } = renderPane();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(MIGRATION.title);
    expect(screen.getByTestId('addon-opening')).toHaveTextContent(ADDON_OPENING_SENTENCE);
    expect(container.querySelector('iframe')).toBeNull();
    expect(fetchAddonStatus).toHaveBeenCalledWith('migration');
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
  });

  it.each([
    ['not configured', () => fetchAddonStatus.mockResolvedValue({ configured: false })],
    ['unreachable', () => fetchAddonStatus.mockResolvedValue({ ...REACHABLE, reachable: false })],
    ['a missing route', () => fetchAddonStatus.mockResolvedValue(null)],
    [
      'a failed read',
      () =>
        fetchAddonStatus.mockRejectedValue(
          new Error(
            'addons-status answered HTTP 503 from https://migration.lab.hybridcloudworks.com'
          )
        ),
    ],
  ])('shows one sentence, and never the error, for %s', async (_label, arrange) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    const { container } = renderPane();
    const unavailable = await screen.findByTestId('addon-unavailable');
    expect(unavailable).toHaveTextContent(ADDON_UNAVAILABLE_SENTENCE);
    expect(within(unavailable).getByRole('link', { name: 'Back to home' })).toHaveAttribute(
      'href',
      staticRoutes.home
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).not.toMatch(/HTTP|503|addons-status/);
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
    expect(screen.getByTestId('addon-status')).toHaveTextContent('Unavailable');
  });
});

describe('AddOnPanePage, the pane', () => {
  beforeEach(() => {
    fetchAddonStatus.mockResolvedValue(REACHABLE);
  });

  it('loads the AddOn’s own pane, titled for the tool', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    const frame = screen.getByTitle(MIGRATION.title);
    expect(frame.tagName).toBe('IFRAME');
    // jsdom's document has no `dark` class, so the site's theme here is light.
    expect(frame.getAttribute('src')).toBe(addonFrameUrl(MIGRATION, 'light'));
    expect(frame.getAttribute('src')).toBe(
      'https://migration.lab.hybridcloudworks.com/?theme=light'
    );
    expect(screen.getByTestId('addon-status')).toHaveTextContent('Available');
  });

  it('passes the dark theme when the site is dark, and keeps the frame address when the theme changes later', async () => {
    document.documentElement.classList.add('dark');
    try {
      renderPane();
      await screen.findByTestId('addon-pane');
      const frame = screen.getByTitle(MIGRATION.title);
      expect(frame.getAttribute('src')).toBe(
        'https://migration.lab.hybridcloudworks.com/?theme=dark'
      );

      // Changing a frame's src reloads it and would drop the visitor's open report, so a toggle must not touch it.
      document.documentElement.classList.remove('dark');
      await flushEffects();
      expect(screen.getByTitle(MIGRATION.title)).toBe(frame);
      expect(frame.getAttribute('src')).toBe(
        'https://migration.lab.hybridcloudworks.com/?theme=dark'
      );
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('reads the site theme from the document and nothing else', () => {
    expect(siteTheme()).toBe('light');
    document.documentElement.classList.add('dark');
    try {
      expect(siteTheme()).toBe('dark');
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it.each(availableAddons.map((addon) => [addon.id]))(
    'frames %s from its own origin and nowhere else',
    async (id) => {
      renderPane(id);
      await screen.findByTestId('addon-pane');
      const url = new URL(document.querySelector('iframe').src);
      expect(url.origin).toBe(addonById(id).origin);
    }
  );

  it('sandboxes the frame to scripts, its own origin, forms and downloads, and nothing more', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    const sandbox = document.querySelector('iframe').getAttribute('sandbox').split(/\s+/);
    expect([...sandbox].sort()).toEqual([
      'allow-downloads',
      'allow-forms',
      'allow-same-origin',
      'allow-scripts',
    ]);
  });

  it('moves focus into the frame when it loads', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    const frame = document.querySelector('iframe');
    expect(document.activeElement).not.toBe(frame);
    fireEvent.load(frame);
    expect(document.activeElement).toBe(frame);
  });

  it('leaves focus alone when the visitor has already moved it before the frame loads', async () => {
    renderPane();
    const pane = await screen.findByTestId('addon-pane');
    const link = within(pane).getByRole('link', { name: 'Back to home' });
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.load(document.querySelector('iframe'));
    expect(document.activeElement).toBe(link);
  });

  it('grants the pane no permission the row does not name', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    const frame = document.querySelector('iframe');
    expect(frame.getAttribute('allow')).toBe('');
    expect(frame.hasAttribute('allowfullscreen')).toBe(false);
  });

  it('keeps the way back on the toolbar, and says nothing behind the site', async () => {
    renderPane();
    const pane = await screen.findByTestId('addon-pane');
    expect(within(pane).getByRole('link', { name: 'Back to home' })).toHaveAttribute(
      'href',
      staticRoutes.home
    );
    expect(visibleWords(document.body)).not.toMatch(BEHIND_THE_SITE);
  });

  it('shows no full-screen button where the browser cannot do it', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    expect(screen.queryByRole('button', { name: /full screen/i })).toBeNull();
  });

  it('says the tool is unavailable when the frame has not loaded in time, and not once it has', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container, unmount } = renderPane();
    await screen.findByTestId('addon-pane');
    // The frame can be in the DOM before its effects have run; the watchdog
    // is set in one, so let it run before moving the clock.
    await flushEffects();
    act(() => {
      vi.advanceTimersByTime(ADDON_PANE_LOAD_TIMEOUT_MS + 1);
    });
    expect(screen.getByTestId('addon-unavailable')).toHaveTextContent(ADDON_UNAVAILABLE_SENTENCE);
    expect(container.querySelector('iframe')).toBeNull();
    unmount();

    const again = renderPane();
    await screen.findByTestId('addon-pane');
    await flushEffects();
    fireEvent.load(again.container.querySelector('iframe'));
    act(() => {
      vi.advanceTimersByTime(ADDON_PANE_LOAD_TIMEOUT_MS * 2);
    });
    expect(screen.queryByTestId('addon-unavailable')).toBeNull();
    expect(again.container.querySelector('iframe')).not.toBeNull();
  });
});

describe('addonMessageState and addonMessageNavigate', () => {
  const frame = { contentWindow: { name: 'the pane' } };
  const good = {
    origin: MIGRATION.origin,
    source: frame.contentWindow,
    data: { type: 'hcw-addon', id: 'migration', state: 'working' },
  };

  it('takes the AddOn’s state from the pane’s own window on its origin, for its id', () => {
    expect(addonMessageState(good, frame, MIGRATION)).toBe('working');
    for (const state of ADDON_PANE_STATES) {
      expect(addonMessageState({ ...good, data: { ...good.data, state } }, frame, MIGRATION)).toBe(
        state
      );
    }
    expect(ADDON_PANE_STATES).toEqual(['loading', 'ready', 'working', 'unavailable']);
  });

  it.each([
    ['the site itself', { ...good, origin: 'https://hybridcloudworks.com' }],
    ['another lab name', { ...good, origin: 'https://cloud-assessment.lab.hybridcloudworks.com' }],
    [
      'a look-alike name',
      { ...good, origin: 'https://migration.lab.hybridcloudworks.com.example' },
    ],
    ['plain http', { ...good, origin: 'http://migration.lab.hybridcloudworks.com' }],
    ['a frame inside the pane', { ...good, source: { name: 'nested' } }],
    ['no source', { ...good, source: null }],
    ['another type', { ...good, data: { ...good.data, type: 'hcw-lab' } }],
    ['another id', { ...good, data: { ...good.data, id: 'cloud-assessment' } }],
    ['an unknown state', { ...good, data: { ...good.data, state: 'owned' } }],
    ['a string', { ...good, data: 'hcw-addon working' }],
    ['no data', { ...good, data: null }],
  ])('ignores %s', (_label, event) => {
    expect(addonMessageState(event, frame, MIGRATION)).toBeNull();
    expect(addonMessageNavigate(event, frame, MIGRATION)).toBeNull();
  });

  it('ignores everything while there is no frame, or no row', () => {
    expect(addonMessageState(good, null, MIGRATION)).toBeNull();
    expect(addonMessageState(good, frame, null)).toBeNull();
  });

  it('reads navigate only for an allow-listed path, and only when the row grants it', () => {
    expect(ADDON_NAVIGATION_TARGETS).toEqual([
      '/contact',
      '/tools/landing-zone',
      '/education/labs',
    ]);
    for (const target of ADDON_NAVIGATION_TARGETS) {
      const event = { ...good, data: { ...good.data, navigate: target } };
      expect(addonMessageNavigate(event, frame, MIGRATION)).toBe(target);
      expect(
        addonMessageNavigate(event, frame, { ...MIGRATION, capabilities: ['downloads'] })
      ).toBeNull();
    }
    for (const bad of [
      '/admin',
      'https://evil.example/contact',
      '/contact/../admin',
      '//evil.example',
      7,
      '',
    ]) {
      const event = { ...good, data: { ...good.data, navigate: bad } };
      expect(addonMessageNavigate(event, frame, MIGRATION)).toBeNull();
      // The state is still read: navigate is extra, not a different message.
      expect(addonMessageState(event, frame, MIGRATION)).toBe('working');
    }
  });

  it('words every state for a visitor', () => {
    for (const words of Object.values(ADDON_PANE_STATE_WORDS)) {
      expect(words).not.toMatch(BEHIND_THE_SITE);
    }
    expect(Object.keys(ADDON_PANE_STATE_WORDS).sort()).toEqual(['loading', 'ready', 'working']);
  });
});

describe('AddOnPanePage, what the AddOn says', () => {
  beforeEach(() => {
    fetchAddonStatus.mockResolvedValue(REACHABLE);
  });

  it('shows the AddOn’s state on the toolbar', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    expect(screen.getByTestId('addon-pane-state')).toHaveTextContent('');
    await addonSays('loading');
    expect(screen.getByTestId('addon-pane-state')).toHaveTextContent(
      ADDON_PANE_STATE_WORDS.loading
    );
    await addonSays('ready');
    expect(screen.getByTestId('addon-pane-state')).toHaveTextContent(ADDON_PANE_STATE_WORDS.ready);
    await addonSays('working');
    expect(screen.getByTestId('addon-pane-state')).toHaveTextContent(
      ADDON_PANE_STATE_WORDS.working
    );
  });

  it('counts a message as the frame loading, so the watchdog does not fire', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPane();
    await screen.findByTestId('addon-pane');
    await flushEffects();
    await addonSays('loading');
    act(() => {
      vi.advanceTimersByTime(ADDON_PANE_LOAD_TIMEOUT_MS * 2);
    });
    expect(screen.queryByTestId('addon-unavailable')).toBeNull();
    expect(document.querySelector('iframe')).not.toBeNull();
  });

  it('shows the unavailable section when the AddOn gives up', async () => {
    const { container } = renderPane();
    await screen.findByTestId('addon-pane');
    await addonSays('unavailable');
    expect(screen.getByTestId('addon-unavailable')).toHaveTextContent(ADDON_UNAVAILABLE_SENTENCE);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('ignores a message from anywhere but the AddOn in this pane, or for another id', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    await addonSays('unavailable', { origin: 'https://example.com' });
    await addonSays('unavailable', { source: window });
    await addonSays('unavailable', { data: { type: 'hcw-lab', state: 'unavailable' } });
    await addonSays('unavailable', {
      data: { type: ADDON_MESSAGE_TYPE, id: 'cloud-assessment', state: 'unavailable' },
    });
    expect(screen.queryByTestId('addon-unavailable')).toBeNull();
    expect(screen.getByTestId('addon-pane-state')).toHaveTextContent('');
  });

  it('navigates the site itself on an allow-listed navigate, and never on another path', async () => {
    renderPane();
    await screen.findByTestId('addon-pane');
    await addonSays('ready', {
      data: { type: ADDON_MESSAGE_TYPE, id: 'migration', state: 'ready', navigate: '/admin' },
    });
    expect(screen.getByTestId('addon-pane')).toBeInTheDocument();
    await addonSays('ready', {
      data: { type: ADDON_MESSAGE_TYPE, id: 'migration', state: 'ready', navigate: '/contact' },
    });
    expect(screen.getByText('contact page')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('AddOnPanePage, a coming row', () => {
  const comingRows = addons.filter((addon) => addon.status === 'coming');
  const rowsToTest =
    comingRows.length > 0
      ? comingRows.map((addon) => [addon.id, addon])
      : [
          [
            MIGRATION.id,
            {
              ...MIGRATION,
              status: 'coming',
              comingSince: '2026-10-10',
              comingReason:
                'This assessment is being prepared for the site and opens here once its first release is published.',
            },
          ],
        ];

  it.each(rowsToTest)(
    'renders %s as its explainer, with no frame and no status read',
    (_id, addon) => {
      const { container } = renderPane(addon.id, addon);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(addon.title);
      expect(container.textContent).toContain(addon.summary);
      const coming = screen.getByTestId('addon-coming');
      expect(coming).toHaveTextContent(addon.comingReason);
      expect(within(coming).getByRole('link', { name: 'Back to home' })).toHaveAttribute(
        'href',
        staticRoutes.home
      );
      expect(screen.getByTestId('addon-status')).toHaveTextContent('Coming soon');
      expect(container.querySelector('iframe')).toBeNull();
      expect(screen.queryByTestId('addon-opening')).toBeNull();
      expect(screen.queryByTestId('addon-unavailable')).toBeNull();
      expect(fetchAddonStatus).not.toHaveBeenCalled();
      expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
    }
  );
});

describe('AddOnPanePage routing', () => {
  it('sends an id the catalogue does not have home, and fetches nothing', () => {
    fetchAddonStatus.mockResolvedValue(REACHABLE);
    renderPane('no-such-addon');
    expect(screen.getByText('home')).toBeInTheDocument();
    expect(fetchAddonStatus).not.toHaveBeenCalled();
  });

  it('sets the canonical for the row’s own path', async () => {
    fetchAddonStatus.mockResolvedValue(REACHABLE);
    renderPane();
    await screen.findByTestId('addon-pane');
    await vi.waitFor(() =>
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
        'https://hybridcloudworks.com/tools/migration'
      )
    );
  });
});
