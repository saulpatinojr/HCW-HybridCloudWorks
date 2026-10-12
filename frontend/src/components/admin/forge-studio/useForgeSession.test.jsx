/**
 * useForgeSession's wiring: the operations read the session through
 * `ctx.get()`, so that read must be current from the moment a state is on
 * screen (#1072).
 */
import React, { useEffect, useLayoutEffect } from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useForgeSession } from './useForgeSession';

const getJSON = vi.fn();
const postJSON = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/lib/jobs', () => ({ runJob: vi.fn() }));

const DOC = { id: 'c1', title: 'A draft', contentStatus: 'drafting', _etag: 'e1' };

/**
 * Loads the document, then calls `sendToReview` in the same commit that first
 * renders it: a layout effect, which runs before the browser paints and before
 * a click on the new screen can reach a handler.
 */
function SendOnFirstRender({ onSent }) {
  const session = useForgeSession({ initialContentId: 'c1' });
  const { loadDoc, sendToReview, doc } = session;
  useEffect(() => {
    loadDoc('c1');
  }, [loadDoc]);
  useLayoutEffect(() => {
    if (doc) onSent(sendToReview());
  }, [doc, onSent, sendToReview]);
  return null;
}

describe('useForgeSession', () => {
  beforeEach(() => {
    getJSON.mockReset().mockResolvedValue({ success: true, item: DOC });
    postJSON.mockReset().mockResolvedValue({ ok: true });
  });

  it('lets an operation read the state it rendered, in the same commit (#1072)', async () => {
    // Before #1072 the ref behind ctx.get() moved in a passive effect, after
    // paint. A document that arrived from a read (not a click) was on screen
    // while ctx.get() still held the session without it, and a click in that
    // gap sent nothing: the Forge Studio test that flaked under coverage.
    const sent = vi.fn();
    render(<SendOnFirstRender onSent={sent} />);

    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    await expect(sent.mock.calls[0][0]).resolves.toEqual({ ok: true });
    expect(postJSON).toHaveBeenCalledWith('cms/drafts/c1/send-to-review', { etag: 'e1' });
  });
});
