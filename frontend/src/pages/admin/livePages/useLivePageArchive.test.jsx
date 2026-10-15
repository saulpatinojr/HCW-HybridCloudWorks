/**
 * Archive with Undo (AP-F13, #937). What must hold: archiving a row is the
 * `archived` transition — the status the Archive board lists — through the
 * shared hook, so the server audits it; the toast offers Undo for ten
 * seconds; Undo is the transition back to `published`, live, and the row
 * returns; a failure shows and nothing is remembered as archived; and a row
 * the API has no archive edge for is not offered one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  VALID_STATUSES,
  VALID_TRANSITIONS,
} from '../../../../../functions/src/lib/cms/content-status.js';
import { normalizeCurrentStatusForBlogOnly } from '../../../../../functions/src/lib/cms/content-update-validation.js';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({ postJSON: (...args) => postJSON(...args) }));

const toast = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({ toast: (...args) => toast(...args) }));

const {
  useLivePageArchive,
  archiveTargetId,
  archiveBlockedReason,
  ARCHIVABLE_STATUSES,
  NO_CONTENT_RECORD_REASON,
  UNDO_WINDOW_MS,
} = await import('./useLivePageArchive.jsx');
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

describe('ARCHIVABLE_STATUSES', () => {
  it('is exactly the statuses the API archives from, read from its own transition table', () => {
    // Every status the table knows, the legacy spellings the server
    // normalizes and some it does not, and the shapes a row might carry
    // instead of a status (the server reads none as `ingested`).
    const candidates = [
      ...VALID_STATUSES,
      'published_blog',
      'published_news',
      'published_both',
      'published_live',
      'approved_blog',
      'approved_news',
      'ready_to_publish',
      'Published',
      '',
    ];
    expect(candidates).toEqual(expect.arrayContaining([...ARCHIVABLE_STATUSES]));
    for (const status of candidates) {
      const serverArchives = (
        VALID_TRANSITIONS[normalizeCurrentStatusForBlogOnly(status)] || []
      ).includes('archived');
      expect(ARCHIVABLE_STATUSES.includes(status), status || '(none)').toBe(serverArchives);
    }
  });
});

describe('archiveBlockedReason', () => {
  it('offers Archive on a published or rejected live page, under every spelling the API reads', () => {
    for (const contentStatus of ARCHIVABLE_STATUSES) {
      expect(archiveBlockedReason({ ...PAGE, contentStatus }), contentStatus).toBe('');
    }
  });

  it('names the spelling, not a contradiction, for a status the badge reads as published and the API does not', () => {
    for (const contentStatus of ['Published', 'published_live']) {
      expect(archiveBlockedReason({ ...PAGE, contentStatus }), contentStatus).toBe(
        `This page’s status is written “${contentStatus}”, which Archive does not accept. Open Editor to move it on first.`
      );
    }
  });

  it('says why a live page in any other status cannot be archived', () => {
    expect(archiveBlockedReason({ ...PAGE, contentStatus: 'editing' })).toBe(
      'Only a published or rejected page can be archived; this one is Editing. Open Editor to move it on first.'
    );
    expect(archiveBlockedReason({ ...PAGE, contentStatus: 'approved' })).toMatch(
      /this one is Approved\./
    );
    // No status at all is `ingested` to the server.
    expect(archiveBlockedReason({ ...PAGE, contentStatus: undefined })).toMatch(
      /this one is Ingested\./
    );
  });

  it('judges a legacy blog row by the content behind it, which the API decides', () => {
    expect(archiveBlockedReason({ id: 'b1', __source: 'blogs', sourceContentId: 'c9' })).toBe('');
    expect(archiveBlockedReason({ id: 'b1', __source: 'blogs' })).toBe(NO_CONTENT_RECORD_REASON);
  });
});

describe('useLivePageArchive', () => {
  it('archives through the status the Archive board lists, hides the row, and offers Undo for ten seconds', async () => {
    postJSON.mockResolvedValue({ success: true, from: 'published', to: 'archived' });
    const { result } = renderHook(() => useLivePageArchive());

    expect(result.current.archiveBlockedReason(PAGE)).toBe('');
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

  it('keeps the toast and the row hidden when Undo is refused, with the failure shown and Undo offered again', async () => {
    postJSON.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('HTTP 403'));
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));
    await act(() => toast.mock.calls[0][0].action.props.onClick());

    expect(handle.dismiss).not.toHaveBeenCalled();
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: true });
    expect(result.current.archiveError).toBe('Undo failed: HTTP 403');
    const offered = handle.update.mock.calls.at(-1)[0].action;
    expect(offered.props.disabled).toBe(false);
    expect(offered.props.children).toBe('Undo');

    // The guard is released: a second try is a second request.
    postJSON.mockResolvedValueOnce({ success: true });
    await act(() => offered.props.onClick());
    expect(postJSON).toHaveBeenCalledTimes(3);
    expect(handle.dismiss).toHaveBeenCalledTimes(1);
  });

  it('sends one Undo however often it is clicked while the first is in flight, with the action disabled meanwhile', async () => {
    postJSON.mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));
    const [[{ action }]] = toast.mock.calls;

    let finish;
    postJSON.mockClear();
    postJSON.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let first;
    await act(async () => {
      first = action.props.onClick();
      action.props.onClick();
    });

    expect(postJSON).toHaveBeenCalledTimes(1);
    const pending = handle.update.mock.calls.at(-1)[0].action;
    expect(pending.props.disabled).toBe(true);
    expect(pending.props.children).toBe('Undoing…');
    await act(() => pending.props.onClick());
    expect(postJSON).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ success: true });
      await first;
    });
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(handle.dismiss).toHaveBeenCalledTimes(1);
    expect(result.current.archiveError).toBe('');
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: false });
  });

  // CodeRabbit on #1193: the button's disabled state lands only after a
  // re-render, so a second click in the same tick posted again, met
  // `archived`, and showed "Archive failed" under an archived page.
  it('sends one Archive however often it is clicked in the same tick, and shows no failure', async () => {
    let finish;
    postJSON.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { result } = renderHook(() => useLivePageArchive());
    let first;
    let second;
    await act(async () => {
      first = result.current.archiveLivePage(PAGE);
      second = result.current.archiveLivePage(PAGE);
    });
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(await second).toBeNull();

    await act(async () => {
      finish({ success: true });
      await first;
    });
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(result.current.archiveError).toBe('');
    expect(result.current.archivingId).toBe('');
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: true });
  });

  it('releases the guard when an archive is refused, so the next click is sent', async () => {
    postJSON.mockRejectedValueOnce(Object.assign(new Error('refused'), { status: 409 }));
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));
    expect(result.current.archivingId).toBe('');

    postJSON.mockResolvedValueOnce({ success: true });
    await act(() => result.current.archiveLivePage(PAGE));
    expect(postJSON).toHaveBeenCalledTimes(2);
    expect(result.current.locallyArchivedKeys).toEqual({ [KEY]: true });
  });

  it('guards each page’s Undo on its own', async () => {
    const OTHER = {
      ...PAGE,
      id: 'c2',
      Title: 'Another page',
      publishedUrl: 'https://hybridcloudworks.com/azure/blog/another',
    };
    postJSON.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useLivePageArchive());
    await act(() => result.current.archiveLivePage(PAGE));
    await act(() => result.current.archiveLivePage(OTHER));
    const [first, second] = toast.mock.calls.map(([shown]) => shown.action);

    postJSON.mockReset();
    postJSON.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      first.props.onClick();
      second.props.onClick();
    });
    expect(postJSON.mock.calls.map(([, body]) => body.contentId)).toEqual(['c1', 'c2']);
  });

  it('does nothing for a legacy page with no content record behind it', async () => {
    const { result } = renderHook(() => useLivePageArchive());
    const legacy = { id: 'b1', __source: 'blogs', Live: true };
    expect(result.current.archiveBlockedReason(legacy)).toBe(NO_CONTENT_RECORD_REASON);
    await act(() => result.current.archiveLivePage(legacy));
    expect(postJSON).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not send a live editing page the API would answer 400 for', async () => {
    // Live Pages lists every Live: true document, and `editing` has no edge
    // to `archived` (VALID_TRANSITIONS): the request would only fail.
    const { result } = renderHook(() => useLivePageArchive());
    const editing = { ...PAGE, contentStatus: 'editing' };
    expect(result.current.archiveBlockedReason(editing)).toMatch(/this one is Editing/);
    await act(() => result.current.archiveLivePage(editing));
    expect(postJSON).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.locallyArchivedKeys).toEqual({});
  });
});
