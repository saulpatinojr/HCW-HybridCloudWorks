import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import { FileText } from 'lucide-react';
import StatTile from './StatTile';

/** A tile linking to the Review Queue's rejected filter, with `props` overriding any default. */
function renderTile(props) {
  return render(
    <MemoryRouter>
      <StatTile to="/admin/review-queue?status=rejected" value={3} label="Rejected" {...props} />
    </MemoryRouter>
  );
}

describe('StatTile', () => {
  it('is one link to its page, named by its aria-label when given', () => {
    renderTile({ ariaLabel: 'Rejected: 3. Opens the rejected list.' });
    const link = screen.getByRole('link', { name: 'Rejected: 3. Opens the rejected list.' });
    expect(link).toHaveAttribute('href', '/admin/review-queue?status=rejected');
    expect(within(link).getByText('3')).toBeInTheDocument();
    expect(within(link).getByText('Rejected')).toBeInTheDocument();
  });

  it('holds the note line open when there is no note, so every tile is the same height', () => {
    // Fails if the empty note collapses: a tile with a note would then be one
    // line taller than its neighbours and stretch the row (the dashboard's
    // Rejected tile, 2026-10-08).
    renderTile({ note: null });
    const note = screen.getByTestId('stat-tile-note');
    expect(note.textContent).toBe(' ');
    expect(note).toHaveAttribute('aria-hidden', 'true');
    expect(note).toHaveClass('leading-4');
  });

  it('keeps label and note to one line each, with the whole text in title', () => {
    renderTile({ note: 'Auto-deletes in 24h', icon: FileText, iconClassName: 'text-blue-500' });
    const label = screen.getByText('Rejected');
    const note = screen.getByText('Auto-deletes in 24h');
    for (const line of [label, note]) {
      expect(line).toHaveClass('truncate');
      expect(line).toHaveAttribute('title', line.textContent);
    }
  });

  it('uses no paragraph, so the global p margin cannot add dead space', () => {
    const { container } = renderTile({ note: '6 to review' });
    expect(container.querySelector('p')).toBeNull();
  });
});
