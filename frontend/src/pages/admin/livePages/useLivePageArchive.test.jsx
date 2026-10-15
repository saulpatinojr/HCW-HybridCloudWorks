/**
 * Archive with Undo (AP-F13, #937). What must hold: archiving a row is the
 * `archived` transition — the status the Archive board lists — through the
 * shared hook, so the server audits it; the toast offers Undo for ten
 * seconds; Undo is the transition back to `published`, live, and the row
 * returns; a failure shows and nothing is remembered as archived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ toast: (...args) => toast(...args) }));

const { useLivePageArchive, archiveTargetId, UNDO_WINDOW_MS } =
  await import('./useLivePageArchive.jsx');
const { ARCHIVED_STATUS } = await import('@/pages/admin/editor-list/editorItems');

const PAGE = {
  id: 'c1',
  __source: 'content',
  Title: 'Ten things about Azure',
  type: 'blog',
  Live: true,
  contentStatus: 'published',
  publishedUrl: 'https://HybridCloudWorks.com/azure/blog/ten-things',
};
const KEY = 'https://hybridcloudworks.com/azure/blog/ten-things';

let handle;

beforeEach(() => {
  postJSON.mockReset();
  toast.mockReset();
  handle = { id: 't1', dismiss: vi.fn(), update: vi.fn() };
  toast.mockReturnValue(handle);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('archiveTargetId', () => {
  it('is the row itself for a content record, the content behind a legacy blog, or nothing', () => {
    expect(archiveTargetId(PAGE)).toBe('c1');
    expect(archiveTargetId({ id: 'b1', __source: 'blogs', sourceContentId: 'c9' })).toBe('c9');
    expect(archiveTargetId({ id: 'b1', __source: 'blogs', publishedContentId: 'c8' })).toBe('c8');
    expect(archiveTargetId({ id: 'b1', __source: 'blogs' })).toBe('');
  });
});

describe('useLivePageArchive', () => {
  it('archives through the status the Archive board lists, hides the row, and offers Undo for ten seconds', async () => {
    postJSON.mockResolvedValue({ success: true, from: 'published', to: 'archived' });
    const { result } = renderHook(() => useLivePageArchive());

    expect(result.current.canArchive(PAGE)).toBe(true);
    await act(() => result.current.archiveLivePage(PAGE));

    expect(ARCHIVED_STATUS).toBe('archived');
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith(
      'transitionContentStatus',
      expect.objectContaining({
        contentId: 'c1',
        newStatus: ARCHIVED_STATUS,
        markLive: false,
        reviewNotes: 'Archived from Live Pages',
      })
    );
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: true });
    expect(result.current.archivingId).toBe('');
    expect(result.current.archiveError).toBe('');

    expect(toast).toHaveBeenCalledTimes(1);
    const [[shown]] = toast.mock.calls;
    expect(shown.title).toBe('Archived');
    expect(shown.description).toContain('Ten things about Azure');
    expect(shown.duration).toBe(UNDO_WINDOW_MS);
    expect(UNDO_WINDOW_MS).toBe(10_000);
    expect(shown.action.props.children).toBe('Undo');
  });

  it('Undo is the transition back to published, live, and the row returns', async () => {
    postJSON.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));
    const [[{ action }]] = toast.mock.calls;

    postJSON.mockClear();
    await act(() => action.props.onClick());

    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith(
      'transitionContentStatus',
      expect.objectContaining({ contentId: 'c1', newStatus: 'published', markLive: true })
    );
    expect(handle.dismiss).toHaveBeenCalledTimes(1);
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: false });
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[1][0].title).toBe('Back on the site');
  });

  it('keeps the row and reports the failure when the archive is refused', async () => {
    postJSON.mockRejectedValue(new Error('HTTP 403'));
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));

    expect(result.current.archiveError).toBe('Archive failed: HTTP 403');
    expect(result.current.locallyArchivedKeys).toEqual({});
    expect(toast).not.toHaveBeenCalled();
  });

  it('keeps the toast and the row hidden when Undo is refused, with the failure shown', async () => {
    postJSON.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('HTTP 403'));
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));
    await act(() => toast.mock.calls[0][0].action.props.onClick());

    expect(handle.dismiss).not.toHaveBeenCalled();
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: true });
    expect(result.current.archiveError).toBe('Undo failed: HTTP 403');
  });

  it('does nothing for a legacy page with no content record behind it', async () => {
    const { result } = renderHook(() => useLivePageArchive());
    const legacy = { id: 'b1', __source: 'blogs', Live: true };
    expect(result.current.canArchive(legacy)).toBe(false);
    await act(() => result.current.archiveLivePage(legacy));
    expect(postJSON).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
