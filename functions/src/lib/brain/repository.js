import { getContainer } from '../cosmos-client.js';
import { RECORDS, SEARCH, BrainError, fail, clean, digest } from './model.js';

/** All authored mutations, revisions, receipts and cursor advancement share one
 * owner partition and one transactional batch. No timestamp-based sync cursor.
 *
 * `records` and `search` name the containers. They default to the creator
 * brain's; the Code Conductor brain passes its own records container and no
 * search container, so it has no index methods at all. */
export function createBrainRepository(
  store,
  ownerId,
  batch,
  { records = RECORDS, search = SEARCH } = {},
) {
  const read = (id) => store.readDoc(records, id, ownerId);
  const query = (sql, params = [], limit = 100) =>
    store.queryDocs(
      records,
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

  async function commit(record, { version = 0, mutationId } = {}) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(mutationId || ''))
      fail(400, 'INVALID', 'A unique mutationId is required.');
    const receiptId = `mutation_${mutationId}`;
    const requestHash = digest(JSON.stringify({ record, version }));
    const existing = await read(receiptId);
    if (existing) {
      if (
        existing.recordId !== record.id ||
        existing.requestHash !== requestHash
      )
        fail(409, 'CONFLICT', 'Mutation id already used for another edit.');
      return existing.result;
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      const [state, current] = await Promise.all([
        read('state'),
        read(record.id),
      ]);
      if ((current?.version || 0) !== version)
        fail(
          412,
          'CONFLICT',
          'This item changed. Your text has been retained; compare it with the current version.',
          { current: clean(current) },
        );
      if (current && current.type !== record.type)
        fail(400, 'INVALID', 'Item type cannot change.');
      const seq = (state?.seq || 0) + 1;
      const now = new Date().toISOString();
      const next = {
        ...record,
        ownerId,
        version: (current?.version || 0) + 1,
        seq,
        createdAt: current?.createdAt || now,
        updatedAt: now,
      };
      const result = clean(next);
      const ops = [
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
      try {
        await batch(ownerId, ops);
        return result;
      } catch (error) {
        if (![409, 412, 424].includes(Number(error.code))) throw error;
        const receipt = await read(receiptId);
        if (
          receipt?.recordId === record.id &&
          receipt.requestHash === requestHash
        )
          return receipt.result;
      }
    }
    throw new BrainError(
      409,
      'BUSY',
      'Another save is in progress. Retry with the same mutation id.',
    );
  }

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
    ...(search && {
      searchPage: (sql, params, options) =>
        store.queryDocsPage(
          search,
          sql,
          [{ name: '@owner', value: ownerId }, ...params],
          { ...options, partitionKey: ownerId },
        ),
      putIndex: (doc) => store.upsertDoc(search, { ...doc, ownerId }),
      readIndex: (id) => store.readDoc(search, id, ownerId),
    }),
    putInternal: (doc) => store.upsertDoc(records, { ...doc, ownerId }),
    store,
  };
}

/** One owner partition's transactional batch against the container `container()` returns. */
export function createCosmosBatch(container) {
  return async (ownerId, operations) => {
    const response = await container().items.batch(operations, ownerId);
    const bad = response.result?.find(
      (r) => r.statusCode >= 400 && r.statusCode !== 424,
    );
    if (response.code >= 400 || bad)
      throw Object.assign(new Error('Brain transaction failed'), {
        code: bad?.statusCode || response.code,
      });
  };
}

export const cosmosBrainBatch = createCosmosBatch(() => getContainer(RECORDS));
