import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@azure/functions', () => ({
  app: { timer: () => {}, http: () => {}, storageQueue: () => {}, cosmosDB: () => {} },
  output: { storageQueue: (options) => ({ type: 'queue', ...options }) },
}));

// The dry run's own reading is tested in lib/backup; here only what the job
// does once a container is read.
const readContainer = vi.fn();
vi.mock('../lib/backup/archive-report.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createReportWorker: () => ({ readContainer }),
  parseReportPayload: (payload) => payload,
}));
const contentArchiveCheck = vi.fn(async () => ({ action: 'started' }));
vi.mock('../lib/backup/archive-check.js', () => ({ contentArchiveCheck }));
vi.mock('../lib/backup/cosmos-export.js', async (importOriginal) => ({
  ...(await importOriginal()),
  exportEnabled: () => true,
}));

const { archiveCheckAfterReport } = await import('./content-archive-http.js');
const { getJobType } = await import('../lib/jobs.js');
const { REPORT_JOB_TYPE } = await import('../lib/backup/archive-report.js');

const payload = { reportId: 'r', runId: '2026-11-22', container: 'content' };
const context = { log: vi.fn() };

describe('the archive dry-run job (#1811)', () => {
  beforeEach(() => {
    readContainer.mockReset();
    contentArchiveCheck.mockClear();
  });

  it('runs the archive’s daily check at once when its part finished the report, with the job’s enqueue', async () => {
    readContainer.mockResolvedValue({ container: 'content', reportWritten: true });
    const enqueue = vi.fn();
    const result = await getJobType(REPORT_JOB_TYPE).worker(payload, { context, signal: undefined, enqueue });
    expect(result).toEqual({ container: 'content', reportWritten: true });
    expect(contentArchiveCheck).toHaveBeenCalledTimes(1);
    expect(contentArchiveCheck).toHaveBeenCalledWith(context, enqueue);
  });

  it('does not run the check while other parts of the report are still to come', async () => {
    readContainer.mockResolvedValue({ container: 'content', reportWritten: false });
    await getJobType(REPORT_JOB_TYPE).worker(payload, { context, signal: undefined, enqueue: vi.fn() });
    expect(contentArchiveCheck).not.toHaveBeenCalled();
  });

  it('leaves the check to the 03:00 UTC timer when too little of the job’s time is left', async () => {
    const check = vi.fn();
    const log = vi.fn();
    const answer = await archiveCheckAfterReport({ log }, vi.fn(), 26 * 60 * 1000, { check, enabled: () => true });
    expect(answer).toEqual({ action: 'left-for-the-timer' });
    expect(check).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('03:00 UTC'));
  });

  it('does not run the check while the nightly export is off, as the timer would not', async () => {
    const check = vi.fn();
    expect(await archiveCheckAfterReport({}, vi.fn(), 0, { check, enabled: () => false })).toEqual({ action: 'export-off' });
    expect(check).not.toHaveBeenCalled();
  });

  it('returns the dry run’s own result even when the check reports a failure', async () => {
    readContainer.mockResolvedValue({ container: 'content', reportWritten: true });
    contentArchiveCheck.mockResolvedValueOnce({ action: 'failed' });
    const result = await getJobType(REPORT_JOB_TYPE).worker(payload, { context, signal: undefined, enqueue: vi.fn() });
    expect(result).toEqual({ container: 'content', reportWritten: true });
  });
});
