import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CalendarPage from './CalendarPage';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/hooks/useAuthReady', () => ({
  useAuthReady: () => ({ authReady: true }),
}));

vi.mock('@/components/admin/calendar/useUnscheduledContent', () => ({
  default: () => ({
    data: [
      { id: 'item-1', title: 'Unscheduled Post 1', contentStatus: 'approved' },
      { id: 'item-2', title: 'Forge Ready Post', contentStatus: 'forge_ready' },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/components/admin/calendar/SharedCalendar', () => ({
  default: () => <div data-testid="shared-calendar">Shared Calendar Grid</div>,
}));

vi.mock('@/components/admin/calendar/UnscheduledPanel', () => ({
  default: ({ onSchedule, items }) => (
    <div data-testid="unscheduled-panel">
      <span>Unscheduled items count: {items.length}</span>
      <button onClick={() => onSchedule(items[0])}>Schedule First</button>
    </div>
  ),
}));

describe('CalendarPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders calendar grid, unscheduled panel, and summary links', () => {
    render(
      <MemoryRouter>
        <CalendarPage />
      </MemoryRouter>
    );

    expect(screen.getByTestId('shared-calendar')).toBeInTheDocument();
    expect(screen.getByTestId('unscheduled-panel')).toBeInTheDocument();
    expect(screen.getByText('Unscheduled items count: 2')).toBeInTheDocument();
    expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    expect(screen.getByText('Instant Ready')).toBeInTheDocument();
  });

  it('navigates when a summary link button is clicked', () => {
    render(
      <MemoryRouter>
        <CalendarPage />
      </MemoryRouter>
    );

    const unscheduledButton = screen.getByRole('button', {
      name: /Unscheduled: 2\. Approved content with no publish time, on the Review Queue/i,
    });
    fireEvent.click(unscheduledButton);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/review-queue?status=approved');
  });
});
