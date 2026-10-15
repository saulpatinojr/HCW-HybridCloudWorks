/**
 * One status request in flight per user (AP-F12, #936). The guard, a page's
 * useAuthReady and a capability gate each mount this hook, and each used to
 * send its own request behind its own forced token refresh. These drive the
 * real hook with a mocked transport, as AdminAuthGuard.test.jsx does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const authedFetch = vi.fn();
let currentUser = { uid: 'oid-1', email: 'owner@example.test', displayName: 'Owner' };

vi.mock('@/lib/api', () => ({
  authedFetch: (...args) => authedFetch(...args),
}));

vi.mock('@/lib/entraAuth', () => ({
  onAuthStateChanged: (callback) => {
    callback(currentUser);
    return () => {};
  },
  reauthenticateForApi: vi.fn(async () => null),
}));

import { useAdminAuth, clearAdminStatusCache } from './useAdminAuth';

/** A request the test settles by hand. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
/** A 2xx response as authedFetch resolves it: only its JSON body is read. */
const answer = (body) => ({ json: async () => body });
/** A refusal as authedFetch throws it: an Error carrying the HTTP status. */
const failure = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

beforeEach(() => {
  vi.clearAllMocks();
  clearAdminStatusCache();
  window.sessionStorage.clear();
  currentUser = { uid: 'oid-1', email: 'owner@example.test', displayName: 'Owner' };
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('useAdminAuth status requests', () => {
  it('two concurrent instances make one request and both get its answer', async () => {
    const request = deferred();
    authedFetch.mockReturnValue(request.promise);

    // The second mounts while the first's request is in flight. (It mounts
    // after the first's own auth-module import has settled: two of that
    // dynamic import at once reach vitest's mock registry unevenly under the
    // vmThreads pool, and the second instance would load real MSAL.)
    const first = renderHook(() => useAdminAuth());
    await waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(1));
    expect(authedFetch).toHaveBeenCalledWith('getCurrentAdminStatus', {
      method: 'GET',
      freshToken: false,
    });
    const second = renderHook(() => useAdminAuth());
    await waitFor(() => expect(second.result.current.isLoading).toBe(true));
    expect(authedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve(answer({ isAdmin: true, role: 'super_admin', permissions: [] }));
    });
    await waitFor(() => expect(first.result.current.isAdmin).toBe(true));
    await waitFor(() => expect(second.result.current.isAdmin).toBe(true));
    expect(authedFetch).toHaveBeenCalledTimes(1);
  });

  it('a failed request is not cached as an answer: the next instance asks again', async () => {
    authedFetch.mockRejectedValueOnce(failure(500));
    const first = renderHook(() => useAdminAuth());
    await waitFor(() => expect(first.result.current.accessState).toBe('unknown'));
    expect(first.result.current.isAdmin).toBe(false);

    authedFetch.mockResolvedValueOnce(answer({ isAdmin: true, role: 'editor', permissions: [] }));
    const second = renderHook(() => useAdminAuth());
    await waitFor(() => expect(second.result.current.isAdmin).toBe(true));
    expect(authedFetch).toHaveBeenCalledTimes(2);
  });

  it('clearAdminStatusCache drops the in-flight promise: a late answer is not put back', async () => {
    const stale = deferred();
    authedFetch.mockReturnValueOnce(stale.promise);
    const first = renderHook(() => useAdminAuth());
    await waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(1));

    clearAdminStatusCache();

    const fresh = deferred();
    authedFetch.mockReturnValueOnce(fresh.promise);
    const second = renderHook(() => useAdminAuth());
    await waitFor(() => expect(authedFetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      fresh.resolve(answer({ isAdmin: true, role: 'editor', permissions: [] }));
    });
    await waitFor(() => expect(second.result.current.isAdmin).toBe(true));
    // The dropped request settles after the fresh one, with a different
    // answer. Its own awaiter gets it; the cache does not.
    await act(async () => {
      stale.resolve(answer({ isAdmin: false, canBootstrap: false }));
    });
    await waitFor(() => expect(first.result.current.accessState).toBe('unauthorized'));

    const third = renderHook(() => useAdminAuth());
    await waitFor(() => expect(third.result.current.isAdmin).toBe(true));
    expect(authedFetch).toHaveBeenCalledTimes(2);
  });

  it('an explicit re-check asks for a fresh token; a mount does not', async () => {
    authedFetch.mockResolvedValue(answer({ isAdmin: true, role: 'editor', permissions: [] }));
    const { result } = renderHook(() => useAdminAuth());
    await waitFor(() => expect(result.current.isAdmin).toBe(true));
    expect(authedFetch).toHaveBeenLastCalledWith('getCurrentAdminStatus', {
      method: 'GET',
      freshToken: false,
    });

    await act(async () => {
      await result.current.recheck();
    });
    expect(authedFetch).toHaveBeenCalledTimes(2);
    expect(authedFetch).toHaveBeenLastCalledWith('getCurrentAdminStatus', {
      method: 'GET',
      freshToken: true,
    });
  });
});
