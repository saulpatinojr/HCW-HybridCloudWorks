/**
 * The Interviews page: the list, one interview as an article, the unknown
 * address, the empty state, the loading state, and the book view being
 * something a visitor opts into on a wide screen with no request for less
 * motion, and nothing else.
 *
 * The public API is stood in for (ADR 0040, D6): the list answers what the
 * test puts in `state.list`, one interview what it finds there by slug, and
 * every item goes through the real `normalizeInterview` on the way to the
 * page. The pre-render cases seed the same keys the manifest writes.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, StaticRouter } from 'react-router';
import { PrerenderDataContext } from '@/hooks/prerenderData';
import { interviewPath } from '@/lib/interviews';
import { rawInterview } from '@/test-utils/interviews';
import { runAxe } from '@/test-utils/axe';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));
vi.mock('@/pages/NotFoundPage', () => ({ default: () => <p>Page not found</p> }));

const state = vi.hoisted(() => ({ list: [], calls: [] }));
vi.mock('@/lib/publicApi', () => ({
  fetchPublicInterviews: vi.fn(async () => {
    state.calls.push('list');
    return state.list;
  }),
  fetchPublicInterview: vi.fn(async (slug) => {
    state.calls.push(`one:${slug}`);
    return state.list.find((item) => item.slug === slug) || null;
  }),
}));

const {
  default: InterviewsPage,
  readInterviewList,
  readInterview,
} = await import('./InterviewsPage');

/** An API item: the raw interview plus its slug, as the public route answers. */
const apiItem = (slug, overrides = {}) => ({ slug, ...rawInterview(overrides) });

const newest = apiItem('newest-one', { title: 'The Newest One', date: '2026-10-01' });
const older = apiItem('older-one', { title: 'The Older One', date: '2026-03-01' });

/** A matchMedia that answers the two questions the page asks. */
function stubMedia({ wide, reduced }) {
  const answers = { 'min-width': wide, 'reduced-motion': reduced };
  window.matchMedia = vi.fn((query) => ({
    matches: Object.entries(answers).some(([part, answer]) => query.includes(part) && answer),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/azure/interviews" element={<InterviewsPage />} />
        <Route path="/azure/interviews/:interviewId" element={<InterviewsPage />} />
      </Routes>
    </MemoryRouter>
  );

/** The page once its read has answered. */
const loaded = async (path) => {
  const rendered = at(path);
  await waitFor(() => expect(rendered.container.querySelector('[aria-busy="true"]')).toBeNull());
  return rendered;
};

beforeEach(() => {
  state.list = [newest, older];
  state.calls = [];
  stubMedia({ wide: true, reduced: false });
});
afterEach(() => {
  delete window.matchMedia;
});

describe('reading the API', () => {
  it('keeps every valid item, newest first, and leaves an invalid one out', () => {
    const list = readInterviewList([older, { slug: 'broken-one', title: 'No guest' }, newest]);
    expect(list.map((item) => item.slug)).toEqual(['newest-one', 'older-one']);
    expect(readInterviewList(null)).toEqual([]);
  });

  it('reads one item through the real checks, and null for anything that fails them', () => {
    expect(readInterview(newest).title).toBe('The Newest One');
    expect(readInterview(null)).toBeNull();
    expect(readInterview({ title: 'no slug' })).toBeNull();
    expect(readInterview({ slug: 'Bad Slug', ...rawInterview() })).toBeNull();
  });
});

describe('the list', () => {
  it('links every interview, newest first, with its guest and date', async () => {
    await loaded('/azure/interviews');
    expect(screen.getByRole('heading', { level: 1, name: 'Interviews' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/azure/interviews/newest-one',
      '/azure/interviews/older-one',
    ]);
    expect(links.map((link) => link.textContent)).toEqual(['The Newest One', 'The Older One']);
    expect(screen.getAllByText(/Test Guest, Test Role/)).toHaveLength(2);
    expect(state.calls).toEqual(['list']);
  });

  it('shows a skeleton and nothing to click while the list loads', () => {
    const { container } = at('/azure/interviews');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText('No interviews yet. Check back soon.')).not.toBeInTheDocument();
  });

  it('says so, and offers nothing to click, when there are no interviews', async () => {
    state.list = [];
    await loaded('/azure/interviews');
    expect(screen.getByText('No interviews yet. Check back soon.')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('leaves out an item the API sent that is not a valid interview', async () => {
    state.list = [newest, { slug: 'broken-one', title: 'No guest, no qa' }];
    await loaded('/azure/interviews');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('has no accessibility violations axe can find', async () => {
    const { container } = await loaded('/azure/interviews');
    expect((await runAxe(container)).violations).toEqual([]);
  });
});

describe('one interview', () => {
  it('shows the whole interview as an article, with a way back to the list', async () => {
    await loaded('/azure/interviews/newest-one');
    expect(screen.getByRole('heading', { level: 1, name: 'The Newest One' })).toBeInTheDocument();
    for (const item of newest.qa) expect(screen.getByText(item.a)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All interviews' })).toHaveAttribute(
      'href',
      '/azure/interviews'
    );
    expect(state.calls).toEqual(['one:newest-one']);
  });

  it('adds no <main> of its own: the site layout supplies the page landmark', async () => {
    // A second one made axe report a nested and a duplicate main landmark in a browser.
    for (const path of ['/azure/interviews', '/azure/interviews/newest-one']) {
      const { container, unmount } = await loaded(path);
      expect(container.querySelector('main')).toBeNull();
      unmount();
    }
  });

  it('gives an address with no interview the not-found page, not an empty article', async () => {
    await loaded('/azure/interviews/no-such-interview');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('gives a document that fails the checks the not-found page, never a broken page', async () => {
    state.list = [{ slug: 'broken-one', title: 'No guest' }];
    await loaded('/azure/interviews/broken-one');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });

  it('shows a skeleton while the interview loads', () => {
    const { container } = at('/azure/interviews/newest-one');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
  });

  it('describes the page for a search engine: a description and Article data', async () => {
    const { container } = await loaded('/azure/interviews/newest-one');
    const script = container.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(script.textContent);
    expect(data).toMatchObject({
      '@type': 'Article',
      headline: 'The Newest One',
      datePublished: '2026-10-01',
      mainEntityOfPage: 'https://hybridcloudworks.com/azure/interviews/newest-one',
      about: ['landing-zones', 'governance'],
      image: 'https://hybridcloudworks.com/images/test-guest.jpg',
    });
    // React 19 moves <title> and <meta> into the document head, out of the container.
    expect(document.querySelector('meta[name="description"]').getAttribute('content')).toBe(
      'Test Guest exists only in the test suite.'
    );
    expect(document.title).toBe('The Newest One | HCW');
  });

  it('cannot let a title close the data script: a "<" is escaped', async () => {
    state.list = [apiItem('x-y', { title: 'Bad </script><b>title' })];
    const { container } = await loaded('/azure/interviews/x-y');
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script.textContent).not.toContain('</script>');
    expect(script.textContent).toContain('\\u003c');
    expect(JSON.parse(script.textContent).headline).toBe('Bad </script><b>title');
  });

  it('has no accessibility violations axe can find', async () => {
    const { container } = await loaded('/azure/interviews/newest-one');
    expect((await runAxe(container)).violations).toEqual([]);
  });
});

describe('the book view is an opt-in extra', () => {
  it('is offered on a wide screen with no request for less motion', async () => {
    await loaded('/azure/interviews/newest-one');
    expect(await screen.findByRole('button', { name: 'Book view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read as article' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('is not offered on a narrow screen, so a phone gets the article', async () => {
    stubMedia({ wide: false, reduced: false });
    await loaded('/azure/interviews/newest-one');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Book view' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('is not offered to a visitor who has asked for less motion', async () => {
    stubMedia({ wide: true, reduced: true });
    await loaded('/azure/interviews/newest-one');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Book view' })).not.toBeInTheDocument();
  });

  it('is not offered where the browser cannot say (no matchMedia), and the article still works', async () => {
    delete window.matchMedia;
    await loaded('/azure/interviews/newest-one');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Book view' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('opens the book when chosen, and goes back to the article', async () => {
    await loaded('/azure/interviews/newest-one');
    fireEvent.click(await screen.findByRole('button', { name: 'Book view' }));
    expect(
      await screen.findByRole('group', { name: 'The Newest One, book view' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book view' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Read as article' }));
    await waitFor(() => expect(screen.getByRole('article')).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: /book view/ })).not.toBeInTheDocument();
  });

  it('closes the book if the window becomes narrow while it is open', async () => {
    let change = () => {};
    window.matchMedia = vi.fn((query) => ({
      get matches() {
        return query.includes('min-width') ? wide : false;
      },
      media: query,
      addEventListener: (_event, handler) => {
        if (query.includes('min-width')) change = handler;
      },
      removeEventListener: vi.fn(),
    }));
    let wide = true;
    await loaded('/azure/interviews/newest-one');
    fireEvent.click(await screen.findByRole('button', { name: 'Book view' }));
    await screen.findByRole('group', { name: /book view/ });
    wide = false;
    act(() => change());
    await waitFor(() => expect(screen.getByRole('article')).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: /book view/ })).not.toBeInTheDocument();
  });
});

describe('the pre-rendered page (no effects run, no browser, seeded from the manifest)', () => {
  const seeded = (seed, location, path) =>
    renderToString(
      <PrerenderDataContext.Provider value={seed}>
        <StaticRouter location={location}>
          <Routes>
            <Route path={path} element={<InterviewsPage />} />
          </Routes>
        </StaticRouter>
      </PrerenderDataContext.Provider>
    );

  it('contains the whole interview and none of the book, whatever the screen later is', () => {
    const html = seeded(
      { 'interview:newest-one': newest },
      '/azure/interviews/newest-one',
      '/azure/interviews/:interviewId'
    );
    for (const item of newest.qa) {
      expect(html).toContain(item.q);
      expect(html).toContain(item.a);
    }
    expect(html).not.toContain('Book view');
    expect(html).not.toContain('book view');
    expect(html).not.toContain('aria-busy');
  });

  it('renders the list the same way, with a link to each interview', () => {
    const html = seeded(
      { 'interviews:list': [newest, older] },
      '/azure/interviews',
      '/azure/interviews'
    );
    expect(html).toContain(`href="${interviewPath('newest-one')}"`);
    expect(html).toContain(`href="${interviewPath('older-one')}"`);
    expect(html).not.toContain('aria-busy');
  });

  it('renders the skeleton, not the not-found page, when nothing was seeded: the browser then fetches', () => {
    const html = seeded(null, '/azure/interviews/newest-one', '/azure/interviews/:interviewId');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('Page not found');
  });
});
