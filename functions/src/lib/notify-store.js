/**
 * notify-store.js — what the notifier (notify.js) keeps in the `system`
 * container: the per-source cooldown in `notify_state`, and the alert log in
 * `notify_log`. Every write is conditional on the ETag it read, so two
 * writers at once cannot erase each other. notify.js re-exports the public
 * names.
 */

export const COOLDOWN_MS = 15 * 60 * 1000;
export const NOTIFY_STATE_ID = 'notify_state';

/**
 * THE ALERT LOG (owner request 2026-11-10). Until now an alert went to
 * Telegram and nowhere else: `notify_state` keeps only when each source last
 * sent, so a notice the owner missed on the phone could not be read again
 * anywhere, by the owner or by Koda. Every alert Telegram accepts is now also
 * kept in `system/notify_log`: the newest NOTIFY_LOG_MAX, oldest first, each
 * with the words that were sent. The Health page lists them with a "Send
 * again" button, and Koda reads the same list (cms/alerts/recent,
 * lib/alerts/handlers.js).
 *
 * The text is the owner's own notices (a job failure's message is already
 * redacted before it gets here, lib/job-failure-notify.js), kept in the
 * owner's own database; it never reaches a log line. Writing the log is best
 * effort and after the send: a failure to record never turns a sent alert
 * into a failed one, and never throws.
 */
export const NOTIFY_LOG_ID = 'notify_log';
export const NOTIFY_LOG_MAX = 50;
/** Telegram's own limit on a message is 4,096 characters; nothing longer is ever sent. */
export const LOG_TEXT_MAX = 4096;
/** Tries at the conditional write before giving up on recording one alert. */
export const LOG_WRITE_ATTEMPTS = 4;
/** A short random pause before retrying a lost race, so racing writers spread out. */
export const jitter = () => new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));

/**
 * The cooldown document with its ETag, created empty on first use so the
 * conditional claim always has something to condition on. Two first-time
 * callers both upsert `{ id }`; upsert does not conflict, and each then
 * reads the ETag it needs.
 */
export async function readOrCreateState(store) {
  const existing = await store.readDoc('system', NOTIFY_STATE_ID, NOTIFY_STATE_ID);
  if (existing) return existing;
  const created = await store.upsertDoc('system', { id: NOTIFY_STATE_ID });
  if (created?._etag) return created;
  return (await store.readDoc('system', NOTIFY_STATE_ID, NOTIFY_STATE_ID)) || { id: NOTIFY_STATE_ID };
}

/** A short random id for one logged alert (not a secret: it names a log entry). */
export function logEntryId(now) {
  return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const clip = (value, max) => String(value ?? '').slice(0, max);

/**
 * Add one sent alert to `system/notify_log`, keeping the newest
 * NOTIFY_LOG_MAX. The list is one field written only if the document is
 * unchanged since it was read (ETag), so two alerts sent at once both land;
 * the loser of a race reads again and retries. Never throws.
 */
export async function recordSent(store, entry, log) {
  for (let attempt = 1; attempt <= LOG_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await appendEntry(store, entry);
      return true;
    } catch (error) {
      const lostRace = error?.code === 412 || error?.code === 409;
      if (lostRace && attempt < LOG_WRITE_ATTEMPTS) {
        await jitter();
        continue;
      }
      log.warn?.(`[notify] could not record the alert in the log: ${error?.code ?? 'error'}`);
      return false;
    }
  }
  return false;
}

/** One try at adding `entry` to the log: a create the first time, else a write under the ETag read. */
async function appendEntry(store, entry) {
  const existing = await store.readDoc('system', NOTIFY_LOG_ID, NOTIFY_LOG_ID);
  if (!existing) {
    // First alert ever: create only, so two first alerts at once cannot
    // overwrite each other (the loser gets 409, reads the winner's
    // document and appends). A store without createDoc is a caller that
    // predates the log; it gets the old unconditional write.
    if (typeof store.createDoc === 'function') {
      await store.createDoc('system', { id: NOTIFY_LOG_ID, entries: [entry] });
    } else {
      await store.upsertDoc('system', { id: NOTIFY_LOG_ID, entries: [entry] });
    }
    return;
  }
  // Without an ETag the write below would not be conditional; read again.
  if (!existing._etag) throw Object.assign(new Error('no etag'), { code: 412 });
  const previous = Array.isArray(existing.entries) ? existing.entries : [];
  const entries = [...previous, entry].slice(-NOTIFY_LOG_MAX);
  await store.patchDoc('system', NOTIFY_LOG_ID, { entries }, { partitionKey: NOTIFY_LOG_ID, ifMatch: existing._etag });
}

/**
 * The alert log, newest first, or an empty list when nothing has been sent
 * since it began. A failed read throws, so a caller can say "could not read"
 * instead of "no alerts".
 */
export async function readAlertLog(store) {
  const doc = await store.readDoc('system', NOTIFY_LOG_ID, NOTIFY_LOG_ID);
  const entries = Array.isArray(doc?.entries) ? doc.entries : [];
  return [...entries].reverse();
}

/** Take a refused resend's entry back out of the log (conditional, best effort, never throws). */
export async function releaseClaim({ store, log }, id) {
  for (let attempt = 1; attempt <= LOG_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const doc = await store.readDoc('system', NOTIFY_LOG_ID, NOTIFY_LOG_ID);
      const stored = Array.isArray(doc?.entries) ? doc.entries : [];
      if (!stored.some((entry) => entry?.id === id)) return;
      if (!doc._etag) throw Object.assign(new Error('no etag'), { code: 412 });
      await store.patchDoc(
        'system',
        NOTIFY_LOG_ID,
        { entries: stored.filter((entry) => entry?.id !== id) },
        { partitionKey: NOTIFY_LOG_ID, ifMatch: doc._etag }
      );
      return;
    } catch (error) {
      if (error?.code === 412 && attempt < LOG_WRITE_ATTEMPTS) {
        await jitter();
        continue;
      }
      log.warn?.(`[notify] could not take back a refused resend: ${error?.code ?? 'error'}`);
      return;
    }
  }
}


/**
 * Claim the cooldown window for `source` before sending: one field, only if
 * nobody else has written the document since it was read. False when the
 * window is still closed or another send claimed it first.
 */
export async function claimCooldown({ store, now, log }, state, { source, sourceForLog }) {
  const previous = state[source];
  const last = Date.parse(previous?.lastNotifiedAt || '') || 0;
  if (now().getTime() - last < COOLDOWN_MS) {
    log.log?.(`[notify] Cooldown active for source="${sourceForLog}"; skipping Telegram send.`);
    return false;
  }
  try {
    await store.patchDoc(
      'system',
      NOTIFY_STATE_ID,
      { [source]: { lastNotifiedAt: now().toISOString() } },
      { partitionKey: NOTIFY_STATE_ID, ifMatch: state._etag }
    );
    return true;
  } catch (error) {
    if (error?.code !== 412) throw error;
    log.log?.(`[notify] Another send claimed source="${sourceForLog}" first; skipping Telegram send.`);
    return false;
  }
}
