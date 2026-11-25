/**
 * labs/portainer-report.js — the Portainer report the lab host sends to the
 * host checks route (host-checks.js has the route and the header that
 * explains it), checked key by key: every field this code reads has a
 * fixed shape, and anything else is refused. host-checks.js re-exports the
 * constants callers use.
 */
import { MAX_CLOCK_SKEW_MS, parseIsoDateTime } from './coder-automation.js';

export const MAX_VERSION_LENGTH = 32;
export const MAX_ENVIRONMENT_NAME_LENGTH = 64;
export const MAX_ERROR_LENGTH = 300;
export const PORTAINER_EDITIONS = Object.freeze(['EE', 'CE']);

/** The container counts a Portainer report carries, every one required. */
export const CONTAINER_COUNT_FIELDS = Object.freeze(['total', 'running', 'unhealthy', 'restarting', 'exited']);

/** A Portainer report's keys, in the order the document keeps them. Anything else is refused. */
export const PORTAINER_REPORT_FIELDS = Object.freeze([
  'checkedAt',
  'up',
  'version',
  'edition',
  'licenseValid',
  'licenseExpiresAt',
  'environmentName',
  'environmentUp',
  'containers',
  'imagesChecked',
  'imagesOutdated',
  'error',
]);

/** The keys a report may leave out: Portainer gives no version or edition when it is down. */
export const PORTAINER_OPTIONAL_FIELDS = Object.freeze(['version', 'edition']);

const SKEW_MINUTES = MAX_CLOCK_SKEW_MS / 60_000;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const ok = (value) => ({ value });
const refuse = (error) => ({ error });

/**
 * `checkedAt`: an ISO 8601 date-time within MAX_CLOCK_SKEW_MS of the site's
 * clock either way (see the header for why both sides), normalised to UTC.
 */
function checkedAtValue(raw, nowMs) {
  const iso = parseIsoDateTime(raw);
  if (!iso) {
    return refuse('report.checkedAt must be an ISO 8601 date-time with a zone, such as 2026-10-19T04:30:00Z');
  }
  const drift = Date.parse(iso) - nowMs;
  if (drift > MAX_CLOCK_SKEW_MS) {
    return refuse(
      `report.checkedAt is more than ${SKEW_MINUTES} minutes ahead of the site's clock; check the lab host's clock`
    );
  }
  if (-drift > MAX_CLOCK_SKEW_MS) {
    return refuse(
      `report.checkedAt is more than ${SKEW_MINUTES} minutes behind the site's clock; the reading is stale or the lab host's clock is slow`
    );
  }
  return ok(iso);
}

const booleanValue = (key, raw) =>
  typeof raw === 'boolean' ? ok(raw) : refuse(`report.${key} must be true or false`);

const nullableBooleanValue = (key, raw) =>
  raw === null || typeof raw === 'boolean' ? ok(raw) : refuse(`report.${key} must be true, false or null`);

function nullableDateValue(key, raw) {
  if (raw === null) return ok(null);
  const iso = parseIsoDateTime(raw);
  return iso ? ok(iso) : refuse(`report.${key} must be an ISO 8601 date-time with a zone, or null`);
}

// `raw + 0` folds -0 (an integer by Number.isInteger) into 0 before it is stored.
const countValue = (key, raw) =>
  Number.isInteger(raw) && raw >= 0 ? ok(raw + 0) : refuse(`report.${key} must be a whole number of zero or more`);

const nullableCountValue = (key, raw) =>
  raw === null ? ok(null) : Number.isInteger(raw) && raw >= 0
    ? ok(raw + 0)
    : refuse(`report.${key} must be a whole number of zero or more, or null`);

/** Control characters, DEL and line breaks: none of the three strings may carry one. */
export const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
/** What a version looks like: `2.45.2`, `2.45.2-linux-amd64`, `v2.38.0+c3c6a67`. */
export const VERSION_SHAPE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;

/** The version Portainer reports, when it answered: absent or null when it did not. */
function versionValue(raw) {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== 'string' || !VERSION_SHAPE.test(raw.trim())) {
    return refuse(
      `report.version must be a version of 1 to ${MAX_VERSION_LENGTH} characters (letters, digits, dots, plus and hyphen), or absent`
    );
  }
  return ok(raw.trim());
}

function editionValue(raw) {
  if (raw === undefined || raw === null) return ok(null);
  return PORTAINER_EDITIONS.includes(raw)
    ? ok(raw)
    : refuse(`report.edition must be ${PORTAINER_EDITIONS.join(' or ')}, or absent`);
}

/** The environment the check looked for (`local`); a string, empty when Portainer did not answer. */
function environmentNameValue(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_ENVIRONMENT_NAME_LENGTH || CONTROL_CHARACTERS.test(raw)) {
    return refuse(
      `report.environmentName must be a string of at most ${MAX_ENVIRONMENT_NAME_LENGTH} printable characters`
    );
  }
  return ok(raw.trim());
}

/** The host's own sentence about what went wrong, or null; an empty sentence is null. */
function errorValue(raw) {
  if (raw === null) return ok(null);
  if (typeof raw !== 'string' || raw.length > MAX_ERROR_LENGTH || CONTROL_CHARACTERS.test(raw)) {
    return refuse(
      `report.error must be one line of at most ${MAX_ERROR_LENGTH} printable characters, or null`
    );
  }
  return ok(raw.trim() || null);
}

/**
 * Counts that contradict each other are a 400 too: the card would otherwise
 * print arithmetic that cannot be true (`9 running of 8`, `5 of ? images`).
 */
function consistentCounts(report) {
  const { total, running, unhealthy, restarting, exited } = report.containers;
  if (running > total) return refuse('report.containers.running cannot exceed report.containers.total');
  if (unhealthy + restarting + exited > total) {
    return refuse('report.containers.unhealthy, restarting and exited together cannot exceed report.containers.total');
  }
  if (report.imagesChecked === null && report.imagesOutdated !== null) {
    return refuse('report.imagesOutdated must be null when report.imagesChecked is null');
  }
  if (report.imagesChecked !== null && report.imagesOutdated !== null && report.imagesOutdated > report.imagesChecked) {
    return refuse('report.imagesOutdated cannot exceed report.imagesChecked');
  }
  return ok(report);
}

/** The five container counts, exactly those keys, each a non-negative integer. */
function containersValue(raw) {
  if (!isPlainObject(raw)) return refuse('report.containers must be a JSON object of counts');
  if (Object.keys(raw).some((key) => !CONTAINER_COUNT_FIELDS.includes(key))) {
    return refuse(
      `report.containers carries a field this route does not read: it holds ${CONTAINER_COUNT_FIELDS.join(', ')} only`
    );
  }
  const counts = {};
  for (const key of CONTAINER_COUNT_FIELDS) {
    const checked = countValue(`containers.${key}`, raw[key]);
    if (checked.error) return checked;
    counts[key] = checked.value;
  }
  return ok(counts);
}

/** A Portainer report, checked key by key in PORTAINER_REPORT_FIELDS order: `{ value }` or `{ error }`. */
export function parsePortainerReport(raw, nowMs) {
  if (!isPlainObject(raw)) return refuse('report must be a JSON object');
  if (Object.keys(raw).some((key) => !PORTAINER_REPORT_FIELDS.includes(key))) {
    return refuse(
      `report carries a field this route does not read: a portainer report holds ${PORTAINER_REPORT_FIELDS.join(', ')}`
    );
  }
  const missing = PORTAINER_REPORT_FIELDS.find(
    (key) => raw[key] === undefined && !PORTAINER_OPTIONAL_FIELDS.includes(key)
  );
  if (missing) return refuse(`report.${missing} is required`);

  const checks = {
    checkedAt: () => checkedAtValue(raw.checkedAt, nowMs),
    up: () => booleanValue('up', raw.up),
    version: () => versionValue(raw.version),
    edition: () => editionValue(raw.edition),
    licenseValid: () => nullableBooleanValue('licenseValid', raw.licenseValid),
    licenseExpiresAt: () => nullableDateValue('licenseExpiresAt', raw.licenseExpiresAt),
    environmentName: () => environmentNameValue(raw.environmentName),
    environmentUp: () => booleanValue('environmentUp', raw.environmentUp),
    containers: () => containersValue(raw.containers),
    imagesChecked: () => nullableCountValue('imagesChecked', raw.imagesChecked),
    imagesOutdated: () => nullableCountValue('imagesOutdated', raw.imagesOutdated),
    error: () => errorValue(raw.error),
  };
  const report = {};
  for (const key of PORTAINER_REPORT_FIELDS) {
    const checked = checks[key]();
    if (checked.error) return checked;
    report[key] = checked.value;
  }
  return consistentCounts(report);
}

