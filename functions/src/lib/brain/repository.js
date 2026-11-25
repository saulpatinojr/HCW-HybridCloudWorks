import { getContainer } from '../cosmos-client.js';
import { RECORDS, SEARCH, BrainError, fail, clean, digest } from './model.js';

// A save, committed once: a mutation id that was already used answers with
// the result it saved then, and a lost race is tried again up to six times.
async function commitRecord(ctx, record, { version = 0, mutationId } = {}) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(mutationId || ''))
    fail(400, 'INVALID', 'A unique mutationId is required.');
  const receiptId = `mutation_${mutationId}`;
  const requestHash = digest(JSON.stringify({ record, version }));
  const existing = await ctx.read(receiptId);
  if (existing) return replayedResult(existing, record, requestHash);
  for (let attempt = 0; attempt < 6; attempt++) {
    const outcome = await attemptCommit(ctx, {
      record,
      version,
      receiptId,
      requestHash,
    });
    if (outcome.done) return outcome.result;
  }
  throw new BrainError(
    409,
    'BUSY',
    'Another save is in progress. Retry with the same mutation id.',
  );
}

function replayedResult(existing, record, requestHash) {
  if (
    existing.recordId !== record.id ||
    existing.requestHash !== requestHash
  )
    fail(409, 'CONFLICT', 'Mutation id already used for another edit.');
  return existing.result;
}

// One try at the batch. `done` is false when another save won the race and
// this one may try again.
async function attemptCommit(ctx, { record, version, receiptId, requestHash }) {
  const { read, batch, ownerId } = ctx;
  const [state, current] = await Promise.all([
    read('state'),
    read(record.id),
  ]);
  checkCurrent(current, record, version);
  const seq = (state?.seq || 0) + 1;
  const next = nextRecord(record, current, ownerId, seq);
  const result = clean(next);
  const ops = commitOps({
    ownerId,
    state,
    current,
    next,
    seq,
    result,
    receiptId,
    requestHash,
  });
  try {
    await batch(ownerId, ops);
    return { done: true, result };
  } catch (error) {
    if (![409, 412, 424].includes(Number(error.code))) throw error;
    const receipt = await read(receiptId);
    if (
      receipt?.recordId === record.id &&
      receipt.requestHash === requestHash
    )
      return { done: true, result: receipt.result };
    return { done: false };
  }
}

function checkCurrent(current, record, version) {
  if ((current?.version || 0) !== version)
    fail(
      412,
      'CONFLICT',
      'This item changed. Your text has been retained; compare it with the current version.',
      { current: clean(current) },
    );
  if (current && current.type !== record.type)
    fail(400, 'INVALID', 'Item type cannot change.');
}

function nextRecord(record, current, ownerId, seq) {
  const now = new Date().toISOString();
  return {
    ...record,
    ownerId,
    version: (current?.version || 0) + 1,
    seq,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
}

// The batch: the workspace's sequence, the item, its revision, its event
// and the mutation's receipt, all in one transaction. Each existing
// document is replaced only over the version that was read (ifMatch).
function commitOps({
  ownerId,
  state,
  current,
  next,
  seq,
  result,
  receiptId,
  requestHash,
}) {
  return [
    state
      ? {
          operationType: 'Replace',
          id: 'state',
          ifMatch: state._etag,
          resourceBody: { id: 'state', ownerId, type: 'state', seq },
        }
      : {
          operationType: 'Create',
          resourceBody: { id: 'state', ownerId, type: 'state', seq },
        },
    current
      ? {
          operationType: 'Replace',
          id: next.id,
          ifMatch: current._etag,
          resourceBody: next,
        }
      : { operationType: 'Create', resourceBody: next },
    {
      operationType: 'Create',
      resourceBody: {
        id: `revision_${next.id}_${seq}`,
        ownerId,
        type: 'revision',
        recordId: next.id,
        seq,
        result,
      },
    },
    {
      operationType: 'Create',
      resourceBody: {
        id: `event_${String(seq).padStart(16, '0')}`,
        ownerId,
        type: 'event',
        recordId: next.id,
        seq,
      },
    },
    {
      operationType: 'Create',
      resourceBody: {
        id: receiptId,
        ownerId,
        type: 'receipt',
        recordId: next.id,
        requestHash,
        result,
      },
    },
  ];
}

/** All authored mutations, revisions, receipts and cursor advancement share one
 * owner partition and one transactional batch. No timestamp-based sync cursor. */
export function createBrainRepository(store, ownerId, batch) {
  const read = (id) => store.readDoc(RECORDS, id, ownerId);
  const query = (sql, params = [], limit = 100) =>
    store.queryDocs(
      RECORDS,
      sql,
      [{ name: '@owner', value: ownerId }, ...params],
      { partitionKey: ownerId, maxItemCount: limit },
    );
  const list = ({
    after = '',
    limit = 50,
    archived = false,
    type = null,
  } = {}) =>
    query(
      'SELECT TOP @limit * FROM c WHERE c.ownerId = @owner AND ARRAY_CONTAINS(@types, c.type) AND c.seq < @before AND c.archived = @archived ORDER BY c.seq DESC',
      [
        { name: '@limit', value: limit },
        {
          name: '@types',
          value: type ? [type] : ['note', 'topic', 'project', 'conflict'],
        },
        { name: '@before', value: Number(after) || Number.MAX_SAFE_INTEGER },
        { name: '@archived', value: archived },
      ],
      limit,
    );

  const commit = (record, options) =>
    commitRecord({ read, batch, ownerId }, record, options);

  async function changes(after = 0, limit = 50) {
    const events = await query(
      'SELECT TOP @limit * FROM c WHERE c.ownerId = @owner AND c.type = "event" AND c.seq > @after ORDER BY c.seq',
      [
        { name: '@limit', value: limit },
        { name: '@after', value: after },
      ],
    );
    const records = await Promise.all(
      events.map((event) => read(event.recordId)),
    );
    return {
      items: [
        ...new Map(
          records.filter(Boolean).map((r) => [r.id, clean(r)]),
        ).values(),
      ],
      cursor: events.at(-1)?.seq || after,
      hasMore: events.length === limit,
    };
  }
  return {
    ownerId,
    read,
    list,
    commit,
    changes,
    history: (id, before = Number.MAX_SAFE_INTEGER) =>
      query(
        'SELECT TOP 50 * FROM c WHERE c.ownerId = @owner AND c.type = "revision" AND c.recordId = @id AND c.seq < @before ORDER BY c.seq DESC',
        [
          { name: '@id', value: id },
          { name: '@before', value: before },
        ],
      ),
    backlinks: (id) =>
      query(
        'SELECT TOP 100 * FROM c WHERE c.ownerId = @owner AND c.archived = false AND (ARRAY_CONTAINS(c.links, @id) OR ARRAY_CONTAINS(c.collections, @id))',
        [{ name: '@id', value: id }],
      ),
    searchPage: (sql, params, options) =>
      store.queryDocsPage(
        SEARCH,
        sql,
        [{ name: '@owner', value: ownerId }, ...params],
        { ...options, partitionKey: ownerId },
      ),
    putIndex: (doc) => store.upsertDoc(SEARCH, { ...doc, ownerId }),
    readIndex: (id) => store.readDoc(SEARCH, id, ownerId),
    putInternal: (doc) => store.upsertDoc(RECORDS, { ...doc, ownerId }),
    store,
  };
}

export async function cosmosBrainBatch(ownerId, operations) {
  const response = await getContainer(RECORDS).items.batch(operations, ownerId);
  const bad = response.result?.find(
    (r) => r.statusCode >= 400 && r.statusCode !== 424,
  );
  if (response.code >= 400 || bad)
    throw Object.assign(new Error('Brain transaction failed'), {
      code: bad?.statusCode || response.code,
    });
}
