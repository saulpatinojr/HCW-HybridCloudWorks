/** Running a Cosmos restore: what each write did, counting what was written, and writing a few items at a time (cosmos-export-restore.mjs). */

/**
 * Which of the two things an upsert did, from its status code: Cosmos answers
 * 201 for a create and 200 for a replace. Anything else is not an upsert
 * outcome the SDK resolves with, so it is refused rather than miscounted.
 *
 * @param {number} statusCode
 * @returns {'created'|'replaced'}
 */
export function classifyUpsert(statusCode) {
  if (statusCode === 201) return 'created';
  if (statusCode === 200) return 'replaced';
  throw new Error(
    `upsert answered HTTP ${statusCode}, which is neither a create (201) nor a replace (200)`
  );
}

/**
 * A streaming tally for one container's restore: per-layer document counts,
 * plus created/replaced from the upsert responses on a real run. Nothing per
 * document is retained — the earlier version kept every id to compute the
 * distinct count, so peak memory grew with the corpus while everything else
 * streamed. On a real run `created` IS the distinct count (a second write to
 * an id is a replace) and `replaced` is the overwritten count; on a dry run
 * there is no upsert to read, so both stay null and the report says so.
 * `writes` marks a real run, where a container with nothing in it created 0,
 * not null: the first drill reported every empty container as a MISMATCH
 * because 0 in the target was compared with null (2026-10-12).
 *
 * @param {{ writes?: boolean }} [options]
 */
export function createRestoreTally({ writes = false } = {}) {
  const perLayer = {};
  let created = 0;
  let replaced = 0;
  let sawUpsert = writes;
  return {
    /** One document read from `layer`; `statusCode` is the upsert's, absent on a dry run. */
    add(layer, statusCode) {
      perLayer[layer] = (perLayer[layer] || 0) + 1;
      if (statusCode === undefined) return;
      sawUpsert = true;
      if (classifyUpsert(statusCode) === 'created') created += 1;
      else replaced += 1;
    },
    /** Zero rows for a layer that was read and held nothing. */
    touch(layer) {
      perLayer[layer] ??= 0;
    },
    result() {
      const documents = Object.values(perLayer).reduce((n, c) => n + c, 0);
      return {
        perLayer: { ...perLayer },
        documents,
        created: sawUpsert ? created : null,
        replaced: sawUpsert ? replaced : null,
      };
    },
  };
}

/** A fixed-width report row; the report is the script's output. */
export function formatRow(cells, widths) {
  return cells
    .map((cell, i) => String(cell).padEnd(widths[i]))
    .join('  ')
    .trimEnd();
}

/** Parse `--concurrency`: a positive integer, default 8, capped at 32. */
export function parseConcurrency(value) {
  if (value === undefined) return 8;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new Error(`--concurrency must be an integer from 1 to 32; got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Run `work(item)` over an async iterable with at most `limit` in flight.
 * Rejects on the first failure after draining what is in flight. A worker
 * that throws synchronously is treated like one that rejects: wrapped in a
 * promise, so it is recorded as the failure and the in-flight set drains,
 * rather than escaping this loop with work still running.
 */
export async function forEachConcurrent(items, limit, work) {
  const inFlight = new Set();
  let failure = null;
  for await (const item of items) {
    if (failure) break;
    const p = Promise.resolve()
      .then(() => work(item))
      .then(
        () => inFlight.delete(p),
        (err) => {
          inFlight.delete(p);
          failure ??= err;
        }
      );
    inFlight.add(p);
    if (inFlight.size >= limit) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);
  if (failure) throw failure;
}
