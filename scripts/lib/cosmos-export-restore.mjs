/**
 * cosmos-export-restore.mjs — the pure half of scripts/restore-cosmos-export.mjs.
 *
 * Everything here works on names, text and plain objects, so it is tested
 * without a storage account or a Cosmos account. The script wires these to
 * the two SDK clients.
 *
 * Layout being read (functions/src/lib/backup/cosmos-export.js, ADR 0028):
 *
 *   full/<YYYY-MM-DD>/<container>.ndjson.gz     one line per document
 *   full/<YYYY-MM-DD>/<container>.marker.json   { docs, bytes, tsHighWater, … }
 *   full/<YYYY-MM-DD>/manifest.json             present only when every marker is
 *   delta/<YYYY-MM-DD>/…                        same shape
 *   state/<container>.json                      change-feed continuations (not restored)
 *
 * A restore set is the latest COMPLETE full (manifest present) on or before
 * the as-of date, followed by every complete delta after it, in date order.
 * Documents are applied in that order, so a document that changed twice ends
 * as its latest exported version. Deletes are not in the deltas (ADR 0028 §1):
 * a document deleted since the full comes back. That is the accepted
 * property the runbook names.
 */

const BLOB = /^(full|delta)\/(\d{4}-\d{2}-\d{2})\/(.+)$/;
export const RUN_ID = /^\d{4}-\d{2}-\d{2}$/;

/** Cosmos system properties, never written back. */
export const SYSTEM_FIELDS = Object.freeze(['_rid', '_self', '_etag', '_attachments', '_ts']);

/**
 * Parse one blob name into its parts, or null for anything outside a run
 * prefix (the `state/` blobs, stray objects).
 *
 * @param {string} name
 * @returns {{ mode: 'full'|'delta', runId: string, kind: 'data'|'marker'|'manifest'|'run'|'other', container: string|null }|null}
 */
export function parseBlobName(name) {
  const m = BLOB.exec(String(name || ''));
  if (!m) return null;
  const [, mode, runId, rest] = m;
  if (rest === 'manifest.json') return { mode, runId, kind: 'manifest', container: null };
  if (rest === 'run.json') return { mode, runId, kind: 'run', container: null };
  if (rest.endsWith('.ndjson.gz')) {
    return { mode, runId, kind: 'data', container: rest.slice(0, -'.ndjson.gz'.length) };
  }
  if (rest.endsWith('.marker.json')) {
    return { mode, runId, kind: 'marker', container: rest.slice(0, -'.marker.json'.length) };
  }
  return { mode, runId, kind: 'other', container: null };
}

/**
 * Choose the runs a restore applies.
 *
 * @param {string[]} names - every blob name in the export container
 * @param {{ asOf?: string }} [options] - latest run id to consider (inclusive); default: no limit
 * @returns {{ full: string, deltas: string[], incompleteSkipped: string[] }} run ids
 */
export function selectRestoreSet(names, { asOf } = {}) {
  if (asOf !== undefined && !RUN_ID.test(asOf)) {
    throw new Error(`--as-of must be a UTC date, YYYY-MM-DD; got ${JSON.stringify(asOf)}`);
  }
  const complete = { full: new Set(), delta: new Set() };
  const seen = { full: new Set(), delta: new Set() };
  for (const name of names) {
    const parsed = parseBlobName(name);
    if (!parsed) continue;
    seen[parsed.mode].add(parsed.runId);
    if (parsed.kind === 'manifest') complete[parsed.mode].add(parsed.runId);
  }
  const within = (runId) => asOf === undefined || runId <= asOf;

  const fulls = [...complete.full].filter(within).sort();
  if (!fulls.length) {
    throw new Error(
      asOf === undefined
        ? 'no complete full export (a full/<date>/manifest.json) found'
        : `no complete full export on or before ${asOf}`
    );
  }
  const full = fulls[fulls.length - 1];
  const deltas = [...complete.delta].filter((runId) => runId > full && within(runId)).sort();
  const incompleteSkipped = [
    ...[...seen.full].filter((r) => !complete.full.has(r) && within(r)).map((r) => `full/${r}`),
    ...[...seen.delta]
      .filter((r) => !complete.delta.has(r) && r > full && within(r))
      .map((r) => `delta/${r}`),
  ].sort();
  return { full, deltas, incompleteSkipped };
}

/** `mode/runId/container.ndjson.gz` */
export function dataBlobName(mode, runId, container) {
  return `${mode}/${runId}/${container}.ndjson.gz`;
}

/** `mode/runId/manifest.json` */
export function manifestBlobName(mode, runId) {
  return `${mode}/${runId}/manifest.json`;
}

/** The layers a restore applies, in order: the full, then each delta. */
export function restoreLayers({ full, deltas }) {
  return [{ mode: 'full', runId: full }, ...deltas.map((runId) => ({ mode: 'delta', runId }))];
}

/**
 * The containers a restore covers: those the selected manifests list, optionally
 * narrowed by an explicit list (unknown names are an error, not a silent skip).
 *
 * @param {{ containers?: {container: string}[] }} fullManifest
 * @param {string[]|null} [only]
 * @param {{containers?: {container: string}[]}[]} [deltaManifests]
 */
export function containersToRestore(fullManifest, only = null, deltaManifests = []) {
  if (!fullManifest?.containers?.length) throw new Error('the full manifest lists no containers');
  // A newly classified container's first delta reads its change feed from the
  // beginning. It is a valid baseline even when the previous full predates it.
  const all = [...new Set([fullManifest, ...deltaManifests].flatMap(
    (manifest) => (manifest.containers || []).map((c) => c.container)
  ))].sort();
  if (!only) return all;
  const known = new Set(all);
  const unknown = only.filter((name) => !known.has(name));
  if (unknown.length) {
    throw new Error(
      `--containers names containers the selected export set does not carry: ${unknown.join(', ')}`
    );
  }
  return [...new Set(only)].sort();
}

/**
 * Split the containers an export set carries into the ones the current
 * container spec (infra/cosmos-containers.json) provisions and the ones it
 * no longer knows. An export written before a container was retired still
 * lists it (the Code Conductor brain's `code_brain_records`, #1479), but the
 * target was provisioned from the current spec and has no such container, so
 * restoring it into `--database` would plant a retired workspace in the
 * creator database or fail at the first write. Legacy names are reported and
 * skipped; one that `--containers` asked for by name is refused instead,
 * because the operator is then expecting it to land somewhere.
 *
 * @param {string[]} containers - what containersToRestore chose
 * @param {Iterable<string>} specNames - the container names the spec provisions
 * @param {string[]|null} only - the --containers selection, if any
 * @returns {{restore: string[], legacy: string[]}}
 */
export function splitBySpec(containers, specNames, only = null) {
  const known = new Set(specNames);
  const legacy = containers.filter((name) => !known.has(name));
  const asked = (only || []).filter((name) => legacy.includes(name));
  if (asked.length) {
    throw new Error(
      '--containers names containers infra/cosmos-containers.json no longer provisions, so the target has ' +
        `no container for them: ${asked.join(', ')}`
    );
  }
  return { restore: containers.filter((name) => known.has(name)), legacy };
}

/**
 * A layer's manifest, checked before anything is restored from it: it names
 * the run it sits in (mode and runId), and lists its containers as
 * `{container: string}` entries. layersCarrying treats a container a manifest
 * leaves out as one the layer does not carry, which is right for a delta that
 * is narrower by design; so a list that is missing, empty or malformed must
 * stop the restore here rather than read as "this layer carries nothing" and
 * silently drop a day of changes (CodeRabbit, #1102).
 *
 * @param {unknown} manifest - the parsed manifest.json
 * @param {{mode: string, runId: string}} layer - the run it was read from
 * @returns {{mode: string, runId: string, containers: {container: string}[]}}
 */
export function assertManifest(manifest, layer) {
  const key = `${layer.mode}/${layer.runId}`;
  const refuse = (why) => {
    throw new Error(`${key}/manifest.json ${why}: the set is corrupted — do not restore from it`);
  };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) refuse('is not a JSON object');
  if (manifest.mode !== layer.mode || manifest.runId !== layer.runId) {
    refuse(`describes ${manifest.mode}/${manifest.runId}, not ${key}`);
  }
  if (!Array.isArray(manifest.containers) || manifest.containers.length === 0) refuse('lists no containers');
  if (manifest.containers.some((entry) => typeof entry?.container !== 'string' || !entry.container)) {
    refuse('has a container entry with no name');
  }
  return manifest;
}

/**
 * The layers that carry one container: those whose manifest lists it.
 *
 * A delta exports the authored and configuration containers only. An
 * operational one (admin_audit_logs, audits, …) is in the full and in no
 * delta, by design: export-classification.js gives operational
 * `full: true, delta: false`. So a container a delta's manifest does not list
 * takes nothing from that delta, and only a listed container's missing blob is
 * a corrupted set (assertLayerBlobPresent). Until 2026-10-12 every layer was
 * asked for every container, and the first drill stopped on admin_audit_logs
 * in the first delta: no restore with a delta in it had ever completed.
 *
 * @param {string} container
 * @param {{mode: string, runId: string}[]} layers - restoreLayers order
 * @param {Map<string, {containers?: {container: string}[]}>} manifests - by `mode/runId`
 * @returns {{mode: string, runId: string}[]} the same order, those listing it
 */
export function layersCarrying(container, layers, manifests) {
  return layers.filter((layer) => {
    const key = `${layer.mode}/${layer.runId}`;
    const manifest = manifests.get(key);
    if (!manifest) throw new Error(`no manifest was read for ${key}`);
    return (manifest.containers || []).some((entry) => entry.container === container);
  });
}

/**
 * The --verify cell for one container: what the target holds against what it
 * should. A restore creates (201) only ids the target did not hold, so the
 * target should hold what it held before this run plus what this run created.
 * The first drill compared the target with `created` alone, which is right
 * only for an empty target: a rerun into the same account reported a
 * container restored by the earlier attempt (3074 there, 0 created) as a
 * MISMATCH (2026-10-12). Ids are unique per partition key, not per container,
 * so two documents may share one; the count includes both, as the target does.
 *
 * @param {{ before: number, created: number, inTarget: number }} counts
 * @returns {{ ok: boolean, cell: string }}
 */
export function verifyTargetCount({ before, created, inTarget }) {
  const expected = before + created;
  if (inTarget === expected) return { ok: true, cell: String(inTarget) };
  return { ok: false, cell: `${inTarget} MISMATCH (expected ${expected})` };
}

/**
 * A listed container's data blob must exist in its layer: the layer was chosen
 * because its manifest exists, the manifest lists the container, and the
 * manifest is written only once every marker is present, so absence means the
 * set is corrupted or has expired under the lifecycle rule. Restoring past it
 * would silently produce a partial copy.
 *
 * @param {boolean} present
 * @param {string} blob - the blob name, for the error
 */
export function assertLayerBlobPresent(present, blob) {
  if (present) return;
  throw new Error(
    `${blob} is missing from the export container: the run's manifest says it was written, so the set is corrupted or expired — do not restore from it`
  );
}

/**
 * The Node stream of a blob download. `download()` types `readableStreamBody`
 * as optional (it is absent in the browser build and on some non-2xx paths),
 * and a bare `undefined.pipe` names no blob. This names it.
 *
 * @param {{ readableStreamBody?: import('node:stream').Readable }} response
 * @param {string} blob
 * @returns {import('node:stream').Readable}
 */
export function requireBody(response, blob) {
  const body = response?.readableStreamBody;
  if (!body || typeof body.pipe !== 'function') {
    throw new Error(`${blob}: the download returned no readable body`);
  }
  return body;
}

/** One NDJSON line → a document, with Cosmos system fields removed. Blank lines are skipped by the caller. */
export function parseLine(line) {
  const doc = JSON.parse(line);
  if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string' || !doc.id) {
    throw new Error('a line is not a document with a string id');
  }
  return stripSystemFields(doc);
}

export function stripSystemFields(doc) {
  const out = { ...doc };
  for (const field of SYSTEM_FIELDS) delete out[field];
  return out;
}

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
