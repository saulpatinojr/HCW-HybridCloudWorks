/**
 * useSetting's race-safety: a double submit sends one PUT, a slow load cannot
 * land over a newer one, and a failed reload leaves nothing from the last
 * good load behind. And `saved` is what is stored, not the working copy.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';

import {
  CHANGED_ELSEWHERE,
  HISTORY_FILTERABLE,
  SETTING_LABELS,
  SettingSection,
  isStaleSave,
  settingRoute,
  useSetting,
} from './settingShared';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const loaded = (value, over = {}) => ({
  success: true,
  value,
  exists: true,
  stored: 'valid',
  ...over,
});

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
});

describe('useSetting', () => {
  it('does not load until auth is ready', async () => {
    getJSON.mockResolvedValue(loaded({ feeds: [] }));
    const { rerender, result } = renderHook(({ ready }) => useSetting('podcast-feeds', ready), {
      initialProps: { ready: false },
    });
    expect(getJSON).not.toHaveBeenCalled();
    rerender({ ready: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getJSON).toHaveBeenCalledWith(settingRoute('podcast-feeds'));
    expect(result.current.value).toEqual({ feeds: [] });
  });

  it('sends one PUT for a double submit', async () => {
    getJSON.mockResolvedValue(loaded({ feeds: [] }));
    const put = deferred();
    sendJSON.mockReturnValue(put.promise);
    const { result } = renderHook(() => useSetting('podcast-feeds', true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let first;
    let second;
    act(() => {
      first = result.current.save({ feeds: [] });
      second = result.current.save({ feeds: [] });
    });
    expect(await second).toBe(false);
    expect(sendJSON).toHaveBeenCalledTimes(1);
    await act(async () => {
      put.resolve(loaded({ feeds: [] }, { updatedAt: '2026-09-14T10:00:00.000Z' }));
      expect(await first).toBe(true);
    });
    expect(result.current.saving).toBe(false);
    expect(result.current.meta).toMatchObject({ exists: true, stored: 'valid' });
  });

  it('clears the last good value when a reload fails', async () => {
    getJSON.mockResolvedValueOnce(
      loaded({ geminiModel: 'x' }, { options: [{ id: 'x', tier: 'best' }] })
    );
    const { result } = renderHook(() => useSetting('listen-and-learn-speech', true));
    await waitFor(() => expect(result.current.value).toEqual({ geminiModel: 'x' }));
    expect(result.current.options).toHaveLength(1);

    getJSON.mockRejectedValueOnce(new Error('HTTP 500'));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.value).toBeNull();
    expect(result.current.options).toEqual([]);
    expect(result.current.meta.exists).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('ignores a slow load that a retry has superseded', async () => {
    const slow = deferred();
    getJSON
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(loaded({ heroes: { AWS: '/new.png' } }));
    const { result } = renderHook(() => useSetting('default-heroes', true));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.value).toEqual({ heroes: { AWS: '/new.png' } }));

    await act(async () => {
      slow.resolve(loaded({ heroes: { AWS: '/old.png' } }));
      await slow.promise;
    });
    expect(result.current.value).toEqual({ heroes: { AWS: '/new.png' } });
  });

  it('keeps `saved` as the stored value: edits do not move it, a save does, and nothing stored is null', async () => {
    getJSON.mockResolvedValueOnce(loaded({ Maya: 'a', Elena: 'b' }));
    const { result } = renderHook(() => useSetting('podcast-voices', true));
    await waitFor(() => expect(result.current.saved).toEqual({ Maya: 'a', Elena: 'b' }));

    act(() => result.current.setValue({ Maya: 'c', Elena: 'b' }));
    expect(result.current.value).toEqual({ Maya: 'c', Elena: 'b' });
    expect(result.current.saved).toEqual({ Maya: 'a', Elena: 'b' });

    sendJSON.mockResolvedValueOnce(loaded({ Maya: 'c', Elena: 'b' }));
    await act(async () => {
      await result.current.save({ Maya: 'c', Elena: 'b' });
    });
    expect(result.current.saved).toEqual({ Maya: 'c', Elena: 'b' });

    getJSON.mockResolvedValueOnce(loaded({ Maya: '', Elena: '' }, { exists: false, stored: null }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.value).toEqual({ Maya: '', Elena: '' }));
    expect(result.current.saved).toBeNull();
  });
});

describe('useSetting names the version it replaces (#946)', () => {
  const MINE = { feeds: [{ provider: 'azure', url: 'https://x.example/mine' }] };
  const THEIRS = { feeds: [{ provider: 'aws', url: 'https://x.example/theirs' }] };
  const route = settingRoute('podcast-feeds');
  const ifMatch = (etag) => ({ headers: { 'If-Match': etag } });

  /** A hook over podcast-feeds once its first load has landed. */
  async function loadedHook() {
    const hook = renderHook(() => useSetting('podcast-feeds', true));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  }

  it('sends the ETag it read as If-Match, then the one each save returns', async () => {
    getJSON.mockResolvedValueOnce(loaded(THEIRS, { etag: '"v1"' }));
    sendJSON
      .mockResolvedValueOnce(loaded(MINE, { etag: '"v2"' }))
      .mockResolvedValueOnce(loaded(MINE, { etag: '"v3"' }));
    const { result } = await loadedHook();

    await act(async () => {
      expect(await result.current.save(MINE)).toBe(true);
    });
    await act(async () => {
      expect(await result.current.save(MINE)).toBe(true);
    });
    expect(sendJSON.mock.calls).toEqual([
      [route, 'PUT', MINE, ifMatch('"v1"')],
      [route, 'PUT', MINE, ifMatch('"v2"')],
    ]);
  });

  it('sends no If-Match when the read offered no version: nothing stored, or the reminders sheet', async () => {
    getJSON.mockResolvedValueOnce(loaded(MINE, { exists: false, stored: null, etag: null }));
    sendJSON.mockResolvedValueOnce(loaded(MINE, { etag: '"v1"' }));
    const { result } = await loadedHook();
    await act(async () => {
      await result.current.save(MINE);
    });
    expect(sendJSON.mock.calls).toEqual([[route, 'PUT', MINE]]);
  });

  it.each([
    [412, 'CONFLICT'],
    [428, 'PRECONDITION_REQUIRED'],
  ])(
    'on a %i says the setting changed elsewhere and reloads what is stored, without saving again',
    async (status, code) => {
      getJSON
        .mockResolvedValueOnce(loaded(THEIRS, { etag: '"v1"' }))
        .mockResolvedValueOnce(loaded(MINE, { etag: '"v2"' }));
      sendJSON.mockRejectedValueOnce(
        Object.assign(new Error('refused'), { status, code, fnName: route })
      );
      const { result } = await loadedHook();

      act(() => result.current.setValue({ feeds: [] }));
      await act(async () => {
        expect(await result.current.save({ feeds: [] })).toBe(false);
      });
      expect(toast).toHaveBeenCalledWith({
        title: 'Changed elsewhere',
        description: CHANGED_ELSEWHERE,
        variant: 'destructive',
      });
      await waitFor(() => expect(result.current.value).toEqual(MINE));
      expect(result.current.saved).toEqual(MINE);
      expect(getJSON).toHaveBeenCalledTimes(2);
      expect(sendJSON).toHaveBeenCalledTimes(1);

      // The next save names the version the reload read.
      sendJSON.mockResolvedValueOnce(loaded(MINE, { etag: '"v3"' }));
      await act(async () => {
        await result.current.save(MINE);
      });
      expect(sendJSON.mock.calls[1]).toEqual([route, 'PUT', MINE, ifMatch('"v2"')]);
    }
  );

  it('any other refusal keeps the working copy and reloads nothing', async () => {
    getJSON.mockResolvedValueOnce(loaded(THEIRS, { etag: '"v1"' }));
    sendJSON.mockRejectedValueOnce(
      Object.assign(new Error('Body must be a JSON object'), { status: 400 })
    );
    const { result } = await loadedHook();
    act(() => result.current.setValue(MINE));
    await act(async () => {
      expect(await result.current.save(MINE)).toBe(false);
    });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Not saved', description: 'Body must be a JSON object' })
    );
    expect(result.current.value).toEqual(MINE);
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it('isStaleSave is true for 412, 428 and a CONFLICT code, and nothing else', () => {
    expect(isStaleSave({ status: 412 })).toBe(true);
    expect(isStaleSave({ status: 428 })).toBe(true);
    expect(isStaleSave({ code: 'CONFLICT' })).toBe(true);
    expect(isStaleSave({ status: 409 })).toBe(false);
    expect(isStaleSave({ status: 400 })).toBe(false);
    expect(isStaleSave(undefined)).toBe(false);
  });
});

describe('SETTING_LABELS and HISTORY_FILTERABLE (ADR 0033)', () => {
  it('labels every setting the history can show, and offers only server-filterable ones', () => {
    expect(SETTING_LABELS['content-taxonomy']).toBe('Content types & idea origins');
    expect(SETTING_LABELS.integrations).toMatch(/Sessionize/);
    expect(HISTORY_FILTERABLE).not.toContain('integrations');
    expect(HISTORY_FILTERABLE).toContain('content-taxonomy');
    for (const id of HISTORY_FILTERABLE) expect(SETTING_LABELS[id]).toBeTruthy();
  });
});

describe('SettingSection', () => {
  it('names the setting in a failure and offers a retry instead of the card', () => {
    const reload = vi.fn();
    const renderCard = vi.fn(() => <p>card</p>);
    render(
      <SettingSection
        setting={{ loading: false, error: 'HTTP 500', reload }}
        label="Podcast feeds"
        render={renderCard}
      />
    );
    expect(screen.getByRole('alert').textContent).toContain('Podcast feeds: HTTP 500');
    expect(renderCard).not.toHaveBeenCalled();
    screen.getByRole('button', { name: /Retry/ }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
