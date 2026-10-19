/**
 * lab-checks.js — the Hybrid Lab checks that keep #1009's failures from
 * coming back unnoticed, each read from what is already stored and judged
 * by a pure function, so the health pulse and the Labs snapshot say the same
 * thing about the same data.
 *
 *   lab-drift       Does every active agent's host run main? The host's
 *                   applied commit (on the agent's registry document)
 *                   against main's lab-host/ and vps-agent/ commits
 *                   (admin_config/lab_drift); labs/drift.js has the rule.
 *   coder-template  Does Coder serve the template of the commit the host
 *                   converged from? The host's Coder upkeep report
 *                   (admin_config/coder_automation) carries the digest of
 *                   what it last published and the digest of its checkout;
 *                   coderTemplateVerdict below compares them.
 *   lab-canary      Did the last real lab job run end to end? The hourly
 *                   canary's record (admin_config/lab_canary, labs/canary.js).
 *   coder-token     Does Coder accept the site's status token? Coder's last
 *                   answers to it (admin_config/coder_status_token,
 *                   labs/coder-status.js recordTokenAnswer).
 *   portainer       Is Portainer on the lab host up, licensed, reaching its
 *                   local environment, with no container unhealthy or
 *                   restarting and no running image behind its registry?
 *                   The host's own fifteen-minute read of it
 *                   (admin_config/host_checks, labs/host-checks.js);
 *                   portainerVerdict below judges it (#1282).
 *
 * WHY THE TEMPLATE IS COMPARED ON THE HOST'S TWO DIGESTS, NOT THE SITE'S
 * BUILD. A digest of lab-host/coder/templates/hcw-lab computed when the
 * Functions app is built would describe the commit the site was deployed
 * from, and deploys are by hand: a template change merged and bootstrapped
 * before the next deploy would read as a mismatch, and one deployed before
 * the host ran bootstrap.sh would read as fine. The question that failed on
 * 2026-10-08 (finding 8) is narrower and exact: after the host converged, did
 * the publish follow? The host computes both digests with one function
 * (template_digest in hcw-coder-automation.py, over the files
 * hcw-coder-template-push publishes and the autostop it sets), so a pair that
 * differs means one thing. Whether the converged commit is main's is the
 * drift check's question, and the two together cover main → host → Coder.
 *
 * Every verdict is `{ status, summary, detail? }` in the Health Hub's words
 * (health/status-model.js). Nothing here throws on odd data.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { CODER_AUTOMATION_DOC_ID } from './coder-automation.js';
import { LAB_CANARY_DOC_ID, UNREACHED_OUTCOMES } from './canary.js';
import { TOKEN_OPERATIONS, TOKEN_STATE_DOC_ID, isRefusing } from './coder-status.js';
import { LAB_DRIFT_DOC_ID, agoText, labDriftVerdict } from './drift.js';
import { HOST_CHECKS_DOC_ID } from './host-checks.js';
import { storedFailure } from '../http/error-response.js';

export const LAB_DRIFT_PROBE = 'lab-drift';
export const CODER_TEMPLATE_PROBE = 'coder-template';
export const LAB_CANARY_PROBE = 'lab-canary';
export const CODER_TOKEN_PROBE = 'coder-token';
export const PORTAINER_PROBE = 'portainer';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/**
 * Three missed fifteen-minute runs of hcw-portainer-check: the host is not
 * reporting, and its last reading is no longer evidence (#1282).
 */
export const PORTAINER_REPORT_STALE_AFTER_MS = 45 * MINUTE_MS;
/** A Portainer licence this close to its end is raised before it lapses. */
export const PORTAINER_LICENCE_WARNING_DAYS = 30;
/** Three missed hourly runs: the canary has stopped, and its last result is no longer evidence. */
export const CANARY_STALE_AFTER_MS = 3 * HOUR_MS;
/**
 * A day without a read of Coder with the token: an acceptance that old no
 * longer vouches for the token. With the canary armed the status is read
 * hourly; without it, only visitors and the Integrations card read it.
 */
export const TOKEN_EVIDENCE_STALE_AFTER_MS = 24 * HOUR_MS;

/** The registry fields the drift verdict reads. */
export const LAB_DRIFT_AGENTS_QUERY = 'SELECT TOP 200 c.id, c.active, c.applied FROM c';

/**
 * The Integrations card's silence rule (SILENT_AFTER_DAYS in
 * frontend/src/components/admin/integrations/coderAutomationView.js): a
 * daily report a week old is a host that has stopped reporting.
 */
export const TEMPLATE_REPORT_COLD_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const DIGEST = /^[0-9a-f]{64}$/;
const result = (status, summary, detail = null) => ({ status, summary, detail });
const day = (iso) => String(iso).slice(0, 10);

/**
 * Whether Coder serves the template of the commit the host converged from.
 * Pure.
 *
 * @param {object|null} report admin_config/coder_automation, as stored
 * @param {number} nowMs
 */
export function coderTemplateVerdict(report, nowMs) {
  if (!report) {
    return result(
      'unknown',
      'The lab host has not sent a Coder upkeep report yet; hcw-coder-automation sends one daily once it is seeded.'
    );
  }
  const reported = report.reportedAt ? ` Reported ${agoText(report.reportedAt, nowMs)}.` : '';
  const version = report.templateVersion ? ` (${report.templateVersion})` : '';
  if (!report.templatePushedAt) {
    return result(
      'critical',
      `The lab host's automation has never published the hcw-lab template, so Coder may serve one older than the host's commit. bootstrap.sh publishes it, once hcw-coder-automation-seed has stored the rotation credential.${reported}`
    );
  }
  const published = report.templateDigest;
  const source = report.templateSourceDigest;
  if (!DIGEST.test(String(published ?? '')) || !DIGEST.test(String(source ?? ''))) {
    return result(
      'unknown',
      `The hcw-lab template was last published ${day(report.templatePushedAt)}${version}, but the host's report carries no template digests to compare with its checkout yet. They arrive with the first daily report after bootstrap.sh installs this version.${reported}`
    );
  }
  const detail = `published ${published}\ncheckout  ${source}`;
  if (published !== source) {
    return result(
      'critical',
      `Coder serves the hcw-lab template published ${day(report.templatePushedAt)}${version}, which is not the template in the commit the host converged from: the publish did not follow the host's last bootstrap.sh run. Run bootstrap.sh again, or hcw-coder-automation push-template on the host.${reported}`,
      detail
    );
  }
  const reportedMs = Date.parse(report.reportedAt ?? '');
  if (Number.isFinite(reportedMs) && nowMs - reportedMs > TEMPLATE_REPORT_COLD_AFTER_MS) {
    return result(
      'degraded',
      `Coder served the hcw-lab template of the host's commit${version} when the host last reported, but that report is more than a week old, so a later change may not be published.${reported}`,
      detail
    );
  }
  return result(
    'healthy',
    `Coder serves the hcw-lab template of the commit the host converged from${version}, published ${day(report.templatePushedAt)}.${reported}`,
    detail
  );
}

const secondsText = (ms) => `${Math.round(ms / 1000)} s`;

/** "claimed after 12 s, done 3 s later", from whichever timings the run has. */
function timingsText(timings) {
  const parts = [];
  if (Number.isFinite(timings?.claimMs)) parts.push(`claimed after ${secondsText(timings.claimMs)}`);
  if (Number.isFinite(timings?.runMs)) parts.push(`done ${secondsText(timings.runMs)} later`);
  return parts.join(', ');
}

/**
 * Whether the last real lab job ran end to end. Pure.
 *
 * Nothing ran it (no agent online, nobody claimed it) is `offline`, the
 * status-model's word for silence; a job that ran and failed, a registry with
 * no agent for the job type, or a job left in flight is `critical`.
 *
 * @param {object|null} state admin_config/lab_canary
 * @param {number} nowMs
 */
export function labCanaryVerdict(state, nowMs) {
  if (!state?.lastRunAt) {
    return result(
      'unknown',
      'The lab canary has not run. Add LAB_CANARY to enabled_timers to run one shell-echo job an hour end to end.'
    );
  }
  const last = state.lastResult ?? {};
  const when = agoText(state.lastRunAt, nowMs);
  const timings = timingsText(last.timings);
  const lastLine = last.ok
    ? `the last job passed${timings ? ` (${timings})` : ''}`
    : `the last did not pass (${last.reason || last.outcome || 'no reason recorded'})`;
  const lastRunMs = Date.parse(String(state.lastRunAt));
  if (!Number.isFinite(lastRunMs) || nowMs - lastRunMs > CANARY_STALE_AFTER_MS) {
    return result(
      'unknown',
      `The lab canary last ran ${when}, and it runs hourly while LAB_CANARY is armed, so it has stopped; ${lastLine}.`
    );
  }
  if (last.ok) {
    return result(
      'healthy',
      `A shell-echo job ran end to end ${when}${timings ? `: ${timings}` : ''}.`
    );
  }
  const streak = Number(state.consecutiveFailures) > 1 ? ` ${state.consecutiveFailures} runs in a row.` : '';
  const success = state.lastSuccessAt
    ? ` The last job that passed ran ${agoText(state.lastSuccessAt, nowMs)}.`
    : ' No canary job has passed yet.';
  return result(
    UNREACHED_OUTCOMES.includes(last.outcome) ? 'offline' : 'critical',
    `The lab canary did not pass ${when}: ${last.reason || last.outcome || 'no reason recorded'}.${streak}${success}`,
    last.outcome ? `outcome ${last.outcome}` : null
  );
}

const refusalMeaning = (status) =>
  status === 403
    ? 'it lacks the template:read or workspace:read scope'
    : 'it has expired or been revoked';

/** What each operation is, in words (coder-status.js TOKEN_OPERATIONS). */
const OPERATION_NAMES = Object.freeze({
  status: 'the labs status read',
  expiry: "the Integrations card's read of its own record",
});

/** One operation's last answers, as one line of the detail. */
function operationLine(operation, entry) {
  const answers = [];
  if (entry.lastAcceptedAt) answers.push(`accepted ${entry.lastAcceptedAt}`);
  if (entry.lastRefusedAt) answers.push(`refused (HTTP ${entry.lastRefusedStatus}) ${entry.lastRefusedAt}`);
  return `${OPERATION_NAMES[operation]}: last ${answers.join(', last ')}`;
}

/**
 * Whether Coder accepts the site's status token, by its last recorded
 * answers, kept per operation (coder-status.js). Pure.
 *
 * Critical while any operation's latest answer is a refusal, however old: it
 * is still that operation's latest evidence, and only an acceptance of the
 * same operation clears it, so the expiry read succeeding never clears a
 * status read's 403. Otherwise healthy on an acceptance within a day, and
 * unknown on an older one.
 *
 * @param {object|null} state admin_config/coder_status_token
 * @param {number} nowMs
 */
export function coderTokenVerdict(state, nowMs) {
  const entries = TOKEN_OPERATIONS.map((operation) => [operation, state?.operations?.[operation]]).filter(
    ([, entry]) => entry?.lastAcceptedAt || entry?.lastRefusedAt
  );
  if (entries.length === 0) {
    return result(
      'unknown',
      "No read of Coder with CODER_STATUS_TOKEN has been recorded yet; the labs status read, checkAgentHealth's hourly check and the Integrations card record each one."
    );
  }
  const detail = entries.map(([operation, entry]) => operationLine(operation, entry)).join('\n');
  const refusing = entries.find(([, entry]) => isRefusing(entry));
  if (refusing) {
    const [operation, entry] = refusing;
    const status = Number(entry.lastRefusedStatus) || 401;
    const since = entry.refusingSince ?? entry.lastRefusedAt;
    return result(
      'critical',
      `Coder has refused CODER_STATUS_TOKEN on ${OPERATION_NAMES[operation]} (HTTP ${status}) since ${since}, ${agoText(since, nowMs)}: ${refusalMeaning(status)}, so the labs card's templates and running count are unknown. The lab host's Coder automation renews it daily; Integrations → Hybrid Lab shows its last report.`,
      detail
    );
  }
  const [newestOperation, newest] = entries.reduce((best, candidate) =>
    Date.parse(String(candidate[1].lastAcceptedAt ?? '')) > Date.parse(String(best[1].lastAcceptedAt ?? ''))
      ? candidate
      : best
  );
  const acceptedMs = Date.parse(String(newest.lastAcceptedAt ?? ''));
  if (!Number.isFinite(acceptedMs) || nowMs - acceptedMs > TOKEN_EVIDENCE_STALE_AFTER_MS) {
    return result(
      'unknown',
      `Coder last accepted CODER_STATUS_TOKEN ${agoText(newest.lastAcceptedAt, nowMs)}, and nothing has read Coder with it since, so whether it still does is unknown.`,
      detail
    );
  }
  return result(
    'healthy',
    `Coder accepted CODER_STATUS_TOKEN ${agoText(newest.lastAcceptedAt, nowMs)} (${OPERATION_NAMES[newestOperation]}).`,
    detail
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Portainer 2.45.2 EE", or as much of it as the reading carries. */
const portainerName = (entry) => ['Portainer', entry.version, entry.edition].filter(Boolean).join(' ');

/** The images clause of a healthy summary: a check with nothing to check, or none made (CE has no image status), is said. */
function imagesText(entry) {
  if (entry.imagesChecked === null || entry.imagesChecked === undefined) return 'images not checked';
  if (entry.imagesChecked === 0) return 'no running image to check';
  return 'images current';
}

/** The licence clause of a healthy summary. */
function licenceText(entry) {
  if (entry.licenseExpiresAt) return `licence to ${day(entry.licenseExpiresAt)}`;
  if (entry.licenseValid === true) return 'licence valid';
  return 'no licence reported';
}

/**
 * The licence's complaint, or null: Portainer calls it invalid, or its end is
 * within PORTAINER_LICENCE_WARNING_DAYS of now (an end already passed
 * included, in case Portainer still calls the licence valid in a grace
 * period).
 */
function licenceWarning(entry, nowMs) {
  const expiry = entry.licenseExpiresAt ? day(entry.licenseExpiresAt) : null;
  if (entry.licenseValid === false) {
    return `Portainer reports its licence as not valid${expiry ? ` (expiry ${expiry})` : ''}; renew it before the Business Edition features lapse.`;
  }
  const expiresMs = Date.parse(String(entry.licenseExpiresAt ?? ''));
  if (!Number.isFinite(expiresMs)) return null;
  const daysLeft = Math.floor((expiresMs - nowMs) / DAY_MS);
  if (daysLeft > PORTAINER_LICENCE_WARNING_DAYS) return null;
  if (daysLeft < 0) return `Portainer's licence expired ${expiry}; renew it.`;
  return `Portainer's licence expires ${expiry}, in ${plural(daysLeft, 'day')}; renew it before then.`;
}

/** Every number the reading carries, one line each; counts and states only, as the report itself is. */
function portainerDetail(entry) {
  const c = entry.containers ?? {};
  const licence =
    entry.licenseValid === null || entry.licenseValid === undefined
      ? 'not reported'
      : entry.licenseValid
        ? 'valid'
        : 'not valid';
  return [
    `${portainerName(entry)}${entry.up === false ? ' (not answering)' : ''}`,
    `environment ${entry.environmentName || '?'} ${entry.environmentUp ? 'up' : 'down'}`,
    `containers ${c.total ?? '?'} total, ${c.running ?? '?'} running, ${c.unhealthy ?? '?'} unhealthy, ${c.restarting ?? '?'} restarting, ${c.exited ?? '?'} exited`,
    entry.imagesChecked === null || entry.imagesChecked === undefined
      ? 'images not checked'
      : `images ${entry.imagesChecked} checked, ${entry.imagesOutdated ?? '?'} outdated`,
    `licence ${licence}${entry.licenseExpiresAt ? `, expires ${day(entry.licenseExpiresAt)}` : ''}`,
    `read ${entry.checkedAt ?? '?'}, received ${entry.receivedAt ?? '?'}`,
  ].join('\n');
}

/**
 * Whether Portainer on the lab host is up and sound, from the host's own
 * last reading of it (host-checks.js; #1282). Pure.
 *
 * No entry is `unknown`: the host has not reported, which until the first
 * bootstrap.sh run with the token is the expected state. A reading older
 * than PORTAINER_REPORT_STALE_AFTER_MS is `critical`, not `offline`: it is
 * the host's timer, not Portainer, that has stopped, its unit's OnFailure
 * path is the LAB-2 alert, and the card says the same thing. Portainer not
 * answering, its local environment down or the check itself failing is
 * `critical` with the reason. Unhealthy or restarting containers, images
 * with an update available, and a licence invalid or within
 * PORTAINER_LICENCE_WARNING_DAYS of its end are `degraded`, every reason
 * named at once; otherwise `healthy` with the numbers. `warning` is not a
 * word the status model has (health/status-model.js), so what #1282 calls
 * a warning is degraded here.
 *
 * @param {object|null} entry admin_config/host_checks → checks.portainer
 * @param {number} nowMs
 */
export function portainerVerdict(entry, nowMs) {
  if (!entry || typeof entry !== 'object') {
    return result(
      'unknown',
      "Portainer has not reported: the host's check needs vault_portainer_api_token (lab-host/README.md, Portainer)."
    );
  }
  const receivedMs = Date.parse(String(entry.receivedAt ?? ''));
  if (!Number.isFinite(receivedMs) || nowMs - receivedMs > PORTAINER_REPORT_STALE_AFTER_MS) {
    const since = Number.isFinite(receivedMs)
      ? `${entry.receivedAt} (${agoText(entry.receivedAt, nowMs)})`
      : 'an unknown time';
    return result(
      'critical',
      `No Portainer report since ${since}; the host's hcw-portainer-check timer is not running or cannot reach the site.`,
      portainerDetail(entry)
    );
  }
  const read = agoText(entry.receivedAt, nowMs);
  const detail = portainerDetail(entry);
  const name = entry.environmentName || 'local';
  if (entry.up === false) {
    return result(
      'critical',
      `Portainer on the lab host did not answer its check ${read}: ${entry.error || 'no reason recorded'}.`,
      detail
    );
  }
  if (entry.error) {
    return result('critical', `Portainer answered but its check failed ${read}: ${entry.error}.`, detail);
  }
  if (entry.environmentUp === false) {
    return result(
      'critical',
      `Portainer is up but its ${name} environment is down ${read}, so it cannot reach the host's Docker engine.`,
      detail
    );
  }
  const containers = entry.containers ?? {};
  const unhealthy = Number(containers.unhealthy) || 0;
  const restarting = Number(containers.restarting) || 0;
  const reasons = [];
  if (unhealthy + restarting > 0) {
    reasons.push(
      `${unhealthy} unhealthy and ${restarting} restarting of ${Number(containers.total) || 0} containers on the lab host, as Portainer saw them ${read}.`
    );
  }
  if (Number(entry.imagesOutdated) > 0) {
    reasons.push(
      `${entry.imagesOutdated} of ${entry.imagesChecked ?? '?'} running images have an update available in their registry.`
    );
  }
  const licence = licenceWarning(entry, nowMs);
  if (licence) reasons.push(licence);
  if (reasons.length > 0) return result('degraded', reasons.join(' '), detail);
  return result(
    'healthy',
    `${portainerName(entry)}, ${name} Up, ${plural(Number(containers.running) || 0, 'container')} running, ${imagesText(entry)}, ${licenceText(entry)}; read ${read}.`,
    detail
  );
}

/** The drift verdict from the registry rows given, or read here when none are. */
export async function readLabDrift(store, nowMs, agentRows = null) {
  const [agents, drift] = await Promise.all([
    agentRows ?? store.queryDocs('lab_agents', LAB_DRIFT_AGENTS_QUERY, []),
    store.readDoc('admin_config', LAB_DRIFT_DOC_ID, ADMIN_CONFIG_PARTITION),
  ]);
  return labDriftVerdict({ agents, drift, nowMs });
}

/** The template verdict from the host's last Coder upkeep report. */
export async function readCoderTemplate(store, nowMs) {
  const report = await store.readDoc('admin_config', CODER_AUTOMATION_DOC_ID, ADMIN_CONFIG_PARTITION);
  return coderTemplateVerdict(report, nowMs);
}

/** The canary verdict from its record. */
export async function readLabCanary(store, nowMs) {
  return labCanaryVerdict(
    await store.readDoc('admin_config', LAB_CANARY_DOC_ID, ADMIN_CONFIG_PARTITION),
    nowMs
  );
}

/** The status-token verdict from Coder's recorded answers. */
export async function readCoderToken(store, nowMs) {
  return coderTokenVerdict(
    await store.readDoc('admin_config', TOKEN_STATE_DOC_ID, ADMIN_CONFIG_PARTITION),
    nowMs
  );
}

/** The Portainer verdict from the host's last reading of it; no document, or no entry, is "not reported". */
export async function readPortainer(store, nowMs) {
  const doc = await store.readDoc('admin_config', HOST_CHECKS_DOC_ID, ADMIN_CONFIG_PARTITION);
  return portainerVerdict(doc?.checks?.portainer ?? null, nowMs);
}

/**
 * A check that could not be read is said as such, never as healthy: a
 * sentence with the error's code, never the store's own words (#945).
 *
 * @param {unknown} error - what the read threw
 * @returns {{ status: string, summary: string }}
 */
const unreadable = (error) =>
  result('unknown', storedFailure(error, "The check's data could not be read."));

/**
 * Every check, for the Labs snapshot: `{ checks, drift }`, where `drift` is
 * the drift verdict whole (its per-agent lines go on the agent cards). One
 * failed read leaves that check unknown and the others standing.
 *
 * @param {object} store
 * @param {number} nowMs
 * @param {object[]} agentRows the registry rows the snapshot already read
 */
export async function readLabChecks(store, nowMs, agentRows) {
  const [drift, template, canary, token, portainer] = await Promise.all([
    readLabDrift(store, nowMs, agentRows).catch((error) => ({ ...unreadable(error), agents: {} })),
    readCoderTemplate(store, nowMs).catch(unreadable),
    readLabCanary(store, nowMs).catch(unreadable),
    readCoderToken(store, nowMs).catch(unreadable),
    readPortainer(store, nowMs).catch(unreadable),
  ]);
  const { agents: _perAgent, ...driftCheck } = drift;
  return {
    checks: {
      [LAB_DRIFT_PROBE]: driftCheck,
      [CODER_TEMPLATE_PROBE]: template,
      [LAB_CANARY_PROBE]: canary,
      [CODER_TOKEN_PROBE]: token,
      [PORTAINER_PROBE]: portainer,
    },
    drift,
  };
}
