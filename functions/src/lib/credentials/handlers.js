/**
 * Admin → Integrations → Credentials: the register's three routes (#1026).
 *
 *   GET  cms/credentials            every credential, its age, expiry and state
 *   PUT  cms/credentials            record (or clear) when one was last rotated
 *   POST cms/credentials/reminders  bring the reminders sheet in line now
 *
 * All three are `super_admin`, the Keys tab's role (admin-secrets.js
 * SECRETS_ROLE), for the Keys tab's reason: the answer is itself an
 * inventory, of every credential the estate holds and which of them are
 * overdue. handlers.test.js holds the two roles equal.
 *
 * NEVER A VALUE. The register is names and metadata (register.js); the
 * answer is built field by field (status.js presentCredential); and the one
 * write stores a date (sources.js recordRotation). The PUT body carries a
 * register id and a date and nothing else: any other key is refused, so a
 * value pasted into the wrong form is a 400 that is never stored or logged.
 *
 * Every answer is `Cache-Control: private, no-store`, as the Coder
 * automation read is: an authenticated inventory no cache may keep.
 */

import { randomUUID } from 'node:crypto';

import { dateOnly, daysUntil, parseDateOnly } from '../reminders/calendar.js';
import { findCredential, isRecordable } from './register.js';
import { readCredentialSources, recordRotation, sourceLabel } from './sources.js';
import { buildRegisterView } from './status.js';
import { reminderIdFor, reminderKind, syncCredentialReminders, wantedReminders } from './reminders.js';

/** The role every route here needs: admin-secrets.js SECRETS_ROLE, held equal by the test. */
export const CREDENTIALS_ROLE = 'super_admin';

/** The audit action a recorded rotation writes. */
export const ROTATION_AUDIT_ACTION = 'credential_rotation_recorded';

/** The PUT body's keys. Anything else is refused. */
export const ROTATION_BODY_FIELDS = Object.freeze(['credentialId', 'rotatedOn']);

/** The earliest date a rotation may be recorded on: anything before is a typo. */
export const EARLIEST_ROTATION = '2000-01-01';

const privateJson = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  body: JSON.stringify(body),
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Why a credential takes no recorded rotation, in the tab's words. */
const NOT_RECORDABLE = Object.freeze({
  self: 'renews itself, so there is no rotation to record',
  automation: 'is renewed by automation, which reports its own dates',
  none: 'is an identifier, not a credential, so it is never rotated',
});

/**
 * The PUT body, checked: `{ value: { entry, rotatedOn } }` or `{ error }`,
 * the error a sentence for the 400. `rotatedOn` null clears the record.
 * Pure given `today` (YYYY-MM-DD, the site's UTC day).
 */
export function parseRotationBody(body, today) {
  if (!isPlainObject(body)) return { error: 'The body must be a JSON object' };
  const found = credentialOf(body);
  if (found.error) return found;
  const { entry } = found;
  if (body.rotatedOn === null) return { value: { entry, rotatedOn: null } };
  const refusal = rotatedOnRefusal(body.rotatedOn, today);
  if (refusal) return { error: refusal };
  return { value: { entry, rotatedOn: body.rotatedOn } };
}

/** The register entry the body names, `{ entry }`, or `{ error }` for an unknown key or a credential that takes no record. */
function credentialOf(body) {
  const unknown = Object.keys(body).find((key) => !ROTATION_BODY_FIELDS.includes(key));
  if (unknown !== undefined) {
    return {
      error: `${JSON.stringify(unknown.slice(0, 40))} is not a field this route reads: the body carries ${ROTATION_BODY_FIELDS.join(' and ')} only`,
    };
  }
  const entry = typeof body.credentialId === 'string' ? findCredential(body.credentialId) : undefined;
  if (!entry) return { error: 'credentialId is not a credential the register knows' };
  if (!isRecordable(entry)) return { error: `${entry.name} ${NOT_RECORDABLE[entry.renewal]}` };
  return { entry };
}

/** Why `rotatedOn` (not null) cannot be recorded, or null when it can. */
function rotatedOnRefusal(rotatedOn, today) {
  if (parseDateOnly(rotatedOn) === null) {
    return 'rotatedOn must be a real date as YYYY-MM-DD, or null to clear the record';
  }
  if (rotatedOn < EARLIEST_ROTATION) return `rotatedOn must be on or after ${EARLIEST_ROTATION}`;
  // One day of grace for a clock ahead of UTC; past that it has not happened yet.
  if (daysUntil(rotatedOn, today) > 1) return 'rotatedOn is in the future: record a rotation once it is done';
  return null;
}

/**
 * Each credential's reminder as the sync would write it (reminders.js
 * wantedReminders, from the same read), and whether the sheet has it: a row
 * with the same id, due date and title. `inSheet` is null when the sheet
 * could not be read, so the tab says "unknown" rather than "missing".
 */
function remindersById(credentials, sheet, nowMs) {
  const wanted = new Map(
    wantedReminders(credentials, { today: dateOnly(nowMs), stored: sheet ?? [] }).map((row) => [row.id, row])
  );
  const stored = new Map((sheet ?? []).map((row) => [row?.id, row]));
  const out = new Map();
  for (const credential of credentials) {
    const row = wanted.get(reminderIdFor(credential.id));
    if (!row) continue;
    const held = stored.get(row.id);
    out.set(credential.id, {
      id: row.id,
      kind: reminderKind(credential),
      dueDate: row.dueDate,
      leadDays: row.leadDays,
      inSheet: sheet === null ? null : Boolean(held && held.dueDate === row.dueDate && held.title === row.title),
    });
  }
  return out;
}

/**
 * The whole answer for the tab, from one read of every source. A credential
 * whose source could not be read is unknown, with no expiry and no reminder,
 * and the counts are taken after that (status.js buildRegisterView).
 */
export function presentRegister({ sources, unavailable }, nowMs) {
  const view = buildRegisterView(sources, nowMs, unavailable);
  const reminders = remindersById(view.credentials, sources.reminders, nowMs);
  return {
    success: true,
    generatedAt: new Date(nowMs).toISOString(),
    stores: view.stores,
    counts: view.counts,
    credentials: view.credentials.map((credential) => ({
      ...credential,
      reminder: reminders.get(credential.id) ?? null,
    })),
    unavailable: unavailable.map((id) => ({ id, label: sourceLabel(id) })),
  };
}

async function answer(deps, extra = {}) {
  const read = await readCredentialSources(deps.store);
  return privateJson(200, { ...presentRegister(read, deps.now().getTime()), ...extra });
}

/** Best effort, like every audit writer here: the record has landed. */
async function audit(deps, user, details, context) {
  try {
    await deps.store.upsertDoc('admin_audit_logs', {
      id: deps.uuid(),
      action: ROTATION_AUDIT_ACTION,
      userId: user?.oid || user?.sub || null,
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: deps.now().toISOString(),
      details,
    });
  } catch (error) {
    context.warn?.(`putCredentialRotation: recorded, but the audit row failed (${error?.code ?? 'error'})`);
  }
}

/** The reminders sync as a summary that never throws: the caller's write has landed. */
async function syncQuietly(deps, context) {
  try {
    return await deps.sync({ store: deps.store, now: deps.now, log: context });
  } catch (error) {
    context.warn?.(`credentials: the reminders sync failed (${error?.code ?? 'error'})`);
    return { synced: false, reason: 'error' };
  }
}

/** Store the rotation date; answers null when it landed, or the refusal to send back. */
async function storeRotation(deps, { entry, rotatedOn, user }, context) {
  try {
    await recordRotation(deps.store, {
      credentialId: entry.id,
      rotatedOn,
      actor: user?.oid ?? user?.preferred_username ?? 'unknown',
      at: deps.now().toISOString(),
    });
    return null;
  } catch (error) {
    context.error?.(`putCredentialRotation failed (${error?.code ?? 'error'})`);
    const status = error?.code === 'CONFLICT' ? 409 : 500;
    return privateJson(status, { success: false, error: 'The rotation could not be recorded; nothing changed' });
  }
}

/** GET cms/credentials */
async function getRegister(deps, request, context) {
  const auth = await deps.guard.requireRole(request, CREDENTIALS_ROLE);
  if (auth.error) return auth.error;
  try {
    return await answer(deps);
  } catch (error) {
    context.error?.(`getCredentialRegister failed (${error?.code ?? 'error'})`);
    return privateJson(500, { error: 'Failed to read the credential register' });
  }
}

/** PUT cms/credentials — { credentialId, rotatedOn: 'YYYY-MM-DD' | null } */
async function putRotation(deps, request, context) {
  const auth = await deps.guard.requireRole(request, CREDENTIALS_ROLE);
  if (auth.error) return auth.error;
  const parsed = parseRotationBody(await request.json().catch(() => null), dateOnly(deps.now()));
  if (parsed.error) return privateJson(400, { success: false, error: parsed.error });
  const { entry, rotatedOn } = parsed.value;

  const refused = await storeRotation(deps, { entry, rotatedOn, user: auth.user }, context);
  if (refused) return refused;
  await audit(deps, auth.user, { credentialId: entry.id, rotatedOn, cleared: rotatedOn === null }, context);
  const reminders = await syncQuietly(deps, context);
  try {
    return await answer(deps, { recorded: { credentialId: entry.id, rotatedOn }, reminders });
  } catch (error) {
    // Recorded is recorded: a failed re-read must not read as a failed write.
    context.warn?.(`putCredentialRotation: recorded, but the re-read failed (${error?.code ?? 'error'})`);
    return privateJson(200, { success: true, recorded: { credentialId: entry.id, rotatedOn }, reminders });
  }
}

/** POST cms/credentials/reminders */
async function syncReminders(deps, request, context) {
  const auth = await deps.guard.requireRole(request, CREDENTIALS_ROLE);
  if (auth.error) return auth.error;
  const reminders = await syncQuietly(deps, context);
  try {
    return await answer(deps, { reminders });
  } catch (error) {
    context.error?.(`syncCredentialReminders: the re-read failed (${error?.code ?? 'error'})`);
    return privateJson(500, { error: 'Failed to read the credential register', reminders });
  }
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, queryDocs: Function, createDoc: Function, replaceDocIfMatch: Function, upsertDoc: Function }} deps.store
 *        queryDocs only for the projected mcp_servers read (sources.js)
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {Function} [deps.sync] syncCredentialReminders, injectable for tests
 */
export function createCredentialRegisterHandlers({
  guard,
  store,
  now = () => new Date(),
  uuid = randomUUID,
  sync = syncCredentialReminders,
}) {
  const deps = { guard, store, now, uuid, sync };
  return {
    getRegister: (request, context) => getRegister(deps, request, context),
    putRotation: (request, context) => putRotation(deps, request, context),
    syncReminders: (request, context) => syncReminders(deps, request, context),
  };
}
