import { RECORDS, SEARCH, sourceKey } from './model.js';
import { SOURCES, referenceOf, createSourceService } from './sources.js';

export const BRAIN_QUEUE = 'brain-index';

const HOUR_MS = 60 * 60 * 1000;
/**
 * How old the last finished rebuild must be before the timer starts another
 * one (#1772). The timer still fires every 15 minutes; until 2026-11-24 each
 * firing started a full rebuild, which rewrote the whole index about 77 times
 * a day. The age is counted from when the last rebuild finished, so the daily
 * rebuild starts on the first firing after that, and its time of day moves a
 * few minutes later each day.
 */
export const REBUILD_INTERVAL_MS = 24 * HOUR_MS;
/**
 * How long an unfinished rebuild is resumed from its saved place before it is
 * given up and started again from the beginning. A rebuild takes minutes, so
 * one still unfinished a day after it started is stuck (for example on a
 * saved place that can no longer be read), and without this rule it would
 * block every later rebuild.
 */
export const REBUILD_STALLED_MS = 24 * HOUR_MS;
/**
 * How far in the future a saved time may be and still be trusted. Servers'
 * clocks differ by a little; a time further ahead than this is treated as
 * wrong, so a bad clock cannot hold the next rebuild back.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const UNFINISHED = ['queued', 'running'];

/**
 * What to do with the saved rebuild record, as one of three words:
 * `start` (begin a rebuild from the first source), `resume` (carry on with
 * the unfinished one) or `wait` (the last one is recent enough).
 *
 * `scheduled` is true for the timer and false for the admin's button. The
 * button never waits: it starts a rebuild whenever none is under way.
 *
 * @param {object | null | undefined} job - the saved record, if any
 * @param {number} nowMs - the current time in milliseconds
 * @param {{ scheduled?: boolean }} [options]
 * @returns {'start' | 'resume' | 'wait'}
 */
export function rebuildDecision(job, nowMs, { scheduled = false } = {}) {
  if (!job) return 'start';
  // A time that is missing, unreadable or too far in the future is `null`.
  const age = (value) => {
    const at = Date.parse(value);
    return Number.isFinite(at) && at - nowMs <= CLOCK_SKEW_TOLERANCE_MS
      ? nowMs - at
      : null;
  };
  if (UNFINISHED.includes(job.status)) {
    const running = age(job.startedAt);
    return running === null || running >= REBUILD_STALLED_MS
      ? 'start'
      : 'resume';
  }
  if (!scheduled) return 'start';
  const finished = age(job.completedAt);
  return finished === null || finished >= REBUILD_INTERVAL_MS
    ? 'start'
    : 'wait';
}

/** One bounded source page per delivery. The persisted checkpoint is resumed
 * by a timer if an output-binding send fails. No private text in queue messages. */
export function createBrainIndexer(repo, { now = Date.now } = {}) {
  const stamp = () => new Date(now()).toISOString();
  /**
   * Save a new rebuild record over the one that was read. The write is
   * refused when the record changed, or appeared, after it was read (HTTP
   * 412 or 409): then another firing got there first, and null is returned.
   */
  async function begin(old) {
    const job = {
      id: 'indexing',
      ownerId: repo.ownerId,
      type: 'indexing',
      status: 'queued',
      sourceIndex: 0,
      after: '',
      count: 0,
      startedAt: stamp(),
      updatedAt: stamp(),
    };
    try {
      return old
        ? await repo.store.replaceDocIfMatch(
            RECORDS,
            { ...job, _etag: old._etag },
            { partitionKey: repo.ownerId },
          )
        : await repo.store.createDoc(RECORDS, job);
    } catch (error) {
      if ([409, 412].includes(Number(error.code))) return null;
      throw error;
    }
  }
  async function decide(scheduled) {
    const old = await repo.read('indexing');
    const action = rebuildDecision(old, now(), { scheduled });
    if (action !== 'start') return { action, job: old };
    const job = await begin(old);
    if (job) return { action, job };
    // Someone else changed the record first. Whatever they saved decides:
    // an unfinished rebuild is resumed, a finished one is left alone.
    const current = await repo.read('indexing');
    return {
      action: UNFINISHED.includes(current?.status) ? 'resume' : 'wait',
      job: current,
    };
  }
  /** The admin's button: a rebuild now, unless one is already under way. */
  const start = async () => (await decide(false)).job;
  /** The timer: resume an unfinished rebuild, or start one once a day. */
  const reconcile = () => decide(true);
  async function step() {
    let job = await repo.read('indexing');
    if (!job || job.status === 'complete') return false;
    if (
      job.status === 'running' &&
      now() - Date.parse(job.updatedAt) < 120000
    )
      return false;
    try {
      job = await repo.store.replaceDocIfMatch(
        RECORDS,
        { ...job, status: 'running', updatedAt: stamp() },
        { partitionKey: repo.ownerId },
      );
    } catch (error) {
      if (Number(error.code) === 412) return false;
      throw error;
    }
    const all = [['brain_records', ''], ...SOURCES, ['reconcile', '']];
    const container = all[job.sourceIndex][0];
    const notes = container === RECORDS;
    const reconcile = container === 'reconcile';
    const parameters = [
      { name: '@after', value: job.after },
      { name: '@owner', value: repo.ownerId },
    ];
    const where = notes
      ? ' AND c.ownerId = @owner AND ARRAY_CONTAINS(["note", "topic", "project", "conflict"], c.type)'
      : reconcile
        ? ' AND c.ownerId = @owner AND c.type = "search-item"'
        : '';
    const docs = await repo.store.queryDocs(
      reconcile ? SEARCH : container,
      `SELECT TOP 30 * FROM c WHERE c.id > @after${where} ORDER BY c.id`,
      parameters,
      notes || reconcile ? { partitionKey: repo.ownerId } : {},
    );
    const sources = createSourceService(repo);
    for (const doc of docs) {
      const item = reconcile
        ? await sources.current(doc)
        : notes
          ? doc
          : referenceOf(container, doc);
      if (item) await sources.indexItem(item);
      else
        await repo.putIndex({
          id: reconcile ? doc.id : sourceKey(container, doc.id),
          type: 'removed',
        });
    }
    const more = docs.length === 30;
    const sourceIndex = more ? job.sourceIndex : job.sourceIndex + 1;
    const status = sourceIndex === all.length ? 'complete' : 'queued';
    await repo.store.replaceDocIfMatch(
      RECORDS,
      {
        ...job,
        status,
        sourceIndex,
        after: more ? docs.at(-1).id : '',
        count: job.count + docs.length,
        updatedAt: stamp(),
        ...(status === 'complete' && { completedAt: stamp() }),
      },
      { partitionKey: repo.ownerId },
    );
    return status !== 'complete';
  }
  return { start, reconcile, step };
}
