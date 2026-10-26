import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AdminRoleProvider } from '@/hooks/useAdminRole';
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

// What the page hands the grid, the panel and the alerts hook, captured for the assertions.
const seen = vi.hoisted(() => ({
  grid: null,
  panel: null,
  hookOptions: null,
  reloadAlerts: () => {},
  refreshUnscheduled: () => {},
}));

vi.mock('@/components/admin/calendar/useUnscheduledContent', () => ({
  default: () => ({
    data: [
      { id: 'item-1', title: 'Unscheduled Post 1', contentStatus: 'approved' },
      { id: 'item-2', title: 'Forge Ready Post', contentStatus: 'forge_ready' },
    ],
    loading: false,
    error: null,
    refresh: (...args) => seen.refreshUnscheduled(...args),
  }),
}));

vi.mock('@/components/admin/calendar-alerts/useCalendarAlerts', () => ({
  default: (options) => {
    seen.hookOptions = options;
    return {
      alerts: [],
      status: 'ready',
      today: '2026-10-26',
      reload: (...args) => seen.reloadAlerts(...args),
    };
  },
}));

vi.mock('@/components/admin/calendar-alerts/CalendarAlertsPanel', () => ({
  default: ({ state }) => {
    seen.panel = state;
    return <div data-testid="alerts-panel">Calendar alerts panel ({state.status})</div>;
  },
}));

vi.mock('@/components/admin/calendar/SharedCalendar', () => ({
  default: (props) => {
    seen.grid = props;
    return <div data-testid="shared-calendar">Shared Calendar Grid</div>;
  },
}));

vi.mock('@/components/admin/calendar/UnscheduledPanel', () => ({
  default: ({ onSchedule, items }) => (
    <div data-testid="unscheduled-panel">
      <span>Unscheduled items count: {items.length}</span>
      <button onClick={() => onSchedule(items[0])}>Schedule First</button>
    </div>
  ),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <CalendarPage />
    </MemoryRouter>
  );

describe('CalendarPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seen.reloadAlerts = vi.fn();
    seen.refreshUnscheduled = vi.fn();
  });

  it('renders calendar grid, unscheduled panel, and summary links', () => {
    renderPage();

    expect(screen.getByTestId('shared-calendar')).toBeInTheDocument();
    expect(screen.getByTestId('unscheduled-panel')).toBeInTheDocument();
    expect(screen.getByText('Unscheduled items count: 2')).toBeInTheDocument();
    expect(screen.getByText('Unscheduled')).toBeInTheDocument();
    expect(screen.getByText('Instant Ready')).toBeInTheDocument();
  });

  it('navigates when a summary link button is clicked', () => {
    renderPage();

    const unscheduledButton = screen.getByRole('button', {
      name: /Unscheduled: 2\. Approved content with no publish time, on the Review Queue/i,
    });
    fireEvent.click(unscheduledButton);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/review-queue?status=approved');
  });
});

describe("CalendarPage and the owner's alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seen.reloadAlerts = vi.fn();
    seen.refreshUnscheduled = vi.fn();
  });

  it("holds the alerts panel under the grid, fed by the page's one alerts hook", () => {
    renderPage();
    const grid = screen.getByTestId('shared-calendar');
    const panel = screen.getByTestId('alerts-panel');
    expect(panel).toHaveTextContent('Calendar alerts panel (ready)');
    // The panel comes after the grid in the page.
    expect(grid.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seen.panel.status).toBe('ready');
    expect(seen.hookOptions.enabled).toBe(true);
  });

  it('has no separate Calendar Alerts page or menu entry: the alerts live on this page', () => {
    renderPage();
    expect(screen.queryByRole('link', { name: /Calendar Alerts/i })).not.toBeInTheDocument();
  });

  it('makes the grid read again when the panel changes an alert, and only then', () => {
    renderPage();
    const first = seen.grid.refreshToken;
    expect(first).toBe(0);
    act(() => seen.hookOptions.onChanged());
    expect(seen.grid.refreshToken).toBe(first + 1);
    act(() => seen.hookOptions.onChanged());
    expect(seen.grid.refreshToken).toBe(first + 2);
  });

  it('makes the panel and the unscheduled list read again when the grid changes something', () => {
    renderPage();
    act(() => seen.grid.onChanged());
    expect(seen.refreshUnscheduled).toHaveBeenCalledTimes(1);
    expect(seen.reloadAlerts).toHaveBeenCalledTimes(1);
  });

  it.each(['editor', 'publisher', 'super_admin'])('uses the alerts for the %s role', (role) => {
    render(
      <AdminRoleProvider value={role}>
        <MemoryRouter>
          <CalendarPage />
        </MemoryRouter>
      </AdminRoleProvider>
    );
    expect(seen.hookOptions.enabled).toBe(true);
    expect(screen.getByTestId('alerts-panel')).toBeInTheDocument();
  });

  it('asks nothing of the alerts and shows no panel to a viewer, whose role the server would refuse', () => {
    render(
      <AdminRoleProvider value="viewer">
        <MemoryRouter>
          <CalendarPage />
        </MemoryRouter>
      </AdminRoleProvider>
    );
    expect(seen.hookOptions.enabled).toBe(false);
    expect(screen.queryByTestId('alerts-panel')).not.toBeInTheDocument();
    act(() => seen.grid.onChanged());
    expect(seen.refreshUnscheduled).toHaveBeenCalledTimes(1);
    expect(seen.reloadAlerts).not.toHaveBeenCalled();
  });

  it('explains alerts in the page help', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /How this works/ }));
    expect(screen.getByText(/Your own alerts \(orange, with a bell/)).toBeInTheDocument();
  });
});
