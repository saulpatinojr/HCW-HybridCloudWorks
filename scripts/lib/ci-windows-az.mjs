/** Running the Azure CLI for remove-ci-access-windows.mjs, with retries, and stopping when a read fails. */
import { AZ_TIMEOUT_MS, WINDOW_TAG } from './ci-windows-decide.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/** Runs `az` with these arguments (no shell) and returns its stdout. */
export async function runAz(args) {
  const { stdout } = await execFileAsync('az', args, { timeout: AZ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** The first line of an error, which is where `az` puts the code and message. */
export const firstLine = (error) => String(error?.stderr || error?.message || error).split('\n').find((line) => line.trim()) ?? 'unknown error';

/** Thrown, never retried, when the window tag names another run than the one being restored. */
export class WindowTaken extends Error {
  constructor(step) {
    super(`stopped before "${step}": the ${WINDOW_TAG} tag changed, so a new deploy run owns the window now and closes it itself`);
    this.name = 'WindowTaken';
  }
}

/** Worth trying again: anything but a refusal of the identity's authority, or a window another run took. */
const retryable = (error) => !(error instanceof WindowTaken) && !/AuthorizationFailed|Forbidden/i.test(String(error?.stderr || error?.message || ''));

/** One write, tried once more after each pause when it fails for a reason that may pass. */
export async function withRetry(write, { pauses, sleep }) {
  for (const pause of [...pauses, null]) {
    try {
      return await write();
    } catch (error) {
      if (pause === null || !retryable(error)) throw error;
      await sleep(pause);
    }
  }
  throw new Error('unreachable: the last try either returned or threw');
}

export const STORAGE_QUERY = `{defaultAction: networkRuleSet.defaultAction, ipRules: networkRuleSet.ipRules, window: tags.${WINDOW_TAG}}`;
/** Something this run had to read and could not; `run` turns it into the "could not read" report. */
export class Unreadable extends Error {}

/** The result of `read()`, or an Unreadable saying `why(error)` when it fails. */
export async function readOrStop(read, why) {
  try {
    return await read();
  } catch (error) {
    throw new Unreadable(why(error));
  }
}
