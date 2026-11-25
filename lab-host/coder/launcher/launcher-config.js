/**
 * The launcher's fixed values: names, paths, states and the words it shows.
 *
 * One of the lab launcher's logic files (#1845 split launcher.js by job into
 * launcher-config.js, launcher-coder.js and launcher-workspace.js; launcher.js
 * runs them and re-exports what they export). Like launcher.js it is pure:
 * no DOM, no globals, and it imports only its siblings, which Caddy serves
 * from the same directory (coder_launcher_files in
 * lab-host/ansible/roles/coder/vars/main.yml).
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
  'limited',
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
  // `{name}` is the other workspace's name, checked by limitBlocker.
  limited:
    'Only one of your lab workspaces runs at a time, and {name} is running. Stop it on the page below, and this lab starts.',
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
