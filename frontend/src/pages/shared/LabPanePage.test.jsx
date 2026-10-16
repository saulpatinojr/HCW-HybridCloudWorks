/**
 * `/education/labs/:labId` (#751): the pane opens only when the status read
 * says the workspaces are reachable; it asks for GitHub sign-in in a new tab
 * first, and opens (and later reloads) when another tab finishes it; the
 * frame loads the lab launcher for the lab with exactly the sandbox and
 * `allow` lists the page states; the page hears the launcher's state and
 * nothing else; full screen is the pane itself; and every way the
 * workspaces can be missing reads as one sentence, never an error.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODER_ORIGIN, coderSignInUrl, labById, labs } from '@/data/labs/catalogue';
import { SIGNED_IN_KEY, SIGN_IN_PENDING_KEY, markSignedIn } from '@/components/labs/labSignIn';

const fetchCoderStatus = vi.fn();
vi.mock('@/lib/publicApi', () => ({
  fetchCoderStatus: () => fetchCoderStatus(),
}));

import LabPanePage, {
  OPENING_SENTENCE,
  PANE_LOAD_TIMEOUT_MS,
  PANE_MESSAGE_TYPE,
  PANE_STATES,
  PANE_STATE_WORDS,
  SIGN_IN_HEADING,
  SIGN_IN_PENDING_SENTENCE,
  UNAVAILABLE_SENTENCE,
  paneMessageState,
  workspaceService,
} from './LabPanePage';

const LAB = labById('terraform-validate-walkthrough');
const REACHABLE = {
  configured: true,
  reachable: true,
  templates: [{ name: 'hcw-lab', activeVersion: 'v0.3.1' }],
  capacity: { running: 1, max: 5 },
  asOf: '2026-09-28T11:59:40.000Z',
};

/** Backend words a visitor must not read on this page, in any state. */
const BEHIND_THE_SITE = /\bcoder\b|oauth|code-server|\bvps\b|callback|caddy|hostinger|\bapi\b/i;

function renderPane(labId = LAB.id, provider = null) {
  const path = provider ? `/${provider}/education/labs/${labId}` : `/education/labs/${labId}`;
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/education/labs/:labId" element={<LabPanePage />} />
          <Route path="/education/labs" element={<p>labs index</p>} />
          <Route path="/:provider/education/labs/:labId" element={<LabPanePage />} />
          <Route path="/:provider/education/labs" element={<p>provider labs</p>} />
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

/**
 * Another tab of the site recording a completed sign-in, as the browser
 * delivers it here: a `storage` event with the key and value the listener
 * reads. Built on Event rather than `new StorageEvent(type, init)`, which
 * CodeQL's DOM model takes for a one-argument constructor (#758).
 */
function anotherTabSignsIn(at) {
  window.localStorage.setItem(SIGNED_IN_KEY, String(at));
  const event = Object.assign(new Event('storage'), {
    key: SIGNED_IN_KEY,
    newValue: String(at),
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

/** Let React run the effects of a commit that arrived outside `act` (the status read resolving). */
async function flushEffects() {
  await act(async () => {});
}

/**
 * A `message` event as the browser delivers one to this page. Built on Event
 * for the same reason as `anotherTabSignsIn`: the fields the listener reads
 * are set directly.
 */
function messageFrom({ origin = CODER_ORIGIN, source, data }) {
  return Object.assign(new Event('message'), { origin, source, data });
}

/**
 * The launcher in the pane posting its state, as it does (lab-host/coder/launcher/main.js).
 *
 * Effects are flushed first. The page attaches its message listener in an
 * effect, and when the commit that renders the pane arrived outside act (the
 * status read resolving), that effect may not have run yet: a message sent
 * then is simply lost. That is how "shows the launcher’s state on the
 * toolbar" failed once in CI on 2026-09-29 and passed on the re-run.
 */
async function launcherSays(state, overrides = {}) {
  await flushEffects();
  const frame = document.querySelector('iframe');
  const event = messageFrom({
    source: frame.contentWindow,
    data: { type: PANE_MESSAGE_TYPE, state },
    ...overrides,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

/** jsdom would try to follow a target=_blank link; the page's own click handler is what is tested. */
const preventNavigation = (event) => {
  if (event.target.closest?.('a[target="_blank"]')) event.preventDefault();
};

beforeEach(() => {
  window.localStorage.clear();
  fetchCoderStatus.mockReset();
  window.addEventListener('click', preventNavigation);
});

afterEach(() => {
  window.removeEventListener('click', preventNavigation);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('workspaceService', () => {
  it.each([
    [{ data: null, loading: true, error: null }, 'checking'],
    [{ data: REACHABLE, loading: false, error: null }, 'available'],
    [{ data: { ...REACHABLE, reachable: false }, loading: false, error: null }, 'unavailable'],
    [{ data: { configured: false }, loading: false, error: null }, 'unavailable'],
    [{ data: null, loading: false, error: null }, 'unavailable'],
    [{ data: null, loading: false, error: new Error('x') }, 'unavailable'],
  ])('%j is %s', (query, expected) => {
    expect(workspaceService(query)).toBe(expected);
  });
});

describe('LabPanePage before the pane', () => {
  it('says it is opening while the status read is in flight, and shows no frame', () => {
    fetchCoderStatus.mockReturnValue(new Promise(() => {}));
    const { container } = renderPane();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(LAB.title);
    expect(screen.getByTestId('lab-opening')).toHaveTextContent(OPENING_SENTENCE);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it.each([
    ['not configured', () => fetchCoderStatus.mockResolvedValue({ configured: false })],
    [
      'unreachable',
      () => fetchCoderStatus.mockResolvedValue({ ...REACHABLE, reachable: false, templates: [] }),
    ],
    ['a missing route', () => fetchCoderStatus.mockResolvedValue(null)],
    [
      'a failed read',
      () =>
        fetchCoderStatus.mockRejectedValue(
          new Error('coder-status answered HTTP 503 from https://coder.lab.hybridcloudworks.com')
        ),
    ],
  ])('shows one sentence, and never the error, for %s', async (_label, arrange) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    markSignedIn();
    const { container } = renderPane();
    const unavailable = await screen.findByTestId('lab-unavailable');
    expect(unavailable).toHaveTextContent(UNAVAILABLE_SENTENCE);
    expect(within(unavailable).getByRole('link', { name: 'Back to labs' })).toHaveAttribute(
      'href',
      '/education/labs'
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).not.toMatch(/HTTP|503|coder-status/);
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
  });
});

describe('LabPanePage sign-in', () => {
  beforeEach(() => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
  });

  it('asks for GitHub sign-in in a new tab before showing the pane', async () => {
    const { container } = renderPane();
    const step = await screen.findByTestId('lab-sign-in');
    expect(within(step).getByRole('heading', { level: 2 })).toHaveTextContent(SIGN_IN_HEADING);
    const link = within(step).getByTestId('lab-sign-in-link');
    expect(link).toHaveAccessibleName('Sign in with GitHub (opens in a new tab)');
    expect(link).toHaveAttribute('href', coderSignInUrl());
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel').split(' ').sort()).toEqual(['noopener', 'noreferrer']);
    expect(container.querySelector('iframe')).toBeNull();
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
  });

  it('displays pre-flight trust pills and privacy disclosure in the sign-in step (#Audit P2-2)', async () => {
    renderPane();
    const trustPills = await screen.findByTestId('lab-preflight-trust');
    expect(trustPills).toHaveTextContent('15-Min Scenarios');
    expect(trustPills).toHaveTextContent('Browser Terminal');
    expect(trustPills).toHaveTextContent('Zero Cloud Account Required');

    const privacy = screen.getByTestId('lab-privacy-assurance');
    expect(privacy).toHaveTextContent('Privacy & Security Disclosure');
    expect(privacy).toHaveTextContent('read:user scope');

    const guarantees = screen.getByTestId('lab-trust-guarantees');
    expect(guarantees).toHaveTextContent('15-Min Scenarios');
    expect(guarantees).toHaveTextContent('No repository write access');
  });

  it('records which lab the sign-in started from, and says to finish it in the new tab', async () => {
    renderPane();
    fireEvent.click(await screen.findByTestId('lab-sign-in-link'));
    expect(JSON.parse(window.localStorage.getItem(SIGN_IN_PENDING_KEY))).toMatchObject({
      labId: LAB.id,
    });
    expect(screen.getByText(SIGN_IN_PENDING_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByTitle(/lab workspace/i)).toBeNull();
  });

  it('opens the pane when another tab finishes sign-in, and reloads it on the next one', async () => {
    const { container } = renderPane();
    fireEvent.click(await screen.findByTestId('lab-sign-in-link'));

    anotherTabSignsIn(Date.now() - 5000);
    const first = container.querySelector('iframe');
    expect(first).not.toBeNull();
    expect(screen.queryByTestId('lab-sign-in')).toBeNull();

    // A session that expired is signed in again from the toolbar; the frame
    // that comes back is a new one, which is the reload.
    anotherTabSignsIn(Date.now());
    const second = container.querySelector('iframe');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it('opens the pane at once for a visitor who is already signed in', async () => {
    const { container } = renderPane();
    fireEvent.click(await screen.findByRole('button', { name: /already signed in/i }));
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(Number(window.localStorage.getItem(SIGNED_IN_KEY))).toBeGreaterThan(0);
  });
});

describe('LabPanePage, the pane', () => {
  beforeEach(() => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
    markSignedIn();
  });

  it('loads the lab launcher for the lab, titled for the lab', async () => {
    renderPane();
    await screen.findByTestId('lab-pane');
    const frame = screen.getByTitle(`Lab workspace: ${LAB.title}`);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe(
      'https://coder.lab.hybridcloudworks.com/_hcw/lab/?lab=terraform-validate-walkthrough'
    );
  });

  it.each(labs.map((lab) => [lab.id]))('tells the launcher %s, and nothing else', async (id) => {
    renderPane(id);
    await screen.findByTestId('lab-pane');
    const url = new URL(document.querySelector('iframe').src);
    expect(url.origin).toBe(CODER_ORIGIN);
    expect(url.pathname).toBe('/_hcw/lab/');
    expect([...url.searchParams]).toEqual([['lab', id]]);
  });

  it('sandboxes the frame to scripts, its own origin, forms and popups, and nothing more', async () => {
    renderPane();
    await screen.findByTestId('lab-pane');
    const sandbox = document.querySelector('iframe').getAttribute('sandbox').split(/\s+/);
    expect([...sandbox].sort()).toEqual([
      'allow-forms',
      'allow-popups',
      'allow-same-origin',
      'allow-scripts',
    ]);
  });

  it('delegates clipboard read, clipboard write and fullscreen on the frame so workspace subdomains receive the document Permissions-Policy grant', async () => {
    renderPane();
    await screen.findByTestId('lab-pane');
    const allow = document.querySelector('iframe').getAttribute('allow');
    const features = Object.fromEntries(
      allow.split(';').map((entry) => {
        const [feature, ...origins] = entry.trim().split(/\s+/);
        return [feature, origins];
      })
    );
    expect(Object.keys(features).sort()).toEqual([
      'clipboard-read',
      'clipboard-write',
      'fullscreen',
    ]);
    for (const origins of Object.values(features)) {
      expect(origins).toEqual(['*']);
    }
    expect(document.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(false);
  });

  it('keeps sign-in and the way back on the toolbar', async () => {
    renderPane();
    const pane = await screen.findByTestId('lab-pane');
    const signIn = within(pane).getByRole('link', { name: /sign in with github/i });
    expect(signIn).toHaveAttribute('href', coderSignInUrl());
    expect(signIn).toHaveAttribute('target', '_blank');
    expect(within(pane).getByRole('link', { name: 'Back to labs' })).toHaveAttribute(
      'href',
      '/education/labs'
    );
    expect(visibleWords(document.body)).not.toMatch(BEHIND_THE_SITE);
  });

  it('shows no full-screen button where the browser cannot do it', async () => {
    renderPane();
    await screen.findByTestId('lab-pane');
    expect(screen.queryByRole('button', { name: /full screen/i })).toBeNull();
  });

  describe('full screen', () => {
    let requestFullscreen;
    let exitFullscreen;
    beforeEach(() => {
      requestFullscreen = vi.fn(() => Promise.resolve());
      exitFullscreen = vi.fn(() => Promise.resolve());
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        writable: true,
        value: null,
      });
      Object.defineProperty(document, 'exitFullscreen', {
        configurable: true,
        value: exitFullscreen,
      });
      Element.prototype.requestFullscreen = requestFullscreen;
    });
    afterEach(() => {
      delete document.fullscreenEnabled;
      delete document.fullscreenElement;
      delete document.exitFullscreen;
      delete Element.prototype.requestFullscreen;
    });

    it('makes the pane itself full screen, and never opens a window', async () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      renderPane();
      const pane = await screen.findByTestId('lab-pane');
      fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }));
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(requestFullscreen.mock.contexts[0]).toBe(pane);
      expect(open).not.toHaveBeenCalled();

      document.fullscreenElement = pane;
      act(() => {
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      // Awaited: the pane reads full screen through useSyncExternalStore, and
      // under the full suite's load the re-render that relabels the button
      // can land after a synchronous query (#997).
      fireEvent.click(await screen.findByRole('button', { name: 'Exit full screen' }));
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
    });
  });

  it('says the workspaces are unavailable when the frame has not loaded in time, and not once it has', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { container, unmount } = renderPane();
    await screen.findByTestId('lab-pane');
    // The frame can be in the DOM before its effects have run; the watchdog
    // is set in one, so let it run before moving the clock.
    await flushEffects();
    act(() => {
      vi.advanceTimersByTime(PANE_LOAD_TIMEOUT_MS + 1);
    });
    expect(screen.getByTestId('lab-unavailable')).toHaveTextContent(UNAVAILABLE_SENTENCE);
    expect(container.querySelector('iframe')).toBeNull();
    unmount();

    const again = renderPane();
    await screen.findByTestId('lab-pane');
    await flushEffects();
    fireEvent.load(again.container.querySelector('iframe'));
    act(() => {
      vi.advanceTimersByTime(PANE_LOAD_TIMEOUT_MS * 2);
    });
    expect(screen.queryByTestId('lab-unavailable')).toBeNull();
    expect(again.container.querySelector('iframe')).not.toBeNull();
  });
});

describe('paneMessageState', () => {
  const frame = { contentWindow: { name: 'the pane' } };
  const good = {
    origin: CODER_ORIGIN,
    source: frame.contentWindow,
    data: { type: 'hcw-lab', state: 'starting' },
  };

  it('takes the launcher’s state from the pane’s own window on Coder’s origin', () => {
    expect(paneMessageState(good, frame)).toBe('starting');
    for (const state of PANE_STATES) {
      expect(paneMessageState({ ...good, data: { type: 'hcw-lab', state } }, frame)).toBe(state);
    }
  });

  it.each([
    ['the site itself', { ...good, origin: 'https://hybridcloudworks.com' }],
    [
      'a workspace app’s own name',
      { ...good, origin: 'https://code-server--lab-tfv--someone.coder.lab.hybridcloudworks.com' },
    ],
    ['a look-alike name', { ...good, origin: 'https://coder.lab.hybridcloudworks.com.example' }],
    ['plain http', { ...good, origin: 'http://coder.lab.hybridcloudworks.com' }],
    ['a frame inside the pane', { ...good, source: { name: 'nested' } }],
    ['no source', { ...good, source: null }],
    ['another type', { ...good, data: { type: 'other', state: 'starting' } }],
    ['an unknown state', { ...good, data: { type: 'hcw-lab', state: 'owned' } }],
    ['a string', { ...good, data: 'hcw-lab starting' }],
    ['no data', { ...good, data: null }],
  ])('ignores %s', (_label, event) => {
    expect(paneMessageState(event, frame)).toBeNull();
  });

  it('ignores everything while there is no frame', () => {
    expect(paneMessageState(good, null)).toBeNull();
  });

  it('knows exactly the states the launcher reports', () => {
    const launcher = readFileSync(
      join(process.cwd(), '..', 'lab-host/coder/launcher/launcher.js'),
      'utf8'
    );
    const block = launcher.match(/export const STATES = Object\.freeze\(\[([^\]]*)\]\);/);
    expect(block, 'lab-host/coder/launcher/launcher.js no longer declares STATES').not.toBeNull();
    const states = [...block[1].matchAll(/'([a-z-]+)'/g)].map(([, state]) => state);
    expect([...PANE_STATES].sort()).toEqual([...states].sort());
    expect(launcher).toContain(`export const MESSAGE_TYPE = '${PANE_MESSAGE_TYPE}';`);
  });

  it('words every state for a visitor', () => {
    for (const words of Object.values(PANE_STATE_WORDS)) {
      expect(words).not.toMatch(BEHIND_THE_SITE);
    }
  });
});

describe('LabPanePage, what the launcher says', () => {
  beforeEach(() => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
    markSignedIn();
  });

  it('shows the launcher’s state on the toolbar', async () => {
    renderPane();
    await screen.findByTestId('lab-pane');
    expect(screen.getByTestId('lab-pane-state')).toHaveTextContent('');
    await launcherSays('create');
    expect(screen.getByTestId('lab-pane-state')).toHaveTextContent(PANE_STATE_WORDS.create);
    await launcherSays('starting');
    expect(screen.getByTestId('lab-pane-state')).toHaveTextContent(PANE_STATE_WORDS.starting);
  });

  it('counts a message as the frame loading, so the watchdog does not fire', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPane();
    await screen.findByTestId('lab-pane');
    await flushEffects();
    await launcherSays('checking');
    act(() => {
      vi.advanceTimersByTime(PANE_LOAD_TIMEOUT_MS * 2);
    });
    expect(screen.queryByTestId('lab-unavailable')).toBeNull();
    expect(document.querySelector('iframe')).not.toBeNull();
  });

  it('makes Sign in with GitHub the toolbar’s main action when the launcher finds no session', async () => {
    renderPane();
    const pane = await screen.findByTestId('lab-pane');
    const signIn = within(pane).getByTestId('lab-pane-sign-in');
    expect(signIn.className).not.toContain('bg-primary');
    await launcherSays('signed-out');
    expect(signIn.className).toContain('bg-primary');
    expect(screen.getByTestId('lab-pane-state')).toHaveTextContent(PANE_STATE_WORDS['signed-out']);
  });

  it('shows the unavailable section when the launcher gives up', async () => {
    const { container } = renderPane();
    await screen.findByTestId('lab-pane');
    await launcherSays('unavailable');
    expect(screen.getByTestId('lab-unavailable')).toHaveTextContent(UNAVAILABLE_SENTENCE);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('ignores a message from anywhere but the launcher in this pane', async () => {
    renderPane();
    await screen.findByTestId('lab-pane');
    await launcherSays('unavailable', { origin: 'https://example.com' });
    await launcherSays('unavailable', { source: window });
    await launcherSays('unavailable', { data: { type: 'other', state: 'unavailable' } });
    expect(screen.queryByTestId('lab-unavailable')).toBeNull();
    expect(screen.getByTestId('lab-pane-state')).toHaveTextContent('');
  });
});

describe('LabPanePage routing', () => {
  it('sends an id the catalogue does not have back to the labs page', () => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
    renderPane('no-such-lab');
    expect(screen.getByText('labs index')).toBeInTheDocument();
    expect(fetchCoderStatus).not.toHaveBeenCalled();
  });

  it('sends an unknown id under a provider back to that provider’s list (ADR 0033)', () => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
    renderPane('no-such-lab', 'terraform');
    expect(screen.getByText('provider labs')).toBeInTheDocument();
  });

  it('goes back to the provider’s list from a page reached under a provider', async () => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
    markSignedIn();
    renderPane(LAB.id, 'terraform');
    const pane = await screen.findByTestId('lab-pane');
    expect(within(pane).getByRole('link', { name: 'Back to labs' })).toHaveAttribute(
      'href',
      '/terraform/education/labs'
    );
    expect(screen.getByRole('link', { name: 'Terraform Learn' })).toHaveAttribute(
      'href',
      '/terraform/education'
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '').toMatch(
      /\/terraform\/education\/labs\/terraform-validate-walkthrough$|^$/
    );
  });
});

describe('LabPanePage, the lab itself (ADR 0033 §4)', () => {
  beforeEach(() => {
    fetchCoderStatus.mockResolvedValue(REACHABLE);
  });

  it('shows the objectives, prerequisites, steps, resources and facts whatever the pane is doing', async () => {
    const { container } = renderPane();
    await screen.findByTestId('lab-sign-in');

    expect(within(screen.getByTestId('lab-objectives')).getAllByRole('listitem')).toHaveLength(
      LAB.objectives.length
    );
    expect(within(screen.getByTestId('lab-prerequisites')).getAllByRole('listitem')).toHaveLength(
      LAB.prerequisites.length
    );
    const steps = screen.getAllByTestId('lab-step');
    expect(steps).toHaveLength(LAB.steps.length);
    LAB.steps.forEach((entry, index) => {
      expect(within(steps[index]).getByRole('heading', { level: 3 })).toHaveTextContent(
        entry.title
      );
    });
    // The one step a runner job can check carries the hint and the job type.
    const checks = screen.getAllByTestId('lab-step-validation');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toHaveTextContent(LAB.validation.jobType);
    expect(checks[0]).toHaveTextContent(LAB.steps.at(-1).validation.hint);
    // Fenced commands render as code blocks.
    expect(container.querySelectorAll('[data-testid="lab-steps"] pre code').length).toBeGreaterThan(
      0
    );
    expect(within(screen.getByTestId('lab-resources')).getAllByRole('link')).toHaveLength(
      LAB.resources.length
    );
    expect(screen.getByTestId('lab-difficulty')).toHaveTextContent('Introductory');
    expect(screen.getByTestId('lab-minutes')).toHaveTextContent('about 20 minutes');
    expect(screen.getByTestId('how-labs-work')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-status')).toBeInTheDocument();
    // Stop and reset are the workspace's own; the page says where.
    expect(screen.getByRole('heading', { name: 'Your workspace' })).toBeInTheDocument();
    expect(container.textContent).toMatch(/Stop keeps your files/);
    // One running workspace per learner, and sign-ins kept in memory (#954).
    expect(container.textContent).toMatch(/Only one of your workspaces runs at a time/);
    expect(container.textContent).toMatch(
      /A cloud sign-in made in a workspace lasts until the\s+workspace stops/
    );
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
  });

  it('lists the articles for a lab that has them, and no heading for one that has none', async () => {
    renderPane('landing-zone-builder-output');
    await screen.findByTestId('lab-sign-in');
    expect(within(screen.getByTestId('lab-articles')).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Build a landing zone you can read' })).toHaveAttribute(
      'href',
      '/azure/blog/build-a-landing-zone-you-can-read'
    );
  });

  it('shows no article heading for a lab without articles', async () => {
    renderPane('ansible-syntax-check-walkthrough');
    await screen.findByTestId('lab-sign-in');
    expect(screen.queryByTestId('lab-articles')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Articles for this lab' })).toBeNull();
  });

  it('reads the workspace state as one word from the status read', async () => {
    markSignedIn();
    renderPane();
    await screen.findByTestId('lab-pane');
    await waitFor(() =>
      expect(screen.getByTestId('workspace-status')).toHaveAttribute('data-status', 'healthy')
    );
  });

  it('reads degraded when the workspaces answer but their detail does not', async () => {
    fetchCoderStatus.mockResolvedValue({
      ...REACHABLE,
      templates: [],
      capacity: { running: null, max: 5 },
    });
    markSignedIn();
    renderPane();
    await screen.findByTestId('lab-pane');
    await waitFor(() =>
      expect(screen.getByTestId('workspace-status')).toHaveAttribute('data-status', 'degraded')
    );
  });

  it('frames the WSL2 Container walkthrough (#1082) with MiniLandingFrame and clean visitor copy', async () => {
    const { container } = renderPane('wsl-containers-walkthrough', 'azure');
    await screen.findByTestId('lab-sign-in');
    expect(screen.getByTestId('mini-landing-frame')).toBeInTheDocument();
    expect(screen.queryByTestId('defender-wsl-simulator')).toBeNull();
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
  });

  it('frames the Defender for Endpoint WSL2 walkthrough (#1083) with MiniLandingFrame and the interactive simulator', async () => {
    const { container } = renderPane('defender-wsl-plugin-walkthrough', 'azure');
    await screen.findByTestId('lab-sign-in');
    expect(screen.getByTestId('mini-landing-frame')).toBeInTheDocument();
    const sim = screen.getByTestId('defender-wsl-simulator');
    expect(sim).toHaveTextContent('1.0.2604.1');

    fireEvent.click(screen.getByTestId('defender-sim-tab-inventory'));
    expect(screen.getByTestId('defender-device-LAB-HOST-wslc')).toHaveTextContent('WSL2');

    fireEvent.click(screen.getByTestId('defender-sim-tab-edr-test'));
    fireEvent.click(screen.getByTestId('trigger-edr-test-btn'));
    expect(screen.getByTestId('edr-alert-banner')).toHaveTextContent(
      'Linux EDR DIY Test Alert (MDE WSL2 Plug-in)'
    );

    fireEvent.click(screen.getByTestId('defender-sim-tab-hunting'));
    fireEvent.click(screen.getByTestId('kql-preset-host-join'));
    expect(screen.getByTestId('kql-query-display')).toHaveTextContent('HostDeviceId');
    expect(visibleWords(container)).not.toMatch(BEHIND_THE_SITE);
  });
});
