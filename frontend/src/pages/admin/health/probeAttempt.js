/**
 * The two helpers every live runner shares (probeRunners.js and
 * mediaRunners.js): `attempt`, a read that becomes a result when it throws,
 * and `listOf`, an array or an empty one.
 */
import { classifyFailure, messageOf, result } from './probeKit';

/**
 * A read as a probe sees it: `{ value }` when it answered, `{ failure }` — the
 * result naming what could not be read — when it threw. Judged on the error
 * itself, not the sentence around it: "did not answer" in the prefix must not
 * make a 401 look like an outage.
 */
export async function attempt(whatFailed, read) {
  try {
    return { value: await read() };
  } catch (error) {
    return { failure: result(classifyFailure(error), `${whatFailed}: ${messageOf(error)}`) };
  }
}

export const listOf = (value) => (Array.isArray(value) ? value : []);
