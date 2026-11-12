/**
 * The framework board's Address topic dropdown (#1628): it saves with the
 * rest of the form, and it is locked once the page has been published.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FrameworkReviewBoard from './FrameworkReviewBoard';

const framework = (over = {}) => ({
  id: 'f1',
  type: 'framework',
  title: 'Landing zone readiness',
  summary: 'A framework.',
  contentStatus: 'inspected',
  ...over,
});

describe('FrameworkReviewBoard address topic (#1628)', () => {
  it('saves the chosen topic with the form', () => {
    const onSave = vi.fn();
    render(<FrameworkReviewBoard blog={framework()} onSave={onSave} onPublish={vi.fn()} />);
    const select = screen.getByLabelText('Address topic');
    expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: 'governance' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ topic: 'governance' }));
  });

  it('sends no topic when the editor did not touch it, so a save cannot clear one stored meanwhile', () => {
    const onSave = vi.fn();
    render(<FrameworkReviewBoard blog={framework()} onSave={onSave} onPublish={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave.mock.calls[0][0].topic).toBeUndefined();
  });

  it('is locked once the page has been published', () => {
    render(
      <FrameworkReviewBoard
        blog={framework({ contentStatus: 'published', topic: 'ai', slug: 'ai-f1' })}
        onSave={vi.fn()}
        onPublish={vi.fn()}
      />
    );
    const select = screen.getByLabelText('Address topic');
    expect(select).toHaveValue('ai');
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription(/its address is fixed/);
  });
});
