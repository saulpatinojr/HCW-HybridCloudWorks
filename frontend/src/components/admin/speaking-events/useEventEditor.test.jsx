/**
 * The override editor's writes (#573, ADR 0033 Spotlight slice): a double
 * click saves once and deletes once, a delete asks first and a cancelled
 * confirmation sends nothing, unsaved edits are guarded before a close or a
 * new open, the stored overrides are re-read after each write, and a failure
 * is reported without closing the form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import useEventEditor from './useEventEditor';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const stored = { refresh: vi.fn() };
const SESSIONIZE_EVENT = { id: 9, name: 'Nine', date: '2026-10-01', _storedDoc: null };

beforeEach(() => {
  postJSON.mockReset().mockResolvedValue({ ok: true });
  stored.refresh.mockReset().mockResolvedValue(true);
});

describe('useEventEditor', () => {
  it('opens a new override for a Sessionize event and saves it once on a double click', async () => {
    const pending = deferred();
    postJSON.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.openEnrich(SESSIONIZE_EVENT));
    expect(result.current.editingId).toBe('new');
    expect(result.current.form.status).toBe('accepted');

    let first;
    let second;
    act(() => {
      first = result.current.save();
      second = result.current.save();
    });
    await act(async () => {
      pending.resolve({ ok: true });
      await Promise.all([first, second]);
    });

    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith('upsertSpeakerEvent', {
      docId: 'event-9',
      merge: true,
      data: expect.objectContaining({
        eventId: 9,
        sessionizeId: 9,
        name: 'Nine',
        date: '2026-10-01',
        status: 'accepted',
      }),
    });
    expect(stored.refresh).toHaveBeenCalledTimes(1);
    expect(result.current.isOpen).toBe(false);
    expect(result.current.saving).toBeNull();
  });

  it('opens a new idea from Future Events as an Idea that is not shown on the site, and saves it as a manual entry', async () => {
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.openNewIdea());
    expect(result.current.editingId).toBe('new');
    expect(result.current.editingEvent).toBeNull();
    expect(result.current.form).toMatchObject({ status: 'idea', display: false, _manualName: '' });
    act(() =>
      result.current.setForm((f) => ({
        ...f,
        _manualName: 'Example Conf 2099',
        _manualDate: '2099-08-02',
        cfpDeadline: '2099-01-14',
      }))
    );
    await act(() => result.current.save());
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith('upsertSpeakerEvent', {
      docId: expect.stringMatching(/^event-\d+$/),
      merge: true,
      data: expect.objectContaining({
        eventName: 'Example Conf 2099',
        name: 'Example Conf 2099',
        date: '2099-08-02',
        cfpDeadline: '2099-01-14',
        status: 'idea',
        display: false,
      }),
    });
    expect(stored.refresh).toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);
  });

  it('keeps the form open and reports a failed save', async () => {
    postJSON.mockRejectedValueOnce(new Error('refused'));
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.openManual());
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.error).toBe('Save failed: refused');
    expect(result.current.isOpen).toBe(true);
    expect(stored.refresh).not.toHaveBeenCalled();
    // The guard is released: a second attempt is sent.
    await act(async () => {
      await result.current.save();
    });
    expect(postJSON).toHaveBeenCalledTimes(2);
  });

  it('asks before deleting, then deletes once however many confirms, and closes the editor on that row', async () => {
    const pending = deferred();
    postJSON.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.openEditManual({ _docId: 'manual-1', name: 'M' }));

    act(() => result.current.requestRemove('manual-1'));
    expect(result.current.pendingDelete).toBe('manual-1');
    expect(postJSON).not.toHaveBeenCalled();

    let first;
    let second;
    act(() => {
      first = result.current.confirmRemove();
    });
    expect(result.current.pendingDelete).toBeNull();
    expect(result.current.deleting).toBe('manual-1');
    act(() => {
      second = result.current.remove('manual-1');
    });
    await act(async () => {
      pending.resolve({ ok: true });
      await Promise.all([first, second]);
    });

    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith('deleteSpeakerEvent', { docId: 'manual-1' });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.deleting).toBeNull();
  });

  it('sends nothing when the delete is cancelled', async () => {
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.requestRemove('manual-1'));
    act(() => result.current.cancelConfirm());
    expect(result.current.pendingDelete).toBeNull();
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('guards unsaved edits: closing asks, cancelling keeps the form, confirming discards; a clean form closes at once', () => {
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.openManual());
    expect(result.current.dirty).toBe(false);
    act(() => result.current.requestClose());
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.openManual());
    act(() => result.current.setForm((f) => ({ ...f, _manualName: 'Typed' })));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.requestClose());
    expect(result.current.pendingDiscard).toBe(true);
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.cancelConfirm());
    expect(result.current.pendingDiscard).toBe(false);
    expect(result.current.form._manualName).toBe('Typed');
    act(() => result.current.requestClose());
    act(() => result.current.confirmDiscard());
    expect(result.current.isOpen).toBe(false);
  });

  it('opening another row while dirty asks first and then opens that row', () => {
    const { result } = renderHook(() => useEventEditor(stored));
    act(() => result.current.openManual());
    act(() => result.current.setForm((f) => ({ ...f, description: 'draft' })));
    act(() => result.current.openEnrich(SESSIONIZE_EVENT));
    // Still the manual entry: the enrich waits on the answer.
    expect(result.current.editingEvent).toBeNull();
    expect(result.current.pendingDiscard).toBe(true);
    act(() => result.current.confirmDiscard());
    expect(result.current.editingEvent?.id).toBe(9);
    expect(result.current.form.description).toBe('');
    expect(result.current.dirty).toBe(false);
  });
});
