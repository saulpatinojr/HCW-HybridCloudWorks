/**
 * contacts.js — the Resend side of a confirmed subscriber: the contact, its
 * place in the Newsletter segment, and its subscribed flag, each read back
 * before it is believed; and the segment's id, found or created. Shared by
 * the public confirm (handlers.js, whose header says why the write is read
 * back) and the admin's consent-recorded add. handlers.js exports these
 * again.
 */

/** The segment every confirmed subscriber is added to. Created if missing. */
export const NEWSLETTER_SEGMENT_NAME = 'Newsletter';

/**
 * The first step of a response Resend gave, as an operator-safe sentence: a
 * status and Resend's `name`, never the body, which can echo the address.
 */
export function describe(result) {
  const name = typeof result?.data?.name === 'string' ? ` ${result.data.name}` : '';
  return `HTTP ${result?.status ?? 0}${name}`;
}

/**
 * Put `email` in the Newsletter segment, subscribed, and READ IT BACK before
 * saying so (the header's "Confirm does not trust the write"). Shared by the
 * public confirm and the admin's consent-recorded add.
 *
 * @returns {Promise<{ ok: true } | { ok: false, why: string }>} `why` is operator-safe: statuses and names, never the address.
 */
export async function ensureConfirmedContact(deps) {
  for (const step of [ensureContactExists, ensureInSegment, ensureSubscribed]) {
    const outcome = await step(deps);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

const OK = Object.freeze({ ok: true });

/** Step 1: the contact exists, resubscribed if it had opted out. */
async function ensureContactExists({ client, email, segmentId }) {
  const created = await client.createContact({ email, segmentId });
  if (created.ok) return OK;
  // Resend does not document which status means "already exists", so the
  // status is not guessed at: the contact is looked up. Only a contact that
  // really exists is resubscribed — someone who unsubscribed and is now
  // choosing to come back, which is exactly the consent this records. A
  // 401, a 5xx or a transport failure finds no contact and is reported as
  // the create failure it was, not masked by a PATCH.
  const existing = await client.getContact(email);
  if (!existing.ok) {
    return {
      ok: false,
      why: `create ${describe(created)}; no existing contact (${describe(existing)})`,
    };
  }
  const resubscribed = await client.resubscribeContact(email);
  return resubscribed.ok
    ? OK
    : { ok: false, why: `create ${describe(created)}, then update ${describe(resubscribed)}` };
}

/** Step 2: the contact is in the Newsletter segment, read back after adding. */
async function ensureInSegment({ client, email, segmentId }) {
  const inSegment = async () => {
    const listed = await client.listContactSegments(email);
    return (
      listed.ok &&
      Array.isArray(listed.data?.data) &&
      listed.data.data.some((row) => row?.id === segmentId)
    );
  };
  if (await inSegment()) return OK;
  const added = await client.addContactToSegment(email, segmentId);
  const present = added.ok && (await inSegment());
  return present
    ? OK
    : {
        ok: false,
        why: `the contact is not in the ${NEWSLETTER_SEGMENT_NAME} segment after adding it (${describe(added)})`,
      };
}

/** Step 3: the contact reads back as subscribed, repaired once if not. */
async function ensureSubscribed({ client, email }) {
  const stored = await client.getContact(email);
  if (!stored.ok) return { ok: false, why: `reading the contact back ${describe(stored)}` };
  if (stored.data?.unsubscribed === false) return OK;
  // resend/resend-node#458's shape. Repair once, then check again.
  const repaired = await client.resubscribeContact(email);
  const reread = repaired.ok ? await client.getContact(email) : repaired;
  return reread.ok && reread.data?.unsubscribed === false
    ? OK
    : { ok: false, why: 'the contact reads back as unsubscribed after confirming' };
}

/**
 * The Newsletter segment id: found by name, created if missing. Used by
 * confirm to add a contact, and exported for the send step to reuse.
 */
export async function findSegmentId(client) {
  let after;
  for (let page = 0; page < 20; page += 1) {
    const listed = await client.listSegments(after);
    if (!listed.ok) throw new Error(`listing segments failed: ${describe(listed)}`);
    const rows = Array.isArray(listed.data?.data) ? listed.data.data : [];
    const found = rows.find((row) => row?.name === NEWSLETTER_SEGMENT_NAME);
    if (found?.id) return found.id;
    if (!listed.data?.has_more || rows.length === 0) break;
    after = rows[rows.length - 1].id;
  }
  return null;
}

export async function resolveSegmentId(client) {
  const existing = await findSegmentId(client);
  if (existing) return existing;
  const created = await client.createSegment(NEWSLETTER_SEGMENT_NAME);
  if (created.ok && created.data?.id) return created.data.id;
  // Two cold instances confirming at once can both find no segment and both
  // create; the loser's failure is not a failure if the winner's segment now
  // exists. Look once more before giving the subscriber a 502.
  const raced = await findSegmentId(client);
  if (raced) return raced;
  throw new Error(`creating the ${NEWSLETTER_SEGMENT_NAME} segment failed: ${describe(created)}`);
}

