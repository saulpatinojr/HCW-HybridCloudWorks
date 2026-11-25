/**
 * Application routes (ADR 0033 §4): one pursuit of one program, with the
 * status machine. A status in a patch is a transition, checked against
 * APPLICATION_TRANSITIONS and appended to history[]; every other field is a
 * plain patch.
 */
import { actorName } from '../auth/actor-name.js';
import { satisfiesRole } from '../auth/roles.js';
import { APPLICATION_TRANSITIONS, canTransition, CONTAINER, programGate } from './model.js';
import { KINDS, byUpdatedDesc, json, loadCreate, loadPatch, stamped } from './steps.js';
import { str } from './fields.js';

/**
 * An application for a program additional to another (MCT Regional Lead to
 * MCT) may start only while the parent's membership is Active: the 409 to
 * answer otherwise, naming the Settings step that opens it, or null.
 */
async function parentLocked(ctx, program) {
  if (!program.parentProgramId) return null;
  const parent = await ctx.readKind('program', program.parentProgramId);
  const gate = programGate(program, parent);
  if (gate.unlocked) return null;
  const parentName = gate.parent.name || program.parentProgramId;
  return json(409, {
    code: 'PARENT_NOT_ACTIVE',
    error: `${program.name} is additional to ${parentName}: set that membership to Active on Settings before starting this application.`,
    parentProgramId: program.parentProgramId,
  });
}

/** GET cms/ambassador/applications?programId=&status= */
export async function listApplications(ctx, request) {
  const programId = str(request.query?.get?.('programId'), 200);
  const status = str(request.query?.get?.('status'), 40);
  let items = await ctx.listKind('application');
  if (programId) items = items.filter((a) => a.programId === programId);
  if (status) items = items.filter((a) => a.status === status);
  items.sort(byUpdatedDesc);
  return json(200, { success: true, items, total: items.length });
}

const applicationDefaults = () => ({
  qualificationPeriod: null,
  applicationDate: null,
  decisionDate: null,
  startDate: null,
  expirationDate: null,
  renewalDate: null,
  notes: '',
  reviewerFeedback: '',
  responses: [],
  files: [],
  images: [],
  links: [],
  badgeImageUrl: null,
  evidenceIds: [],
  customValues: {},
  private: true,
});

/** POST cms/ambassador/applications — starts as `interested` unless told otherwise. */
export async function createApplication(ctx, request, auth) {
  const loaded = await loadCreate(ctx, request, KINDS.application);
  if (loaded.error) return loaded.error;
  // A control field for PATCH (patchApplication checks the role); on a
  // create it would be stored as data by the spread below.
  if ('statusOverride' in loaded.value) {
    return json(400, { error: 'statusOverride is accepted only when updating an application' });
  }
  const program = await ctx.readKind('program', loaded.value.programId);
  if (!program) return json(400, { error: `Unknown programId ${loaded.value.programId}` });
  const locked = await parentLocked(ctx, program);
  if (locked) return locked;
  const stamp = ctx.nowIso();
  const status = loaded.value.status || 'interested';
  const doc = stamped(
    ctx,
    KINDS.application,
    {
      ...applicationDefaults(),
      title: `${program.name} ${stamp.slice(0, 4)}`,
      submissionDeadline: program.applicationWindow?.closes || null,
      ...loaded.value,
      status,
      history: [
        {
          at: stamp,
          by: actorName(auth.user),
          from: null,
          to: status,
          note: loaded.value.statusNote || 'Created',
        },
      ],
    },
    auth
  );
  delete doc.statusNote;
  await ctx.store.upsertDoc(CONTAINER, doc);
  await ctx.audit('ambassador_application_created', auth, request, {
    applicationId: doc.id,
    programId: doc.programId,
    status,
  });
  return json(200, { success: true, id: doc.id, item: doc });
}

const TRANSITION_DATES = [
  ['applicationDate', ['submitted']],
  ['decisionDate', ['accepted', 'denied']],
];

/**
 * A status in a patch is a transition: refused when APPLICATION_TRANSITIONS
 * does not list it, otherwise appended to history[] with its note and, for
 * the moves that imply a date, the date defaulted to today. A patch that
 * repeats the current status is a plain patch with the status dropped.
 * Mutates `updates`; answers the refusal to send, or null.
 */
function applyTransition(updates, { existing, statusNote, stamp, actor, today, override }) {
  if (!updates.status || updates.status === existing.status) {
    delete updates.status;
    return null;
  }
  if (!override && !canTransition(existing.status, updates.status)) {
    return json(400, {
      error: `Cannot move an application from ${existing.status} to ${updates.status}`,
      allowed: APPLICATION_TRANSITIONS[existing.status] || [],
    });
  }
  const history = Array.isArray(existing.history) ? existing.history : [];
  updates.history = [
    ...history,
    {
      at: stamp,
      by: actor,
      from: existing.status,
      to: updates.status,
      note: statusNote || '',
      ...(override ? { override: true } : {}),
    },
  ];
  for (const [field, statuses] of TRANSITION_DATES) {
    const unset = !updates[field] && !existing[field];
    if (statuses.includes(updates.status) && unset) updates[field] = today;
  }
  return null;
}

/**
 * What refuses a patch before anything is written: a status override from
 * below super_admin, or a move to a program that does not exist or is
 * locked. The response, or null.
 */
async function patchRefusal(ctx, { auth, updates, existing, statusOverride }) {
  if (statusOverride && !satisfiesRole(auth.role, 'super_admin')) {
    return json(403, { error: 'Setting a status outside the transition table needs super_admin' });
  }
  if (!updates.programId || updates.programId === existing.programId) return null;
  const program = await ctx.readKind('program', updates.programId);
  if (!program) return json(400, { error: `Unknown programId ${updates.programId}` });
  return parentLocked(ctx, program);
}

/**
 * PATCH cms/ambassador/applications/{id} — a status in the body is a
 * transition, checked against APPLICATION_TRANSITIONS and appended to
 * history[] with its note; every other field is a plain patch. With
 * `statusOverride: true` (super_admin only — the Settings tab's state
 * select, owner request 2026-10-05) any status is accepted and the history
 * row says so, so a record can be corrected without walking the funnel.
 */
export async function patchApplication(ctx, request, auth) {
  const loaded = await loadPatch(ctx, request, KINDS.application);
  if (loaded.error) return loaded.error;
  const { id, existing } = loaded;
  const { statusNote, statusOverride, ...updates } = loaded.updates;
  const refusal = await patchRefusal(ctx, { auth, updates, existing, statusOverride });
  if (refusal) return refusal;
  const stamp = ctx.nowIso();
  const refused = applyTransition(updates, {
    existing,
    statusNote,
    stamp,
    actor: actorName(auth.user),
    today: ctx.today(),
    override: Boolean(statusOverride),
  });
  if (refused) return refused;
  // The history row above was derived from `existing`: write only if that
  // is still what is stored, so two Settings changes at once cannot each
  // append to the same old history and the later one erase the first.
  let updated;
  try {
    updated = await ctx.store.patchDoc(
      CONTAINER,
      id,
      { ...updates, updatedAt: stamp },
      existing._etag ? { ifMatch: existing._etag } : {}
    );
  } catch (error) {
    if (error?.code === 412 || error?.statusCode === 412) {
      return json(409, {
        error: 'The application changed since it was read; reload and try again',
        code: 'CONFLICT',
      });
    }
    throw error;
  }
  await ctx.audit('ambassador_application_updated', auth, request, {
    applicationId: id,
    fields: Object.keys(updates),
    transition: updates.status ? { from: existing.status, to: updates.status } : null,
  });
  return json(200, { success: true, item: updated });
}
