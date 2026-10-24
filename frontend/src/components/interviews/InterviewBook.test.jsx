/**
 * The book view: only the two pages on show are reachable, the keyboard and
 * the buttons turn it, each turn is spoken, and the arrow keys are the book's
 * only when the book itself has focus.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import InterviewBook from './InterviewBook';
import { buildBookPages, lastSpread, visiblePageIndexes } from '@/lib/interviews';
import { makeInterview } from '@/test-utils/interviews';
import { runAxe } from '@/test-utils/axe';

const interview = makeInterview();
const pages = buildBookPages(interview);

const show = () =>
  render(
    <MemoryRouter>
      <InterviewBook interview={interview} />
    </MemoryRouter>
  );

const book = () => screen.getByRole('group', { name: 'A Test Interview, book view' });
const status = () => screen.getByRole('status');
const next = () => screen.getByRole('button', { name: 'Next page' });
const previous = () => screen.getByRole('button', { name: 'Previous page' });

describe('InterviewBook', () => {
  it('is a labelled book, closed on the cover, with the position spoken', () => {
    show();
    expect(book()).toHaveAttribute('aria-roledescription', 'book');
    expect(status()).toHaveAttribute('aria-live', 'polite');
    expect(status()).toHaveTextContent('Cover.');
    expect(previous()).toHaveAttribute('aria-disabled', 'true');
    expect(next()).toHaveAttribute('aria-disabled', 'false');
  });

  it('is turned with real buttons: the book itself is not a keyboard stop and handles no keys', () => {
    show();
    expect(book()).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(book(), { key: 'ArrowRight' });
    expect(status()).toHaveTextContent('Cover.');
  });

  it('makes every page except the ones on show unreachable and hidden from screen readers', () => {
    const { container } = show();
    const faces = [...container.querySelectorAll('[data-book-face]')];
    expect(faces).toHaveLength(pages.length);
    const shown = visiblePageIndexes(0, pages);
    faces.forEach((face, index) => {
      const isShown = shown.includes(index);
      expect(face.hasAttribute('inert')).toBe(!isShown);
      if (isShown) expect(face).not.toHaveAttribute('aria-hidden');
      else expect(face).toHaveAttribute('aria-hidden', 'true');
    });
  });

  it('prints on paper that the site theme cannot repaint: a fixed colour, never a themed class', () => {
    // Inside a provider page the theme rewrites `.bg-white` with !important, and
    // in the dark theme that turned the pages dark under dark text (seen in a
    // browser; jsdom has no layout and could not show it).
    const { container } = show();
    const faces = [...container.querySelectorAll('[data-book-face]')];
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.style.backgroundColor).toBe('rgb(255, 253, 248)');
      expect(face.style.color).toBe('rgb(30, 41, 59)');
    }
    expect(container.querySelectorAll('.bg-white, .bg-gray-50, .bg-gray-100')).toHaveLength(0);
  });

  it('turns with the buttons and speaks each position, and the pages on show follow', () => {
    const { container } = show();
    fireEvent.click(next());
    expect(status()).toHaveTextContent(`Pages 1 and 2 of ${pages.length - 2}.`);
    const faces = [...container.querySelectorAll('[data-book-face]')];
    const shown = visiblePageIndexes(1, pages);
    faces.forEach((face, index) => expect(face.hasAttribute('inert')).toBe(!shown.includes(index)));
    expect(previous()).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(previous());
    expect(status()).toHaveTextContent('Cover.');
  });

  it('can be read to the back cover, where Next is off but still has focus', () => {
    show();
    next().focus();
    for (let turn = 0; turn < lastSpread(pages); turn += 1) fireEvent.click(next());
    expect(status()).toHaveTextContent('Back cover.');
    expect(next()).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled: a disabled button under focus drops a keyboard user out of the page.
    expect(next()).not.toBeDisabled();
    expect(document.activeElement).toBe(next());
    fireEvent.click(next());
    expect(status()).toHaveTextContent('Back cover.');
  });

  it('turns with the arrow keys, Home and End when a page button has focus', () => {
    show();
    fireEvent.keyDown(next(), { key: 'ArrowRight' });
    expect(status()).toHaveTextContent(/Pages 1 and 2/);
    fireEvent.keyDown(next(), { key: 'ArrowRight' });
    expect(status()).toHaveTextContent(/Pages 3 and 4/);
    fireEvent.keyDown(previous(), { key: 'ArrowLeft' });
    expect(status()).toHaveTextContent(/Pages 1 and 2/);
    fireEvent.keyDown(previous(), { key: 'End' });
    expect(status()).toHaveTextContent('Back cover.');
    fireEvent.keyDown(next(), { key: 'Home' });
    expect(status()).toHaveTextContent('Cover.');
  });

  it('does not run past either end with the keyboard', () => {
    show();
    fireEvent.keyDown(previous(), { key: 'ArrowLeft' });
    expect(status()).toHaveTextContent('Cover.');
    fireEvent.keyDown(next(), { key: 'End' });
    fireEvent.keyDown(next(), { key: 'ArrowRight' });
    expect(status()).toHaveTextContent('Back cover.');
  });

  it('leaves the keys to a link or a scrolling page inside the book', () => {
    show();
    fireEvent.click(next());
    const page = screen.getByRole('region', { name: 'Question 1' });
    fireEvent.keyDown(page, { key: 'ArrowRight' });
    expect(status()).toHaveTextContent(/Pages 1 and 2/);
  });

  it('ignores the arrow keys when a modifier is held, so browser shortcuts still work', () => {
    show();
    fireEvent.keyDown(next(), { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(next(), { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(next(), { key: 'ArrowRight', metaKey: true });
    expect(status()).toHaveTextContent('Cover.');
  });

  it('takes the key it uses away from the page, and only that key', () => {
    show();
    const arrow = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    next().dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    const letter = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    next().dispatchEvent(letter);
    expect(letter.defaultPrevented).toBe(false);
  });

  it('cannot be tabbed into a page that is turned away: its links are inert', () => {
    const { container } = show();
    const links = [...container.querySelectorAll('a[href]')];
    expect(links.length).toBeGreaterThan(0);
    // On the cover nothing but the cover is reachable, and the cover has no link.
    expect(links.every((link) => link.closest('[inert]'))).toBe(true);
    // On the related page its links come into reach.
    const relatedIndex = pages.findIndex((page) => page.kind === 'related');
    const spread = Math.ceil(relatedIndex / 2);
    for (let turn = 0; turn < spread; turn += 1) fireEvent.click(next());
    const reachable = [...container.querySelectorAll('a[href]')].filter(
      (link) => !link.closest('[inert]')
    );
    expect(reachable.map((link) => link.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('A lab')])
    );
  });

  it('puts the question, answer and pull quote on a question page', () => {
    show();
    fireEvent.click(next());
    expect(screen.getByText('Question 1 of 3')).toBeInTheDocument();
    expect(screen.getAllByText('What is the first question?').length).toBeGreaterThan(0);
    expect(screen.getByText('The first pull quote.').tagName).toBe('BLOCKQUOTE');
  });

  it('has no accessibility violations axe can find, closed and open', async () => {
    const { container } = show();
    expect((await runAxe(container)).violations).toEqual([]);
    fireEvent.click(next());
    expect((await runAxe(container)).violations).toEqual([]);
  });
});
