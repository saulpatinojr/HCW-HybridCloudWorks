/**
 * The Health page's Archive card (ADR 0046, #1811): the switch, whether an
 * archive could start, the newest dry-run report, and the Dry run button.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AdminRoleProvider } from '@/hooks/useAdminRole';
import ArchiveCard, {
  ARCHIVE_DRY_RUN_ROUTE,
  ARCHIVE_STATUS_ROUTE,
  blockerSentence,
  reasonWords,
} from './ArchiveCard';

const getJSON = vi.fn();
const postJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const STATUS = {
  ok: true,
  setting: 'CONTENT_ARCHIVE_ENABLED',
  switchOn: false,
  jobBuilt: false,
  year: 2026,
  archived: false,
  wouldStart: false,
  blockers: ['switch-off', 'backup-too-early'],
  latest: null,
};

const REPORT = {
  reportId: '20270208T0400Z',
  complete: true,
  report: {
    completedAt: '2027-02-08T04:06:00.000Z',
    sourceBackup: { mode: 'full', runId: '2027-02-07' },
    totals: { kept: 1234, changed: 5, leftOut: 40, mismatched: 0, unreadable: 0 },
    containers: [
      {
        container: 'blogs',
        decision: 'archive',
        reason: null,
        read: 242,
        kept: 242,
        changed: 0,
        leftOut: 0,
      },
      {
        container: 'developer_events',
        decision: 'archive-changed',
        reason: null,
        read: 7,
        kept: 7,
        changed: 5,
        removed: { speakerName: 5, speakerEmail: 5 },
        leftOut: 0,
      },
      {
        container: 'admin_config',
        decision: 'archive-changed',
        reason: null,
        read: 60,
        kept: 20,
        changed: 0,
        leftOut: 40,
        leftOutBy: { secret: 3, 'working-state': 37 },
      },
      {
        container: 'tool_workspaces',
        decision: 'leave-out',
        reason: 'unclassified',
        read: 12,
        kept: 0,
        leftOut: 12,
        fieldNames: [
          { name: 'id', records: 12 },
          { name: 'visitorId', records: 12 },
        ],
        fieldNamesTruncated: false,
        otherNames: 0,
      },
      {
        container: 'config_providers',
        decision: 'leave-out',
        reason: 'unclassified',
        inBackup: false,
        read: 0,
        fieldNames: [],
      },
    ],
    leftOutWhole: [{ container: 'admins', reason: 'access-list', backupDocs: 2 }],
  },
};

const renderAs = (role) =>
  render(
    <AdminRoleProvider value={role}>
      <ArchiveCard />
    </AdminRoleProvider>
  );

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue(STATUS);
  postJSON
    .mockReset()
    .mockResolvedValue({ ok: true, started: true, sourceBackup: '2027-02-07', queued: 61 });
  toast.mockReset();
});

describe('ArchiveCard', () => {
  it('is not drawn, and reads nothing, below super_admin or with no role known', () => {
    for (const role of ['viewer', 'editor', 'publisher', 'admin']) {
      const { container, unmount } = renderAs(role);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    const { container } = render(<ArchiveCard />);
    expect(container).toBeEmptyDOMElement();
    expect(getJSON).not.toHaveBeenCalled();
  });

  it('shows the switch off, that the job is not built, and what stands in the way', async () => {
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-switch')).toHaveTextContent('Off');
    expect(getJSON).toHaveBeenCalledWith(ARCHIVE_STATUS_ROUTE);
    expect(screen.getByTestId('archive-year-state')).toHaveTextContent('Not written');
    const readiness = screen.getByTestId('archive-readiness');
    expect(readiness).toHaveTextContent('The job that writes an archive is not built yet');
    expect(readiness).toHaveTextContent(
      'An archive of 2026 could not start today: the switch is off; the newest complete weekly backup is from before 2 February.'
    );
    expect(screen.getByTestId('archive-no-report')).toBeInTheDocument();
  });

  it('says "Not known" when the archive container could not be read, not "Not written"', async () => {
    getJSON.mockResolvedValue({ ...STATUS, archived: null, blockers: ['archive-not-readable'] });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-year-state')).toHaveTextContent('Not known');
  });

  it('shows the report: totals, the containers waiting for the owner with field names, and every container', async () => {
    getJSON.mockResolvedValue({ ...STATUS, latest: REPORT });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-kept')).toHaveTextContent('1,234');
    expect(screen.getByTestId('archive-report')).toHaveTextContent(
      'from the weekly backup of 2027-02-07'
    );
    const waiting = within(
      screen.getByRole('list', { name: 'Containers to classify' })
    ).getAllByTestId('archive-unclassified');
    expect(waiting).toHaveLength(2);
    expect(waiting[0]).toHaveTextContent('tool_workspaces: 12 records');
    expect(waiting[0]).toHaveTextContent('Fields: id, visitorId');
    expect(waiting[1]).toHaveTextContent('config_providers: not in the backup');
    const table = screen.getByRole('table', { hidden: true });
    expect(table).toHaveTextContent('developer_events');
    expect(table).toHaveTextContent('5 (speakerName, speakerEmail)');
    expect(table).toHaveTextContent('40 (3 it is a secret, 37 short-lived working state)');
    expect(table).toHaveTextContent('all 2 (it is the access list)');
    expect(screen.queryByTestId('archive-mismatch')).not.toBeInTheDocument();
  });

  it('warns when a container did not match the backup’s own count', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      latest: {
        ...REPORT,
        report: { ...REPORT.report, totals: { ...REPORT.report.totals, mismatched: 1 } },
      },
    });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-mismatch')).toHaveTextContent(
      'Do not switch the archive on'
    );
  });

  it('shows progress while a dry run is reading, and holds the button', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      latest: { reportId: 'x', complete: false, sourceRun: '2027-02-07', done: 12, expected: 61 },
    });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-progress')).toHaveTextContent(
      '12 of 61 containers done'
    );
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
  });

  it('starts a dry run, says so, and reads the state again', async () => {
    renderAs('super_admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith(ARCHIVE_DRY_RUN_ROUTE, {}));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Dry run started' }))
    );
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
  });

  it('gives the server’s own sentence when the dry run is refused', async () => {
    postJSON.mockRejectedValue(
      new Error('no_backup — No complete weekly full backup was found. (reference abc)')
    );
    renderAs('super_admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Dry run' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'The dry run did not start',
          description: 'No complete weekly full backup was found.',
          variant: 'destructive',
        })
      )
    );
  });

  it('says the state could not be read when the read fails', async () => {
    getJSON.mockRejectedValue(new Error('forbidden — Not allowed.'));
    renderAs('super_admin');
    expect(
      await screen.findByText(/The archive’s state could not be read: Not allowed\./)
    ).toBeInTheDocument();
  });
});

describe('words', () => {
  it('turns blocker and reason codes into plain words, and passes an unknown one through', () => {
    expect(blockerSentence(['before-1-february', 'something-new'])).toBe(
      'it is still January, the month of grace; something-new'
    );
    expect(reasonWords({ promise: 2, orphan: 1 })).toBe(
      '2 a promise limits keeping it, 1 its content item is not in the backup'
    );
    expect(reasonWords()).toBe('');
  });
});
