/**
 * search-console-http.js as registered (#1612): the two routes reach the
 * handlers with the Cosmos functions and the queue output, and the
 * sync-search-console job's worker hands the run the job's signal and id and
 * reports each outcome. The run itself (lib/search-console/sync.js) is a stub
 * here, the Cosmos functions are spies behind the real module's other
 * exports, the guard admits everyone, and httpRoute captures the handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  run: vi.fn(),
  createSearchConsoleSync: vi.fn(),
  readDoc: vi.fn(),
  upsertDoc: vi.fn(),
  queryDocs: vi.fn(),
  createDoc: vi.fn(),
  replaceDocIfMatch: vi.fn(),
  registrations: new Map(),
}));
vi.mock('../lib/search-console/sync.js', async (load) => ({
  ...(await load()),
  createSearchConsoleSync: fakes.createSearchConsoleSync,
}));
vi.mock('../lib/auth/http-route.js', async (load) => ({
  ...(await load()),
  httpRoute: (name, options) => fakes.registrations.set(name, options),
}));
vi.mock('../lib/auth/default-guard.js', () => ({
  getDefaultGuard: () => ({
    requireRole: async () => ({ user: { oid: '00000000-0000-0000-0000-000000000002' }, error: null }),
  }),
}));
vi.mock('../lib/cosmos-client.js', async (load) => ({
  ...(await load()),
  readDoc: (...args) => fakes.readDoc(...args),
  upsertDoc: (...args) => fakes.upsertDoc(...args),
  queryDocs: (...args) => fakes.queryDocs(...args),
  createDoc: (...args) => fakes.createDoc(...args),
  replaceDocIfMatch: (...args) => fakes.replaceDocIfMatch(...args),
}));
import { getJobType } from '../lib/jobs.js';
import './search-console-http.js';

const worker = () => getJobType('sync-search-console').worker;
const context = { log: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  fakes.createSearchConsoleSync.mockImplementation(() => ({ run: fakes.run }));
  fakes.readDoc.mockResolvedValue(null);
  fakes.upsertDoc.mockImplementation(async (_container, doc) => doc);
  fakes.queryDocs.mockResolvedValue([]);
  fakes.createDoc.mockImplementation(async (_container, doc) => doc);
  fakes.replaceDocIfMatch.mockImplementation(async (_container, doc) => doc);
  vi.stubEnv('GSC_WIF_AUDIENCE', '//iam.googleapis.com/projects/000000000001/locations/global/workloadIdentityPools/hcw-azure/providers/entra');
  vi.stubEnv('GSC_ENTRA_APP_ID_URI', 'api://00000000-0000-0000-0000-000000000001');
  vi.stubEnv('GSC_SERVICE_ACCOUNT_EMAIL', 'sa-hcw-search-console@example-project.iam.gserviceaccount.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the routes', () => {
  it('GET cms/search-console reads the snapshot', async () => {
    const response = await fakes.registrations.get('cmsSearchConsole').handler({}, context);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).status).toBe('never_run');
    expect(fakes.readDoc).toHaveBeenCalledWith('admin_config', 'search_console_snapshot', 'admin_config');
  });

  it('POST cms/search-console/run writes the job and sends its message through the queue output', async () => {
    const set = vi.fn();
    const response = await fakes.registrations.get('cmsSearchConsoleRun').handler({}, { ...context, extraOutputs: { set } });
    expect(response.status).toBe(202);
    const { jobId } = JSON.parse(response.body);
    expect(set).toHaveBeenCalledWith(expect.anything(), { jobId, type: 'sync-search-console' });
    expect(fakes.upsertDoc).toHaveBeenCalledWith('jobs', expect.objectContaining({ id: jobId, type: 'sync-search-console' }));
    // The queued-job marker was claimed first, on the lease document.
    expect(fakes.createDoc).toHaveBeenCalledWith(
      'admin_config',
      expect.objectContaining({ id: 'search_console_lease', pendingJob: expect.objectContaining({ jobId }) })
    );
  });
});

describe('the sync-search-console job', () => {
  it('runs one sync with the job\'s signal and id, and answers its summary', async () => {
    fakes.run.mockResolvedValueOnce({ status: 'ok', pages: 2, inspected: 2 });
    const signal = new AbortController().signal;
    await expect(worker()({}, { context, signal, job: { id: 'job-1', createdAt: '2026-11-09T12:00:00.000Z' } })).resolves.toEqual({
      status: 'ok',
      pages: 2,
      inspected: 2,
    });
    expect(fakes.createSearchConsoleSync).toHaveBeenCalledWith(
      expect.objectContaining({ log: context, signal, jobId: 'job-1', jobCreatedAt: '2026-11-09T12:00:00.000Z' })
    );
  });

  it('completes with the skip when another run holds the lease', async () => {
    fakes.run.mockResolvedValueOnce({ skipped: 'already_running' });
    await expect(worker()({}, { context })).resolves.toEqual({ skipped: 'already_running' });
    expect(fakes.createSearchConsoleSync).toHaveBeenCalledWith(expect.objectContaining({ jobId: null, jobCreatedAt: null }));
  });

  it('completes with the skip when the run is no longer needed', async () => {
    fakes.run.mockResolvedValueOnce({ skipped: 'superseded' });
    await expect(worker()({}, { context, job: { id: 'job-3', createdAt: 42 } })).resolves.toEqual({ skipped: 'superseded' });
    expect(fakes.createSearchConsoleSync).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-3', jobCreatedAt: null }));
  });

  it('fails with its own sentence when the run failed', async () => {
    fakes.run.mockResolvedValueOnce({ status: 'error' });
    await expect(worker()({}, { context, job: { id: 'job-2' } })).rejects.toThrow(
      'The Search Console run failed; the page shows which step.'
    );
  });
});
