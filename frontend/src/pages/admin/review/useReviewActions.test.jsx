/**
 * The review page's writes report their outcome and navigate only after a
 * write that landed (ADR 0033 §1, bug 7).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ postJSON: vi.fn() }));
vi.mock('@/lib/auditLog', () => ({ logAdminAction: vi.fn(async () => {}) }));
vi.mock('@/lib/contentModel', () => ({ getPublishTargetForType: vi.fn(() => 'blog') }));

const { postJSON } = await import('@/lib/api');
const { logAdminAction } = await import('@/lib/auditLog');
const { useReviewActions } = await import('./useReviewActions.js');

function setup(overrides = {}) {
  const props = {
    blogId: 'c-1',
    transitions: { approve: vi.fn(async () => ({ to: 'approved' })), errors: {} },
    navigate: vi.fn(),
    toast: vi.fn(),
    ...overrides,
  };
  const hook = renderHook(() => useReviewActions(props));
  return { ...props, hook };
}

describe('useReviewActions', () => {
  beforeEach(() => {
    postJSON.mockReset();
    logAdminAction.mockClear();
  });

  it('saveFields writes the fields, toasts the noun and reports true', async () => {
    postJSON.mockResolvedValueOnce({ ok: true });
    const { hook, toast } = setup();
    let landed;
    await act(async () => {
      landed = await hook.result.current.saveFields({ title: 'T' }, 'Blueprint');
    });
    expect(landed).toBe(true);
    expect(postJSON).toHaveBeenCalledWith('updateContentItem', {
      contentId: 'c-1',
      updates: { title: 'T' },
    });
    expect(toast).toHaveBeenCalledWith({ title: 'Blueprint saved' });
    expect(hook.result.current.saving).toBe(false);
    expect(hook.result.current.boardError).toBeNull();
  });

  it('saveFields reports false and leaves the error on the board when the write fails', async () => {
    postJSON.mockRejectedValueOnce(new Error('403'));
    const { hook, toast } = setup();
    let landed;
    await act(async () => {
      landed = await hook.result.current.saveFields({}, 'Framework');
    });
    expect(landed).toBe(false);
    expect(hook.result.current.boardError).toBe('Save failed: 403');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Framework not saved', variant: 'destructive' })
    );
  });

  it('publishFields does not approve or navigate when the save did not land', async () => {
    postJSON.mockRejectedValueOnce(new Error('nope'));
    const { hook, transitions, navigate } = setup();
    await act(async () => {
      await hook.result.current.publishFields({}, 'framework', 'Framework');
    });
    expect(transitions.approve).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('publishFields approves and navigates to the queue for the type', async () => {
    postJSON.mockResolvedValueOnce({ ok: true });
    const { hook, transitions, navigate } = setup();
    await act(async () => {
      await hook.result.current.publishFields({}, 'architecture', 'Blueprint');
    });
    expect(transitions.approve).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ publishTarget: 'blog' })
    );
    expect(navigate).toHaveBeenCalledWith('/admin/review-queue?contentType=architecture');
  });

  it('publishFields puts the approve failure on the board and stays put', async () => {
    postJSON.mockResolvedValueOnce({ ok: true });
    const { hook, navigate } = setup({
      transitions: { approve: vi.fn(async () => null), errors: { 'c-1': 'Approve failed: 409' } },
    });
    await act(async () => {
      await hook.result.current.publishFields({}, 'framework', 'Framework');
    });
    expect(hook.result.current.boardError).toBe('Approve failed: 409');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('doFrameworkDelete deletes and navigates, leaving the audit row to the server', async () => {
    postJSON.mockResolvedValueOnce({ ok: true });
    const { hook, navigate, toast } = setup();
    await act(async () => {
      await hook.result.current.doFrameworkDelete();
    });
    // From any review status, as before: no expectedStatus is named.
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith('deleteContentItem', { contentId: 'c-1' });
    // deleteContentItem audits the delete itself (AP-F13, #937); a client
    // row beside it would record the same delete twice.
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ title: 'Framework deleted' });
    expect(navigate).toHaveBeenCalledWith('/admin/review-queue?contentType=framework');
    expect(hook.result.current.frameworkDeleteOpen).toBe(false);
  });
});
