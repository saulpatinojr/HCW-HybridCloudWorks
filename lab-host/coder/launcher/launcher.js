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
 *     CSRF token. Two more only when a start of this lab's workspace failed
 *     (#954): that build's log, once per build, and the one other workspace
 *     of the learner's that the log names. None of these changes anything
 *     in Coder.
 *   - ONE write, and only this one: `POST /api/v2/workspaces/{id}/builds`
 *     with `{ transition: "start" }` (and the template's active version id
 *     when the workspace is outdated), for the learner's own workspace for
 *     this lab, only when its last build stopped or was cancelled, or when
 *     it failed because another lab was running and that lab no longer is
 *     (the running-workspace limit, below), each at most once per visit,
 *     carrying the CSRF token Coder embeds in its own page as
 *     `X-CSRF-TOKEN` — the same call, and the same token, Coder's Start
 *     button sends (#911, owner 2026-10-07). Never a create, never a delete,
 *     never another learner's workspace, and never a stop: the id comes from
 *     the workspace read above, which Coder scopes to the signed-in learner.
 *     When Coder refuses, or its page carries no token, the launcher frames
 *     Coder's workspace page with Start, as it always did. Creating a
 *     workspace is still Coder's own UI in a frame of the same origin, with
 *     Coder's own consent dialog.
 *   - Everything it builds comes from constants in launcher-config.js: the lab id and the
 *     workspace name from LAB_WORKSPACES, the template name, and the host
 *     suffix it navigates to. The query string only selects a key of
 *     LAB_WORKSPACES, and no text from it reaches the page. The one other
 *     name it uses is the workspace a refused start's log says to stop
 *     first, only when it is a Coder workspace name (letters, digits and
 *     single hyphens, at most 32), and only in two same-origin paths
 *     under `me` (that workspace's read and Coder's page for it) and in
 *     the text the page shows, which is set as text.
 *   - The one address it takes from Coder is code-server's
 *     `subdomain_name`, and only when it is exactly the name Coder v2.37.3
 *     builds (`code-server--<workspace>--<owner>`, coderd/database/db2sdk
 *     AppSubdomain: no agent segment for a named app) for this workspace
 *     and the signed-in learner's own username (`/api/v2/users/me`).
 *
 * Pure: no DOM, no globals, and no imports but its three sibling files
 * (launcher-config.js, launcher-coder.js, launcher-workspace.js; split by
 * job in #1845), which Caddy serves beside it. main.js wires it to the page, and
 * scripts/lab-host-launcher.test.mjs drives it with a mocked fetch, clock and
 * navigation.
 */

import {
  MESSAGES,
  ME_PATH,
  POLL,
  TEMPLATE,
  TEMPLATE_API_PATH,
  createPagePath,
  workspaceApiPath,
  workspacePagePath,
} from './launcher-config.js';
import {
  buildLogsPath,
  isBlocking,
  limitBlocker,
  limitMessage,
  read,
  startWorkspace,
} from './launcher-coder.js';
import { assess, ownerName, resolveLab } from './launcher-workspace.js';

// What the sibling files export is re-exported here, so main.js and the
// tests keep one import path.
export {
  APPS_HOST_SUFFIX,
  TEMPLATE,
  APP_SLUG,
  SITE_ORIGINS,
  MESSAGE_TYPE,
  LAB_WORKSPACES,
  STATES,
  MESSAGES,
  POLL,
  ME_PATH,
  TEMPLATE_API_PATH,
  workspaceApiPath,
  createPagePath,
  workspacePagePath,
} from './launcher-config.js';
export {
  CSRF_PAGE_PATH,
  CSRF_HEADER,
  buildsApiPath,
  csrfTokenFrom,
  startPlan,
  LIMIT_REFUSAL,
  buildLogsPath,
  limitBlocker,
  isBlocking,
  limitMessage,
  refusedStart,
} from './launcher-coder.js';
export {
  resolveLab,
  ownerName,
  codeServerUrl,
  findCodeServer,
  assess,
} from './launcher-workspace.js';

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
 * The workspace a failed start's log says to stop first, read once per
 * build: the name, `null` when the log names none, or how the step ends
 * (`'signed-out'`). A log Coder will not give leaves the answer unknown for
 * this step only, so the next one asks again.
 */
async function readBlocker(buildId, session, fetchImpl) {
  if (session.limitLog?.buildId === buildId) return { blocker: session.limitLog.blocker };
  const log = await read(fetchImpl, buildLogsPath(buildId));
  if (log.kind === 'signed-out') return { end: 'signed-out' };
  if (log.kind !== 'ok') return { blocker: null };
  session.limitLog = { buildId, blocker: limitBlocker(log.body) };
  return { blocker: session.limitLog.blocker };
}

/**
 * The running-workspace limit, for a failed start of this lab's workspace.
 * Null to go on as for any failed build (Coder's page with Retry);
 * otherwise how the step goes on. While the other workspace counts against
 * the limit, the state is `limited`: the learner reads the limit and Coder's
 * page for that workspace, where Stop is, is framed. Once it does not, this
 * one is started, once per visit.
 */
async function limitGate(verdict, session, { fetchImpl, view }) {
  if (!verdict.refused) return null;
  const { blocker, end } = await readBlocker(verdict.refused.buildId, session, fetchImpl);
  if (end) return end;
  if (!blocker) return null;
  return (await blockedBy(blocker, fetchImpl, view)) || retryOnce(verdict, session, { fetchImpl, view });
}

/**
 * Whether the workspace named in the log still counts against the limit:
 * `'limited'` (and Coder's page for it framed) when it does, how the step
 * ends when it cannot be read, null when it no longer counts.
 */
async function blockedBy(blocker, fetchImpl, view) {
  const other = await read(fetchImpl, workspaceApiPath(blocker));
  if (other.kind === 'signed-out' || other.kind === 'error') return other.kind;
  if (other.kind !== 'ok' || !isBlocking(other.body)) return null;
  view.frame(workspacePagePath(blocker));
  view.report('limited', limitMessage(blocker));
  return 'limited';
}

/** Start this lab's workspace again, once per visit, now the limit allows it. Null when it is not started. */
async function retryOnce(verdict, session, { fetchImpl, view }) {
  if (session.retryTried) return null;
  session.retryTried = true;
  if (!(await startWorkspace(fetchImpl, verdict.refused.retry))) return null;
  view.frame(null);
  view.report('starting');
  return 'wait';
}

/**
 * A stopped workspace is started once, without a click; if Coder takes
 * the build the visit waits for it, otherwise Coder's page with Start.
 * Null to go on to that page.
 */
async function startOnce(verdict, session, fetchImpl, view) {
  if (!verdict.start || session.startTried) return null;
  session.startTried = true;
  if (!(await startWorkspace(fetchImpl, verdict.start))) return null;
  view.report('starting');
  return 'wait';
}

/**
 * One step of the wait: who is signed in, then their workspace for this lab,
 * with the template read before a create. `session` carries what the steps
 * learn: `{ owner, templateFound, startTried, retryTried, limitLog }`.
 */
async function launcherStep(session, { fetchImpl, target, view, navigate }) {
  if (!session.owner) return readOwner(session, fetchImpl);
  const verdict = workspaceVerdict(await read(fetchImpl, workspaceApiPath(target.workspace)), target, session.owner);
  if (verdict.end) return verdict.end;
  // The first of the three that has something to say ends the step.
  const outcome =
    (await templateGate(verdict, session, fetchImpl)) ||
    (await limitGate(verdict, session, { fetchImpl, view })) ||
    (await startOnce(verdict, session, fetchImpl, view));
  return outcome || show(verdict, { target, view, navigate });
}

/**
 * What goes on after a step: `'wait'` sleeps and backs off, `'again'` goes
 * straight on, `'error'` counts toward giving up, and `'limited'` waits like
 * `'wait'` on the learner rather than on Coder.
 */
const CONTINUES = new Set(['wait', 'again', 'error', 'limited']);

/**
 * Run `step` until it ends, with the backoff and both caps in POLL. A step
 * that gives anything outside CONTINUES ends the run with that; running out
 * of time or of retries ends it with `'unavailable'`. The time cap is for
 * Coder, so it does not run while the learner is asked to stop another lab
 * (`'limited'`): that wait lasts until they do, or until that lab stops
 * itself at its autostop, and the cap counts again from then.
 */
async function pollUntilDone(step, { sleep, now, poll }) {
  let started = now();
  let delay = poll.firstDelayMs;
  let errors = 0;
  for (;;) {
    const outcome = await step();
    if (!CONTINUES.has(outcome)) return outcome;
    if (outcome === 'limited') started = now();
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

  const session = { owner: null, templateFound: false, startTried: false, retryTried: false, limitLog: null };
  const step = () => launcherStep(session, { fetchImpl, target, view, navigate });
  const ending = await pollUntilDone(step, { sleep, now, poll });
  return ending === 'ready' ? ending : view.end(ending);
}
