/**
 * The page title is the menu label (AP-F13, #937). What must hold: on every
 * registry route the h1 and the document title are that route's label, with
 * no title written on the page; a page the registry does not name (a record
 * on /admin/editor/:id) still shows the title it passes.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import PageHeader from './PageHeader';
import { NAV_ITEMS } from '@/config/adminNav';

function renderAt(pathname, props = {}) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <PageHeader {...props} />
    </MemoryRouter>
  );
}

describe('PageHeader', () => {
  it.each(NAV_ITEMS.map((item) => [item.label, item.to]))(
    'titles %s from the registry at %s',
    (label, to) => {
      renderAt(to);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(label);
      expect(document.title).toBe(`${label} · ContentForge`);
    }
  );

  it('titles a deeper path from the item it sits under, and lets the page name the record', () => {
    renderAt('/admin/editor/abc123');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Editor');

    renderAt('/admin/editor/abc123', { title: 'Ten things about Azure' });
    expect(screen.getAllByRole('heading', { level: 1 }).at(-1)).toHaveTextContent(
      'Ten things about Azure'
    );
  });

  it('draws the registry icon when the page passes none', () => {
    const { container } = renderAt('/admin/live-pages');
    expect(container.querySelector('h1 svg')).not.toBeNull();
  });

  /**
   * Read as text, because the drift this guards is a page writing its own
   * title: a rendering test of PageHeader cannot see what a page passes to
   * it. A literal `title="…"` on a registry page is exactly the hand-written
   * heading the finding was about; a title computed from a record
   * (`title={blog.title}`) is a detail page's and is allowed.
   */
  it('no admin page writes a literal title on its header', () => {
    const dir = join(process.cwd(), 'src', 'pages', 'admin');
    const pages = readdirSync(dir).filter((f) => f.endsWith('.jsx') && !f.includes('.test.'));
    expect(pages.length).toBeGreaterThan(20);
    // ServicePageHeader is the Certifications page's header and resolves its
    // title the same way; TypedReviewList is the Frameworks and Coder Corner
    // pages' and passes none.
    const headers = ['<PageHeader', '<ServicePageHeader', '<TypedReviewList'];
    const offenders = pages.filter((file) => {
      const source = readFileSync(join(dir, file), 'utf8');
      return headers.some((name) => openingTags(source, name).some((tag) => /\btitle="/.test(tag)));
    });
    expect(offenders, 'these pages hand-write a title the registry already holds').toEqual([]);
  });
});

/**
 * Each opening tag of `name` in `source`, from the `<` to the `>` that ends
 * it — skipping any `>` inside a `{…}` prop value, where a `status={<span>}`
 * would otherwise end the scan early.
 */
function openingTags(source, name) {
  const tags = [];
  let from = source.indexOf(name);
  while (from !== -1) {
    let depth = 0;
    let end = from;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) break;
    }
    tags.push(source.slice(from, end));
    from = source.indexOf(name, end);
  }
  return tags;
}

describe('openingTags', () => {
  it('reads past a > inside a prop value', () => {
    const [tag] = openingTags('<PageHeader status={<b>x</b>} title="T">body', '<PageHeader');
    expect(tag).toBe('<PageHeader status={<b>x</b>} title="T"');
  });
});
