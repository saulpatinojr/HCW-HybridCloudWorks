/**
 * Deep links that focus one item (#1013, #1014): the hook, and each row the
 * dashboard's Decision Center links to — a workflow alert, a reminder, a
 * podcast transcript and a Listen & Learn chapter. The linked row scrolls
 * into view and is ringed; its neighbours are not.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useLinkedItem, { LINKED_CLASS, linkedId } from './useLinkedItem';
import { WorkflowAlertsCard } from '@/pages/admin/health/signals';
import { ReminderList } from '@/components/admin/platform-settings/RemindersTab';
import TranscriptsTab from '@/components/admin/recording-hub/TranscriptsTab';
import EpisodeCard from '@/components/admin/listen-and-learn/EpisodeCard';

vi.mock('@/lib/api', () => ({ getJSON: vi.fn(), postJSON: vi.fn(), sendJSON: vi.fn() }));

const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  delete Element.prototype.scrollIntoView;
  window.history.replaceState({}, '', '/');
});

const visit = (path) => window.history.replaceState({}, '', path);
const linkedRows = (container) => [...container.querySelectorAll('[data-linked="true"]')];

function Row({ itemId }) {
  const { ref, linked, linkedProps, linkedClassName } = useLinkedItem('alert', itemId);
  return (
    <div ref={ref} {...linkedProps} className={linkedClassName} data-testid={itemId}>
      {linked ? 'linked' : 'plain'}
    </div>
  );
}

describe('useLinkedItem', () => {
  it('rings and scrolls to the one row the address names', () => {
    visit('/admin/health?tab=alerts&alert=a2');
    render(
      <>
        <Row itemId="a1" />
        <Row itemId="a2" />
      </>
    );
    const linked = screen.getByTestId('a2');
    expect(linked).toHaveTextContent('linked');
    expect(linked).toHaveAttribute('aria-current', 'true');
    expect(linked.className).toBe(LINKED_CLASS);
    expect(screen.getByTestId('a1')).toHaveTextContent('plain');
    expect(screen.getByTestId('a1')).not.toHaveAttribute('aria-current');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('marks nothing without the parameter, or for a row with no id', () => {
    visit('/admin/health?tab=alerts');
    render(<Row itemId="a1" />);
    expect(screen.getByTestId('a1')).toHaveTextContent('plain');
    visit('/admin/health?alert=');
    render(<Row itemId="" />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('reads the parameter decoded', () => {
    expect(linkedId('alert', '?alert=a%201')).toBe('a 1');
    expect(linkedId('alert', '')).toBeNull();
  });
});

describe('each linked page focuses its item', () => {
  it('Health → Alerts: ?alert=<id> rings that alert', () => {
    visit('/admin/health?tab=alerts&alert=publish-failures');
    const { container } = render(
      <WorkflowAlertsCard
        alertFilter="open"
        setAlertFilter={vi.fn()}
        filteredAlerts={[
          { id: 'quiet', alertType: 'quiet_alert' },
          { id: 'publish-failures', alertType: 'scheduled_publish_failures' },
        ]}
        alertActionId=""
        resolutionNotes={{}}
        setResolutionNotes={vi.fn()}
        handleAlertAction={vi.fn()}
      />
    );
    const rows = linkedRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('scheduled_publish_failures');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('Platform Settings → Reminders: ?reminder=<id> rings that reminder', () => {
    visit('/admin/platform-settings?tab=reminders&reminder=r2');
    const { container } = render(
      <ReminderList
        reminders={[
          { id: 'r1', title: 'Renew the token', dueDate: '2026-10-01', leadDays: 7, notified: {} },
          {
            id: 'r2',
            title: 'Re-verify the catalogue',
            dueDate: '2026-10-08',
            leadDays: 7,
            notified: {},
          },
        ]}
        today="2026-10-08"
        saving={false}
        onEdit={vi.fn()}
        onToggleDone={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const rows = linkedRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Re-verify the catalogue');
  });

  it('Recording Hub → Transcripts: ?transcript=<id> rings that transcript', () => {
    visit('/admin/recording-hub?tab=transcripts&transcript=article_b');
    const hub = {
      items: [
        { id: 'article_a', title: 'First episode', status: 'draft' },
        { id: 'article_b', title: 'Second episode', status: 'draft' },
      ],
      loading: false,
      loadError: null,
      detail: null,
      busyKey: null,
      reload: vi.fn(),
      open: vi.fn(),
      closeDetail: vi.fn(),
      review: vi.fn(),
      retryHost: vi.fn(),
    };
    const { container } = render(<TranscriptsTab hub={hub} />);
    const rows = linkedRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Second episode');
  });

  it('Listen & Learn → Review: ?chapter=<id> rings that chapter', () => {
    visit('/admin/listen-and-learn?tab=review&platform=azure&exam=AZ-104&chapter=storage');
    const props = { busy: false, onReview: vi.fn(), onRetry: vi.fn(), onKeepCurrent: vi.fn() };
    const { container } = render(
      <>
        <EpisodeCard {...props} episode={{ id: 'compute', title: 'Compute', status: 'draft' }} />
        <EpisodeCard {...props} episode={{ id: 'storage', title: 'Storage', status: 'draft' }} />
      </>
    );
    const rows = linkedRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Storage');
  });
});
