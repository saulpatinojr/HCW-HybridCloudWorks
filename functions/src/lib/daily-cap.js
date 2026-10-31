/**
 * A global cap per UTC day: one counter document per day, taken one at a
 * time with a compare-and-increment so a burst cannot read-then-write its
 * way past the limit.
 *
 * Extracted from the explain route's quota (cloud-tools/explain/quota.js,
 * #613 Phase 3) when the public lab submission (#672) needed the same
 * counter with its own id and limit. The behaviour is the explain route's,
 * unchanged: `incrementIf` is the compare-and-increment cosmos-client.js
 * documents; 404 means today's counter does not exist yet and `createDoc`
 * races to make it (409: someone else did, go round); 412 means the
 * predicate failed, which for `count < limit` is the cap. Anything else is
 * a fault and propagates, so a store outage is a 500 rather than a free
 * pass.
 */

/**
 * Take one of today's `limit`, or say no.
 *
 * @param {{ incrementIf: Function, createDoc: Function }} store
 * @param {object} args
 * @param {string} args.container - the container the counter lives in (partition key `/id`)
 * @param {string} args.id - the counter's id for this day, e.g. `explain-quota:2026-09-27`
 * @param {string} args.kind - the discriminator written on the document
 * @param {string} args.day - the UTC day, `YYYY-MM-DD`
 * @param {string} args.nowIso
 * @param {number} args.limit
 * @param {number} args.ttlSeconds - the counter's own `ttl`, so it ages out
 * @returns {Promise<boolean>} true when the call may proceed
 */
export async function takeDailyCap(store, { container, id, kind, day, nowIso, limit, ttlSeconds }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const incremented = await increment(store, container, id, limit);
    if (incremented !== 'missing') return incremented;
    if (await create(store, container, { id, kind, day, nowIso, ttlSeconds })) return true;
  }
  return false;
}

/**
 * Give one of today's back, for a call that took one and then did not do the
 * thing it was counted for (a visitor lab start that Coder failed, #1400 item
 * 1). One conditional decrement: Cosmos's increment takes a negative value
 * (https://learn.microsoft.com/azure/cosmos-db/partial-document-update#supported-operations),
 * and the condition `c.count > 0` keeps a counter from going below zero. That
 * is all it guards: on a counter at 2 or more, a give-back sent twice takes 2
 * off and so hands out an extra call. The caller must make sure it gives back
 * at most once; the visitor sessions do it with a marker on the session
 * record that only one writer can turn from `pending` to `given`
 * (`DAILY_CAP_REFUND` in labs/visitor-session.js).
 *
 * @param {{ incrementIf: Function }} store
 * @param {{ container: string, id: string }} args - the same counter `takeDailyCap` took from
 * @returns {Promise<boolean>} true when one was given back; false when there
 *   was nothing to give back (no counter today, 404, or it is at zero, 412)
 * @throws any other store fault, for the caller to log
 */
export async function giveBackDailyCap(store, { container, id }) {
  try {
    await store.incrementIf(container, id, {
      path: '/count',
      value: -1,
      condition: 'FROM c WHERE c.count > @floor',
      conditionValues: { floor: 0 },
    });
    return true;
  } catch (error) {
    if (error?.code === 412 || error?.code === 404) return false;
    throw error;
  }
}

/** true: counted; false: at the cap; 'missing': no counter yet. */
async function increment(store, container, id, limit) {
  try {
    await store.incrementIf(container, id, {
      path: '/count',
      value: 1,
      condition: 'FROM c WHERE c.count < @limit',
      conditionValues: { limit },
    });
    return true;
  } catch (error) {
    if (error?.code === 412) return false;
    if (error?.code === 404) return 'missing';
    throw error;
  }
}

/** true: created with count 1; false: another instance created it first. */
async function create(store, container, { id, kind, day, nowIso, ttlSeconds }) {
  try {
    await store.createDoc(container, {
      id,
      kind,
      day,
      count: 1,
      createdAt: nowIso,
      ttl: ttlSeconds,
    });
    return true;
  } catch (error) {
    if (error?.code !== 409) throw error;
    return false;
  }
}
