/**
 * The Health page's Archive card (ADR 0046, #1811): the switch, whether an
 * archive could start, the last archive and one in progress, the newest
 * dry-run report, and the Dry run button.
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
  sizeWords,
  sensitiveSentence,
  yearState,
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
  jobBuilt: true,
  exportOn: true,
  progressKnown: true,
  lastArchive: null,
  run: null,
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
        fieldNames: [
          { name: 'id', records: 242 },
          { name: 'title', records: 242 },
        ],
        otherNames: 4,
        sensitive: {
          records: 3,
          keptRecords: 3,
          names: [{ name: 'authorEmail', records: 3 }],
          namesNotShown: 0,
        },
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
        sensitive: {
          records: 5,
          keptRecords: 0,
          names: [{ name: 'speakerEmail', records: 5 }],
          namesNotShown: 0,
        },
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
        sensitive: {
          records: 3,
          keptRecords: 0,
          names: [
            { name: 'apiKey', records: 2 },
            { name: 'token', records: 1 },
          ],
          namesNotShown: 1,
        },
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

  it('shows the switch off, what stands in the way, and that no archive has been written', async () => {
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-switch')).toHaveTextContent('Off');
    expect(getJSON).toHaveBeenCalledWith(ARCHIVE_STATUS_ROUTE);
    expect(screen.getByTestId('archive-year-state')).toHaveTextContent('Not written');
    const readiness = screen.getByTestId('archive-readiness');
    expect(readiness).not.toHaveTextContent('not built');
    expect(readiness).toHaveTextContent(
      'An archive of 2026 could not start today: the switch is off; the newest complete weekly backup is from before 2 February.'
    );
    expect(screen.getByTestId('archive-none')).toHaveTextContent(
      'No archive has been written yet.'
    );
    expect(screen.getByTestId('archive-no-report')).toBeInTheDocument();
  });

  it('says why it did not start when the nightly export is off', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      switchOn: true,
      exportOn: false,
      blockers: ['export-off'],
    });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-readiness')).toHaveTextContent(
      'An archive of 2026 could not start today: the nightly export is off'
    );
  });

  it('shows the last archive: year, when, files, records, size and the Archive tier', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      switchOn: true,
      archived: true,
      blockers: ['already-archived'],
      lastArchive: {
        year: 2026,
        createdAt: '2027-02-08T03:41:00.000Z',
        sourceRun: '2027-02-07',
        containers: 39,
        records: 123456,
        bytes: 5 * 1024 * 1024,
        inArchiveTier: 39,
        missingFiles: 0,
      },
    });
    renderAs('super_admin');
    const last = await screen.findByTestId('archive-last');
    expect(last).toHaveTextContent('Last archive: 2026');
    expect(last).toHaveTextContent('2027-02-08 03:41 UTC');
    expect(last).toHaveTextContent(
      '39 files (one per container), 123,456 records, 5.0 MB compressed'
    );
    expect(last).toHaveTextContent('made from the weekly backup of 2027-02-07');
    expect(last).toHaveTextContent('Every file is in the Archive tier');
    expect(screen.queryByTestId('archive-last-missing')).toBeNull();
    expect(screen.getByTestId('archive-year-state')).toHaveTextContent('Written');
  });

  it('says when some files are not in the Archive tier yet, and when a listed file is missing', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      archived: true,
      lastArchive: {
        year: 2026,
        createdAt: null,
        sourceRun: null,
        containers: 39,
        records: 1,
        bytes: 10,
        inArchiveTier: 30,
        missingFiles: 2,
      },
    });
    renderAs('super_admin');
    const last = await screen.findByTestId('archive-last');
    expect(last).toHaveTextContent(
      '30 of 39 files are in the Archive tier; the daily check moves the rest.'
    );
    expect(screen.getByTestId('archive-last-missing')).toHaveTextContent('2 file(s)');
  });

  it('shows an archive that is being written, and one that is late with what it lacks', async () => {
    const run = {
      year: 2026,
      startedAt: '2027-02-08T03:00:00.000Z',
      sourceRun: '2027-02-07',
      expected: 39,
      done: 12,
      missing: ['content_versions'],
      late: false,
    };
    getJSON.mockResolvedValue({ ...STATUS, switchOn: true, run });
    const first = renderAs('super_admin');
    expect(await screen.findByTestId('archive-run')).toHaveTextContent(
      'The archive of 2026 is being written from the weekly backup of 2027-02-07: 12 of 39 files are written and checked.'
    );
    expect(screen.queryByTestId('archive-none')).toBeNull();
    first.unmount();

    getJSON.mockResolvedValue({ ...STATUS, switchOn: true, run: { ...run, done: 38, late: true } });
    renderAs('super_admin');
    const late = await screen.findByTestId('archive-run-late');
    expect(late).toHaveTextContent('is not finished: 38 of 39 files are written and checked.');
    expect(late).toHaveTextContent('Missing: content_versions.');
    expect(late).toHaveTextContent('Nothing has been moved to the Archive tier');
  });

  it('says "could not be read" for the archive’s progress, not "none", when the server could not tell', async () => {
    getJSON.mockResolvedValue({ ...STATUS, progressKnown: false });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-progress-unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-none')).toBeNull();
  });

  it('keeps the old sentence for a server that has not been deployed with the job yet', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      jobBuilt: false,
      progressKnown: undefined,
      lastArchive: undefined,
      run: undefined,
    });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-readiness')).toHaveTextContent(
      'The job that writes an archive is not built yet'
    );
    expect(screen.queryByTestId('archive-none')).toBeNull();
  });

  it('writes sizes in plain words', () => {
    expect(sizeWords(512)).toBe('512 bytes');
    expect(sizeWords(1536)).toBe('1.5 KB');
    expect(sizeWords(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(sizeWords(undefined)).toBe('an unknown size');
  });

  it('says "Not known" when the archive container could not be read, not "Not written"', async () => {
    getJSON.mockResolvedValue({ ...STATUS, archived: null, blockers: ['archive-not-readable'] });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-year-state')).toHaveTextContent('Not known');
  });

  it('says the container does not exist yet, and never "Not written", when it was not created', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      switchOn: true,
      archiveContainerExists: false,
      archived: null,
      blockers: ['archive-container-missing'],
    });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-year-state')).toHaveTextContent(
      'Not known: no container yet'
    );
    expect(screen.getByTestId('archive-readiness')).toHaveTextContent(
      'the archive’s storage container does not exist yet'
    );
    // Even a wrong "archived: false" beside a missing container is not shown as "Not written".
    expect(yearState(false, false)).toBe('Not known: no container yet');
    expect(yearState(false, true)).toBe('Not written');
  });

  it('says where reports are kept and when one is deleted', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      reports: { container: 'cosmos-export-state', prefix: 'state/archive-report/', keepDays: 90 },
    });
    renderAs('super_admin');
    expect(await screen.findByTestId('archive-report-home')).toHaveTextContent(
      'cosmos-export-state storage container, under state/archive-report/, and one older than 90 days is deleted'
    );
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
    expect(waiting[0]).toHaveTextContent(
      '3 record(s) have a field named like a secret or contact details: apiKey, token, and 1 not shown. None of those names would be in the archive.'
    );
    expect(waiting[1]).toHaveTextContent('config_providers: not in the backup');
    // A container an archive would KEEP that still carries such a name is called out above everything else.
    const flagged = screen.getByTestId('archive-flagged');
    expect(flagged).toHaveTextContent('1 container(s) an archive would keep');
    expect(flagged).toHaveTextContent('blogs');
    expect(flagged).toHaveTextContent('3 of them would still carry one in the archive.');
    expect(flagged).not.toHaveTextContent('developer_events');
    const table = screen.getByRole('table', { hidden: true });
    expect(table).toHaveTextContent('developer_events');
    expect(table).toHaveTextContent('5 (speakerName, speakerEmail)');
    expect(table).toHaveTextContent('40 (3 it is a secret, 37 short-lived working state)');
    expect(table).toHaveTextContent('all 2 (it is the access list)');
    // Field names for every container read, not only the unclassified ones.
    expect(table).toHaveTextContent('Fields: id, title');
    expect(table).toHaveTextContent('4 more uses of names that are not shown');
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

  it('says a dry run did not finish, names what is missing, and frees the button', async () => {
    getJSON.mockResolvedValue({
      ...STATUS,
      latest: {
        reportId: 'x',
        complete: false,
        stalled: true,
        sourceRun: '2027-02-07',
        done: 59,
        expected: 61,
        missing: ['content_versions', 'brain_records'],
      },
    });
    renderAs('super_admin');
    const stalled = await screen.findByTestId('archive-stalled');
    expect(stalled).toHaveTextContent('The last dry run did not finish: 59 of 61 containers');
    expect(stalled).toHaveTextContent('Missing: content_versions, brain_records.');
    expect(screen.queryByTestId('archive-progress')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
  });

  it('shows the server’s sentence when a dry run is already reading', async () => {
    postJSON.mockRejectedValue(
      new Error('in_progress — A dry run is still reading the backup. (reference abc)')
    );
    renderAs('super_admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Dry run' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'The dry run did not start',
          description: 'A dry run is still reading the backup.',
        })
      )
    );
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

  it('says nothing about sensitive names when no record has one', () => {
    expect(sensitiveSentence()).toBe('');
    expect(sensitiveSentence({ records: 0, names: [] })).toBe('');
    expect(sensitiveSentence({ records: 2, keptRecords: 0, names: [], namesNotShown: 2 })).toBe(
      '2 record(s) have a field named like a secret or contact details: 2 not shown. None of those names would be in the archive.'
    );
  });
});
