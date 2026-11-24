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
  isFlagged,
  kindWords,
  notShownWords,
  reasonWords,
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

  describe('names that look like a secret: taken out, or would remain', () => {
    const remaining = (over) => ({
      document: null,
      records: 1,
      kinds: { 'short-text': 1 },
      quiet: false,
      keptOnPurpose: null,
      flagged: true,
      ...over,
    });
    const part = (container, sensitive, over = {}) => ({
      container,
      decision: 'archive',
      reason: null,
      read: 10,
      kept: 10,
      changed: 0,
      leftOut: 0,
      sensitive: {
        records: 10,
        keptRecords: 10,
        takenOut: [],
        takenOutNotShown: { notPlain: 0, tooMany: 0 },
        remaining: [],
        remainingNotShown: { notPlain: 0, tooMany: 0 },
        flagged: 0,
        ...sensitive,
      },
      ...over,
    });
    const show = async (containers) => {
      getJSON.mockResolvedValue({
        ...STATUS,
        latest: {
          reportId: '20270208T0400Z',
          complete: true,
          report: {
            completedAt: '2027-02-08T04:06:00.000Z',
            sourceBackup: { runId: '2027-02-07' },
            totals: { kept: 1 },
            containers,
            leftOutWhole: [],
          },
        },
      });
      renderAs('super_admin');
      await screen.findByTestId('archive-report');
    };

    it('puts in red only a name that would remain and is not explained, with its path, count and kinds', async () => {
      await show([
        part('brain_records', {
          flagged: 1,
          remaining: [
            remaining({
              path: 'meta.requestHash',
              name: 'requestHash',
              records: 12,
              kinds: { 'short-text': 11, empty: 1 },
            }),
          ],
        }),
        part('ai_usage', {
          remaining: [
            remaining({
              path: 'totalTokens',
              name: 'totalTokens',
              records: 10,
              kinds: { number: 10 },
              quiet: true,
              flagged: false,
            }),
            remaining({
              path: 'emailVerified',
              name: 'emailVerified',
              kinds: { 'yes-no': 10 },
              quiet: true,
              flagged: false,
            }),
          ],
        }),
      ]);
      const flagged = screen.getByTestId('archive-flagged');
      expect(flagged).toHaveTextContent('1 container(s) an archive would keep');
      expect(flagged).toHaveTextContent('brain_records');
      expect(flagged).toHaveTextContent(
        'meta.requestHash in 12 record(s); values seen: short text (under 64 characters) ×11, empty ×1'
      );
      // A container whose such names hold only numbers or yes/no is not in the red block.
      expect(flagged).not.toHaveTextContent('ai_usage');
      expect(flagged).not.toHaveTextContent('totalTokens');
      const table = screen.getByRole('table', { hidden: true });
      expect(
        within(table).getByText(/Named like one, but only numbers or yes\/no/)
      ).toHaveTextContent('totalTokens, emailVerified');
    });

    it('shows a name kept on purpose with its reason, and what is taken out, without red', async () => {
      await show([
        part(
          'mcp_servers',
          {
            keptRecords: 1,
            takenOut: [
              { name: 'oauthToken', records: 3 },
              { name: 'Authorization', records: 1 },
            ],
            takenOutNotShown: { notPlain: 2, tooMany: 0 },
            remaining: [
              remaining({
                path: 'apiKeyEnvVar',
                name: 'apiKeyEnvVar',
                records: 4,
                flagged: false,
                keptOnPurpose: 'the name of the setting a key is read from, never the key itself',
              }),
            ],
          },
          { decision: 'archive-changed' }
        ),
      ]);
      expect(screen.queryByTestId('archive-flagged')).toBeNull();
      const table = screen.getByRole('table', { hidden: true });
      expect(within(table).getByTestId('archive-kept-on-purpose')).toHaveTextContent(
        'Kept on purpose: apiKeyEnvVar in 4 record(s) (the name of the setting a key is read from, never the key itself)'
      );
      expect(within(table).getByTestId('archive-taken-out')).toHaveTextContent(
        'Taken out before archiving: oauthToken (3), Authorization (1); 2 more use(s) of a name that is not shown because it is shaped like an id or typed text'
      );
      expect(within(table).queryByTestId('archive-remaining-flagged')).toBeNull();
    });

    it('names the settings document a remaining field is in', async () => {
      await show([
        part(
          'admin_config',
          {
            flagged: 1,
            remaining: [
              remaining({
                document: 'credential_register',
                path: 'rotated.some-api-token',
                name: 'some-api-token',
                kinds: { date: 1 },
              }),
            ],
          },
          { decision: 'archive-changed' }
        ),
      ]);
      expect(screen.getByTestId('archive-flagged')).toHaveTextContent(
        'credential_register › rotated.some-api-token in 1 record(s); values seen: date-like text ×1'
      );
    });

    it('says how many remaining names cannot be shown and why, in red', async () => {
      await show([part('system', { flagged: 1, remainingNotShown: { notPlain: 7, tooMany: 0 } })]);
      expect(screen.getByTestId('archive-flagged')).toHaveTextContent(
        '7 more use(s) of a name that is not shown because it is shaped like an id or typed text'
      );
    });

    it('for a container that is left out, says the names were found and are not archived', async () => {
      await show([
        part(
          'tool_exports',
          { keptRecords: 0, takenOut: [{ name: 'apiKey', records: 2 }] },
          { decision: 'leave-out', reason: 'unclassified', kept: 0, leftOut: 10 }
        ),
      ]);
      expect(screen.queryByTestId('archive-flagged')).toBeNull();
      expect(screen.getByTestId('archive-taken-out')).toHaveTextContent(
        'Found, and not archived: apiKey (2)'
      );
    });

    it('the small helpers', () => {
      expect(kindWords({ number: 3, 'long-text': 1200 })).toBe('number ×3, long text ×1,200');
      expect(kindWords()).toBe('');
      expect(notShownWords({ notPlain: 0, tooMany: 0 })).toBe('');
      expect(notShownWords({ notPlain: 0, tooMany: 4 })).toContain('more than 2,000 different');
      expect(isFlagged({ sensitive: { remaining: [], flagged: 0, keptRecords: 9 } })).toBe(false);
      expect(isFlagged({ sensitive: { remaining: [{}], flagged: 1 } })).toBe(true);
      // A report from before the lists were split is still read the old way.
      expect(isFlagged({ sensitive: { keptRecords: 2 } })).toBe(true);
      expect(isFlagged({})).toBe(false);
    });
  });
});
