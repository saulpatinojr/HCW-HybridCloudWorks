import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CommandPalette from './CommandPalette';

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: vi.fn(),
  };
});

describe('CommandPalette', () => {
  const mockNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  });

  it('renders nothing by default when closed', () => {
    render(
      <MemoryRouter>
        <CommandPalette isOpen={false} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders dialog when isOpen is true', () => {
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} />
      </MemoryRouter>
    );
    expect(screen.getByRole('dialog', { name: /command search palette/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('opens and closes via global Cmd+K or Ctrl+K shortcut in uncontrolled mode', () => {
    render(
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Trigger Cmd+K
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Trigger Cmd+K again to toggle closed
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Trigger Ctrl+K
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes when Escape is pressed', () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={handleClose} />
      </MemoryRouter>
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('closes when backdrop is clicked', () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={handleClose} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTestId('command-palette-backdrop'));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('filters results for "FOCUS 1.4" and navigates on Enter', () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={handleClose} />
      </MemoryRouter>
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'FOCUS 1.4' } });

    expect(screen.getByText('Multi-Cloud Cost Optimization')).toBeInTheDocument();
    expect(screen.getByText('FinOps Certified Practitioner (FOCUS 1.4)')).toBeInTheDocument();

    // Press Enter to select the top active result
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/finops/education');
    expect(handleClose).toHaveBeenCalled();
  });

  it('navigates through items with ArrowDown and ArrowUp', () => {
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} />
      </MemoryRouter>
    );

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');

    // Arrow down
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    // Arrow up
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowUp' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates when an option is clicked', () => {
    const handleClose = vi.fn();
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} onClose={handleClose} />
      </MemoryRouter>
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Landing Zone Builder' } });

    const lzOption = screen.getByText('Landing Zone Builder');
    fireEvent.click(lzOption);

    expect(mockNavigate).toHaveBeenCalledWith('/tools/landing-zone');
    expect(handleClose).toHaveBeenCalled();
  });

  it('shows empty state when no items match query', () => {
    render(
      <MemoryRouter>
        <CommandPalette isOpen={true} />
      </MemoryRouter>
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'nonexistentquery123' } });

    expect(screen.getByTestId('command-palette-empty')).toBeInTheDocument();
    expect(screen.getByText(/no matching results found/i)).toBeInTheDocument();
  });
});
