/**
 * The toast store holds three (AP-F12, #936), newest first, and each toast
 * expires on its own clock rather than on the clock of whichever arrived
 * last. The clock is the store's: an update that changes a toast's duration
 * reschedules it, and nothing has to be mounted for a toast to expire. It
 * stops while the toast is being read (pauseToast) and runs out what was left
 * once it is not (resumeToast).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { TOAST_LIMIT, pauseToast, resumeToast, toast, useToast } from './use-toast';

const fired = [];
/** Fire a toast and keep its handle, so afterEach can clear what a test left behind. */
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

  it('a timed toast updated to an infinite duration stays: its timer is cancelled', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'publishing' });
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      handle.update({ title: 'needs an answer', duration: Infinity });
    });
    // Well past the five seconds the toast was first given.
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['needs an answer']);
  });

  it('a changed duration counts from the update; an unchanged one keeps the clock', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let longer;
    let same;
    act(() => {
      longer = fire({ title: 'longer' });
      same = fire({ title: 'same' });
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      longer.update({ duration: 10000 });
      same.update({ description: 'retitled, same duration' });
    });

    // 5 s after both were fired: the one whose duration did not change goes
    // on its first clock; the other runs to 10 s after its update.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['longer']);
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(result.current.toasts.map((t) => t.title)).toEqual(['longer']);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toEqual([]);
  });

  it('a toast expires on its own clock with nothing mounted to show it', () => {
    vi.useFakeTimers();
    act(() => {
      fire({ title: 'fired with no toaster' });
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Mounted after the toast's lifetime: nothing left to show, and no
    // fresh clock started for an old outcome.
    const { result } = renderHook(() => useToast());
    expect(result.current.toasts).toEqual([]);
  });
});

describe('pauseToast and resumeToast', () => {
  /** Advance the fake clock inside act, so the hook sees each removal. */
  const advance = (ms) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  /** The titles the hook currently holds. */
  const titles = (result) => result.current.toasts.map((t) => t.title);

  it('a paused toast outlives its lifetime, and goes only after resume plus what it had left', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'Undo' });
    });
    advance(2000);
    pauseToast(handle.id);
    // Hovered for a minute: the five seconds pass and it stays.
    advance(60000);
    expect(titles(result)).toEqual(['Undo']);

    resumeToast(handle.id);
    advance(2999);
    expect(titles(result)).toEqual(['Undo']);
    advance(1);
    expect(result.current.toasts).toEqual([]);
  });

  it('a second pause takes nothing more off what is left', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'paused twice' });
    });
    advance(1000);
    pauseToast(handle.id);
    advance(1000);
    pauseToast(handle.id);
    resumeToast(handle.id);
    advance(3999);
    expect(titles(result)).toEqual(['paused twice']);
    advance(1);
    expect(result.current.toasts).toEqual([]);
  });

  it('resume on a toast that is not paused does not restart its clock', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'running' });
    });
    advance(3000);
    resumeToast(handle.id);
    advance(2000);
    expect(result.current.toasts).toEqual([]);
  });

  it('pause and resume on an unknown id, or on an Infinity toast, do nothing', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let sticky;
    act(() => {
      fire({ title: 'timed' });
      sticky = fire({ title: 'sticky', duration: Infinity });
    });
    expect(() => {
      pauseToast('no-such-toast');
      resumeToast('no-such-toast');
      pauseToast(undefined);
      resumeToast(undefined);
      pauseToast(sticky.id);
      resumeToast(sticky.id);
    }).not.toThrow();

    // The timed toast's clock never noticed; the sticky one still waits for a hand.
    advance(5000);
    expect(titles(result)).toEqual(['sticky']);
  });

  it('an update that changes the duration while paused keeps it paused, with the new lifetime left', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'Undo' });
    });
    advance(1000);
    pauseToast(handle.id);
    act(() => {
      handle.update({ duration: 8000 });
    });
    advance(60000);
    expect(titles(result)).toEqual(['Undo']);

    resumeToast(handle.id);
    advance(7999);
    expect(titles(result)).toEqual(['Undo']);
    advance(1);
    expect(result.current.toasts).toEqual([]);
  });

  it('a paused toast dismissed by hand leaves, and a later resume finds nothing to run', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useToast());
    let handle;
    act(() => {
      handle = fire({ title: 'closed while hovered' });
    });
    pauseToast(handle.id);
    act(() => {
      handle.dismiss();
    });
    expect(result.current.toasts).toEqual([]);
    expect(() => resumeToast(handle.id)).not.toThrow();
    advance(10000);
    expect(result.current.toasts).toEqual([]);
  });
});
