/**
 * The toast store holds three (AP-F12, #936), newest first, and each toast
 * expires on its own clock rather than on the clock of whichever arrived
 * last.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { TOAST_LIMIT, toast, useToast } from './use-toast';

const fired = [];
const fire = (props) => {
  const handle = toast(props);
  fired.push(handle);
  return handle;
};

afterEach(() => {
  act(() => {
    fired.splice(0).forEach((handle) => handle.dismiss());
  });
  vi.useRealTimers();
});

describe('useToast', () => {
  it('holds three, newest first, and the oldest leaves when a fourth arrives', () => {
    expect(TOAST_LIMIT).toBe(3);
    const { result } = renderHook(() => useToast());
    act(() => {
      fire({ title: 'one' });
      fire({ title: 'two' });
      fire({ title: 'three' });
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['three', 'two', 'one']);
    act(() => {
      fire({ title: 'four' });
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['four', 'three', 'two']);
  });

  it('expires each toast on its own clock', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    act(() => {
      fire({ title: 'first' });
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      fire({ title: 'second' });
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['second', 'first']);

    // 5 s after the first: it goes, and the second — 3 s old — stays. Before
    // this the second's arrival restarted the first's clock.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['second']);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.toasts).toEqual([]);
  });

  it('a toast with an infinite duration stays until dismissed', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'sticky', duration: Infinity });
    });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['sticky']);
    act(() => {
      handle.dismiss();
    });
    expect(result.current.toasts).toEqual([]);
  });
});
