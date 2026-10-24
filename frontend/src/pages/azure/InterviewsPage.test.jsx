/**
 * The Interviews page: the list, one interview as an article, the unknown
 * address, the empty state, and the book view being something a visitor opts
 * into on a wide screen with no request for less motion, and nothing else.
 */
import React from 'react';
import { renderToString } from 'react-dom/server';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, StaticRouter } from 'react-router';
import { makeInterview } from '@/test-utils/interviews';
import { runAxe } from '@/test-utils/axe';

vi.mock('react-helmet-async', () => ({
  Helmet: ({ children }) => <>{children}</>,
}));
vi.mock('@/pages/NotFoundPage', () => ({ default: () => <p>Page not found</p> }));

const state = vi.hoisted(() => ({ list: [] }));
vi.mock('@/data/interviews', () => ({
  get interviews() {
    return state.list;
  },
  findInterview: (slug) => state.list.find((interview) => interview.slug === slug),
}));

const { default: InterviewsPage } = await import('./InterviewsPage');

const newest = makeInterview('newest-one', { title: 'The Newest One', date: '2026-10-01' });
const older = makeInterview('older-one', { title: 'The Older One', date: '2026-03-01' });

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

beforeEach(() => {
  state.list = [newest, older];
  stubMedia({ wide: true, reduced: false });
});
afterEach(() => {
  delete window.matchMedia;
});

describe('the list', () => {
  it('links every interview, newest first, with its guest and date', () => {
    at('/azure/interviews');
    expect(screen.getByRole('heading', { level: 1, name: 'Interviews' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/azure/interviews/newest-one',
      '/azure/interviews/older-one',
    ]);
    expect(links.map((link) => link.textContent)).toEqual(['The Newest One', 'The Older One']);
    expect(screen.getAllByText(/Test Guest, Test Role/)).toHaveLength(2);
  });

  it('says so, and offers nothing to click, when there are no interviews', () => {
    state.list = [];
    at('/azure/interviews');
    expect(screen.getByText('No interviews yet. Check back soon.')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('has no accessibility violations axe can find', async () => {
    const { container } = at('/azure/interviews');
    expect((await runAxe(container)).violations).toEqual([]);
  });
});

describe('one interview', () => {
  it('shows the whole interview as an article, with a way back to the list', () => {
    at('/azure/interviews/newest-one');
    expect(screen.getByRole('heading', { level: 1, name: 'The Newest One' })).toBeInTheDocument();
    for (const item of newest.qa) expect(screen.getByText(item.a)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All interviews' })).toHaveAttribute(
      'href',
      '/azure/interviews'
    );
  });

  it('adds no <main> of its own: the site layout supplies the page landmark', () => {
    // A second one made axe report a nested and a duplicate main landmark in a browser.
    for (const path of ['/azure/interviews', '/azure/interviews/newest-one']) {
      const { container, unmount } = at(path);
      expect(container.querySelector('main')).toBeNull();
      unmount();
    }
  });

  it('gives an address with no interview the not-found page, not an empty article', () => {
    at('/azure/interviews/no-such-interview');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('describes the page for a search engine: a description and Article data', () => {
    const { container } = at('/azure/interviews/newest-one');
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

  it('cannot let a title close the data script: a "<" is escaped', () => {
    state.list = [makeInterview('x-y', { title: 'Bad </script><b>title' })];
    const { container } = at('/azure/interviews/x-y');
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script.textContent).not.toContain('</script>');
    expect(script.textContent).toContain('\\u003c');
    expect(JSON.parse(script.textContent).headline).toBe('Bad </script><b>title');
  });

  it('has no accessibility violations axe can find', async () => {
    const { container } = at('/azure/interviews/newest-one');
    expect((await runAxe(container)).violations).toEqual([]);
  });
});

describe('the book view is an opt-in extra', () => {
  it('is offered on a wide screen with no request for less motion', async () => {
    at('/azure/interviews/newest-one');
    expect(await screen.findByRole('button', { name: 'Book view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read as article' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('is not offered on a narrow screen, so a phone gets the article', async () => {
    stubMedia({ wide: false, reduced: false });
    at('/azure/interviews/newest-one');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Book view' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('is not offered to a visitor who has asked for less motion', async () => {
    stubMedia({ wide: true, reduced: true });
    at('/azure/interviews/newest-one');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Book view' })).not.toBeInTheDocument();
  });

  it('is not offered where the browser cannot say (no matchMedia), and the article still works', async () => {
    delete window.matchMedia;
    at('/azure/interviews/newest-one');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Book view' })).not.toBeInTheDocument();
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('opens the book when chosen, and goes back to the article', async () => {
    at('/azure/interviews/newest-one');
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
    at('/azure/interviews/newest-one');
    fireEvent.click(await screen.findByRole('button', { name: 'Book view' }));
    await screen.findByRole('group', { name: /book view/ });
    wide = false;
    act(() => change());
    await waitFor(() => expect(screen.getByRole('article')).toBeInTheDocument());
    expect(screen.queryByRole('group', { name: /book view/ })).not.toBeInTheDocument();
  });
});

describe('the pre-rendered page (no effects run, no browser)', () => {
  it('contains the whole interview and none of the book, whatever the screen later is', () => {
    const html = renderToString(
      <StaticRouter location="/azure/interviews/newest-one">
        <Routes>
          <Route path="/azure/interviews/:interviewId" element={<InterviewsPage />} />
        </Routes>
      </StaticRouter>
    );
    for (const item of newest.qa) {
      expect(html).toContain(item.q);
      expect(html).toContain(item.a);
    }
    expect(html).not.toContain('Book view');
    expect(html).not.toContain('book view');
  });

  it('renders the list the same way, with a link to each interview', () => {
    const html = renderToString(
      <StaticRouter location="/azure/interviews">
        <Routes>
          <Route path="/azure/interviews" element={<InterviewsPage />} />
        </Routes>
      </StaticRouter>
    );
    expect(html).toContain('href="/azure/interviews/newest-one"');
    expect(html).toContain('href="/azure/interviews/older-one"');
  });
});
