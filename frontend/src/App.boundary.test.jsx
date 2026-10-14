/**
 * The route error boundary (AP-F7, #931): it resets when the path changes,
 * and it tells a stale chunk from a render error.
 *
 * Rendered on its own rather than through the whole App: what is under test
 * is the boundary's state, and a route tree with lazy pages would make every
 * assertion wait on chunks that have nothing to say about it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouteErrorBoundary, isChunkLoadError } from './App';

/** A route that fails to render with the given error. */
function Thrower({ error }) {
  throw error;
}

/** A route that renders. */
const Fine = () => <p>Route B renders</p>;

describe('RouteErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error; the test is about what the user sees.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers on the next navigation: throw in route A, navigate to B, B renders', () => {
    const { rerender } = render(
      <RouteErrorBoundary isAdminRoute pathname="/admin/a">
        <Thrower error={new Error('boom in A')} />
      </RouteErrorBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This page hit an error');

    rerender(
      <RouteErrorBoundary isAdminRoute pathname="/admin/b">
        <Fine />
      </RouteErrorBoundary>
    );
    expect(screen.getByText('Route B renders')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the card while the path is unchanged, so a re-render does not retry a broken page', () => {
    const { rerender } = render(
      <RouteErrorBoundary isAdminRoute pathname="/admin/a">
        <Thrower error={new Error('boom in A')} />
      </RouteErrorBoundary>
    );
    rerender(
      <RouteErrorBoundary isAdminRoute pathname="/admin/a">
        <Fine />
      </RouteErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows the error message on an admin route and the reload offer, for a runtime error', () => {
    render(
      <RouteErrorBoundary isAdminRoute pathname="/admin/a">
        <Thrower error={new TypeError('Cannot read properties of undefined (reading map)')} />
      </RouteErrorBoundary>
    );
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('This page hit an error');
    expect(card).toHaveTextContent('Cannot read properties of undefined (reading map)');
    expect(card).not.toHaveTextContent('old build chunks');
    expect(screen.getByRole('button', { name: 'Reload this page' })).toBeInTheDocument();
  });

  it('blames stale chunks only for a failed dynamic import, and offers the hard refresh', () => {
    const error = new Error(
      'Failed to fetch dynamically imported module: https://x/assets/Page-abc.js'
    );
    render(
      <RouteErrorBoundary isAdminRoute pathname="/admin/a">
        <Thrower error={error} />
      </RouteErrorBoundary>
    );
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('Page load failed');
    expect(card).toHaveTextContent('old build chunks');
    expect(screen.getByRole('button', { name: 'Hard Refresh Admin' })).toBeInTheDocument();
  });

  it('keeps a public route generic: no message, no button', () => {
    render(
      <RouteErrorBoundary isAdminRoute={false} pathname="/aws">
        <Thrower error={new Error('secret-ish component detail')} />
      </RouteErrorBoundary>
    );
    const card = screen.getByRole('alert');
    expect(card).not.toHaveTextContent('secret-ish');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('isChunkLoadError', () => {
  it('matches the wordings browsers and bundlers use for a failed import', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://x/a.js',
      'Loading chunk 12 failed.',
      'Loading CSS chunk 3 failed.',
      'Importing a module script failed.',
      'error loading dynamically imported module',
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(true);
    }
    const named = new Error('x');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('does not match an ordinary runtime error, or nothing at all', () => {
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it('does not match a runtime error that happens to mention a chunk (near misses)', () => {
    // These would have matched the first version's loose alternation and
    // sent an admin to a hard refresh that fixes nothing (review on #1170).
    for (const message of [
      'Loading chunk of report failed',
      'The chunk of the report failed to load after Loading chunk data',
      'ChunkLoadError is what the user typed into the search box',
      'Importing a module script failed to be the reason; the module threw',
    ]) {
      expect(isChunkLoadError(new Error(message)), message).toBe(false);
    }
    const named = new Error('x');
    named.name = 'NotChunkLoadError';
    expect(isChunkLoadError(named)).toBe(false);
  });
});
