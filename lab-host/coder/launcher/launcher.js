/**
 * The lab launcher's logic: what the site's pane shows between "open this
 * lab" and the editor (ADR 0032, amendment "Coder in the site's panes", note
 * of 2026-09-28 on the launcher).
 *
 * WHY IT EXISTS. The lab is reached only through panes on
 * https://hybridcloudworks.com, and Caddy redirects any top-level visit
 * (lab_panes_only). Coder's dashboard opens code-server in a new window or
 * tab (`open_in` has no same-frame value in Coder v2.37.3), and a new window
 * is a top-level visit, so from the dashboard the editor can never open in
 * the pane. The launcher is a page on Coder's own name that the pane loads
 * instead. It reads the learner's workspace with the learner's own Coder
 * session, and when code-server is healthy it replaces itself with
 * code-server's own subdomain. code-server stays on its own origin, away
 * from Coder's API.
 *
 * WHAT IT MAY DO, and nothing more:
 *   - GET, same origin, with the learner's session cookie, to four paths:
 *     who is signed in, their workspace for this lab, before Coder's create
 *     page is ever framed the template, and Coder's own index page for the
 *     CSRF token. None of these changes anything in Coder.
 *   - ONE write, and only this one: `POST /api/v2/workspaces/{id}/builds`
 *     with `{ transition: "start" }` (and the template's active version id
 *     when the workspace is outdated), for the learner's own workspace for
 *     this lab, only when its last build stopped or was cancelled, once per
 *     visit, carrying the CSRF token Coder embeds in its own page as
 *     `X-CSRF-TOKEN` — the same call, and the same token, Coder's Start
 *     button sends (#911, owner 2026-10-07). Never a create, never a delete,
 *     never another learner's workspace: the id comes from the workspace
 *     read above, which Coder scopes to the signed-in learner. When Coder
 *     refuses, or its page carries no token, the launcher frames Coder's
 *     workspace page with Start, as it always did. Creating a workspace is
 *     still Coder's own UI in a frame of the same origin, with Coder's own
 *     consent dialog.
 *   - Everything it builds comes from constants below: the lab id and the
 *     workspace name from LAB_WORKSPACES, the template name, and the host
 *     suffix it navigates to. The query string only selects a key of
 *     LAB_WORKSPACES, and no text from it reaches the page.
 *   - The one address it takes from Coder is code-server's
 *     `subdomain_name`, and only when it is exactly the name Coder v2.37.3
 *     builds (`code-server--<workspace>--<owner>`, coderd/database/db2sdk
 *     AppSubdomain: no agent segment for a named app) for this workspace
 *     and the signed-in learner's own username (`/api/v2/users/me`).
 *
 * Pure: no DOM, no globals. main.js wires it to the page, and
 * scripts/lab-host-launcher.test.mjs drives it with a mocked fetch, clock and
 * navigation.
 */

/** Where code-server's subdomain lives: CODER_WILDCARD_ACCESS_URL in lab-host/coder/docker-compose.yml. */
export const APPS_HOST_SUFFIX = '.coder.lab.hybridcloudworks.com';

/** The one workspace template (lab-host/coder/templates/hcw-lab). */
export const TEMPLATE = 'hcw-lab';

/** code-server's app slug: the module's default, which the template keeps. */
export const APP_SLUG = 'code-server';

/**
 * Where the site's pages live: both names, because www serves the site with
 * a 200 rather than redirecting (caddy_frame_ancestors in
 * lab-host/ansible/group_vars/all.yml). Each gets a post of its own; the
 * browser delivers only the one that matches the parent.
 */
export const SITE_ORIGINS = Object.freeze([
  'https://hybridcloudworks.com',
  'https://www.hybridcloudworks.com',
]);

/** The `type` of every message this page posts to the site. */
export const MESSAGE_TYPE = 'hcw-lab';

/**
 * Lab id to workspace name, one workspace per lab per learner. The ids are
 * the catalogue's (frontend/src/data/labs/catalogue.js), and its
 * `workspaceName` for each is the same string; both
 * scripts/lab-host-launcher.test.mjs and the catalogue's own test fail when
 * they differ.
 *
 * Short on purpose. Coder serves code-server at
 * `code-server--<workspace>--<owner>`, one DNS label of at most 63
 * characters, and an owner name can be 32 (codersdk/name.go), so a
 * workspace name has 16 at most. Lowercase letters, digits and single
 * hyphens, which is Coder's own rule for a name.
 */
export const LAB_WORKSPACES = Object.freeze({
  'landing-zone-builder-output': 'lab-lzb',
  'terraform-validate-walkthrough': 'lab-tfv',
  'ansible-syntax-check-walkthrough': 'lab-asc',
  'wsl-containers-walkthrough': 'lab-wslc',
  'defender-wsl-plugin-walkthrough': 'lab-mde-wsl',
  'aws-transit-gateway-walkthrough': 'lab-aws-tgw',
  'gcp-shared-vpc-walkthrough': 'lab-gcp-vpc',
  'vmware-hcx-migration-walkthrough': 'lab-vmw-hcx',
  'docker-sandbox-agent-walkthrough': 'lab-dck-sbx',
});

/** Every state this page reports, in the order a visit can move through them. */
export const STATES = Object.freeze([
  'checking',
  'signed-out',
  'create',
  'stopped',
  'starting',
  'ready',
  'unavailable',
]);

/**
 * Everything a visitor reads here. It renders inside the site's pane, so it
 * follows the site's public-pages rule: "your lab workspace", never the name
 * of a tool, the host or a setting (scripts/lab-host-visitor-copy.test.mjs).
 * `unavailable` is the site's own sentence for the same state
 * (UNAVAILABLE_SENTENCE in frontend/src/pages/shared/LabPanePage.jsx).
 */
export const MESSAGES = Object.freeze({
  checking: 'Opening your lab workspace…',
  'signed-out':
    "You're not signed in. Use Sign in with GitHub above to open your lab workspace here.",
  create: "Your lab workspace is new. Confirm below to create it, and it opens here when it's ready.",
  stopped:
    "Your lab workspace isn't running. Start it on the page below, and it opens here when it's ready.",
  starting: 'Getting your lab workspace ready. This can take a minute or two.',
  ready: 'Your lab workspace is ready. Opening it…',
  unavailable: "Lab workspaces aren't available right now.",
  'unknown-lab': "There's no lab at this address.",
  'frame-title': 'Your lab workspace',
});

/**
 * How often, and for how long. The wait grows from one second to five, so
 * a workspace that starts in seconds opens in seconds and one that takes
 * minutes is asked about every five. Ten minutes covers a first start (the
 * image is on the host already; code-server installs once per workspace)
 * with time to confirm the create dialog. Six failed reads in a row, about
 * thirteen seconds, is an outage rather than a blip.
 */
export const POLL = Object.freeze({
  firstDelayMs: 1_000,
  factor: 1.5,
  maxDelayMs: 5_000,
  capMs: 10 * 60 * 1_000,
  maxErrors: 6,
});

export const ME_PATH = '/api/v2/users/me';

/**
 * The template, read before Coder's create page is ever loaded. It is the
 * same read that page makes first (Coder v2.37.3, site CreateWorkspacePage:
 * `templateByName(organization ?? "default", template)`), and `default` is
 * Coder's name for the default organization (codersdk.DefaultOrganization,
 * resolved by httpmw.ExtractOrganizationParam), which is the one this
 * deployment has. Coder answers 404 when the template does not exist, and
 * also when the learner cannot read it (templateByOrganizationAndName,
 * httpapi.ResourceNotFound). Loaded in the pane, that 404 is Coder's own red
 * "Resource not found or you do not have access to this resource" box with
 * its response data and stack trace (2026-09-28, before the template was
 * published), so the launcher reads it first and says the site's sentence
 * instead.
 */
export const TEMPLATE_API_PATH = `/api/v2/organizations/default/templates/${TEMPLATE}`;

/** Coder's API for one of the signed-in learner's workspaces, by name. */
export function workspaceApiPath(workspace) {
  return `/api/v2/users/me/workspace/${encodeURIComponent(workspace)}`;
}

/**
 * Coder's own create page, with the name and the lab set. `mode=auto` shows
 * Coder's consent dialog and creates on confirm, then moves that frame to
 * the new workspace's page.
 */
export function createPagePath(labId, workspace) {
  const query = `mode=auto&name=${encodeURIComponent(workspace)}&param.lab=${encodeURIComponent(labId)}`;
  return `/templates/${TEMPLATE}/workspace?${query}`;
}

/** Coder's page for the learner's workspace, where Start is. `me` resolves to the learner. */
export function workspacePagePath(workspace) {
  return `/@me/${encodeURIComponent(workspace)}`;
}

/**
 * Starting a stopped workspace without a click (owner, 2026-10-07, #911:
 * "the lab was enabled but I still needed to start it").
 *
 * Coder starts a workspace with `POST /api/v2/workspaces/{id}/builds
 * { transition: "start" }`, the call its own Start button makes. The
 * launcher is signed in the way Coder's pages are, by the session cookie,
 * and Coder guards every cookie-authenticated write with a CSRF token
 * (coderd/httpmw/csrf.go): the cookie is HttpOnly, so a page cannot read
 * it, and the token is instead embedded in every page Coder serves as
 * `<meta property="csrf-token">`, which Coder's own front end reads and
 * sends as `X-CSRF-TOKEN` (site/src/api/api.ts). The launcher does the
 * same: it reads one of Coder's pages and sends the token it finds. When
 * the page carries none, or Coder refuses the start, the launcher does
 * what it did before — frames Coder's workspace page, where Start is — so
 * a Coder change here costs a click, never the lab.
 *
 * Only a build that stopped or was cancelled is started this way. A failed
 * build is not: its page carries the reason and Retry, and starting it
 * blind would hide the reason. An outdated workspace is started on its
 * template's active version, so a template change (a new editor pin, say)
 * reaches every lab on its next open rather than waiting for each learner
 * to press "Update and start". One attempt per visit; the poll then waits
 * for the build like any other start.
 */
export const CSRF_PAGE_PATH = '/';
export const CSRF_HEADER = 'X-CSRF-TOKEN';
const CSRF_META = /<meta\s+property="csrf-token"\s+content="([^"]+)"/i;
const STARTABLE = new Set(['stopped', 'canceled']);

/** Coder's builds API for one workspace, by id. */
export function buildsApiPath(workspaceId) {
  return `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/builds`;
}

/** The CSRF token a Coder page carries, or null. */
export function csrfTokenFrom(html) {
  const match = typeof html === 'string' ? html.match(CSRF_META) : null;
  return match ? match[1] : null;
}

/**
 * How to start this workspace, or null when it should not be started
 * without a click: `{ path, body }` for a stopped or cancelled build of a
 * workspace with an id, on the active template version when outdated.
 */
export function startPlan(workspace) {
  const status = workspace?.latest_build?.status;
  if (!STARTABLE.has(status) || typeof workspace?.id !== 'string' || workspace.id === '') return null;
  const body = { transition: 'start' };
  if (workspace.outdated === true && typeof workspace.template_active_version_id === 'string') {
    body.template_version_id = workspace.template_active_version_id;
  }
  return { path: buildsApiPath(workspace.id), body };
}

/** One attempt to start: true when Coder accepted the build, false for anything else. */
async function startWorkspace(fetchImpl, plan) {
  try {
    const page = await fetchImpl(CSRF_PAGE_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'text/html' },
    });
    if (!page.ok) return false;
    const token = csrfTokenFrom(await page.text());
    if (!token) return false;
    const response = await fetchImpl(plan.path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', [CSRF_HEADER]: token },
      body: JSON.stringify(plan.body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The lab and workspace a query string names, or null for anything but exactly one known `lab`. */
export function resolveLab(search) {
  let params;
  try {
    params = new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return null;
  }
  const ids = params.getAll('lab');
  if (ids.length !== 1 || !Object.hasOwn(LAB_WORKSPACES, ids[0])) return null;
  return { lab: ids[0], workspace: LAB_WORKSPACES[ids[0]] };
}

const SUBDOMAIN = /^code-server--[a-z0-9-]+--[a-z0-9-]+$/;
const DNS_LABEL_MAX = 63;
/** Coder's rule for a username (codersdk/name.go), lowercased: letters, digits and single hyphens. */
const OWNER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The signed-in learner's username from `GET /api/v2/users/me`, lowercased,
 * or null when it is not a Coder username. Lowercased because a Coder
 * username may carry capitals and a host name is case-insensitive.
 */
export function ownerName(me) {
  const name = typeof me?.username === 'string' ? me.username.toLowerCase() : '';
  return OWNER.test(name) ? name : null;
}

/**
 * code-server's address, or null unless Coder's `subdomain_name` is exactly
 * the name v2.37.3 builds for this workspace of this learner:
 * `code-server--<workspace>--<owner>`, one DNS label. So the pane can only
 * ever move to the learner's own editor for this lab, never another
 * learner's. The suffix is fixed here and never read from anywhere.
 */
export function codeServerUrl(app, workspace, owner) {
  if (app?.subdomain !== true || typeof app.subdomain_name !== 'string') return null;
  const name = app.subdomain_name.toLowerCase();
  const own = typeof owner === 'string' && OWNER.test(owner) && name === `${APP_SLUG}--${workspace}--${owner}`;
  return own && name.length <= DNS_LABEL_MAX && SUBDOMAIN.test(name) ? `https://${name}${APPS_HOST_SUFFIX}/` : null;
}

/** An array, or an empty one for anything else a response might carry. */
const list = (value) => (Array.isArray(value) ? value : []);
const isCodeServer = (app) => app?.slug === APP_SLUG;

/** code-server's app and the agent that serves it, from a workspace's latest build. */
export function findCodeServer(workspace) {
  const agents = list(workspace?.latest_build?.resources).flatMap((resource) => list(resource?.agents));
  const agent = agents.find((candidate) => list(candidate?.apps).some(isCodeServer));
  return agent ? { agent, app: agent.apps.find(isCodeServer) } : null;
}

/**
 * A latest build that is not running, and what the learner sees for it: a
 * workspace deleted is created again, and a stopped, failed or cancelled one
 * gets Coder's workspace page, where Start (or Retry) is. Any other status is
 * waited on.
 */
const NOT_RUNNING = new Map([
  ['deleted', 'create'],
  ['stopped', 'stopped'],
  ['failed', 'stopped'],
  ['canceled', 'stopped'],
]);

const isReady = ({ agent, app }) =>
  agent.status === 'connected' && agent.lifecycle_state === 'ready' && app.health === 'healthy';

/**
 * What a workspace read means: `{ state }`, plus `url` when it is ready.
 * Anything this does not recognise is waited on, and the poll cap ends a
 * wait that never resolves.
 */
export function assess(workspace, workspaceName, owner) {
  const status = workspace?.latest_build?.status;
  if (status !== 'running') {
    const state = NOT_RUNNING.get(status) ?? 'starting';
    const start = state === 'stopped' ? startPlan(workspace) : null;
    return start ? { state, start } : { state };
  }
  const found = findCodeServer(workspace);
  // A startup script that failed never becomes ready; the workspace page
  // shows why and has Restart.
  if (found?.agent.lifecycle_state === 'start_error') return { state: 'stopped' };
  if (!found || !isReady(found)) return { state: 'starting' };
  const url = codeServerUrl(found.app, workspaceName, owner);
  return url ? { state: 'ready', url } : { state: 'unavailable' };
}

/** What a response's status means, where it is not simply ok or an error. */
const STATUS_KIND = new Map([
  [401, 'signed-out'],
  [404, 'missing'],
]);

/** One GET: `{ kind: 'ok', body }`, `'signed-out'` (401), `'missing'` (404) or `'error'`. */
async function read(fetchImpl, path) {
  try {
    const response = await fetchImpl(path, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    const kind = STATUS_KIND.get(response.status) ?? (response.ok ? 'ok' : 'error');
    return kind === 'ok' ? { kind, body: await response.json() } : { kind };
  } catch {
    return { kind: 'error' };
  }
}

/** The page's text, frame and messages to the site, each changed only when it changes. */
function createView({ ui, post }) {
  let reported = null;
  let framePath = null;
  const view = {
    report(state, text = MESSAGES[state]) {
      ui.say(text);
      if (state !== reported) {
        reported = state;
        post(state);
      }
    },
    frame(path) {
      if (path === framePath) return;
      framePath = path;
      ui.frame(path);
    },
    end(state, text) {
      view.frame(null);
      view.report(state, text);
      return state;
    },
  };
  return view;
}

/** The Coder page a state shows in the launcher's frame; states not listed keep whatever is there. */
const FRAMES = new Map([
  ['create', (target) => createPagePath(target.lab, target.workspace)],
  ['stopped', (target) => workspacePagePath(target.workspace)],
]);

/**
 * What one read of the learner's workspace means: `{ end }` for a read that
 * ends or fails the step (`'signed-out'`, `'error'`), otherwise the verdict
 * of `assess`, where a workspace that does not exist yet is `create`.
 */
function workspaceVerdict(result, target, owner) {
  if (result.kind === 'signed-out' || result.kind === 'error') return { end: result.kind };
  return result.kind === 'missing' ? { state: 'create' } : assess(result.body, target.workspace, owner);
}

/**
 * What the template read means: `'ok'` when Coder has the template and it
 * takes new workspaces; `'unavailable'` when it is missing, or not the
 * template asked for, or deprecated (Coder's create page refuses a
 * deprecated template with a notice of its own); otherwise the read's own
 * `'signed-out'` or `'error'`.
 */
export function templateVerdict(result) {
  if (result.kind === 'missing') return 'unavailable';
  if (result.kind !== 'ok') return result.kind;
  return result.body?.name === TEMPLATE && result.body.deprecated !== true ? 'ok' : 'unavailable';
}

/**
 * What a workspace verdict does to the page. Answers how the wait goes on:
 * `'wait'` (poll again), or an end (`'ready'`, `'unavailable'`).
 */
function show(verdict, { target, view, navigate }) {
  if (verdict.state === 'unavailable') return 'unavailable';
  if (FRAMES.has(verdict.state)) view.frame(FRAMES.get(verdict.state)(target));
  view.report(verdict.state);
  if (verdict.state !== 'ready') return 'wait';
  navigate(verdict.url);
  return 'ready';
}

/** Who is signed in: their username becomes `session.owner`, the owner in code-server's name. */
async function readOwner(session, fetchImpl) {
  const me = await read(fetchImpl, ME_PATH);
  if (me.kind === 'signed-out') return 'signed-out';
  session.owner = me.kind === 'ok' ? ownerName(me.body) : null;
  return session.owner ? 'again' : 'error';
}

/**
 * The template, read once, before Coder's create page is ever framed. Null
 * to go on; otherwise how the step ends (`'unavailable'`, `'signed-out'`,
 * `'error'`). A template Coder does not have ends the visit with the site's
 * sentence, so Coder's page, with its own error, is never loaded.
 */
async function templateGate(verdict, session, fetchImpl) {
  if (verdict.state !== 'create' || session.templateFound) return null;
  const template = templateVerdict(await read(fetchImpl, TEMPLATE_API_PATH));
  session.templateFound = template === 'ok';
  return session.templateFound ? null : template;
}

/**
 * One step of the wait: who is signed in, then their workspace for this lab,
 * with the template read before a create. `session` carries what the steps
 * learn: `{ owner, templateFound, startTried }`.
 */
async function launcherStep(session, { fetchImpl, target, view, navigate }) {
  if (!session.owner) return readOwner(session, fetchImpl);
  const verdict = workspaceVerdict(await read(fetchImpl, workspaceApiPath(target.workspace)), target, session.owner);
  if (verdict.end) return verdict.end;
  const gate = await templateGate(verdict, session, fetchImpl);
  if (gate) return gate;
  // A stopped workspace is started once, without a click; if Coder takes
  // the build the visit waits for it, otherwise Coder's page with Start.
  if (verdict.start && !session.startTried) {
    session.startTried = true;
    if (await startWorkspace(fetchImpl, verdict.start)) {
      view.report('starting');
      return 'wait';
    }
  }
  return show(verdict, { target, view, navigate });
}

/** What goes on after a step: `'wait'` sleeps and backs off, `'again'` goes straight on, `'error'` counts toward giving up. */
const CONTINUES = new Set(['wait', 'again', 'error']);

/**
 * Run `step` until it ends, with the backoff and both caps in POLL. A step
 * that gives anything outside CONTINUES ends the run with that; running out
 * of time or of retries ends it with `'unavailable'`.
 */
async function pollUntilDone(step, { sleep, now, poll }) {
  const started = now();
  let delay = poll.firstDelayMs;
  let errors = 0;
  for (;;) {
    const outcome = await step();
    if (!CONTINUES.has(outcome)) return outcome;
    errors = outcome === 'error' ? errors + 1 : 0;
    if (errors >= poll.maxErrors || now() - started >= poll.capMs) return 'unavailable';
    if (outcome !== 'again') {
      await sleep(delay);
      delay = Math.min(delay * poll.factor, poll.maxDelayMs);
    }
  }
}

/**
 * Run the launcher once, to one of its ends: `ready` (navigated),
 * `signed-out` or `unavailable`.
 *
 * @param {object} deps
 * @param {string} deps.search  the page's query string
 * @param {(path: string, init: object) => Promise<Response>} deps.fetch
 * @param {{ say: (text: string) => void, frame: (path: string | null) => void }} deps.ui
 * @param {(state: string) => void} deps.post  tells the site the state
 * @param {(url: string) => void} deps.navigate  replaces the page, leaving no history entry
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} deps.now
 * @param {typeof POLL} [deps.poll]
 */
export async function runLauncher({ search, fetch: fetchImpl, ui, post, navigate, sleep, now, poll = POLL }) {
  const view = createView({ ui, post });
  const target = resolveLab(search);
  if (!target) return view.end('unavailable', MESSAGES['unknown-lab']);
  view.report('checking');

  const session = { owner: null, templateFound: false, startTried: false };
  const step = () => launcherStep(session, { fetchImpl, target, view, navigate });
  const ending = await pollUntilDone(step, { sleep, now, poll });
  return ending === 'ready' ? ending : view.end(ending);
}
