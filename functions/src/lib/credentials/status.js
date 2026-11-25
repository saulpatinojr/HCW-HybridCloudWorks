/**
 * How old each credential is, when it expires, and whether that is a problem
 * (#1026). Pure: every function here takes the sources it reads and the
 * clock, so each state is testable without Cosmos and without a calendar.
 *
 * ## The four states
 *
 *   ok        nothing is due: it renews itself, it is an identifier, its
 *             expiry is outside its window, or no rule makes it due
 *   due-soon  its expiry or rotation date is inside its window (DUE_SOON_DAYS,
 *             or SHORT_DUE_SOON_DAYS for a short-lived one)
 *   overdue   past it, or signed out: shown red
 *   unknown   a rule exists but the date it runs from does not: no rotation
 *             recorded, no report from its automation, or a source that
 *             could not be read
 *
 * ## Where an expiry comes from
 *
 * A LIVE expiry first: what the lab host reported for a Coder token. Failing
 * that, for a HAND credential only, the last rotation plus its lifetimeDays,
 * marked `expiryEstimated`. An automation-renewed credential is judged only
 * by what its automation reports, never by an estimate: the Coder status
 * token the owner minted by hand on 2026-09-28 lasts a year, and an estimate
 * from the 90-day tokens the lab host mints would have shown it overdue for
 * nine months it was valid. Without a report it is `unknown`, which is true.
 *
 * ## Where the last rotation comes from
 *
 * The latest of: the Keys tab's `lastWriteAt` for a Key Vault secret
 * (admin_config/secret_state), the lab host's `statusTokenRotatedAt`, an
 * OAuth connection's refresh or connect time, and the date the owner
 * recorded on the tab (admin_config/credential_register). The owner's date
 * counts only for a hand-renewed credential, which is the only kind the tab
 * lets them record.
 *
 * ## A source that could not be read
 *
 * A credential whose dates come from a source sources.js could not read, or
 * read and found malformed, is `unknown`, with no age, expiry or reminder:
 * a status computed from the sources that DID answer would be a guess
 * presented as a fact (review of #1039: an owner-recorded date standing in
 * for a Key Vault write nobody could see).
 *
 * NOTHING HERE TOUCHES A VALUE. An mcp_servers record holds its tokens, so
 * it reaches this module only as the projection sources.js asks Cosmos for:
 * dates, states and a `hasToken` boolean. Every other source is read by the
 * one field it is wanted for.
 */

import { dateOnly, daysUntil } from '../reminders/calendar.js';
import { CREDENTIAL_REGISTER, CREDENTIAL_STORES, isRecordable } from './register.js';
import { resolveLive } from './live-dates.js';

export { mcpConnection, resolveLive } from './live-dates.js';

export const CREDENTIAL_STATES = Object.freeze(['ok', 'due-soon', 'overdue', 'unknown']);

/** Days before a due date that a credential turns due-soon, and its reminder is first said. */
export const DUE_SOON_DAYS = 30;
/** The same, for a credential whose rule is shorter than SHORT_LIFETIME_DAYS: a third of 90 is too early. */
export const SHORT_DUE_SOON_DAYS = 14;
export const SHORT_LIFETIME_DAYS = 180;

const DAY_MS = 86_400_000;

/** The due-soon window for one entry. */
export function dueSoonDays(entry) {
  const lifetime = entry?.lifetimeDays;
  return Number.isInteger(lifetime) && lifetime < SHORT_LIFETIME_DAYS ? SHORT_DUE_SOON_DAYS : DUE_SOON_DAYS;
}

/** The expiry to judge by: live, or estimated for a hand credential; null when there is none. */
function expiryOf(entry, live) {
  if (live.expiresAt) return { expiresAt: live.expiresAt, estimated: false };
  if (entry.renewal !== 'hand' || !Number.isInteger(entry.lifetimeDays) || !live.lastRotatedAt) return null;
  const at = Date.parse(live.lastRotatedAt) + entry.lifetimeDays * DAY_MS;
  return { expiresAt: new Date(at).toISOString(), estimated: true };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The state and its sentence for a credential with an expiry. */
function judgeExpiry(entry, expiry, daysLeft, nowMs) {
  const day = dateOnly(expiry.expiresAt);
  const what = expiry.estimated ? 'Rotation due' : 'Expires';
  if (nowMs >= Date.parse(expiry.expiresAt)) {
    return {
      state: 'overdue',
      reason: expiry.estimated ? `Rotation was due on ${day}.` : `Expired on ${day}.`,
    };
  }
  if (daysLeft <= dueSoonDays(entry)) {
    const when = daysLeft <= 0 ? 'today' : `in ${plural(daysLeft, 'day')}`;
    return { state: 'due-soon', reason: `${what} ${when}, on ${day}.` };
  }
  return {
    state: 'ok',
    reason: expiry.estimated ? `Next rotation due on ${day}.` : `Expires on ${day}.`,
  };
}

/** The state and its sentence for a credential with no expiry to judge. */
function judgeWithoutExpiry(entry, live) {
  if (entry.source?.mcpServer && live.connection === null) {
    return { state: 'unknown', reason: 'Its connection could not be read.' };
  }
  if (entry.renewal === 'automation') {
    if (Number.isInteger(entry.lifetimeDays)) {
      return { state: 'unknown', reason: 'Renewed by automation, which has not reported an expiry yet.' };
    }
    return { state: 'ok', reason: 'Connected, and renewed automatically.' };
  }
  if (Number.isInteger(entry.lifetimeDays)) {
    return { state: 'unknown', reason: 'No rotation date is known: record when it was last rotated.' };
  }
  return { state: 'ok', reason: 'It does not expire, and no rotation rule applies.' };
}

/**
 * One entry's age, expiry and state at `nowMs`.
 *
 * @returns {{ ageDays: number|null, expiresAt: string|null, expiryEstimated: boolean,
 *   daysLeft: number|null, state: string, reason: string }}
 */
export function computeCredentialStatus(entry, live, nowMs = Date.now()) {
  const rotated = Date.parse(live.lastRotatedAt ?? '');
  const ageDays = Number.isFinite(rotated) ? Math.max(0, Math.floor((nowMs - rotated) / DAY_MS)) : null;
  const expiry = expiryOf(entry, live);
  const daysLeft = expiry ? daysUntil(dateOnly(expiry.expiresAt), dateOnly(nowMs)) : null;
  const base = {
    ageDays,
    expiresAt: expiry?.expiresAt ?? null,
    expiryEstimated: Boolean(expiry?.estimated),
    daysLeft,
  };

  if (entry.renewal === 'none') {
    return { ...base, state: 'ok', reason: 'Not a credential: an identifier or address, with nothing to renew.' };
  }
  if (entry.renewal === 'self') {
    return { ...base, state: 'ok', reason: 'Renews itself: nothing is stored that needs rotating.' };
  }
  if (live.connection === 'expired') {
    return { ...base, state: 'overdue', reason: 'Signed out: its last refresh failed, so it must be connected again.' };
  }
  if (live.connection === 'not_connected') {
    return { ...base, state: 'unknown', reason: 'Not connected, so there is nothing to renew yet.' };
  }
  const judged = expiry ? judgeExpiry(entry, expiry, daysLeft, nowMs) : judgeWithoutExpiry(entry, live);
  return { ...base, ...judged };
}

/** What each source gives a credential, in the sentence for one that could not be read. */
const SOURCE_WORDS = Object.freeze({
  'secret-state': 'Key Vault write date',
  'coder-automation': 'lab host report',
  'credential-register': 'recorded rotation date',
  'lab-certificates': 'lab host certificate report',
  'swa-reset': 'Static Web App reset log',
});

/**
 * The sources (sources.js ids) one entry's dates come from: its Key Vault
 * record, its Coder report, its MCP record, and, for one the owner may
 * record, the register document.
 */
export function sourcesOf(entry) {
  const source = entry.source ?? {};
  return [
    ...(source.secret ? ['secret-state'] : []),
    ...(source.coder ? ['coder-automation'] : []),
    ...(source.labCertificate ? ['lab-certificates'] : []),
    ...(source.swaReset ? ['swa-reset'] : []),
    ...(source.mcpServer ? [`mcp:${source.mcpServer}`] : []),
    ...(isRecordable(entry) ? ['credential-register'] : []),
  ];
}

/** The status of an entry whose source could not be read: unknown, with nothing computed. */
function unreadableStatus(sourceId) {
  const words = SOURCE_WORDS[sourceId] ?? 'connection record';
  return {
    lastRotatedAt: null,
    lastRotatedSource: null,
    ageDays: null,
    expiresAt: null,
    expiryEstimated: false,
    daysLeft: null,
    connection: null,
    state: 'unknown',
    reason: `Its ${words} could not be read, so its age and expiry are not shown.`,
  };
}

/**
 * One credential as the API answers it: the register's metadata and the
 * computed status, field by field. Named rather than spread, so nothing a
 * future source carries can reach the answer unreviewed.
 *
 * `unavailable` is sources.js's list of sources it could not read. When one
 * of this entry's is among them the entry is unknown, with no age, expiry or
 * reminder, and `sourceUnavailable` names the source (review of #1039).
 */
export function presentCredential(entry, sources, nowMs = Date.now(), unavailable = []) {
  const live = resolveLive(entry, sources);
  const missing = sourcesOf(entry).find((id) => unavailable.includes(id)) ?? null;
  const status = missing ? unreadableStatus(missing) : { ...live, ...computeCredentialStatus(entry, live, nowMs) };
  return {
    id: entry.id,
    name: entry.name,
    store: entry.store,
    consumer: entry.consumer,
    issuer: entry.issuer,
    renewal: entry.renewal,
    lifetimeDays: entry.lifetimeDays,
    rotate: entry.rotate,
    recordable: isRecordable(entry),
    dueSoonDays: dueSoonDays(entry),
    lastRotatedAt: status.lastRotatedAt,
    lastRotatedSource: status.lastRotatedSource,
    // A fact about the register document, shown whenever that was read.
    recordedOn: unavailable.includes('credential-register') ? null : live.recordedOn,
    connection: status.connection,
    ageDays: status.ageDays,
    expiresAt: status.expiresAt,
    expiryEstimated: status.expiryEstimated,
    daysLeft: status.daysLeft,
    state: status.state,
    reason: status.reason,
    sourceUnavailable: missing,
  };
}

/** How many credentials are in each state. */
export function countStates(credentials) {
  const counts = Object.fromEntries(CREDENTIAL_STATES.map((state) => [state, 0]));
  for (const credential of credentials) counts[credential.state] += 1;
  return counts;
}

/** Every credential in the register, presented, with the counts taken after any unreadable source. */
export function buildRegisterView(sources, nowMs = Date.now(), unavailable = []) {
  const credentials = CREDENTIAL_REGISTER.map((entry) => presentCredential(entry, sources, nowMs, unavailable));
  return { stores: CREDENTIAL_STORES, credentials, counts: countStates(credentials) };
}
