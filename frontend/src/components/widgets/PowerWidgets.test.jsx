/**
 * NoteBox: the coloured note card. Every render builds the table of its three
 * looks (info, warning, success), so a missing icon in any one of them broke
 * all three (#1852). Each look is rendered here.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NoteBox } from './PowerWidgets';

describe('NoteBox', () => {
  it.each([
    ['info', 'Info'],
    ['warning', 'Warning'],
    ['success', 'Success'],
  ])('renders the %s look with its icon and its default title', (type, title) => {
    const { container } = render(<NoteBox type={type}>Body text</NoteBox>);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to the info look for a type it does not know', () => {
    const { container } = render(
      <NoteBox type="other" title="Heads up">
        Body text
      </NoteBox>
    );
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('border-l-blue-500');
  });
});
