/**
 * Fixing the key has to fix the page, without a reload.
 *
 * The profile probe is not a health check that happens to also fetch — it IS
 * the profile resolve, because every posts and analytics path on this page is
 * profile-scoped. So while it has not answered, Links and Analytics have
 * nothing to query and stay disabled.
 *
 * It was keyed on `authReady` alone, which is true exactly once. An operator
 * who arrived with a broken key, fixed it in the Connection tab and pressed
 * Test Connection therefore got a green header over a page that still could
 * not do anything — because `profiles` was still the empty array the failed
 * probe left, and only a reload would refill it. That is a worse state than
 * the honest failure it replaced: the page now claims to work.
 *
 * Caught in review on PR #429.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

import LinkiePage from './LinkiePage';
import { LINKIE_POST_IMAGE_FIELD } from '@/lib/linkie';

const postJSON = vi.fn();
const getJSON = vi.fn();
const toast = vi.fn();
/** Which tab the page renders on; the setter is a no-op, so tests set this. */
let searchParams = 'tab=connection';

vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  getJSON: (...args) => getJSON(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
// Rendered already on the tab that holds the connection test. The setter is a
// no-op here, so clicking a tab would not move `activeTab` — starting there
// tests the same thing without needing a stateful router mock.
//
// `tab=connection` is deliberately the OLD id: #577 renamed that tab to
// Settings, and every one of these tests reaching the Test Connection button
// is the redirect working. The explicit assertions are at the end of the file.
vi.mock('react-router', async () => {
  const React_ = await vi.importActual('react');
  return {
    // PageHeader reads the route to find its purpose sentence.
    useLocation: () => ({ pathname: '/admin/linkie-hub', search: '' }),
    useSearchParams: () => [new URLSearchParams(searchParams), vi.fn()],
    Link: ({ to, children }) => React_.createElement('a', { href: to }, children),
  };
});

// The Functions base is cross-origin in production, which is what makes a
// stored `/api/public/media/…` path absolute. jsdom's origin is http, so
// without this every uploaded image would be refused as not-https.
vi.mock('@/lib/functionsBase', () => ({
  resolveMediaUrl: (url) =>
    typeof url === 'string' && url.startsWith('/api/') ? `https://api.test${url}` : url,
}));
// The gallery picker's data source; the picker itself renders for real.
const loadGalleryItems = vi.fn();
vi.mock('@/lib/imageGallery', () => ({
  loadGalleryItems: (...args) => loadGalleryItems(...args),
  getSourceLabel: () => 'Uploaded',
}));

/** The proxy's envelope, which is HTTP 200 whatever the upstream said. */
const envelope = (ok, status, data) => ({ ok, status, data });

const REFUSED = envelope(false, 401, { message: 'Unauthorized' });
const ONE_PROFILE = envelope(true, 200, {
  data: { pages: [{ _id: 'p1', username: 'hcw' }] },
});

beforeEach(() => {
  searchParams = 'tab=connection';
  postJSON.mockReset();
  getJSON.mockReset();
  toast.mockReset();
  loadGalleryItems.mockReset();
  // The published-content panel; irrelevant here and must not reject.
  getJSON.mockResolvedValue({ items: [] });
});

describe('a Connection test that succeeds re-resolves the profile', () => {
  it('re-runs the probe, so a fixed key does not need a page reload', async () => {
    // First call is the mount probe and it is refused. Every later call
    // succeeds — the operator has fixed the key in between.
    postJSON.mockResolvedValueOnce(REFUSED).mockResolvedValue(ONE_PROFILE);

    render(<LinkiePage />);

    // The mount probe has run and failed.
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    const afterMount = postJSON.mock.calls.length;

    fireEvent.click(await screen.findByRole('button', { name: /Test Connection/i }));

    // The test call itself, and then the probe again — which is the fix. Two
    // more calls, not one: without the re-run this stays at afterMount + 1.
    await waitFor(() => expect(postJSON.mock.calls.length).toBeGreaterThan(afterMount + 1));
  });

  it('does not re-run the probe when the test fails', async () => {
    // Nothing was learned, so there is nothing to re-ask.
    postJSON.mockResolvedValue(REFUSED);

    render(<LinkiePage />);
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /Test Connection/i }));

    // The test call, and no probe after it.
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(2));

    // A negative assertion needs the pending work to have run, or it passes
    // while the call it forbids is still queued. This flushes React's pending
    // effects and microtasks deterministically — a wall-clock sleep would do
    // the same job by guessing, and guess wrong under CI load. Raised in
    // review on PR #429.
    await act(async () => {});
    expect(postJSON).toHaveBeenCalledTimes(2);
  });
});

describe('Push waits until it knows what is already linked', () => {
  // `posts` is [] while the fetch is in flight, so `alreadyLinked` is false
  // for every row until it settles. Leaving Push enabled through that window
  // offers a one-click duplicate on exactly the articles that are already
  // there — and "not answered yet" is not "not linked". Caught in review on
  // PR #429.
  const ARTICLE = {
    id: 'c1',
    Title: 'Landing zones',
    Live: true,
    contentStatus: 'published_live',
    slugPageUrl: 'https://hybridcloudworks.com/azure/blog/landing-zones',
  };

  it('disables Push while the linked set is still loading', async () => {
    searchParams = 'tab=links';
    getJSON.mockResolvedValue({ items: [ARTICLE] });

    // /pages resolves; the posts fetch never settles, so the page stays in
    // the loading window this test is about.
    postJSON.mockImplementation((_fn, body) => {
      if (String(body?.path || '').includes('/posts')) return new Promise(() => {});
      return Promise.resolve(ONE_PROFILE);
    });

    render(<LinkiePage />);

    const push = await screen.findByRole('button', { name: /^Push$/i });
    expect(push).toBeDisabled();
    expect(push).toHaveAttribute('title', expect.stringMatching(/Checking what is already linked/));
  });
});

describe('a post image, from the computer or the gallery (#501)', () => {
  const UPLOADED_PATH = '/api/public/media/covers/linkie/1-abc.png';

  /** /pages and the posts list answer; every other call is recorded. */
  const routeProxy = ({ uploadUrl = UPLOADED_PATH } = {}) =>
    postJSON.mockImplementation((fn, body) => {
      if (fn.startsWith('cms/uploads/')) return Promise.resolve({ success: true, url: uploadUrl });
      if (body?.method === 'POST') return Promise.resolve(envelope(true, 201, { data: [] }));
      if (String(body?.path || '').includes('/posts')) {
        return Promise.resolve(envelope(true, 200, { data: [] }));
      }
      return Promise.resolve(ONE_PROFILE);
    });

  const createCall = () =>
    postJSON.mock.calls.find(([fn, body]) => fn === 'linkieProxy' && body?.method === 'POST');

  const uploadPng = async () => {
    const file = new File(['png-bytes'], 'Cover Photo.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('linkie-post-image-file'), { target: { files: [file] } });
    return screen.findByAltText('Attached to this post');
  };

  beforeEach(() => {
    searchParams = 'tab=links';
  });

  it('uploads a chosen file to the public covers container and previews it', async () => {
    routeProxy();
    render(<LinkiePage />);
    await screen.findByText('No posts yet.');

    const preview = await uploadPng();

    expect(preview).toHaveAttribute('src', `https://api.test${UPLOADED_PATH}`);
    const upload = postJSON.mock.calls.find(([fn]) => fn.startsWith('cms/uploads/'));
    expect(upload[0]).toBe('cms/uploads/covers');
    expect(upload[1]).toMatchObject({ contentType: 'image/png' });
    expect(upload[1].path).toMatch(/^linkie\/\d+-[a-z0-9]+\.png$/);
    expect(upload[1].dataBase64).toBeTruthy();
  });

  it('refuses an SVG with a toast and no upload', async () => {
    routeProxy();
    render(<LinkiePage />);
    await screen.findByText('No posts yet.');

    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    fireEvent.change(screen.getByTestId('linkie-post-image-file'), { target: { files: [svg] } });

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    expect(postJSON.mock.calls.some(([fn]) => fn.startsWith('cms/uploads/'))).toBe(false);
  });

  it('removing the image clears the preview, and Add Post then sends no image key', async () => {
    routeProxy();
    render(<LinkiePage />);
    await screen.findByText('No posts yet.');
    await uploadPng();

    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));

    expect(screen.queryByAltText('Attached to this post')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://a.test/post' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Post/ }));
    await waitFor(() => expect(createCall()).toBeTruthy());
    expect(createCall()[1].body[0]).not.toHaveProperty(LINKIE_POST_IMAGE_FIELD);
  });

  it('Add Post sends the uploaded image under the image field', async () => {
    routeProxy();
    render(<LinkiePage />);
    await screen.findByText('No posts yet.');
    await uploadPng();

    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://a.test/post' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Post/ }));

    await waitFor(() => expect(createCall()).toBeTruthy());
    expect(createCall()[1].body).toEqual([
      expect.objectContaining({
        url: 'https://a.test/post',
        [LINKIE_POST_IMAGE_FIELD]: `https://api.test${UPLOADED_PATH}`,
      }),
    ]);
  });

  it('choosing from the gallery sets the image from the row’s public URL', async () => {
    routeProxy();
    loadGalleryItems.mockResolvedValue([
      {
        id: 'g1',
        articleId: 'a1',
        title: 'Hero shot',
        imageUrl: '/api/public/media/covers/h.webp',
      },
    ]);
    render(<LinkiePage />);
    await screen.findByText('No posts yet.');

    fireEvent.click(screen.getByRole('button', { name: /Choose from gallery/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add Image/ }));

    const preview = await screen.findByAltText('Attached to this post');
    expect(preview).toHaveAttribute('src', 'https://api.test/api/public/media/covers/h.webp');
  });

  it('a gallery row with no public URL is refused, not attached', async () => {
    routeProxy();
    loadGalleryItems.mockResolvedValue([
      { id: 'g2', articleId: 'a2', title: 'Private', imageUrl: '' },
    ]);
    render(<LinkiePage />);
    await screen.findByText('No posts yet.');

    fireEvent.click(screen.getByRole('button', { name: /Choose from gallery/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Add Image/ }));

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'That gallery image has no public URL' })
    );
    expect(screen.queryByAltText('Attached to this post')).not.toBeInTheDocument();
  });

  it('Push sends a content item’s cover image', async () => {
    getJSON.mockResolvedValue({
      items: [
        {
          id: 'c1',
          Title: 'Landing zones',
          Live: true,
          slugPageUrl: 'https://hybridcloudworks.com/azure/blog/landing-zones',
          heroImageUrl: '/api/public/media/covers/lz.png',
        },
      ],
    });
    routeProxy();
    render(<LinkiePage />);

    const push = await screen.findByRole('button', { name: /^Push$/i });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);

    await waitFor(() => expect(createCall()).toBeTruthy());
    expect(createCall()[1].body[0][LINKIE_POST_IMAGE_FIELD]).toBe(
      'https://api.test/api/public/media/covers/lz.png'
    );
  });

  it('shows a thumbnail for an existing post that carries an image', async () => {
    postJSON.mockImplementation((_fn, body) => {
      if (String(body?.path || '').includes('/posts')) {
        return Promise.resolve(
          envelope(true, 200, {
            data: [
              {
                _id: 'x1',
                url: 'https://a.test',
                text: 'With image',
                thumbnail_url: 'https://cdn.test/t.png',
              },
            ],
          })
        );
      }
      return Promise.resolve(ONE_PROFILE);
    });
    const { container } = render(<LinkiePage />);
    await screen.findByText('With image');
    expect(container.querySelector('img[src="https://cdn.test/t.png"]')).not.toBeNull();
  });
});

describe('the duty tabs (#577)', () => {
  const noProfilesYet = () => postJSON.mockResolvedValue(ONE_PROFILE);

  it('opens on Links when there is no ?tab=', async () => {
    searchParams = '';
    noProfilesYet();
    render(<LinkiePage />);
    // The Links tab is the one with the composer.
    expect(await screen.findByText(/Add a Post/i)).toBeInTheDocument();
  });

  it('sends the old `connection` id to Settings, where the test now lives', async () => {
    searchParams = 'tab=connection';
    noProfilesYet();
    render(<LinkiePage />);
    expect(await screen.findByRole('button', { name: /Test Connection/i })).toBeInTheDocument();
  });

  it('shows Links for an unknown tab rather than a header with nothing under it', async () => {
    searchParams = 'tab=nope';
    noProfilesYet();
    render(<LinkiePage />);
    expect(await screen.findByText(/Add a Post/i)).toBeInTheDocument();
  });

  it('names Linkie in the page header', async () => {
    searchParams = '';
    noProfilesYet();
    render(<LinkiePage />);
    await waitFor(() => expect(screen.getAllByText(/Linkie/).length).toBeGreaterThan(0));
  });
});
