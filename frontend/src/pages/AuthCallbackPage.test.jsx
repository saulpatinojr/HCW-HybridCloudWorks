/**
 * The callback page's two jobs when things go wrong (#520).
 *
 * It succeeds by navigating away, so there is little to assert on the happy
 * path. The failure path is where it earns its tests: an authorization code
 * must not survive in the address bar, and MSAL's own error text must not reach
 * the screen.
 *
 * A REAL LOCATION AT A REAL URL, NOT A FABRICATED ONE (#645). This file used to
 * redefine `window.location` with a hand-built object, because the page reads
 * `pathname`, `search` and `hash` and calls `replace`. That cost two bugs — a
 * spread that silently dropped `pathname` and `search`, since jsdom puts them
 * on the prototype, and a redefinition left in place that leaked a crippled
 * `location` into every later file in the same worker — and it only worked at
 * all while `window.location` was configurable, which is true under vitest's
 * `forks` pool and false under `vmThreads`.
 *
 * So the environment provides the URL instead, through the docblock below, and
 * every read the page makes is a real `Location` parsing a real address. The
 * one thing that still cannot be observed, `location.replace`, is reached
 * through `@/lib/hardNavigate` and mocked there.
 *
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://example.test/auth/callback#code=1.AUYA-secret-authorization-code&state=abc" }
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AuthCallbackPage from './AuthCallbackPage';

const initializeAuth = vi.fn();
vi.mock('@/lib/entraAuth', () => ({ initializeAuth: (...a) => initializeAuth(...a) }));

const hardReplace = vi.fn();
vi.mock('@/lib/hardNavigate', () => ({ hardReplace: (...a) => hardReplace(...a) }));

// Captured before anything spies on it: the tests below stub `replaceState` to
// watch what the page does with it, and still need the real one to move the
// browser themselves when setting a scenario up.
const navigate = window.history.replaceState.bind(window.history);
const START = window.location.href;

let replaceState;

beforeEach(() => {
  vi.clearAllMocks();
  replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // A test that moved the browser must put it back: the files each get their own
  // jsdom, but the tests inside one file share it.
  navigate(null, '', START);
});

describe('a completed sign-in', () => {
  it('clears the fragment and sends the user to the admin portal', async () => {
    initializeAuth.mockResolvedValue(undefined);
    render(<AuthCallbackPage />);

    await waitFor(() => expect(hardReplace).toHaveBeenCalledWith('/admin'));
    expect(replaceState).toHaveBeenCalled();
  });

  // MSAL's `navigateToLoginRequestUrl` returns the user to whichever page
  // started sign-in — `/admin/queue`, say — as a client-side history
  // navigation, so this component's `.then()` still runs afterwards. Replacing
  // unconditionally would overwrite the destination they actually asked for.
  it('does not override the page MSAL already returned the user to', async () => {
    // The real thing MSAL does, rather than a description of it: a history
    // navigation, which moves `pathname` and drops the fragment together.
    initializeAuth.mockImplementation(async () => navigate(null, '', '/admin/queue'));
    render(<AuthCallbackPage />);

    await waitFor(() => expect(initializeAuth).toHaveBeenCalled());
    expect(window.location.pathname).toBe('/admin/queue');
    expect(hardReplace).not.toHaveBeenCalled();
  });
});

describe('a failed sign-in', () => {
  beforeEach(() => {
    initializeAuth.mockRejectedValue(
      new Error('endpoints_resolution_error: authority https://login.microsoftonline.com/…')
    );
  });

  // A fragment left in the address bar is re-processed on every reload, so the
  // same failure reproduces forever and reads as permanent — and it is an
  // authorization code sitting in history and in whatever the user pastes when
  // they ask what went wrong.
  it('still clears the fragment, so the failure does not reproduce on reload', async () => {
    render(<AuthCallbackPage />);

    await waitFor(() => expect(replaceState).toHaveBeenCalled());
    const [, , url] = replaceState.mock.calls.at(-1);

    // Assert what it IS, not only what it lacks: a URL of `undefinedundefined`
    // would satisfy "contains no code=" while proving nothing.
    expect(url).toBe('/auth/callback');
    expect(url).not.toContain('code=');
  });

  // MSAL's MESSAGES name the authority, the client id and the failure mode,
  // and this page is reachable by anyone with the URL, so the message stays
  // off the screen (same reasoning as the 401 descriptions in
  // require-role.js, #517). The CODE goes on screen (AP-F8, #932): a phone
  // cannot open the console, and an Entra error code is not a secret.
  it('puts the error code on the screen and keeps the message off it', async () => {
    render(<AuthCallbackPage />);

    expect(await screen.findByText(/could not be completed/i)).toBeTruthy();
    expect(screen.getByTestId('auth-error-code')).toHaveTextContent('endpoints_resolution_error');

    // Substring checks on the rendered text, not regexes. A bare host pattern
    // is unanchored by nature and CodeQL flags it as one — correctly, since the
    // same shape in non-test code would match `evil.com/login.microsoftonline.com`.
    const rendered = document.body.textContent ?? '';
    expect(rendered).not.toContain('login.microsoftonline.com');
    expect(rendered).not.toContain('authority');
  });

  it('Copy writes the code and the full message to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AuthCallbackPage />);

    fireEvent.click(await screen.findByRole('button', { name: /copy the detail/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const [[text]] = writeText.mock.calls;
    expect(text.startsWith('endpoints_resolution_error: ')).toBe(true);
    expect(text).toContain('login.microsoftonline.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied.');
  });

  it('uses the MSAL error code when the error carries one', async () => {
    const msalError = Object.assign(new Error('Interaction is currently in progress.'), {
      errorCode: 'interaction_in_progress',
      errorMessage:
        'Interaction is currently in progress. Please ensure that this interaction has been completed before calling an interactive API.',
    });
    initializeAuth.mockRejectedValue(msalError);
    render(<AuthCallbackPage />);

    expect(await screen.findByTestId('auth-error-code')).toHaveTextContent(
      'interaction_in_progress'
    );
  });

  it('logs the detail for whoever is actually debugging', async () => {
    render(<AuthCallbackPage />);

    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(console.error.mock.calls.at(-1).join(' ')).toContain('endpoints_resolution_error');
  });

  it('offers a way out rather than a dead end', async () => {
    render(<AuthCallbackPage />);

    const link = await screen.findByRole('link', { name: /admin portal/i });
    expect(link.getAttribute('href')).toBe('/admin');
  });
});
