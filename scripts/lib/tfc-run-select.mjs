/** Choosing the HCP Terraform run that planned a given commit, and describing a run's state in words (check-tfc-plan.mjs). */

/**
 * Run states where a human decision is still outstanding — the case this tool
 * exists for.
 *
 * HashiCorp's run states are documented at
 * developer.hashicorp.com/terraform/cloud-docs/run/states; this is the subset
 * where the run is parked waiting on someone, not a claim to enumerate them all.
 * An unrecognised state therefore reads as "not awaiting", which errs toward
 * printing the caveat rather than silently omitting it.
 */
export const AWAITING_DECISION = new Set(['planned', 'cost_estimated', 'policy_checked', 'policy_override']);

/**
 * Run states that are over.
 *
 * Kept SEPARATE from the complement of AWAITING_DECISION, because those are not
 * the same thing and the first draft of this treated them as though they were.
 * `planning`, `applying`, `cost_estimating` and `apply_queued` are neither
 * awaiting a decision nor finished — they are running. Saying "already
 * finished" of a run that is applying right now is false in the direction that
 * matters, since the operator would read it as settled while ARM is mid-change.
 * Caught in review on 2026-08-30.
 *
 * A state in neither set is in progress as far as the caveat is concerned,
 * which is the safe reading: it claims less.
 */
export const FINISHED = new Set([
  'applied',
  'discarded',
  'errored',
  'canceled',
  'force_canceled',
  'planned_and_finished',
]);

/**
 * Accept a run id with or without its `run-` prefix.
 *
 * HCP Terraform prints run ids prefixed, but the bare suffix is what you get
 * from a hasty copy out of the URL bar or off the run header, and that is what
 * an operator pasted into the workflow's input on 2026-08-30. The bare form
 * 404s, and the 404 handler blamed the token.
 *
 * Prefixing is announced rather than silent: the caller should learn the shape
 * for next time. Anything that is not recognisably an id is refused here, with
 * the expected shape, rather than being sent to the API to come back as a 404
 * that reads like a permissions problem.
 *
 * BLANK IS DECIDED AFTER TRIMMING. The workflow tests its input with
 * `[ -n "$RUN_ID" ]`, and a whitespace-only value passes that — so "   " used
 * to arrive here and throw, when the operator plainly meant "use the latest".
 *
 * The SAME minimum length applies to both forms. It used to be eight for a
 * bare id and one for a prefixed one, so `run-a` passed validation and 404d
 * anyway, reproducing the identifier-versus-token confusion this function
 * exists to end. The bound is deliberately a minimum rather than the sixteen
 * characters HCP Terraform issues today: refusing a valid id because HashiCorp
 * changed its id length would break the tool outright, which is worse than one
 * confusing 404.
 */
const RUN_ID_BODY = /^[A-Za-z0-9]{8,}$/;

export function normaliseRunId(raw) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith('run-')) {
    const body = value.slice(4);
    if (RUN_ID_BODY.test(body)) return value;
  } else if (RUN_ID_BODY.test(value)) {
    console.log(`(read "${value}" as "run-${value}" — run ids carry a run- prefix)`);
    return `run-${value}`;
  }
  throw new Error(
    `"${raw}" is not a run id. Expected the identifier shown on the run page in HCP Terraform, ` +
      'such as run-KqAcgGBXrFkcYP76 — the run- prefix is optional here. Leave it blank to check ' +
      'the workspace latest.'
  );
}

/**
 * The `included` section of a JSON:API document, keyed `type:id`.
 *
 * Shared with `ingressCommitFor` below and with `check-deploy-drift.mjs`,
 * which resolves the same two hops for a different question (which commit did
 * the last APPLY come from?) and should not carry a second copy of the walk.
 */
export function indexIncluded(included) {
  const byId = new Map();
  for (const resource of included || []) {
    if (resource?.id) byId.set(`${resource.type}:${resource.id}`, resource);
  }
  return byId;
}

/**
 * The VCS commit one run was planned from, resolved through `included`.
 *
 * Returns the `commit-sha` string, or null when the run carries no
 * configuration version or its configuration version carries no ingress
 * attributes — both facts about the run, see ABSENT versus DANGLING below.
 * Throws when a relationship is present but its target is missing from
 * `included`, or when the ingress attributes carry no string sha: those are
 * shapes this could not read, and reporting them as "no commit" is how a
 * check vouches for health it never saw.
 *
 * The attribute path is HashiCorp's: `/workspaces/:id/runs` with
 * `include=configuration_version.ingress_attributes` puts the configuration
 * version and its ingress attributes in `included`, and the commit sits at
 * `ingress-attributes.attributes.commit-sha`
 * (developer.hashicorp.com/terraform/cloud-docs/api-docs/run, "Available
 * Related Resources", and /api-docs/configuration-versions, "Show a
 * Configuration Version's Commit Information").
 */
export function ingressCommitFor(run, byId) {
  // ABSENT versus DANGLING, which is the whole distinction this function is
  // built around and the first draft got wrong. A relationship that is not
  // there is a fact about the run — CLI-driven runs have no configuration
  // version, and an API-uploaded configuration version has no ingress
  // attributes — so those are skipped. A relationship that IS there but whose
  // target is missing from `included` means the payload did not carry what was
  // asked for, and skipping it would report "no run for this commit" for a
  // commit that has one. That is the failure this function exists to prevent,
  // so it throws.
  const dangling = (ref, kind) =>
    new Error(
      `HCP Terraform referenced ${kind} ${ref} but did not include it. The runs request must ` +
        'carry include=configuration_version.ingress_attributes, and this tool cannot tell ' +
        'whether a run exists for the commit without it.'
    );

  const cvRef = run?.relationships?.['configuration-version']?.data;
  if (!cvRef?.id) return null;

  const cv = byId.get(`${cvRef.type ?? 'configuration-versions'}:${cvRef.id}`);
  if (!cv) throw dangling(cvRef.id, 'configuration version');

  const iaRef = cv.relationships?.['ingress-attributes']?.data;
  if (!iaRef?.id) return null;

  const ia = byId.get(`${iaRef.type ?? 'ingress-attributes'}:${iaRef.id}`);
  if (!ia) throw dangling(iaRef.id, 'ingress attributes');

  const commit = ia.attributes?.['commit-sha'];
  if (typeof commit !== 'string') {
    throw new Error(
      `Ingress attributes ${iaRef.id} carry no string commit-sha, so the run it belongs to ` +
        'cannot be matched against a commit.'
    );
  }
  return commit;
}

/**
 * Find the run HCP Terraform planned for one commit.
 *
 * WHY THIS EXISTS. Without it this tool resolves the workspace's LATEST run,
 * which is whatever ran last and is usually not the commit in front of you — a
 * check that is green about someone else's run is worse than no check.
 *
 * WHAT IT IS NOT YET KNOWN TO DO, corrected after the first live exercise on
 * 2026-08-31: select the speculative plan for a PULL REQUEST. Asked for a
 * pull-request head that HCP Terraform had posted a green status on, it found
 * nothing, twice, ten minutes apart — while the newest run in the listing was
 * an apply from sixteen hours earlier. So either speculative runs are absent
 * from `/workspaces/:id/runs`, or that status comes from somewhere other than
 * this workspace. Selecting a MERGE commit, whose run is a real queued plan, is
 * the use this is known to serve. `describeRunWindow` below exists so the next
 * person hits a message that distinguishes the two rather than repeating the
 * investigation.
 *
 * SHAPE. `/workspaces/:id/runs?include=configuration_version.ingress_attributes`
 * answers JSON:API: the run carries a `configuration-version` relationship, the
 * configuration version carries an `ingress-attributes` relationship, and the
 * ingress attributes carry `commit-sha`. Both hops are resolved through
 * `included`, which is why the caller must fetch this raw rather than through
 * the `.data` unwrapping the other calls use.
 *
 * UNRECOGNISED SHAPES THROW rather than returning null, following
 * `check-unresolved-secrets.mjs`: "no run for this commit" and "I could not
 * read the answer" are different facts, and reporting the second as the first
 * is how a check reports health it cannot vouch for.
 *
 * The line is ABSENT versus DANGLING. A relationship that is not there is a
 * fact about the run — CLI-driven runs have no configuration version, and an
 * API-uploaded configuration version has no ingress attributes — so those runs
 * are skipped. A relationship that IS there but whose target is missing from
 * `included` means the response did not carry what was asked for; skipping it
 * would report "no run for this commit" for a commit that has one, so it
 * throws. Checking only that `included` EXISTS is not enough: an empty array
 * passes that and then every run is silently skipped.
 *
 * Returns the newest matching run, or null when the payload was readable and
 * nothing matched.
 */
export function selectRunForCommit(payload, sha) {
  const wanted = String(sha ?? '').trim().toLowerCase();
  if (!wanted) throw new Error('selectRunForCommit needs a commit sha');

  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(
      'HCP Terraform returned a runs payload with no `data` array. Expected JSON:API from ' +
        '/workspaces/:id/runs — this tool cannot tell whether a run exists for the commit.'
    );
  }
  if (!Array.isArray(payload.included)) {
    throw new Error(
      'HCP Terraform returned no `included` section, so configuration versions and their ' +
        'commit shas could not be resolved. The request must carry ' +
        'include=configuration_version.ingress_attributes.'
    );
  }

  const byId = indexIncluded(payload.included);

  const matches = [];
  for (const run of payload.data) {
    const commit = ingressCommitFor(run, byId);
    if (commit !== null && commit.toLowerCase() === wanted) matches.push(run);
  }

  if (matches.length === 0) return null;

  // Newest first. A pull request head is usually planned once, but a re-run or
  // a retried plan gives the same commit two runs and the later one is the one
  // a reviewer is looking at.
  matches.sort((a, b) =>
    String(b.attributes?.['created-at'] ?? '').localeCompare(String(a.attributes?.['created-at'] ?? ''))
  );
  return matches[0];
}

/**
 * What the run window actually contained, for the case where nothing matched.
 *
 * WHY THIS EXISTS. The first live exercise of `--commit` (2026-08-31) reported
 * "no run for this commit" for a commit HCP Terraform had posted a green status
 * on. Two explanations fit that — the speculative plan had not been created
 * yet, or speculative runs are not in the listing this tool reads — and the
 * message could not tell them apart, so the operator learned nothing they could
 * act on. "No match" and "no match, and the newest thing here is sixteen hours
 * old" are different findings.
 *
 * Counts runs that carry a resolvable commit separately from runs in total: a
 * window full of runs where none carries a commit sha is the signature of the
 * second explanation.
 */
export function describeRunWindow(payload) {
  const runs = Array.isArray(payload?.data) ? payload.data : [];
  const included = Array.isArray(payload?.included) ? payload.included : [];

  const byId = new Map();
  for (const resource of included) {
    if (resource?.id) byId.set(`${resource.type}:${resource.id}`, resource);
  }

  let newest = null;
  for (const run of runs) {
    const createdAt = run?.attributes?.['created-at'];
    if (typeof createdAt === 'string' && (!newest || createdAt > newest)) newest = createdAt;
  }
  const withCommit = runs.filter((run) => carriesCommit(run, byId)).length;

  return { count: runs.length, withCommit, newest };
}

/** Whether a run's configuration version leads, through `included`, to ingress attributes with a commit sha. */
function carriesCommit(run, byId) {
  const cvRef = run?.relationships?.['configuration-version']?.data;
  if (!cvRef?.id) return false;
  const cv = byId.get(`${cvRef.type ?? 'configuration-versions'}:${cvRef.id}`);
  const iaRef = cv?.relationships?.['ingress-attributes']?.data;
  if (!iaRef?.id) return false;
  const ia = byId.get(`${iaRef.type ?? 'ingress-attributes'}:${iaRef.id}`);
  return typeof ia?.attributes?.['commit-sha'] === 'string';
}
