/**
 * The launcher's calls to Coder: starting a workspace (with Coder's CSRF
 * token), the running-workspace limit read from a build's log, and the one
 * GET every read goes through.
 *
 * One of the lab launcher's logic files (#1845 split launcher.js by job into
 * launcher-config.js, launcher-coder.js and launcher-workspace.js; launcher.js
 * runs them and re-exports what they export). Like launcher.js it is pure:
 * no DOM, no globals, and it imports only its siblings, which Caddy serves
 * from the same directory (coder_launcher_files in
 * lab-host/ansible/roles/coder/vars/main.yml).
 */

import { MESSAGES } from './launcher-config.js';

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
  return STARTABLE.has(status) ? anyStartPlan(workspace) : null;
}

/** The start call for this workspace whatever its last build did, or null without an id. */
function anyStartPlan(workspace) {
  if (typeof workspace?.id !== 'string' || workspace.id === '') return null;
  const body = { transition: 'start' };
  if (workspace.outdated === true && typeof workspace.template_active_version_id === 'string') {
    body.template_version_id = workspace.template_active_version_id;
  }
  return { path: buildsApiPath(workspace.id), body };
}

/**
 * The running-workspace limit (owner decision 2026-10-16, #954). Every
 * template refuses a start while another of the learner's workspaces is
 * starting or running: a Terraform precondition fails the build at plan,
 * and Coder logs its message, `Only one lab workspace can run at a time.
 * Stop your other lab first: <name>.`, as an error line of that build's
 * log (docker_container.workspace in each template under
 * lab-host/coder/templates; Coder v2.38.0 logs a diagnostic's detail as
 * lines of its own, and the job's own error only says that `terraform plan`
 * failed). The launcher reads that log for a failed start of this lab's
 * workspace, once per build, and when it finds the line it shows the
 * learner the limit, as the state `limited`, with Coder's page for the other
 * workspace, where Stop is, in the frame. When the other workspace no
 * longer counts against the limit (isBlocking, below), the refusal no
 * longer holds, and the launcher starts this one, once per visit: the one
 * case a failed build is started without a click, because its log says why
 * it failed and that reason is gone.
 */
export const LIMIT_REFUSAL = /Stop your other lab first: ([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/;
/** Coder's limit on a workspace name (codersdk/name.go). */
const WORKSPACE_NAME_MAX = 32;
/** A start that is queued, under way or done: what the templates count against the limit. */
/**
 * The latest builds the templates count against the limit (`blocking_builds`
 * in each main.tf), by transition: the ones that leave a container running,
 * or may. A start that is queued, under way, done or being cancelled, and a
 * stop that failed. A failed start is not one, so a refused start never
 * holds the limit itself. template.test.mjs holds the two lists equal.
 */
const BLOCKING = new Map([
  ['start', new Set(['pending', 'starting', 'running', 'canceling'])],
  ['stop', new Set(['failed'])],
]);

/** Coder's log of one build, by id. */
export function buildLogsPath(buildId) {
  return `/api/v2/workspacebuilds/${encodeURIComponent(buildId)}/logs`;
}

/** The other workspace a build's log says to stop first, or null when the log carries no such refusal. */
export function limitBlocker(logs) {
  if (!Array.isArray(logs)) return null;
  for (const entry of logs) {
    if (entry?.log_level !== 'error' || typeof entry.output !== 'string') continue;
    const name = entry.output.match(LIMIT_REFUSAL)?.[1];
    if (name && name.length <= WORKSPACE_NAME_MAX) return name;
  }
  return null;
}

/** Whether a workspace counts against the limit, as the templates count it. */
export function isBlocking(workspace) {
  const build = workspace?.latest_build;
  return BLOCKING.get(build?.transition)?.has(build.status) === true;
}

/** What the learner reads while another of their workspaces holds the limit. */
export function limitMessage(name) {
  return MESSAGES.limited.replace('{name}', name);
}

/**
 * A start of this workspace that failed, which may be the limit's refusal:
 * `{ buildId, retry }`, retry being the start call to make once the other
 * workspace has stopped. Null for anything else.
 */
export function refusedStart(workspace) {
  const build = workspace?.latest_build;
  if (build?.status !== 'failed' || build.transition !== 'start') return null;
  if (typeof build.id !== 'string' || build.id === '') return null;
  const retry = anyStartPlan(workspace);
  return retry ? { buildId: build.id, retry } : null;
}

/** One attempt to start: true when Coder accepted the build, false for anything else. */
export async function startWorkspace(fetchImpl, plan) {
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

/** What a response's status means, where it is not simply ok or an error. */
const STATUS_KIND = new Map([
  [401, 'signed-out'],
  [404, 'missing'],
]);

/** One GET: `{ kind: 'ok', body }`, `'signed-out'` (401), `'missing'` (404) or `'error'`. */
export async function read(fetchImpl, path) {
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
