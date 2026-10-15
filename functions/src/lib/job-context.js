/**
 * job-context.js — no Cosmos or Blob write starts after a platform job is
 * recorded `timeout` (#942 follow-up to #1198).
 *
 * #1198 hands each worker's AbortSignal to the libraries it calls, and those
 * check it at points they choose. The writes themselves go through the
 * shared clients (cosmos-client.js, blob-storage.js), which never saw the
 * signal, so a write that starts after the deadline — a step that was
 * already past its last check when the budget ran out — still landed. That
 * was #942's own acceptance item: a timed-out job's side effects stop.
 *
 * runJob runs the worker inside the job's context (`runAsJob`), and the
 * shared clients call `refuseWriteAfterJobAbort` before every write: once the
 * signal has fired, a write that starts inside that context throws the
 * job's reason instead of reaching the service. Routes, timers and the
 * onComplete hooks, which runJob calls after the terminal write, run outside
 * the context and are not affected. Nothing is threaded through the workers.
 *
 * The context follows every async operation the worker STARTS, which is
 * more than the worker's own work. A process-wide single-flight, a
 * module-level map of in-flight promises that later callers join, is the
 * case that matters: started by a job, it would run in that job's context,
 * and a route that joined it would meet that job's abort. Shared work of
 * that kind is started with `outsideJob` (the MCP OAuth token refresh in
 * ai/mcp-oauth.js is the one today; the AI config cache's single-flight in
 * ai/ai-config.js only reads, which the context never touches).
 *
 * A write already in flight when the signal fires is handed the signal as
 * well: the shared clients pass `writeAbortSignal(container)` as the SDK's
 * `abortSignal`, so the SDK stops waiting for the request and rejects. That
 * stops the client, not the service, which may already have applied the
 * write. Reads are neither refused nor handed the signal: a read changes
 * nothing, and a sequence that reads before its kept record (below) would
 * otherwise lose the record.
 *
 * The rule for what is kept: a write is refused when it IS a side effect,
 * and kept when it RECORDS one that has already happened, because refusing
 * a record cannot undo the thing it records, only lose the record of it.
 * The kept containers are:
 *
 *  - `ai_usage`: a usage row for a model or speech call already billed
 *    (recordAiUsage swallows a failed write, so a refused row would vanish).
 *  - `mcp_servers`: an OAuth token a provider has already rotated, which is
 *    only usable once stored.
 *  - `content_versions`: the version snapshot of a content write that has
 *    already landed. The forge save (content/forge.js) patches the content
 *    and then snapshots it; cms/publish.js does the same on publish. An
 *    abort between the two would leave changed content with no version to
 *    restore from.
 *  - `admin_audit_logs` and `audits`: the audit row of a change that has
 *    already landed (the forge save writes one after its snapshot). A
 *    refused row would leave a change with no record of who made it.
 *
 * Derived documents that the next run rebuilds (`_snapshots`,
 * `tool_price_history`) are not kept: refusing them loses nothing that a
 * later run does not write again.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const jobContext = new AsyncLocalStorage();

/** Containers whose writes go through after a job's abort; the header says why. */
export const WRITES_KEPT_AFTER_ABORT = Object.freeze([
  'admin_audit_logs',
  'ai_usage',
  'audits',
  'content_versions',
  'mcp_servers',
]);

/**
 * Run `fn` as a platform job's work: inside it, and in everything it starts,
 * the shared clients refuse a write once `signal` has fired.
 *
 * @template T
 * @param {AbortSignal} signal the job's signal
 * @param {() => T} fn
 * @returns {T}
 */
export function runAsJob(signal, fn) {
  return jobContext.run({ signal }, fn);
}

/**
 * Run `fn` outside any job's context, for work that other callers may join:
 * nothing it starts is refused or handed a signal because of the job that
 * happened to start it.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function outsideJob(fn) {
  return jobContext.exit(fn);
}

/**
 * The running job's AbortSignal, or undefined outside a job.
 *
 * @returns {AbortSignal|undefined}
 */
export function currentJobSignal() {
  return jobContext.getStore()?.signal;
}

/**
 * The signal a write to `containerName` carries as the SDK's `abortSignal`:
 * the running job's, except for a kept container, whose write must be able
 * to finish after the abort. Undefined outside a job, so a write made there
 * passes exactly the options it always did.
 *
 * @param {string} [containerName] the Cosmos container, when there is one
 * @returns {AbortSignal|undefined}
 */
export function writeAbortSignal(containerName) {
  if (containerName && WRITES_KEPT_AFTER_ABORT.includes(containerName)) return undefined;
  return currentJobSignal();
}

/**
 * Throw the running job's abort reason when its signal has fired and the
 * write is to a container that is not kept; do nothing outside a job.
 * Called by the shared clients before every write.
 *
 * @param {string} [containerName] the Cosmos container, when there is one
 */
export function refuseWriteAfterJobAbort(containerName) {
  const signal = currentJobSignal();
  if (!signal?.aborted) return;
  if (containerName && WRITES_KEPT_AFTER_ABORT.includes(containerName)) return;
  throw signal.reason || new Error('aborted');
}
