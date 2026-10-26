// Test-only transactional store: verifies preconditions before applying ANY
// operation, so failure injection exercises the same atomicity as Cosmos.
export function memoryStore() {
  const docs = new Map();
  let etag = 0;
  const key = (container, id, owner) => `${container}/${owner || ''}/${id}`;
  const clone = (v) => (v ? structuredClone(v) : null);
  const put = (container, doc) => {
    const saved = { ...clone(doc), _etag: String(++etag) };
    docs.set(key(container, doc.id, doc.ownerId), saved);
    return clone(saved);
  };
  const readDoc = async (container, id, owner) =>
    clone(
      docs.get(
        key(container, id, container.startsWith('brain_') ? owner : undefined),
      ),
    );
  const queryDocs = async (container, sql, params = [], options = {}) => {
    const p = Object.fromEntries(params.map((v) => [v.name, v.value]));
    let rows = [...docs.entries()]
      .filter(([k]) => k.startsWith(`${container}/`))
      .map(([, v]) => clone(v));
    if (p['@owner'])
      rows = rows.filter(
        (r) => !container.startsWith('brain_') || r.ownerId === p['@owner'],
      );
    if (p['@types']) rows = rows.filter((r) => p['@types'].includes(r.type));
    if (p['@before'] !== undefined)
      rows = rows.filter((r) => r.seq < p['@before']);
    if (p['@archived'] !== undefined)
      rows = rows.filter((r) => r.archived === p['@archived']);
    if (sql.includes('c.type = "event"'))
      rows = rows.filter((r) => r.type === 'event' && r.seq > p['@after']);
    else if (p['@after'] !== undefined)
      rows = rows.filter((r) => r.id > p['@after']);
    if (sql.includes('c.type = "revision"'))
      rows = rows.filter(
        (r) => r.type === 'revision' && r.recordId === p['@id'],
      );
    if (sql.includes('c.type = "search-item"'))
      rows = rows.filter((r) => r.type === 'search-item');
    if (sql.includes('ARRAY_CONTAINS(["note"'))
      rows = rows.filter((r) =>
        ['note', 'topic', 'project', 'conflict'].includes(r.type),
      );
    if (sql.includes('ARRAY_CONTAINS(c.links'))
      rows = rows.filter(
        (r) =>
          !r.archived &&
          (r.links?.includes(p['@id']) || r.collections?.includes(p['@id'])),
      );
    if (p['@kind']) rows = rows.filter((r) => r.itemType === p['@kind']);
    const terms = Object.entries(p)
      .filter(([k]) => /^@t\d/.test(k))
      .map(([, v]) => v);
    if (terms.length)
      rows = rows.filter((r) => terms.some((t) => r.searchable?.includes(t)));
    if (sql.includes('ORDER BY c.seq'))
      rows.sort((a, b) =>
        sql.includes('DESC') ? b.seq - a.seq : a.seq - b.seq,
      );
    else rows.sort((a, b) => a.id.localeCompare(b.id));
    const count = p['@limit'] ?? Number(sql.match(/TOP (\d+)/)?.[1] || 100000);
    return rows.slice(0, count || options.maxItemCount);
  };
  const store = {
    docs,
    readDoc,
    queryDocs,
    upsertDoc: async (c, d) => put(c, d),
    createDoc: async (c, d) => {
      if (await readDoc(c, d.id, d.ownerId))
        throw Object.assign(new Error('exists'), { code: 409 });
      return put(c, d);
    },
    replaceDocIfMatch: async (c, d) => {
      const old = await readDoc(c, d.id, d.ownerId);
      if (!old || old._etag !== d._etag)
        throw Object.assign(new Error('conflict'), { code: 412 });
      return put(c, d);
    },
    queryDocsPage: async (c, sql, p, options) => {
      const rows = await queryDocs(c, sql, p, options);
      const start = Number(options.continuationToken || 0);
      const size = options.maxItemCount || 30;
      return {
        resources: rows.slice(start, start + size),
        continuationToken:
          rows.length > start + size ? String(start + size) : null,
        hasMoreResults: rows.length > start + size,
      };
    },
  };
  const batch = async (owner, ops) => {
    for (const op of ops) {
      const current = docs.get(
        key('brain_records', op.id || op.resourceBody.id, owner),
      );
      if (op.operationType === 'Create' && current)
        throw Object.assign(new Error('exists'), { code: 409 });
      if (op.operationType === 'Replace' && current?._etag !== op.ifMatch)
        throw Object.assign(new Error('conflict'), { code: 412 });
    }
    // No awaits between validation and commit in this test adapter.
    for (const op of ops) put('brain_records', op.resourceBody);
  };
  return { store, batch };
}
