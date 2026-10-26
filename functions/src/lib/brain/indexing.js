import { RECORDS, SEARCH, sourceKey } from './model.js';
import { SOURCES, referenceOf, createSourceService } from './sources.js';

export const BRAIN_QUEUE = 'brain-index';
/** One bounded source page per delivery. The persisted checkpoint is resumed
 * by a timer if an output-binding send fails. No private text in queue messages. */
export function createBrainIndexer(repo) {
  async function start() {
    const old = await repo.read('indexing');
    if (old && ['queued', 'running'].includes(old.status)) return old;
    const job = {
      id: 'indexing',
      type: 'indexing',
      status: 'queued',
      sourceIndex: 0,
      after: '',
      count: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repo.putInternal(job);
    return job;
  }
  async function step() {
    let job = await repo.read('indexing');
    if (!job || job.status === 'complete') return false;
    if (
      job.status === 'running' &&
      Date.now() - Date.parse(job.updatedAt) < 120000
    )
      return false;
    try {
      job = await repo.store.replaceDocIfMatch(
        RECORDS,
        { ...job, status: 'running', updatedAt: new Date().toISOString() },
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
        updatedAt: new Date().toISOString(),
        ...(status === 'complete' && { completedAt: new Date().toISOString() }),
      },
      { partitionKey: repo.ownerId },
    );
    return status !== 'complete';
  }
  return { start, step };
}
