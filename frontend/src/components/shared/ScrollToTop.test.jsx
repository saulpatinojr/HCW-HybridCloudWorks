/**
 * Route transitions must reach keyboard and screen-reader users too (T-740).
 *
 * `window.scrollTo` moves the viewport and nothing else. Before this, every
 * navigation left a keyboard user parked on the link they had just activated,
 * in the previous page's header, with no announcement — so they had to work
 * out that the page had changed and then tab back through the navigation to
 * reach the content. The focus target already existed and was never used.
 *
 * These are behavioural assertions rather than snapshot ones: what matters is
 * that focus actually moves and that the announcer actually receives the new
 * title, since either can be silently lost by a refactor that still renders
 * identical markup.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import ScrollToTop from './ScrollToTop';

/** Mount the component inside a route, with the landmark and announcer present. */
function mountAt(path) {
  document.body.innerHTML = `
    <main id="main-content" tabindex="-1"></main>
    <div id="route-announcer"></div>
  `;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ScrollToTop />
    </MemoryRouter>
  );
}

/** Run the rAF the announcer is deferred behind. */
function flushFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ScrollToTop', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  });

  it('scrolls to the top on navigation', () => {
    mountAt('/aws/blog');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('moves focus to the main landmark', () => {
    mountAt('/aws/blog');
    // The whole point: a viewport scroll is not a focus move, and a keyboard
    // user is wherever focus is.
    expect(document.activeElement?.id).toBe('main-content');
  });

  it('focuses without scrolling, so it cannot fight the scroll reset', () => {
    document.body.innerHTML = `
      <main id="main-content" tabindex="-1"></main>
      <div id="route-announcer"></div>
    `;
    const main = document.getElementById('main-content');
    const focus = vi.spyOn(main, 'focus');
    render(
      <MemoryRouter initialEntries={['/aws/blog']}>
        <ScrollToTop />
      </MemoryRouter>
    );
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('announces the new document title', async () => {
    document.title = 'AWS Blog | Hybrid Cloud Works';
    mountAt('/aws/blog');
    await flushFrame();
    expect(document.getElementById('route-announcer').textContent).toBe(
      'AWS Blog | Hybrid Cloud Works'
    );
  });

  it('leaves a hash link alone', async () => {
    // `#section` means "go to this part of the page". Stealing focus to the
    // top of <main> would undo exactly what the user asked for.
    mountAt('/aws/blog#pricing');
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement?.id).not.toBe('main-content');
    await flushFrame();
    expect(document.getElementById('route-announcer').textContent).toBe('');
  });

  it('resets the admin content column, which scrolls instead of the window', async () => {
    // The admin shell is one viewport tall and #admin-main is its scroll
    // container (#566). It survives navigation between admin pages, so a
    // window scroll alone would leave the next page opened mid-way down.
    document.body.innerHTML = `
      <main id="main-content" tabindex="-1"><div id="admin-main"></div></main>
      <div id="route-announcer"></div>
    `;
    const adminMain = document.getElementById('admin-main');
    let scrollTop = 0;
    Object.defineProperty(adminMain, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = value;
      },
    });

    let goTo;
    function Navigator() {
      goTo = useNavigate();
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/admin/new-content']}>
        <ScrollToTop />
        <Navigator />
      </MemoryRouter>
    );

    scrollTop = 1800;
    await act(async () => goTo('/admin/newsletter-hub'));
    expect(scrollTop).toBe(0);
  });

  it('does not throw when the landmark or announcer is absent', () => {
    // Admin routes and the error boundary render different shells.
    document.body.innerHTML = '';
    expect(() =>
      render(
        <MemoryRouter initialEntries={['/aws/blog']}>
          <ScrollToTop />
        </MemoryRouter>
      )
    ).not.toThrow();
  });
});
