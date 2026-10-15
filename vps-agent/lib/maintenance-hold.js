/**
 * The lab host's maintenance hold: while it is in force the agent claims no
 * new job (LAB-13, #959).
 *
 * hcw-reboot-when-idle (lab-host/ansible/roles/hardening) reboots the host
 * for a pending upgrade only when nobody is logged in and no lab job
 * container is running. Asked once, that left a gap (CodeRabbit on #1191):
 * a job claimed after its `docker ps` came back empty and before
 * `systemctl reboot` started a container the reboot then killed. So the
 * script looks twice. When the first look finds the host idle it writes
 * this file, root's, under /run, holding the epoch second the hold lapses.
 * It then waits longer than a claim already sent can take to come back and
 * start its container (CLAIM_SETTLE_MS), looks again, and reboots only if
 * the host is still idle. Every other way out of the script removes the
 * file. On the reboot path the file stays, so no claim lands between the
 * request and the manager stopping this agent; /run is a tmpfs, so the
 * reboot clears it.
 *
 * lib/poll.js asks before every claim. A claim already in flight when the
 * hold appears is not recalled: its job runs, and the script's second look
 * sees its container and defers the reboot.
 *
 * What the file can say, and what the agent does with it:
 *
 *  - absent, or its directory is: no hold.
 *  - an expiry in the future: held until then, and never longer than
 *    MAX_HOLD_MS after the file was written, so a hold whose writer died,
 *    or whose expiry is wrong, cannot keep the host from taking jobs for
 *    longer than that.
 *  - an expiry in the past: no hold. Its writer died without removing it.
 *  - present but unreadable, or not an expiry: held until MAX_HOLD_MS after
 *    it was written. Its existence is root's statement that a reboot is
 *    about to be asked for. Claiming through it could start the very job
 *    the reboot kills; honouring it with no end could stop the host taking
 *    jobs until someone looks. The file's write time bounds it, and `stat`
 *    reads that without reading the file.
 *  - whether it exists cannot be told (stat fails other than not found):
 *    no hold. Refusing every job on a permission fault would take labs down
 *    for visitors, and the cost of the other choice is bounded: a job the
 *    reboot interrupts is reported so within seconds (lib/shutdown.js).
 *
 * Every state change is one journal line with no path and no identifier in
 * it: info when a hold starts or lifts, which stays on the host; warn, which
 * is collected (lib/log.js), when a hold is unreadable, expired without
 * being removed, or cannot be checked.
 *
 * Everything the module touches is injected, so lib/maintenance-hold.test.js
 * runs it against a fake file system and a fake clock.
 */

import fs from 'node:fs';

/**
 * Where the agent looks unless LABS_AGENT_MAINTENANCE_HOLD_PATH names another
 * absolute path. The hardening role writes it at hardening_reboot_hold_path
 * and the labs_agent role passes labs_agent_maintenance_hold_path; the three
 * defaults are one path, and scripts/lab-job-limits.test.mjs fails if they
 * part.
 */
export const DEFAULT_HOLD_PATH = '/run/hcw-maintenance/reboot-hold';

/** The longest any hold is honoured, counted from the file's write time: ten minutes. */
export const MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * The shortest wait a holder must allow between writing the hold and its
 * second look: lib/api.js's REQUEST_TIMEOUT_MS, which bounds a claim already
 * sent, plus the 15 s start grace lib/docker-runner.js allows a job's
 * container, by which the claimed job is running. lib/maintenance-hold.test.js
 * holds the sum to both; scripts/lab-job-limits.test.mjs holds the role's
 * hardening_reboot_hold_settle_seconds to at least this.
 */
export const CLAIM_SETTLE_MS = 20000 + 15000;

/** An expiry is whole epoch seconds, as `date +%s` prints them, and at most one newline. */
const EXPIRY = /^(\d{1,12})\n?$/;

/** The states in which the agent claims nothing. */
const HELD = new Set(['held', 'held-unreadable']);

/**
 * The hold's path from the environment: an absolute path, or the default.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function holdPath(env = process.env) {
  const requested = env.LABS_AGENT_MAINTENANCE_HOLD_PATH;
  return typeof requested === 'string' && requested.startsWith('/') ? requested : DEFAULT_HOLD_PATH;
}

/**
 * Reads the hold once. Never throws.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {number} [options.now]  epoch milliseconds
 * @param {{ statSync: Function, readFileSync: Function }} [options.fsImpl]  tests only
 * @returns {{ state: 'none'|'held'|'held-unreadable'|'expired'|'unknown', until?: number }}
 *   `until` is the epoch millisecond a held state lapses
 */
export function readHold(path, { now = Date.now(), fsImpl = fs } = {}) {
  let written;
  try {
    written = fsImpl.statSync(path).mtimeMs;
  } catch (err) {
    return { state: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'none' : 'unknown' };
  }
  const cap = written + MAX_HOLD_MS;
  let text;
  try {
    text = fsImpl.readFileSync(path, 'utf8');
  } catch (err) {
    // Removed between the two reads: the script's own way out.
    if (err?.code === 'ENOENT') return { state: 'none' };
    return now < cap ? { state: 'held-unreadable', until: cap } : { state: 'expired' };
  }
  const found = EXPIRY.exec(text);
  if (!found) return now < cap ? { state: 'held-unreadable', until: cap } : { state: 'expired' };
  const until = Math.min(Number(found[1]) * 1000, cap);
  return now < until ? { state: 'held', until } : { state: 'expired' };
}

/** The journal line for entering each state, and its level; `none` is said only when a hold lifts. */
const LINES = {
  held: ['info', 'maintenance hold in force: claiming no new job until it lifts'],
  'held-unreadable': ['warn', 'maintenance hold present but unreadable: claiming no new job until it is ten minutes old'],
  expired: ['warn', 'maintenance hold expired without being removed: claiming as usual'],
  unknown: ['warn', 'maintenance hold could not be checked: claiming as usual'],
  none: ['info', 'maintenance hold lifted: claiming again'],
};

/**
 * The check lib/poll.js makes before each claim: true while a hold is in
 * force. Synchronous, so the poll's concurrency guard and its slot
 * reservation keep no await between them (T-744). Says each change of state
 * once, never each poll.
 *
 * @param {object} deps
 * @param {string} deps.path                                   holdPath()
 * @param {{ info: Function, warn: Function }} deps.log        lib/log.js
 * @param {() => number} [deps.now]                            tests only
 * @param {{ statSync: Function, readFileSync: Function }} [deps.fsImpl]  tests only
 * @returns {() => boolean}
 */
export function createHoldGate({ path, log, now = () => Date.now(), fsImpl = fs }) {
  let last = 'none';
  return function held() {
    const { state } = readHold(path, { now: now(), fsImpl });
    if (state !== last) {
      if (state !== 'none' || HELD.has(last)) {
        const [level, line] = LINES[state];
        log[level](line);
      }
      last = state;
    }
    return HELD.has(state);
  };
}
