/**
 * What the launcher makes of the query string and of a workspace read: the
 * lab, the learner's username, code-server's address and the state to show.
 *
 * One of the lab launcher's logic files (#1845 split launcher.js by job into
 * launcher-config.js, launcher-coder.js and launcher-workspace.js; launcher.js
 * runs them and re-exports what they export). Like launcher.js it is pure:
 * no DOM, no globals, and it imports only its siblings, which Caddy serves
 * from the same directory (coder_launcher_files in
 * lab-host/ansible/roles/coder/vars/main.yml).
 */

import { APPS_HOST_SUFFIX, APP_SLUG, LAB_WORKSPACES } from './launcher-config.js';
import { refusedStart, startPlan } from './launcher-coder.js';

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
    if (start) return { state, start };
    // A failed start may be the running-workspace limit's refusal.
    const refused = refusedStart(workspace);
    return refused ? { state, refused } : { state };
  }
  const found = findCodeServer(workspace);
  // A startup script that failed never becomes ready; the workspace page
  // shows why and has Restart.
  if (found?.agent.lifecycle_state === 'start_error') return { state: 'stopped' };
  if (!found || !isReady(found)) return { state: 'starting' };
  const url = codeServerUrl(found.app, workspaceName, owner);
  return url ? { state: 'ready', url } : { state: 'unavailable' };
}
