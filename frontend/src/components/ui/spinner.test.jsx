/**
 * Spinner (AP-F12, #936): a loading state with a status role and a label.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Spinner } from './spinner';

describe('Spinner', () => {
  it('exposes a status role carrying its label, with the ring hidden from the tree', () => {
    render(<Spinner label="Loading published articles" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading published articles');
    expect(status.querySelector('[aria-hidden="true"]')).toHaveClass('animate-spin');
  });

  it('defaults its label and takes a size and extra classes', () => {
    render(<Spinner size="lg" className="min-h-[60vh]" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading');
    expect(status).toHaveClass('min-h-[60vh]');
    expect(status.querySelector('[aria-hidden="true"]')).toHaveClass('h-12');
  });
});
