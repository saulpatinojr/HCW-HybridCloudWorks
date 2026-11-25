/** The services check-deploy-drift.mjs watches, and the limits on how far it pages and how long it waits. */
import { ORGANIZATION, WORKSPACE } from '../tfc-workspace-busy.mjs';

export const API = 'https://api.github.com';

/**
 * What each deployable service is, and what it ships.
 *
 * A service names where its deployed baseline comes from: the `workflow`
 * whose last successful run deployed it, or the `terraform` workspace whose
 * last applied run did (see the header for why those are different reads).
 * `paths` are prefixes matched against the repository-relative paths the
 * GitHub commits API is filtered by. Adding a service here is the only change
 * a new deploy target needs.
 */
export const SERVICES = Object.freeze([
  Object.freeze({
    name: 'Function App',
    workflow: 'deploy-functions.yml',
    paths: Object.freeze(['functions']),
  }),
  Object.freeze({
    name: 'Static Web App',
    workflow: 'deploy-azure-frontend.yml',
    paths: Object.freeze(['frontend']),
  }),
  Object.freeze({
    name: 'Terraform Infrastructure',
    // No `workflow`: nothing in this repository applies, so the baseline is
    // the newest APPLIED run on the workspace, read from HCP Terraform. One
    // path: `infra/cosmos-containers.json` sits under `infra`. The first
    // version also listed `cosmos-containers.json` at the root, which does
    // not exist and matched nothing (F5, #963).
    terraform: Object.freeze({ organization: ORGANIZATION, workspace: WORKSPACE }),
    paths: Object.freeze(['infra']),
  }),
]);

/** Hours of drift tolerated before this is called stale. */
export const DEFAULT_THRESHOLD_HOURS = 8;

/** GitHub's maximum page size for the commits API. */
export const COMMITS_PER_PAGE = 100;

/**
 * A ceiling on pagination, so an unexpected answer cannot loop against the API
 * forever. Ten pages is 1,000 commits since the last deploy — far past any
 * drift worth measuring rather than simply deploying.
 */
export const MAX_COMMIT_PAGES = 10;

/**
 * How many of a deploy workflow's runs one listing page names, newest first,
 * and so how many are read by id per page (#1564). The same ten
 * `check-functions-deploy-in-progress.mjs` reads: a deploy succeeds far more
 * often than not, so the newest success is nearly always on the first page,
 * and ten reads a page keeps a monitor that runs every four hours well
 * inside the token's hourly allowance.
 */
export const RUNS_PER_PAGE = 10;

/**
 * How many listing pages are read before this stops looking for a success.
 * Ten pages is a hundred runs with no success among them; past that, "never
 * deployed" and "a long failure streak" cannot be told apart from here, and
 * `lastSuccessfulRun` says so rather than guessing either.
 */
export const MAX_RUN_PAGES = 10;

/**
 * How long one GitHub request may take, and the pause before the one retry a
 * 5xx, a 429 or a dropped connection gets. The two values
 * `check-functions-deploy-in-progress.mjs` uses, for the same reason: without
 * a bound a stalled connection waits on undici's five-minute defaults, and
 * the monitor's job has a ten-minute timeout.
 */
export const TIMEOUT_MS = 15000;
export const RETRY_DELAY_MS = 2000;
