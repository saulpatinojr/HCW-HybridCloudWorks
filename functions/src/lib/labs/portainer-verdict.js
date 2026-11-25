/**
 * labs/portainer-verdict.js — the Portainer card's verdict (lab-checks.js
 * has the other lab checks and reads the report): from the lab host's last
 * Portainer reading, whether Portainer, its environment, the containers,
 * the images and the licence are in order. Pure; lab-checks.js re-exports
 * what callers use.
 */
import { agoText } from './drift.js';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Three missed fifteen-minute runs of hcw-portainer-check: the host is not
 * reporting, and its last reading is no longer evidence (#1282).
 */
export const PORTAINER_REPORT_STALE_AFTER_MS = 45 * MINUTE_MS;
/** A Portainer licence this close to its end is raised before it lapses. */
export const PORTAINER_LICENCE_WARNING_DAYS = 30;
const result = (status, summary, detail = null) => ({ status, summary, detail });
const day = (iso) => String(iso).slice(0, 10);

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
  const down = portainerDownVerdict(entry, { read, detail, name });
  if (down) return down;
  const reasons = degradedReasons(entry, read, nowMs);
  if (reasons.length > 0) return result('degraded', reasons.join(' '), detail);
  const containers = entry.containers ?? {};
  return result(
    'healthy',
    `${portainerName(entry)}, ${name} Up, ${plural(Number(containers.running) || 0, 'container')} running, ${imagesText(entry)}, ${licenceText(entry)}; read ${read}.`,
    detail
  );
}

/** Critical when Portainer did not answer, its check failed, or its environment is down; null otherwise. */
function portainerDownVerdict(entry, { read, detail, name }) {
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
  return null;
}

/** Every reason the reading is degraded: troubled containers, outdated images, the licence. */
function degradedReasons(entry, read, nowMs) {
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
  return reasons;
}
