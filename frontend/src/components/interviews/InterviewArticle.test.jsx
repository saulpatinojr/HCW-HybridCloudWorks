/**
 * The article view holds the whole interview, renders every file string as
 * text, keeps links on this site inside the app and says when one leaves it.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import InterviewArticle from './InterviewArticle';
import { makeInterview } from '@/test-utils/interviews';
import { runAxe } from '@/test-utils/axe';

const show = (interview) =>
  render(
    <MemoryRouter>
      <InterviewArticle interview={interview} />
    </MemoryRouter>
  );

describe('InterviewArticle', () => {
  it('has one h1, the title, and the guest and date under it', () => {
    show(makeInterview());
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('A Test Interview');
    expect(screen.getByText(/Test Guest, Test Role/)).toBeInTheDocument();
    expect(screen.getByText('1 October 2026').closest('time')).toHaveAttribute(
      'datetime',
      '2026-10-01'
    );
  });

  it('uses no bare <header>: the site styles that element as its own page header', () => {
    // Seen in a browser as a darker box with a rule under the title block.
    const { container } = show(makeInterview());
    expect(container.querySelector('header')).toBeNull();
  });

  it('prints every question as a heading and every answer under it, in order', () => {
    const interview = makeInterview();
    show(interview);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 3)).toEqual(interview.qa.map((item) => item.q));
    for (const item of interview.qa) expect(screen.getByText(item.a)).toBeInTheDocument();
    expect(screen.getByText('The first pull quote.').tagName).toBe('BLOCKQUOTE');
  });

  it('shows the picture with the description the file gave it', () => {
    show(makeInterview());
    expect(
      screen.getByRole('img', { name: /grey square standing in for a portrait/ })
    ).toBeInTheDocument();
  });

  it('keeps a link on this site in the app and says when a link leaves it', () => {
    show(makeInterview());
    const lab = screen.getByRole('link', { name: 'A lab' });
    expect(lab).toHaveAttribute('href', '/azure/education/labs/a-lab');
    expect(lab).not.toHaveAttribute('rel');
    const learn = screen.getByRole('link', { name: /A Learn page/ });
    expect(learn).toHaveAttribute('href', 'https://learn.microsoft.com/training/');
    expect(learn).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(learn).getByText(/opens another site/)).toHaveClass('sr-only');
  });

  it('leaves out the sections the file has nothing for', () => {
    show(
      makeInterview('x-y', {
        bio: undefined,
        image: undefined,
        tags: [],
        related: {},
        subtitle: undefined,
      })
    );
    expect(screen.queryByText('About the guest')).not.toBeInTheDocument();
    expect(screen.queryByText('Keep learning')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Topics')).not.toBeInTheDocument();
  });

  it('renders markup in a file as text, never as elements', () => {
    const { container } = show(
      makeInterview('x-y', {
        title: 'Title with <script>alert(1)</script>',
        bio: '<img src=x onerror="alert(1)">',
        qa: [{ q: '<b>Bold?</b>', a: '<a href="javascript:alert(1)">click</a>' }],
      })
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(screen.getByText('<b>Bold?</b>')).toBeInTheDocument();
    expect(screen.getByText('<a href="javascript:alert(1)">click</a>')).toBeInTheDocument();
  });

  it('keeps line breaks in an answer', () => {
    show(makeInterview('x-y', { qa: [{ q: 'Q?', a: 'First line.\n\nSecond paragraph.' }] }));
    const answer = screen.getByText(/First line\./);
    expect(answer).toHaveClass('whitespace-pre-line');
    expect(answer.textContent).toContain('Second paragraph.');
  });

  it('has no accessibility violations axe can find', async () => {
    const { container } = show(makeInterview());
    const results = await runAxe(container);
    expect(results.violations).toEqual([]);
  });
});
