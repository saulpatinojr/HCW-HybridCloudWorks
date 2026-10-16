/**
 * The lab launcher (lab-host/coder/launcher/): the page the site's panes
 * load on Coder's name, which opens code-server inside the pane.
 *
 * It runs with the learner's Coder session, so what it may do is narrow and
 * this holds it there:
 *
 *   1. THE LOGIC, driven with a mocked fetch, clock, frame and navigation:
 *      only allowlisted labs; GET to four paths and ONE write, the start of
 *      the learner's own stopped or cancelled workspace, once per visit,
 *      with the CSRF token read from Coder's own page, falling back to
 *      Coder's workspace page when refused or tokenless and never starting a
 *      failed build blind; a start the running-workspace limit refused (#954)
 *      read from that build's log once, the learner told which lab to stop
 *      with Coder's page for it framed, and this one started once that lab
 *      no longer runs; a visitor with no session is told to sign in above; a
 *      missing workspace shows Coder's own create page once the template is
 *      known to exist, a missing template the site's sentence and never
 *      Coder's page;
 *      the pane moves to code-server only when the build is running, the
 *      agent connected and ready, and code-server healthy, and only to the
 *      one name Coder builds for this workspace, under a fixed suffix; the
 *      wait backs off and ends.
 *   2. THE FILES: no inline script or style, text only through textContent,
 *      nothing else in the directory Caddy serves.
 *   3. THE ROUTE: the launcher's handle comes before Coder's, has the strict
 *      policy and no-store, and no top-level exemption.
 *   4. THE MAP: the workspace names are the site catalogue's, and the lab
 *      ids are the template's.
 *
 * `caddy adapt` on the rendered route, and the answers through Caddy, are
 * in the container rehearsal the pull request records; the visitor wording
 * is in lab-host-visitor-copy.test.mjs.
 *
 * In the CI matrix this runs in the `scripts (operations)` row, whose filter
 * covers lab-host/ and the catalogue.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPS_HOST_SUFFIX,
  CSRF_HEADER,
  CSRF_PAGE_PATH,
  LAB_WORKSPACES,
  ME_PATH,
  MESSAGES,
  POLL,
  SITE_ORIGINS,
  STATES,
  TEMPLATE,
  TEMPLATE_API_PATH,
  assess,
  buildLogsPath,
  buildsApiPath,
  codeServerUrl,
  createPagePath,
  csrfTokenFrom,
  isBlocking,
  limitBlocker,
  limitMessage,
  ownerName,
  refusedStart,
  resolveLab,
  runLauncher,
  startPlan,
  templateVerdict,
  workspaceApiPath,
  workspacePagePath,
} from '../lab-host/coder/launcher/launcher.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const LAUNCHER_DIR = 'lab-host/coder/launcher';
const ROUTE = 'lab-host/ansible/roles/coder/templates/10-coder.caddy.j2';

// ---------------------------------------------------------------------------
// Coder's answers, shaped as v2.37.3 sends them (codersdk.Workspace), with
// only the fields the launcher reads.

const OWNER = 'saulpatinojr';
/** `GET /api/v2/users/me` for that learner, capitals and all, as GitHub gave the name. */
const ME = { id: '3f1c6a2e-5f0b-4b7e-9d1a-0c2b4e6f8a10', username: 'SaulPatinoJr' };
const TFV = 'terraform-validate-walkthrough';

const WORKSPACE_ID = '0b7e1f3a-5c2d-4e8f-9a1b-2c3d4e5f6a7b';
const ACTIVE_VERSION = 'd4c3b2a1-0f9e-4d8c-b7a6-5f4e3d2c1b0a';

function workspace({
  status = 'running',
  agentStatus = 'connected',
  lifecycle = 'ready',
  health = 'healthy',
  subdomainName = `code-server--lab-tfv--${OWNER}`,
  subdomain = true,
  apps,
  outdated = false,
  buildId,
  transition = 'start',
  id = WORKSPACE_ID,
  name = 'lab-tfv',
} = {}) {
  return {
    id,
    name,
    outdated,
    template_active_version_id: ACTIVE_VERSION,
    latest_build: {
      ...(buildId === undefined ? {} : { id: buildId }),
      status,
      transition,
      resources: [
        { name: 'workspace', agents: [] },
        {
          name: 'main',
          agents: [
            {
              name: 'main',
              status: agentStatus,
              lifecycle_state: lifecycle,
              apps: apps ?? [
                { slug: 'terminal', health: 'disabled', subdomain: false },
                { slug: 'code-server', health, subdomain, subdomain_name: subdomainName },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** `GET /api/v2/organizations/default/templates/hcw-lab`, shaped as codersdk.Template, with the fields the launcher reads. */
const HCW_LAB = { id: '6b0e2f4c-2d7a-4c1e-9a53-1f0d2c3b4a59', name: 'hcw-lab', organization_name: 'coder', deprecated: false };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/**
 * One scripted answer: a body (200), a number (that status, no body), an
 * Error (the fetch rejects), or `'bad-json'` (a 200 whose body does not parse).
 */
function answer(spec) {
  if (spec instanceof Error) throw spec;
  if (spec === 'bad-json') return { ok: true, status: 200, json: async () => JSON.parse('{') };
  return typeof spec === 'number' ? json(spec, {}) : json(200, spec);
}

/** Coder's index page, as the launcher reads the CSRF token from it. */
const CSRF_TOKEN = 'JXm9hOUdZctWt0ZZGAy9xiS/gxMKYOThdxjjMnMUyn4=';
const CODER_PAGE = `<!doctype html><html><head><meta property="csrf-token" content="${CSRF_TOKEN}" /></head><body></body></html>`;
const page = (html) => ({ ok: true, status: 200, text: async () => html });

/**
 * A launcher run against a scripted Coder. `me` answers /users/me; `reads`
 * answers the workspace reads in order, `templates` the template reads,
 * `logs` the build-log reads, `others` the reads of any other workspace of
 * the learner's and `builds` the start POSTs, the last of each repeating
 * (see `answer`); `csrfPage` is what GET / answers (a page, or a status).
 */
async function launch({
  search = `?lab=${TFV}`,
  me = ME,
  reads = [404],
  templates = [HCW_LAB],
  logs = [[]],
  others = [404],
  builds = [201],
  csrfPage = CODER_PAGE,
  poll = POLL,
} = {}) {
  let clock = 0;
  const calls = [];
  const says = [];
  const frames = [];
  const posts = [];
  const navigations = [];
  const sleeps = [];
  // Requests and frame changes in the order they happened.
  const events = [];
  const next = { reads: 0, templates: 0, logs: 0, others: 0, builds: 0 };
  const scripted = (list, key) => {
    const spec = list[Math.min(next[key], list.length - 1)];
    next[key] += 1;
    return answer(spec);
  };

  const fetch = async (url, init) => {
    calls.push({ url, init });
    events.push([init?.method ?? 'GET', url]);
    if (url === CSRF_PAGE_PATH) return typeof csrfPage === 'number' ? answer(csrfPage) : page(csrfPage);
    if (init?.method === 'POST') return scripted(builds, 'builds');
    if (url === ME_PATH) return answer(me);
    if (url === TEMPLATE_API_PATH) return scripted(templates, 'templates');
    if (url.startsWith('/api/v2/workspacebuilds/')) return scripted(logs, 'logs');
    if (url !== workspaceApiPath('lab-tfv') && url.startsWith('/api/v2/users/me/workspace/')) {
      return scripted(others, 'others');
    }
    return scripted(reads, 'reads');
  };

  const end = await runLauncher({
    search,
    fetch,
    ui: {
      say: (text) => says.push(text),
      frame: (p) => {
        frames.push(p);
        events.push(['frame', p]);
      },
    },
    post: (state) => posts.push(state),
    navigate: (url) => navigations.push(url),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    poll,
  });
  return { end, calls, events, says, frames, posts, navigations, sleeps, clock };
}

// ---------------------------------------------------------------------------

describe('the allowlist', () => {
  it('maps each lab to a short workspace name Coder accepts', () => {
    for (const [lab, name] of Object.entries(LAB_WORKSPACES)) {
      expect(lab).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name, lab).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(name.length, lab).toBeLessThanOrEqual(16);
      // code-server--<workspace>--<owner>, with a 32-character Coder username, is one DNS label.
      expect(`code-server--${name}--${'u'.repeat(32)}`.length).toBeLessThanOrEqual(63);
    }
    const names = Object.values(LAB_WORKSPACES);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.isFrozen(LAB_WORKSPACES)).toBe(true);
  });

  it('takes exactly one known lab from the query, and nothing else', () => {
    expect(resolveLab(`?lab=${TFV}`)).toEqual({ lab: TFV, workspace: 'lab-tfv' });
    expect(resolveLab('?lab=landing-zone-builder-output&x=1')).toEqual({
      lab: 'landing-zone-builder-output',
      workspace: 'lab-lzb',
    });
    for (const search of [
      '',
      '?',
      '?lab=',
      '?lab=no-such-lab',
      `?lab=${TFV}&lab=${TFV}`,
      '?lab=__proto__',
      '?lab=constructor',
      '?lab=hasOwnProperty',
      `?lab=${TFV.toUpperCase()}`,
      `?lab=${TFV}%00`,
      '?lab=<script>alert(1)</script>',
      undefined,
    ]) {
      expect(resolveLab(search), String(search)).toBeNull();
    }
  });

  it('builds Coder paths from its own values only', () => {
    expect(workspaceApiPath('lab-tfv')).toBe('/api/v2/users/me/workspace/lab-tfv');
    expect(createPagePath(TFV, 'lab-tfv')).toBe(
      `/templates/hcw-lab/workspace?mode=auto&name=lab-tfv&param.lab=${TFV}`
    );
    expect(workspacePagePath('lab-tfv')).toBe('/@me/lab-tfv');
  });

  it('reads the template where Coder’s create page reads it: the default organization, by name', () => {
    // site/src/pages/CreateWorkspacePage (v2.37.3): organization defaults to "default".
    expect(TEMPLATE_API_PATH).toBe('/api/v2/organizations/default/templates/hcw-lab');
    expect(createPagePath(TFV, 'lab-tfv')).toMatch(new RegExp(`^/templates/${TEMPLATE}/workspace\\?`));
  });
});

describe('templateVerdict', () => {
  it('is ok for the template, when Coder takes new workspaces from it', () => {
    expect(templateVerdict({ kind: 'ok', body: HCW_LAB })).toBe('ok');
  });

  it.each([
    ['missing, or not the learner’s to read (404)', { kind: 'missing' }],
    ['another template', { kind: 'ok', body: { ...HCW_LAB, name: 'docker' } }],
    ['deprecated', { kind: 'ok', body: { ...HCW_LAB, deprecated: true } }],
    ['a body that is not a template', { kind: 'ok', body: null }],
    ['an empty body', { kind: 'ok', body: {} }],
  ])('is unavailable when the template is %s', (_label, result) => {
    expect(templateVerdict(result)).toBe('unavailable');
  });

  it('passes a lost session and a failed read through', () => {
    expect(templateVerdict({ kind: 'signed-out' })).toBe('signed-out');
    expect(templateVerdict({ kind: 'error' })).toBe('error');
  });
});

describe('ownerName', () => {
  it('is the signed-in username, lowercased', () => {
    expect(ownerName(ME)).toBe(OWNER);
    expect(ownerName({ username: 'a-b-9' })).toBe('a-b-9');
  });

  it.each([
    ['no body', null],
    ['no username', {}],
    ['a number', { username: 42 }],
    ['nothing', { username: '' }],
    ['a double hyphen, which Coder never makes', { username: 'a--b' }],
    ['a leading hyphen', { username: '-a' }],
    ['a dot', { username: 'a.b' }],
    ['a non-ASCII letter', { username: 'sömeone' }],
  ])('refuses %s', (_label, me) => {
    expect(ownerName(me)).toBeNull();
  });
});

describe('codeServerUrl', () => {
  const app = (subdomain_name, extra = {}) => ({ slug: 'code-server', subdomain: true, subdomain_name, ...extra });

  it('is the learner’s own code-server for this workspace, under the fixed suffix', () => {
    expect(APPS_HOST_SUFFIX).toBe('.coder.lab.hybridcloudworks.com');
    expect(codeServerUrl(app(`code-server--lab-tfv--${OWNER}`), 'lab-tfv', OWNER)).toBe(
      `https://code-server--lab-tfv--${OWNER}.coder.lab.hybridcloudworks.com/`
    );
    // A Coder username may carry capitals; a host name is case-insensitive.
    expect(codeServerUrl(app('code-server--lab-tfv--SaulPatinoJr'), 'lab-tfv', OWNER)).toBe(
      'https://code-server--lab-tfv--saulpatinojr.coder.lab.hybridcloudworks.com/'
    );
  });

  it.each([
    ['another learner’s code-server for the same lab', 'code-server--lab-tfv--someone'],
    ['an owner that only ends with the learner’s name', `code-server--lab-tfv--x--${OWNER}`],
    ['another workspace', `code-server--lab-lzb--${OWNER}`],
    ['another app', `terminal--lab-tfv--${OWNER}`],
    ['a longer workspace name that starts the same', `code-server--lab-tfvx--${OWNER}`],
    ['an agent segment, which v2.37.3 does not build for a named app', `code-server--main--lab-tfv--${OWNER}`],
    ['a dot, which would leave the suffix', `code-server--lab-tfv--${OWNER}.evil.example`],
    ['a slash', `code-server--lab-tfv--${OWNER}/x`],
    ['a port', `code-server--lab-tfv--${OWNER}:8443`],
    ['an at sign', `code-server--lab-tfv--${OWNER}@evil.example`],
    ['a space', `code-server--lab-tfv--${OWNER} `],
    ['no owner', 'code-server--lab-tfv--'],
    ['nothing', ''],
    ['a non-ASCII letter', 'code-server--lab-tfv--sömeone'],
  ])('refuses %s', (_label, name) => {
    expect(codeServerUrl(app(name), 'lab-tfv', OWNER)).toBeNull();
  });

  it('refuses a label over 63 characters even for the learner’s own name', () => {
    const long = 'a'.repeat(42);
    expect(codeServerUrl(app(`code-server--lab-tfv--${long}`), 'lab-tfv', long)).toBeNull();
  });

  it('refuses everything without a learner to match', () => {
    for (const owner of [null, undefined, '', 'a--b', 'Saul']) {
      expect(codeServerUrl(app(`code-server--lab-tfv--${owner}`), 'lab-tfv', owner)).toBeNull();
    }
  });

  it('refuses an app that is not a subdomain app, or has no name', () => {
    expect(codeServerUrl(app(`code-server--lab-tfv--${OWNER}`, { subdomain: false }), 'lab-tfv', OWNER)).toBeNull();
    expect(codeServerUrl({ slug: 'code-server', subdomain: true, subdomain_name: 42 }, 'lab-tfv', OWNER)).toBeNull();
    expect(codeServerUrl(null, 'lab-tfv', OWNER)).toBeNull();
  });
});

describe('assess', () => {
  it.each([
    ['pending', 'starting'],
    ['starting', 'starting'],
    ['stopping', 'starting'],
    ['canceling', 'starting'],
    ['deleting', 'starting'],
    ['something new', 'starting'],
    ['stopped', 'stopped'],
    ['failed', 'stopped'],
    ['canceled', 'stopped'],
    ['deleted', 'create'],
  ])('a latest build %s is %s', (status, state) => {
    // A stopped or cancelled build also carries its start plan (tested below).
    expect(assess(workspace({ status }), 'lab-tfv', OWNER)).toMatchObject({ state });
  });

  it.each([
    ['the agent still connecting', { agentStatus: 'connecting' }],
    ['the agent disconnected', { agentStatus: 'disconnected' }],
    ['the startup script still running', { lifecycle: 'starting' }],
    ['code-server initializing', { health: 'initializing' }],
    ['code-server unhealthy', { health: 'unhealthy' }],
    ['code-server with no health check', { health: 'disabled' }],
    ['no code-server app yet', { apps: [] }],
  ])('running with %s is still starting', (_label, over) => {
    expect(assess(workspace(over), 'lab-tfv', OWNER)).toEqual({ state: 'starting' });
  });

  it('sends a startup script that failed to the workspace page, where Restart is', () => {
    expect(assess(workspace({ lifecycle: 'start_error' }), 'lab-tfv', OWNER)).toEqual({ state: 'stopped' });
  });

  it('is ready only when all three hold, with the checked address', () => {
    expect(assess(workspace(), 'lab-tfv', OWNER)).toEqual({
      state: 'ready',
      url: `https://code-server--lab-tfv--${OWNER}.coder.lab.hybridcloudworks.com/`,
    });
  });

  it('is unavailable, not ready, when Coder’s name for code-server is not the shape it builds', () => {
    expect(assess(workspace({ subdomainName: 'code-server--lab-tfv--x.evil.example' }), 'lab-tfv', OWNER)).toEqual({
      state: 'unavailable',
    });
  });

  it('waits on a body that is not a workspace, rather than guessing', () => {
    for (const body of [null, {}, { latest_build: null }, { latest_build: { status: 'running', resources: 'x' } }]) {
      expect(assess(body, 'lab-tfv', OWNER)).toEqual({ state: 'starting' });
    }
  });
});

describe('runLauncher', () => {
  it('refuses a lab it does not know, before any request', async () => {
    const run = await launch({ search: '?lab=no-such-lab' });
    expect(run.end).toBe('unavailable');
    expect(run.calls).toEqual([]);
    expect(run.says).toEqual([MESSAGES['unknown-lab']]);
    expect(run.posts).toEqual(['unavailable']);
    expect(run.navigations).toEqual([]);
  });

  it('asks a visitor with no session to sign in above, and reads nothing else', async () => {
    const run = await launch({ me: 401 });
    expect(run.end).toBe('signed-out');
    expect(run.calls.map((c) => c.url)).toEqual([ME_PATH]);
    expect(run.says.at(-1)).toBe(MESSAGES['signed-out']);
    expect(run.says.at(-1)).toMatch(/Sign in with GitHub above/);
    expect(run.posts).toEqual(['checking', 'signed-out']);
    expect(run.frames).toEqual([]);
  });

  it('sends only GETs, same origin, to the three API paths', async () => {
    const run = await launch({ reads: [404, workspace({ status: 'starting' }), workspace()] });
    const paths = new Set(run.calls.map((c) => c.url));
    expect([...paths].sort()).toEqual([ME_PATH, workspaceApiPath('lab-tfv'), TEMPLATE_API_PATH].sort());
    for (const { init } of run.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      expect(init).not.toHaveProperty('body');
    }
  });

  it('shows Coder’s own create page for a workspace that does not exist, then opens the editor', async () => {
    const run = await launch({ reads: [404, 404, workspace({ status: 'pending' }), workspace({ status: 'starting' }), workspace({ health: 'initializing' }), workspace()] });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual([createPagePath(TFV, 'lab-tfv')]);
    expect(run.posts).toEqual(['checking', 'create', 'starting', 'ready']);
    expect(run.says).toContain(MESSAGES.create);
    expect(run.says).toContain(MESSAGES.starting);
    expect(run.says.at(-1)).toBe(MESSAGES.ready);
    expect(run.navigations).toEqual([`https://code-server--lab-tfv--${OWNER}.coder.lab.hybridcloudworks.com/`]);
  });

  it('reads the template once, after the workspace read and before Coder’s create page is framed', async () => {
    const run = await launch({ reads: [404, 404, 404, workspace()] });
    expect(run.events.slice(0, 4)).toEqual([
      ['GET', ME_PATH],
      ['GET', workspaceApiPath('lab-tfv')],
      ['GET', TEMPLATE_API_PATH],
      ['frame', createPagePath(TFV, 'lab-tfv')],
    ]);
    expect(run.calls.filter((c) => c.url === TEMPLATE_API_PATH)).toHaveLength(1);
    expect(run.frames).toEqual([createPagePath(TFV, 'lab-tfv')]);
    expect(run.end).toBe('ready');
  });

  it.each([
    ['missing (404)', 404],
    ['another template', { ...HCW_LAB, name: 'docker' }],
    ['deprecated', { ...HCW_LAB, deprecated: true }],
  ])('says the site’s sentence and never loads Coder’s page when the template is %s', async (_label, template) => {
    const run = await launch({ reads: [404], templates: [template] });
    expect(run.end).toBe('unavailable');
    // Coder's create page, with its red "Resource not found" box, is never framed.
    expect(run.frames).toEqual([]);
    expect(run.says).toEqual([MESSAGES.checking, MESSAGES.unavailable]);
    expect(run.posts).toEqual(['checking', 'unavailable']);
    expect(run.navigations).toEqual([]);
    expect(run.sleeps).toEqual([]);
  });

  it('checks the template for a workspace whose last build deleted it too', async () => {
    const run = await launch({ reads: [workspace({ status: 'deleted' })], templates: [404] });
    expect(run.end).toBe('unavailable');
    expect(run.frames).toEqual([]);
    expect(run.calls.map((c) => c.url)).toContain(TEMPLATE_API_PATH);
  });

  it.each([
    ['running', [workspace()]],
    ['stopped', [workspace({ status: 'stopped' }), workspace()]],
    ['starting', [workspace({ status: 'starting' }), workspace()]],
  ])('never reads the template for a workspace that exists (%s)', async (_label, reads) => {
    const run = await launch({ reads, templates: [404] });
    expect(run.end).toBe('ready');
    expect(run.calls.map((c) => c.url)).not.toContain(TEMPLATE_API_PATH);
  });

  it('retries a template read that fails, and counts it toward giving up', async () => {
    const recovered = await launch({ reads: [404, 404, 404, workspace()], templates: [500, new TypeError('Failed to fetch'), HCW_LAB] });
    expect(recovered.end).toBe('ready');
    expect(recovered.frames).toEqual([createPagePath(TFV, 'lab-tfv')]);
    expect(recovered.calls.filter((c) => c.url === TEMPLATE_API_PATH)).toHaveLength(3);
    const outage = await launch({ reads: [404], templates: [502] });
    expect(outage.end).toBe('unavailable');
    expect(outage.frames).toEqual([]);
    expect(outage.calls.filter((c) => c.url === TEMPLATE_API_PATH)).toHaveLength(POLL.maxErrors);
  });

  it('stops at once when the session ends at the template read', async () => {
    const run = await launch({ reads: [404], templates: [401] });
    expect(run.end).toBe('signed-out');
    expect(run.frames).toEqual([]);
    expect(run.says.at(-1)).toBe(MESSAGES['signed-out']);
  });

  it('starts a stopped workspace itself, with the CSRF token from Coder’s page, and waits for it', async () => {
    const run = await launch({ reads: [workspace({ status: 'stopped' }), workspace({ status: 'starting' }), workspace()] });
    expect(run.end).toBe('ready');
    // No Coder page is framed and no click is asked for.
    expect(run.frames).toEqual([]);
    expect(run.posts).toEqual(['checking', 'starting', 'ready']);
    expect(run.says).not.toContain(MESSAGES.stopped);
    const start = run.calls.find((c) => c.init?.method === 'POST');
    expect(start.url).toBe(buildsApiPath(WORKSPACE_ID));
    expect(start.init.headers[CSRF_HEADER]).toBe(CSRF_TOKEN);
    expect(start.init.credentials).toBe('same-origin');
    expect(JSON.parse(start.init.body)).toEqual({ transition: 'start' });
    // The page was read before the start, and only then.
    expect(run.events.map(([m, u]) => `${m} ${u}`)).toEqual(
      expect.arrayContaining([`GET ${CSRF_PAGE_PATH}`, `POST ${buildsApiPath(WORKSPACE_ID)}`])
    );
    expect(run.calls.filter((c) => c.url === CSRF_PAGE_PATH)).toHaveLength(1);
    expect(run.navigations).toHaveLength(1);
  });

  it('starts an outdated workspace on the template’s active version, so a template change reaches every lab', async () => {
    const run = await launch({ reads: [workspace({ status: 'stopped', outdated: true }), workspace()] });
    expect(run.end).toBe('ready');
    const start = run.calls.find((c) => c.init?.method === 'POST');
    expect(JSON.parse(start.init.body)).toEqual({ transition: 'start', template_version_id: ACTIVE_VERSION });
  });

  it('falls back to Coder’s own workspace page, where Start is, when Coder refuses the start — once per visit', async () => {
    const run = await launch({
      reads: [workspace({ status: 'stopped' }), workspace({ status: 'stopped' }), workspace({ status: 'starting' }), workspace()],
      builds: [403],
    });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual(['/@me/lab-tfv']);
    expect(run.posts).toEqual(['checking', 'stopped', 'starting', 'ready']);
    expect(run.says).toContain(MESSAGES.stopped);
    expect(run.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
  });

  it('falls back the same way when Coder’s page carries no CSRF token, and never posts without one', async () => {
    const run = await launch({
      reads: [workspace({ status: 'stopped' }), workspace({ status: 'starting' }), workspace()],
      csrfPage: '<!doctype html><html><head></head><body>no token here</body></html>',
    });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual(['/@me/lab-tfv']);
    expect(run.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
    const unreadable = await launch({ reads: [workspace({ status: 'stopped' }), workspace()], csrfPage: 503 });
    expect(unreadable.frames).toEqual(['/@me/lab-tfv']);
    expect(unreadable.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
  });

  it('never starts a failed build blind: its page carries the reason and Retry', async () => {
    const run = await launch({ reads: [workspace({ status: 'failed' }), workspace({ status: 'starting' }), workspace()] });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual(['/@me/lab-tfv']);
    expect(run.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
  });

  it('plans a start only for a stopped or cancelled build of a workspace with an id, reading the token from the meta tag', () => {
    expect(startPlan(workspace({ status: 'stopped' }))).toEqual({ path: buildsApiPath(WORKSPACE_ID), body: { transition: 'start' } });
    expect(startPlan(workspace({ status: 'canceled', outdated: true }))).toEqual({
      path: buildsApiPath(WORKSPACE_ID),
      body: { transition: 'start', template_version_id: ACTIVE_VERSION },
    });
    expect(startPlan(workspace({ status: 'failed' }))).toBeNull();
    expect(startPlan(workspace({ status: 'running' }))).toBeNull();
    expect(startPlan({ ...workspace({ status: 'stopped' }), id: '' })).toBeNull();
    expect(assess(workspace({ status: 'stopped' }), 'lab-tfv', OWNER)).toEqual({
      state: 'stopped',
      start: { path: buildsApiPath(WORKSPACE_ID), body: { transition: 'start' } },
    });
    expect(assess(workspace({ status: 'failed' }), 'lab-tfv', OWNER)).toEqual({ state: 'stopped' });
    expect(csrfTokenFrom(CODER_PAGE)).toBe(CSRF_TOKEN);
    expect(csrfTokenFrom('<meta property="csrf-token" content="">')).toBeNull();
    expect(csrfTokenFrom('<meta name="description" content="x">')).toBeNull();
    expect(csrfTokenFrom(null)).toBeNull();
  });

  it('waits on a workspace that is already starting, with no frame of Coder’s', async () => {
    const run = await launch({ reads: [workspace({ status: 'starting' }), workspace({ agentStatus: 'connecting' }), workspace({ lifecycle: 'starting' }), workspace()] });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual([]);
    expect(run.posts).toEqual(['checking', 'starting', 'ready']);
  });

  it('opens a healthy workspace straight away', async () => {
    const run = await launch({ reads: [workspace()] });
    expect(run.end).toBe('ready');
    expect(run.sleeps).toEqual([]);
    expect(run.posts).toEqual(['checking', 'ready']);
  });

  it('never navigates to a malformed name, and says the workspaces are unavailable', async () => {
    for (const subdomainName of ['code-server--lab-tfv--x.evil.example', 'code-server--lab-lzb--someone', '']) {
      const run = await launch({ reads: [workspace({ subdomainName })] });
      expect(run.end).toBe('unavailable');
      expect(run.navigations).toEqual([]);
      expect(run.says.at(-1)).toBe(MESSAGES.unavailable);
      expect(run.posts.at(-1)).toBe('unavailable');
    }
  });

  it('takes the frame away when it gives up', async () => {
    const run = await launch({ reads: [404, 500], poll: { ...POLL, maxErrors: 2 } });
    expect(run.end).toBe('unavailable');
    expect(run.frames).toEqual([createPagePath(TFV, 'lab-tfv'), null]);
  });

  it('backs off from one second to five, and stops at the cap', async () => {
    const run = await launch({ reads: [workspace({ status: 'starting' })] });
    expect(run.end).toBe('unavailable');
    expect(run.sleeps.slice(0, 6)).toEqual([1000, 1500, 2250, 3375, 5000, 5000]);
    expect(Math.max(...run.sleeps)).toBe(POLL.maxDelayMs);
    expect(run.clock).toBeGreaterThanOrEqual(POLL.capMs);
    expect(run.clock).toBeLessThan(POLL.capMs + POLL.maxDelayMs * 2);
    expect(run.says.at(-1)).toBe(MESSAGES.unavailable);
    expect(run.posts).toEqual(['checking', 'starting', 'unavailable']);
    expect(run.navigations).toEqual([]);
  });

  it('gives up after six failed reads in a row, however they fail', async () => {
    for (const failure of [500, 502, new TypeError('Failed to fetch'), 'bad-json']) {
      const run = await launch({ reads: [failure] });
      expect(run.end).toBe('unavailable');
      expect(run.calls.filter((c) => c.url !== ME_PATH)).toHaveLength(POLL.maxErrors);
    }
    const noSession = await launch({ me: new TypeError('Failed to fetch') });
    expect(noSession.end).toBe('unavailable');
    expect(noSession.calls).toHaveLength(POLL.maxErrors);
  });

  it('forgives a failed read that is followed by a good one', async () => {
    const reads = [500, 500, 500, 500, 500, workspace({ status: 'starting' }), 500, 500, 500, 500, 500, workspace()];
    const run = await launch({ reads });
    expect(run.end).toBe('ready');
  });

  it('opens only the signed-in learner’s own editor, never another learner’s', async () => {
    const run = await launch({ reads: [workspace({ subdomainName: 'code-server--lab-tfv--someone' })] });
    expect(run.end).toBe('unavailable');
    expect(run.navigations).toEqual([]);
  });

  it('counts a session whose username it cannot use as a failed read, and reads no workspace', async () => {
    for (const me of [{}, { username: 'a--b' }, 'bad-json']) {
      const run = await launch({ me, reads: [workspace()] });
      expect(run.end).toBe('unavailable');
      expect(run.calls.map((c) => c.url)).toEqual(Array(POLL.maxErrors).fill(ME_PATH));
      expect(run.navigations).toEqual([]);
    }
  });

  it('stops at once when the session ends while it waits', async () => {
    const run = await launch({ reads: [workspace({ status: 'starting' }), 401] });
    expect(run.end).toBe('signed-out');
    expect(run.posts).toEqual(['checking', 'starting', 'signed-out']);
  });

  it('posts each state once, and only the states the site knows', async () => {
    const run = await launch({ reads: [404, 404, 404, workspace({ status: 'starting' }), workspace({ status: 'starting' }), workspace()] });
    expect(run.posts).toEqual(['checking', 'create', 'starting', 'ready']);
    for (const state of run.posts) expect(STATES).toContain(state);
  });
});

// ---------------------------------------------------------------------------
// The running-workspace limit (#954): every template refuses a start while
// another of the learner's workspaces is starting or running, and Coder logs
// the refusal on the failed build.

const REFUSED_BUILD = '5e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b';
const OTHER_ID = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
/**
 * The log Coder v2.38.0 keeps for a start the precondition refused: the
 * diagnostic's summary, its snippet and its detail, each a line of its own
 * at error level. The detail is the text `terraform plan -json` gave for
 * the template's precondition on 2026-10-16.
 */
const REFUSAL_LOG = [
  { id: 1, log_level: 'info', stage: 'Planning infrastructure', output: 'data.http.owner_workspaces[0]: Refreshing...' },
  { id: 2, log_level: 'error', stage: 'Planning infrastructure', output: 'Error: Resource precondition failed' },
  {
    id: 3,
    log_level: 'error',
    stage: 'Planning infrastructure',
    output: 'on main.tf line 628, in resource "docker_container" "workspace":',
  },
  {
    id: 4,
    log_level: 'error',
    stage: 'Planning infrastructure',
    output: 'Only one lab workspace can run at a time. Stop your other lab first: lab-lzb.',
  },
];
/** This lab's workspace, its last start refused. */
const refused = (buildId = REFUSED_BUILD) => workspace({ status: 'failed', buildId });
/** The learner's other lab. */
const lzb = (status, transition = 'start') =>
  workspace({ status, transition, id: OTHER_ID, name: 'lab-lzb', subdomainName: `code-server--lab-lzb--${OWNER}` });
const errorLine = (output) => [{ log_level: 'error', output }];
const posted = (run) => run.calls.filter((c) => c.init?.method === 'POST');
const EDITOR = `https://code-server--lab-tfv--${OWNER}.coder.lab.hybridcloudworks.com/`;

describe('the running-workspace limit (#954)', () => {
  it('takes the lab to stop from the refusal Coder logs, and nothing else', () => {
    expect(limitBlocker(REFUSAL_LOG)).toBe('lab-lzb');
    expect(limitBlocker(errorLine('Stop your other lab first: lab-lzb, lab-asc.'))).toBe('lab-lzb');
    expect(limitBlocker(errorLine('Stop your other lab first: My-Lab-2.'))).toBe('My-Lab-2');
    // Only a Coder workspace name is taken: the match ends at anything else.
    expect(limitBlocker(errorLine('Stop your other lab first: lab-lzb/../../x'))).toBe('lab-lzb');
    for (const logs of [
      [],
      null,
      'Stop your other lab first: lab-lzb.',
      [{ log_level: 'info', output: 'Stop your other lab first: lab-lzb.' }],
      errorLine('Error: Resource precondition failed'),
      errorLine('Stop your other lab first: '),
      errorLine('Stop your other lab first: <img src=x>'),
      errorLine('Stop your other lab first: -lab'),
      errorLine(`Stop your other lab first: ${'a'.repeat(33)}.`),
      [{ log_level: 'error', output: 42 }],
      [null],
    ]) {
      expect(limitBlocker(logs), JSON.stringify(logs)).toBeNull();
    }
    expect(buildLogsPath(REFUSED_BUILD)).toBe(`/api/v2/workspacebuilds/${REFUSED_BUILD}/logs`);
  });

  it('counts a workspace as the templates do: a start that is queued, under way or done', () => {
    for (const status of ['pending', 'starting', 'running']) expect(isBlocking(lzb(status)), status).toBe(true);
    for (const status of ['stopped', 'failed', 'canceled', 'deleted']) expect(isBlocking(lzb(status)), status).toBe(false);
    for (const status of ['pending', 'stopping', 'stopped']) expect(isBlocking(lzb(status, 'stop')), status).toBe(false);
    expect(isBlocking(null)).toBe(false);
    expect(isBlocking({})).toBe(false);
  });

  it('takes only a failed start with a build id for a possible refusal', () => {
    expect(refusedStart(refused())).toEqual({
      buildId: REFUSED_BUILD,
      retry: { path: buildsApiPath(WORKSPACE_ID), body: { transition: 'start' } },
    });
    expect(refusedStart(workspace({ status: 'failed', buildId: REFUSED_BUILD, outdated: true })).retry.body).toEqual({
      transition: 'start',
      template_version_id: ACTIVE_VERSION,
    });
    expect(refusedStart(workspace({ status: 'failed' }))).toBeNull();
    expect(refusedStart(workspace({ status: 'failed', buildId: REFUSED_BUILD, transition: 'stop' }))).toBeNull();
    expect(refusedStart(workspace({ status: 'stopped', buildId: REFUSED_BUILD }))).toBeNull();
    expect(refusedStart({ ...refused(), id: '' })).toBeNull();
    expect(assess(refused(), 'lab-tfv', OWNER)).toEqual({ state: 'stopped', refused: refusedStart(refused()) });
  });

  it('says which lab to stop, and frames Coder’s page for it, where Stop is, while it runs', async () => {
    const run = await launch({
      reads: [refused()],
      logs: [REFUSAL_LOG],
      others: [lzb('running')],
      poll: { ...POLL, capMs: 20_000 },
    });
    // The learner never stopped it, so the wait ends at the cap.
    expect(run.end).toBe('unavailable');
    expect(run.frames).toEqual(['/@me/lab-lzb', null]);
    expect(limitMessage('lab-lzb')).toBe(
      'Only one of your lab workspaces runs at a time, and lab-lzb is running. Stop it on the page below, and this lab starts.'
    );
    expect(run.says).toContain(limitMessage('lab-lzb'));
    // The site hears a state it knows: this lab is not running.
    expect(run.posts).toEqual(['checking', 'stopped', 'unavailable']);
    // The log is read once for the build, however long the wait.
    expect(run.calls.filter((c) => c.url === buildLogsPath(REFUSED_BUILD))).toHaveLength(1);
    expect(run.calls.filter((c) => c.url === workspaceApiPath('lab-lzb')).length).toBeGreaterThan(1);
    expect(posted(run)).toHaveLength(0);
    for (const { init } of run.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    }
  });

  it('starts this lab once the other one stops, with no click, and only this lab', async () => {
    const run = await launch({
      reads: [refused(), refused(), workspace({ status: 'starting' }), workspace()],
      logs: [REFUSAL_LOG],
      others: [lzb('running'), lzb('stopping', 'stop')],
    });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual(['/@me/lab-lzb', null]);
    expect(run.posts).toEqual(['checking', 'stopped', 'starting', 'ready']);
    const starts = posted(run);
    expect(starts).toHaveLength(1);
    expect(starts[0].url).toBe(buildsApiPath(WORKSPACE_ID));
    expect(starts[0].init.headers[CSRF_HEADER]).toBe(CSRF_TOKEN);
    expect(JSON.parse(starts[0].init.body)).toEqual({ transition: 'start' });
    expect(run.calls.some((c) => c.url.includes(OTHER_ID))).toBe(false);
    expect(run.navigations).toEqual([EDITOR]);
  });

  it('starts it straight away when the other lab stopped, or was deleted, since the refusal', async () => {
    for (const other of [lzb('stopped', 'stop'), lzb('failed'), 404]) {
      const run = await launch({
        reads: [refused(), workspace({ status: 'starting' }), workspace()],
        logs: [REFUSAL_LOG],
        others: [other],
      });
      expect(run.end).toBe('ready');
      expect(run.frames).toEqual([]);
      expect(run.posts).toEqual(['checking', 'starting', 'ready']);
      expect(posted(run)).toHaveLength(1);
    }
  });

  it('starts at most once a visit, and then leaves Retry to Coder’s page', async () => {
    const run = await launch({
      reads: [refused(), refused('second-build'), workspace({ status: 'starting' }), workspace()],
      logs: [REFUSAL_LOG, REFUSAL_LOG],
      others: [lzb('stopped', 'stop')],
    });
    expect(run.end).toBe('ready');
    expect(posted(run)).toHaveLength(1);
    // The second build's log is its own read.
    expect(run.calls.filter((c) => c.url === buildLogsPath('second-build'))).toHaveLength(1);
    expect(run.frames).toEqual(['/@me/lab-tfv']);
    expect(run.posts).toEqual(['checking', 'starting', 'stopped', 'starting', 'ready']);
  });

  it('falls back to Coder’s page with Retry when Coder refuses the start', async () => {
    const run = await launch({
      reads: [refused(), refused(), workspace({ status: 'starting' }), workspace()],
      logs: [REFUSAL_LOG],
      others: [lzb('stopped', 'stop')],
      builds: [403],
    });
    expect(run.end).toBe('ready');
    expect(posted(run)).toHaveLength(1);
    expect(run.frames).toEqual(['/@me/lab-tfv']);
    expect(run.says).toContain(MESSAGES.stopped);
  });

  it('treats a failed start whose log names no lab as any failed build: Coder’s page, no start', async () => {
    const run = await launch({
      reads: [refused(), refused(), workspace({ status: 'starting' }), workspace()],
      logs: [errorLine('Error: Error pulling image')],
    });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual(['/@me/lab-tfv']);
    expect(posted(run)).toHaveLength(0);
    expect(run.calls.filter((c) => c.url === buildLogsPath(REFUSED_BUILD))).toHaveLength(1);
    expect(run.calls.some((c) => c.url === workspaceApiPath('lab-lzb'))).toBe(false);
  });

  it('shows Coder’s page while the log cannot be read, and asks for it again', async () => {
    const run = await launch({
      reads: [refused(), refused(), refused(), workspace({ status: 'starting' }), workspace()],
      logs: [500, REFUSAL_LOG],
      others: [lzb('running'), lzb('stopped', 'stop')],
    });
    expect(run.end).toBe('ready');
    expect(run.frames).toEqual(['/@me/lab-tfv', '/@me/lab-lzb', null]);
    expect(run.calls.filter((c) => c.url === buildLogsPath(REFUSED_BUILD))).toHaveLength(2);
    expect(posted(run)).toHaveLength(1);
  });

  it('stops at once when the session ends at the log or at the other lab', async () => {
    const atLog = await launch({ reads: [refused()], logs: [401] });
    expect(atLog.end).toBe('signed-out');
    const atOther = await launch({ reads: [refused()], logs: [REFUSAL_LOG], others: [401] });
    expect(atOther.end).toBe('signed-out');
    expect(posted(atOther)).toHaveLength(0);
  });

  it('counts a failed read of the other lab toward giving up', async () => {
    const run = await launch({ reads: [refused()], logs: [REFUSAL_LOG], others: [500] });
    expect(run.end).toBe('unavailable');
    expect(run.calls.filter((c) => c.url === workspaceApiPath('lab-lzb'))).toHaveLength(POLL.maxErrors);
    expect(posted(run)).toHaveLength(0);
  });
});

describe('the files Caddy serves', () => {
  const files = readdirSync(path.join(repoRoot, LAUNCHER_DIR)).sort();
  const html = read(`${LAUNCHER_DIR}/index.html`);
  const main = read(`${LAUNCHER_DIR}/main.js`);
  const launcher = read(`${LAUNCHER_DIR}/launcher.js`);

  it('are these four, and nothing else', () => {
    expect(files).toEqual(['index.html', 'launcher.css', 'launcher.js', 'main.js']);
  });

  it('are the files the role installs by name, and the role removes anything else', () => {
    const vars = read('lab-host/ansible/roles/coder/vars/main.yml');
    const listed = vars.match(/^coder_launcher_files:\n((?: {2}- \S+\n)+)/m);
    expect(listed, 'coder_launcher_files is not a plain list in vars/main.yml').not.toBeNull();
    expect(listed[1].trim().split('\n').map((line) => line.trim().replace(/^- /, '')).sort()).toEqual(files);
    const tasks = read('lab-host/ansible/roles/coder/tasks/main.yml');
    expect(tasks).toContain('excludes: "{{ coder_launcher_files }}"');
    // The directory is removed whole while Coder is disabled, so it must be the launcher's own.
    expect(vars).toContain("coder_launcher_dir_pattern: '^/etc/caddy/hcw-[a-z0-9-]+$'");
    expect(tasks).toContain('coder_launcher_dir is match(coder_launcher_dir_pattern)');
  });

  it('load one module script from this origin, and nothing inline', () => {
    // Any case, and any end tag (`</script >`, `</SCRIPT foo>`), as a browser reads them.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1].trim()).toBe('type="module" src="main.js"');
    expect(scripts[0][2]).toBe('');
    expect(html).not.toMatch(/\sstyle=|<style\b|\son[a-z]+=|javascript:/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
    expect(html).toContain('<link rel="stylesheet" href="launcher.css" />');
  });

  it('start with the same words the logic starts with', () => {
    const status = html.match(/<p id="status"[^>]*>([^<]*)<\/p>/);
    expect(status?.[1]).toBe(MESSAGES.checking);
  });

  it('set text only as text, and nothing from the query', () => {
    for (const source of [main, launcher]) {
      expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    }
    expect(main).toContain('status.textContent = text;');
    expect(main).toMatch(/^import \{[^}]+\} from '\.\/launcher\.js';$/m);
    expect(main.match(/^import /gm)).toHaveLength(1);
    // The logic is pure: no page, no globals, no imports.
    expect(launcher).not.toMatch(/^import /m);
    expect(launcher).not.toMatch(/\b(?:document|window|location|localStorage)\./);
  });

  it('post only to the site’s two names, with its own type', () => {
    expect(SITE_ORIGINS).toEqual(['https://hybridcloudworks.com', 'https://www.hybridcloudworks.com']);
    expect(main).toContain('window.parent.postMessage({ type: MESSAGE_TYPE, state }, origin);');
    expect(main).not.toMatch(/postMessage\([^)]*'\*'/);
  });

  it('navigate only with location.replace, to the address the logic checked', () => {
    expect(main).toContain('navigate: (url) => window.location.replace(url),');
    expect(main.match(/location\.(?:replace|assign)\(|location\.href\s*=|\.src\s*=/g).sort()).toEqual([
      '.src =',
      'location.replace(',
    ]);
    // The one frame address: a path the logic built, set on a frame of this page.
    expect(main).toContain('frame.src = path;');
  });
});

describe('the route', () => {
  const route = read(ROUTE);
  const launcherHandle = route.match(/^handle @coder_lab_launcher \{\n([\s\S]*?)\n\}$/m);

  it('matches the launcher’s path on the dashboard name only', () => {
    expect(route).toMatch(/^@coder_lab_launcher \{\n {2}host \{\{ coder_domain \}\}\n {2}path \/_hcw\/lab\/\*\n\}$/m);
  });

  it('comes before Coder’s own handle, so Coder never sees these paths', () => {
    expect(launcherHandle).not.toBeNull();
    expect(route.indexOf('handle @coder_lab_launcher {')).toBeLessThan(route.indexOf('handle @coder {'));
  });

  it('adds the strict policy beside the panes-only frame-ancestors, with no-store', () => {
    const body = launcherHandle[1];
    const csp = body.match(/^ {4}\+Content-Security-Policy "([^"]+)"$/m);
    expect(csp, 'the policy is added (+), not set over lab_panes_only').not.toBeNull();
    const directives = Object.fromEntries(
      csp[1].split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values])
    );
    expect(directives).toEqual({
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'connect-src': ["'self'"],
      'style-src': ["'self'"],
      'frame-src': ["'self'"],
      'img-src': ["'self'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    });
    expect(body).not.toMatch(/frame-ancestors/);
    expect(body).toMatch(/^ {4}Cache-Control "no-store"$/m);
    expect(body).toMatch(/^ {4}X-Content-Type-Options "nosniff"$/m);
  });

  it('serves the role’s directory, with the prefix stripped', () => {
    const body = launcherHandle[1];
    expect(body).toMatch(/^ {2}uri strip_prefix \/_hcw\/lab$/m);
    expect(body).toMatch(/^ {2}root \* \{\{ coder_launcher_dir \}\}$/m);
    expect(body).toMatch(/^ {2}file_server$/m);
    expect(body).not.toMatch(/browse/);
    expect(read('lab-host/ansible/roles/coder/defaults/main.yml')).toMatch(
      /^coder_launcher_dir: \/etc\/caddy\/hcw-lab-launcher$/m
    );
    expect(read('lab-host/ansible/roles/coder/vars/main.yml')).toContain(
      'coder_launcher_source: "{{ role_path }}/../../../coder/launcher"'
    );
  });

  it('gives it no top-level exemption: only GitHub sign-in has one', () => {
    const exemptions = [...route.matchAll(/^vars (@\S+) lab_top_level_allowed true$/gm)].map((m) => m[1]);
    expect(exemptions).toEqual(['@coder_github_sign_in']);
    expect(launcherHandle[1]).not.toMatch(/lab_top_level_allowed/);
  });
});

describe('the map', () => {
  it('names each workspace exactly as the site’s catalogue does', () => {
    const catalogue = read('frontend/src/data/labs/catalogue.js');
    const rows = [...catalogue.matchAll(/id: '([a-z0-9-]+)',\n\s+workspaceName: '([a-z0-9-]+)',/g)];
    expect(Object.fromEntries(rows.map(([, id, name]) => [id, name]))).toEqual({ ...LAB_WORKSPACES });
  });

  it('knows exactly the labs the workspace template offers', () => {
    const template = read('lab-host/coder/templates/hcw-lab/main.tf');
    const regex = template.match(/regex = "\^\(([^)]+)\)\$"/);
    expect(regex, 'the template no longer validates lab with a regex of alternatives').not.toBeNull();
    expect(regex[1].split('|').sort()).toEqual(Object.keys(LAB_WORKSPACES).sort());
  });

  it('gives every lab in LAB_WORKSPACES and every guided Add-On lab its own per-lab bootloader script in lab-image/bootloaders/', () => {
    const dispatcher = read('lab-image/bootloaders/hcw-boot');
    expect(dispatcher).toContain('/usr/local/libexec/hcw-boot/${LAB_ID}.sh');
    for (const labId of Object.keys(LAB_WORKSPACES)) {
      const script = read(`lab-image/bootloaders/${labId}.sh`);
      expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    }
    for (const addonLabId of ['migration-assessment', 'network-assessment', 'cloud-assessment']) {
      const script = read(`lab-image/bootloaders/${addonLabId}.sh`);
      expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
      expect(script).toContain('python3 -m zipfile -e');
      expect(script).toContain('HCW_BOOT_OFFLINE');
    }
    const template = read('lab-host/coder/templates/hcw-lab/main.tf');
    expect(template).toContain('/usr/local/libexec/hcw-boot/hcw-boot');
  });
});

