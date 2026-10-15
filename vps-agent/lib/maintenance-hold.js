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
 * It then waits for this agent to acknowledge the hold, looks again, and
 * reboots only if the host is still idle. Every other way out of the script
 * removes the file. On the reboot path the file stays, so no claim lands
 * between the request and the manager stopping this agent; /run is a
 * tmpfs, so the reboot clears it.
 *
 * lib/poll.js reads the hold on every tick. While it is in force no claim
 * is sent, and once no claim is in flight and no job is running, the poll
 * writes the acknowledgement (createAcknowledger, below): a file in the
 * agent's own runtime directory holding the hold's expiry, exactly as read,
 * so an acknowledgement answers one hold and no other. A claim already in
 * flight when the hold appears is not recalled; until it has come back, and
 * any job it brought has finished, there is no acknowledgement. The script
 * waits for one for at most hardening_reboot_hold_settle_seconds and defers
 * the night without it (CodeRabbit's second round on #1191: a fixed wait
 * could not see a claim whose container was slow to appear; this needs no
 * guess about how slow). An agent that cannot acknowledge, an older one or
 * a stuck one, therefore defers the reboot rather than risking a job.
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
 *    jobs until someone looks. The file's write time bounds it.
 *  - whether it exists cannot be told (it cannot be opened for a reason
 *    other than not found or not permitted, or its descriptor cannot be
 *    read for its time): no hold. Refusing every job on such a fault would
 *    take labs down for visitors, and the cost of the other choice is
 *    bounded: a job the reboot interrupts is reported so within seconds
 *    (lib/shutdown.js).
 *
 * The write time and the expiry come from one open descriptor (CodeQL
 * js/file-system-race, alert 1404 on #1191). The script replaces the hold
 * with a rename, so reading the time by path and then the content by path
 * could pair one file's cap with the next file's expiry. A descriptor keeps
 * the file it opened, whatever is renamed over the path after, so the pair
 * is always one file's. Only a file that exists and cannot be opened for
 * reading has its time read by path, and nothing else is read from it.
 *
 * Every state change is one journal line with no path and no identifier in
 * it: info when a hold starts or lifts, and when an acknowledgement is
 * written or withdrawn, which stays on the host; warn, which is collected
 * (lib/log.js), when a hold is unreadable, expired without being removed,
 * or cannot be checked, or when an acknowledgement cannot be written or
 * withdrawn.
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
 * Where the agent writes its acknowledgement of a hold unless
 * LABS_AGENT_MAINTENANCE_ACK_PATH names another absolute path: in its own
 * runtime directory (the unit's RuntimeDirectory=, not preserved, so a
 * stopped agent leaves no acknowledgement behind). The labs_agent role
 * passes labs_agent_maintenance_ack_path and the hardening role's script
 * reads hardening_reboot_ack_path; the three defaults are one path, and
 * scripts/lab-job-limits.test.mjs fails if they part.
 */
export const DEFAULT_ACK_PATH = '/run/hcw-labs-agent/maintenance-ack';

/**
 * The agent's default poll interval (LABS_AGENT_POLL_MS in index.js,
 * labs_agent_poll_ms in the role; scripts/lab-job-limits.test.mjs holds the
 * three together). The acknowledgement is written on a poll tick, so an
 * idle agent acknowledges within one interval of the hold appearing.
 */
export const ACK_POLL_INTERVAL_MS = 15000;

/**
 * The longest an agent that honours the hold takes to acknowledge it, at
 * the default poll interval: lib/api.js's REQUEST_TIMEOUT_MS (20 s), which
 * bounds a claim already sent when the hold appeared, then one poll
 * interval for the next tick to find nothing in flight. A claim that
 * brought a job adds that job's run, and the script then rightly defers.
 * The script's wait, hardening_reboot_hold_settle_seconds, must be at least
 * this; scripts/lab-job-limits.test.mjs holds the role's default to it and
 * lib/maintenance-hold.test.js holds the sum to lib/api.js. Written as a
 * sum of literals because lib/api.js imports @azure/identity, which the
 * scripts suite that imports this module does not install.
 */
export const ACK_WITHIN_MS = 20000 + ACK_POLL_INTERVAL_MS;

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
 * The acknowledgement's path from the environment: an absolute path, or the default.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function ackPath(env = process.env) {
  const requested = env.LABS_AGENT_MAINTENANCE_ACK_PATH;
  return typeof requested === 'string' && requested.startsWith('/') ? requested : DEFAULT_ACK_PATH;
}

/**
 * The file system calls the reader makes; node:fs in production.
 *
 * @typedef {object} HoldFs
 * @property {(path: string, flags: 'r') => number} openSync         opens the hold once
 * @property {(fd: number) => { mtimeMs: number }} fstatSync          its write time, from that descriptor
 * @property {(fd: number, encoding: 'utf8') => string} readFileSync  its content, from that descriptor
 * @property {(fd: number) => void} closeSync                         on every way out once it is open
 * @property {(path: string) => { mtimeMs: number }} statSync         only for a hold that exists and cannot be opened
 */

/** A hold whose content cannot be used: held until its write time plus MAX_HOLD_MS, then expired. */
const unreadable = (now, written) =>
  now < written + MAX_HOLD_MS ? { state: 'held-unreadable', until: written + MAX_HOLD_MS } : { state: 'expired' };

/**
 * Reads the hold once, from one descriptor. Never throws.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {number} [options.now]  epoch milliseconds
 * @param {HoldFs} [options.fsImpl]  tests only
 * @returns {{ state: 'none'|'held'|'held-unreadable'|'expired'|'unknown', until?: number, expiry?: string }}
 *   `until` is the epoch millisecond a held state lapses; `expiry` is the
 *   hold's own expiry, the digits exactly as read, for a hold that is `held`
 */
export function readHold(path, { now = Date.now(), fsImpl = fs } = {}) {
  let fd;
  try {
    fd = fsImpl.openSync(path, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'none' };
    if (err?.code !== 'EACCES' && err?.code !== 'EPERM') return { state: 'unknown' };
    // There and not ours to read: its write time still bounds the hold, and
    // a stat of the path reads that without the content, so there is no
    // pair to keep together.
    try {
      return unreadable(now, fsImpl.statSync(path).mtimeMs);
    } catch {
      return { state: 'unknown' };
    }
  }
  try {
    let written;
    try {
      written = fsImpl.fstatSync(fd).mtimeMs;
    } catch {
      return { state: 'unknown' };
    }
    let text;
    try {
      text = fsImpl.readFileSync(fd, 'utf8');
    } catch {
      return unreadable(now, written);
    }
    const found = EXPIRY.exec(text);
    if (!found) return unreadable(now, written);
    const until = Math.min(Number(found[1]) * 1000, written + MAX_HOLD_MS);
    return now < until ? { state: 'held', until, expiry: found[1] } : { state: 'expired' };
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {
      // A descriptor that will not close has still been read; the answer
      // above stands, and this module never throws into the poll.
    }
  }
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
 * The check lib/poll.js makes on every tick: whether a hold is in force, and
 * its expiry when it can be read. Synchronous, so the poll's concurrency
 * guard and its slot reservation keep no await between them (T-744). Says
 * each change of state once, never each poll.
 *
 * @param {object} deps
 * @param {string} deps.path                                   holdPath()
 * @param {{ info: Function, warn: Function }} deps.log        lib/log.js
 * @param {() => number} [deps.now]                            tests only
 * @param {HoldFs} [deps.fsImpl]                               tests only
 * @returns {() => { held: boolean, expiry: string|null }}
 */
export function createHoldGate({ path, log, now = () => Date.now(), fsImpl = fs }) {
  let last = 'none';
  /**
   * Whether a hold is in force, and its expiry as read (null for a hold
   * whose content cannot be used, which therefore cannot be acknowledged);
   * reads the file once and says a change of state once.
   *
   * @returns {{ held: boolean, expiry: string|null }}
   */
  return function hold() {
    const { state, expiry } = readHold(path, { now: now(), fsImpl });
    if (state !== last) {
      if (state !== 'none' || HELD.has(last)) {
        const [level, line] = LINES[state];
        log[level](line);
      }
      last = state;
    }
    return { held: HELD.has(state), expiry: expiry ?? null };
  };
}

/**
 * The file system calls the acknowledger makes; node:fs in production.
 *
 * @typedef {object} AckFs
 * @property {(path: string, data: string, options: { mode: number }) => void} writeFileSync  the temporary file
 * @property {(from: string, to: string) => void} renameSync                                    into place, in one step
 * @property {(path: string) => void} unlinkSync                                                withdrawal, and a failed write's leftovers
 */

/**
 * The agent's acknowledgement of a hold: written by lib/poll.js on a tick
 * where the hold is in force, no claim is in flight and no job is running,
 * holding that hold's expiry exactly as read, so it answers one hold and no
 * other; withdrawn on a tick where any of that stops being true. Written to
 * a temporary file in the same directory and renamed into place, so the
 * script never reads half of one. Synchronous and never throws, so the poll
 * can call it without an await before its slot reservation (T-744). Each
 * change is one journal line with no path in it; a write or a withdrawal
 * that fails is said at warn once, until one succeeds.
 *
 * @param {object} deps
 * @param {string} deps.path                                   ackPath()
 * @param {{ info: Function, warn: Function }} deps.log        lib/log.js
 * @param {AckFs} [deps.fsImpl]                                tests only
 * @returns {{ acknowledge: (expiry: string) => void, withdraw: () => void, current: () => string|null }}
 */
export function createAcknowledger({ path, log, fsImpl = fs }) {
  const temporary = `${path}.new`;
  // The expiry acknowledged now, or null. Only this process writes the file,
  // and its directory goes when the unit stops, so this is what is on disk.
  let acknowledged = null;
  let failing = false;

  /** Says a failure once per run of failures. */
  function failed(line) {
    if (!failing) log.warn(line);
    failing = true;
  }

  /**
   * Writes the acknowledgement of the hold whose expiry is `expiry`, unless it is already written.
   *
   * @param {string} expiry  the hold's expiry, the digits as read
   */
  function acknowledge(expiry) {
    if (acknowledged === expiry) return;
    try {
      fsImpl.writeFileSync(temporary, `${expiry}\n`, { mode: 0o644 });
      fsImpl.renameSync(temporary, path);
    } catch {
      try {
        fsImpl.unlinkSync(temporary);
      } catch {
        // Nothing was left behind, or nothing more can be done.
      }
      failed('maintenance hold could not be acknowledged: the idle reboot will defer');
      return;
    }
    acknowledged = expiry;
    failing = false;
    log.info('maintenance hold acknowledged: no claim in flight and no job running');
  }

  /** Removes the acknowledgement, if one is written. */
  function withdraw() {
    if (acknowledged === null) return;
    try {
      fsImpl.unlinkSync(path);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        failed('maintenance hold acknowledgement could not be withdrawn');
        return;
      }
    }
    acknowledged = null;
    failing = false;
    log.info('maintenance hold acknowledgement withdrawn');
  }

  return {
    acknowledge,
    withdraw,
    /** The expiry acknowledged now, or null, for the tests. */
    current: () => acknowledged,
  };
}
