/** The files and images the lab pin planners edit (see lab-pin-bumps.mjs), and two small helpers they share. */
import { createHash } from 'node:crypto';

export const USER_AGENT =
  'HCW-HybridCloudWorks lab-pins-upstream (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

export const GROUP_VARS_PATH = 'lab-host/ansible/group_vars/all.yml';
export const VERSIONS_ENV_PATH = 'lab-image/versions.env';
export const DOCKERFILE_PATH = 'lab-image/Dockerfile';
export const SANDBOX_DOCKERFILE_PATH = 'lab-image/sandbox-template/Dockerfile';
export const CAPABILITIES_PATH = 'vps-agent/lib/capabilities.js';
export const CODER_TEMPLATE_PATH = 'lab-host/coder/templates/hcw-lab/main.tf';
/**
 * Every Coder template that runs the `hcw-lab` image, the one above first.
 * The two guided labs pin the same image, and until #1704 the digest bump
 * moved only `hcw-lab`, so they stayed on an older build through every
 * publish. lab-pin-bumps.test.mjs fails if a template under
 * lab-host/coder/templates/ pins `hcw-lab` and is missing here.
 */
export const CODER_TEMPLATE_PATHS = Object.freeze([
  CODER_TEMPLATE_PATH,
  'lab-host/coder/templates/amo-guided-lab/main.tf',
  'lab-host/coder/templates/na-guided-lab/main.tf',
]);
/**
 * Files held to a pin that a bump must move with it, or the bump's own pull
 * request fails its checks (#1122 and #1123 did, on 2026-10-13): the caddy
 * test verifies the release it downloads against CADDY_SHA512; the Docker CLI
 * request fixture records the CLI the host pins (scripts/lab/
 * record-docker-cli-fixture.mjs re-records it); the Docker guide page names
 * the lab image's base tag and CPython release in its prose and commands.
 */
export const CADDY_TEST_PATH = 'lab-host/ansible/roles/caddy/tests/caddy-adapt.test.sh';
export const BOOTSTRAP_PATH = 'lab-host/bootstrap.sh';
export const DOCKER_CLI_FIXTURE_PATH = 'scripts/fixtures/docker-cli-agent-requests.json';
export const DOCKER_GUIDE_PAGE_PATH = 'frontend/src/pages/docker/BuildingImagesPage.jsx';
export const README_PATH = 'lab-image/README.md';

// Docker Hub only since 2026-10-08. GHCR was the first stop until the
// repository left the HybridCloudWorks organisation, whose package namespace
// its token can no longer write.
export const RUNNER_IMAGE = 'docker.io/hybridcloudworks/hcw-lab-runner';
export const FULL_IMAGE = 'docker.io/hybridcloudworks/hcw-lab';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
