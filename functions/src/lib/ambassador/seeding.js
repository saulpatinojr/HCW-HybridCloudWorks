/**
 * ambassador/seeding.js — the built-in programs (programs.js DEFAULT_PROGRAMS)
 * kept in the container: inserted when missing, and given the fields a seed
 * gained since it was stored, without ever overwriting an owner's edit.
 * Split out of steps.js, which re-exports ensureSeededPrograms and
 * seedBackfillFor so callers and tests import what they always did.
 */
import { CONTAINER } from './model.js';
import { DEFAULT_PROGRAMS, SUPERSEDED_SEED_VALUES, currentSeedRevision } from './programs.js';

/** One seed as the stored document: enabled, ordered, stamped. */
function seededDoc(ctx, program, order) {
  const stamp = ctx.nowIso();
  return {
    ...program,
    docType: 'program',
    enabled: true,
    order,
    seeded: true,
    reminders: { daysBeforeDeadline: 14, daysBeforeRenewal: 30 },
    customFields: [],
    // A seed with a superseded history starts at its current revision, so
    // nothing of it is ever "corrected".
    ...(SUPERSEDED_SEED_VALUES[program.id]
      ? { seedRevision: currentSeedRevision(program.id) }
      : {}),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * The stored programs plus any DEFAULT_PROGRAMS entry the container does not
 * hold yet, inserted after the current highest `order`. An empty container
 * gets every seed in order (the first read); an existing one gets only the
 * seeds added since, so a program edited, disabled or soft-deleted by the
 * owner is never overwritten or brought back — a soft-deleted seed is absent
 * from `rows` but still stored, and the read of its id is what keeps it out.
 */
export async function ensureSeededPrograms(ctx, rows) {
  const current = await backfillSeedFields(ctx, rows);
  const present = new Set(current.map((row) => row.id));
  const missing = DEFAULT_PROGRAMS.filter((program) => !present.has(program.id));
  if (missing.length === 0) return current;
  let order = current.reduce((max, row) => Math.max(max, Number(row.order) || 0), 0);
  const added = [];
  for (const program of missing) {
    const stored = await ctx.store.readDoc(CONTAINER, program.id, program.id);
    if (stored) continue;
    order += 1;
    const inserted = await insertSeed(ctx, seededDoc(ctx, program, order));
    if (inserted) added.push(inserted);
  }
  return [...current, ...added];
}

/**
 * Create the seed atomically. Two overlapping reads can both find it
 * missing; the second's create answers 409, and the row the first inserted
 * — with whatever the owner edited since — wins: it is re-read and used as
 * stored, or left out when it was soft-deleted in the meantime. Nothing is
 * ever overwritten.
 */
async function insertSeed(ctx, doc) {
  try {
    return (await ctx.store.createDoc(CONTAINER, doc)) || doc;
  } catch (error) {
    if (error?.code !== 409) throw error;
    const stored = await ctx.store.readDoc(CONTAINER, doc.id, doc.id);
    return stored && !stored.softDeletedAt ? stored : null;
  }
}

const SEEDS_BY_ID = new Map(DEFAULT_PROGRAMS.map((program) => [program.id, program]));

const hasQuestions = (doc) =>
  Array.isArray(doc?.applicationQuestions) && doc.applicationQuestions.length > 0;

/** Plain objects with their keys sorted, so two equal values serialise alike. */
const canonical = (value) =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner
  );

/**
 * The fields a seed gained after it was stored that a stored seed may take
 * without losing an edit: the official `applicationQuestions` when the
 * document has none, `scoring` when it has none, and `parentProgramId` when
 * the seed became additional to another program. Each is a whole value
 * the owner has never set (missing or empty), so filling it in cannot
 * overwrite anything; the field's own editor takes over from there.
 */
const BACKFILL_FIELDS = [
  ['applicationQuestions', (stored, seed) => hasQuestions(seed) && !hasQuestions(stored)],
  ['scoring', (stored, seed) => Boolean(seed.scoring) && !stored.scoring],
  // Absent, not falsy: the owner clearing "Additional to" stores an explicit
  // null, and that is an edit to keep, not a gap to fill (#881 review).
  [
    'parentProgramId',
    (stored, seed) => Boolean(seed.parentProgramId) && !('parentProgramId' in stored),
  ],
  // Absent, as for parentProgramId: the owner clearing it stores null.
  ['upkeep', (stored, seed) => Boolean(seed.upkeep) && !('upkeep' in stored)],
];

/**
 * Give a stored seed (`seeded: true`, the id in DEFAULT_PROGRAMS, listed so
 * not soft-deleted) the fields the seed gained since it was stored, when the
 * document has none of its own: one patch per program that needs it, on the
 * stored ETag where the store exposes one. Nothing else on the document is
 * touched — requirements, description, enabled, order, membership and every
 * other field stay as the owner left them. A program the owner created, or a
 * seed already carrying its own value, is left alone.
 */
async function backfillSeedFields(ctx, rows) {
  const out = [];
  for (const stored of rows) {
    const patch = seedBackfillFor(stored, SEEDS_BY_ID.get(stored.id));
    if (!patch) {
      out.push(stored);
      continue;
    }
    const patched = await ctx.store.patchDoc(
      CONTAINER,
      stored.id,
      { ...patch, updatedAt: ctx.nowIso() },
      stored._etag ? { ifMatch: stored._etag } : {}
    );
    // Field names only: telemetry carries no document id (CodeRabbit on #1077).
    ctx.log.info?.(`[ambassador] seed backfill: ${Object.keys(patch).join(', ')}`);
    out.push(patched || { ...stored, ...patch });
  }
  return out;
}

/**
 * What a stored program should take from its seed: the BACKFILL_FIELDS it
 * has none of, as the patch to write, or null when there is nothing to do —
 * no seed for the id, a program the owner made (not `seeded`), or a seed
 * already carrying its own values. Pure, so the decision is testable alone.
 */
export function seedBackfillFor(stored, seed) {
  if (!seed || stored?.seeded !== true) return null;
  const patch = {};
  for (const [field, wanted] of BACKFILL_FIELDS) {
    if (wanted(stored, seed)) patch[field] = seed[field];
  }
  Object.assign(patch, revisionPatch(stored, seed));
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Once per revision (programs.js SUPERSEDED_SEED_VALUES): a field still
 * holding the value of any earlier seed above the stored revision was
 * never edited, so the current seed's value replaces it, and the stamp
 * keeps a later deliberate return to an old value from being corrected
 * again. Every step above the stored revision is read, not only the last,
 * so a row that missed a revision is still matched against what it holds
 * (CodeRabbit on #1304). The fields to replace and the new stamp, or {}.
 */
function revisionPatch(stored, seed) {
  const history = SUPERSEDED_SEED_VALUES[seed.id]?.revisions || [];
  const storedRevision = Number(stored.seedRevision) || 1;
  const target = currentSeedRevision(seed.id);
  if (history.length === 0 || storedRevision >= target) return {};
  const missed = history.filter((step) => step.revision > storedRevision);
  const patch = {};
  for (const field of new Set(missed.flatMap((step) => Object.keys(step.fields)))) {
    if (stillHoldsOldSeed(field, stored, seed, missed)) patch[field] = seed[field];
  }
  patch.seedRevision = target;
  return patch;
}

/** Does the stored field still hold a value one of the missed revisions replaced? */
function stillHoldsOldSeed(field, stored, seed, missed) {
  if (!(field in seed) || !(field in stored)) return false;
  const held = canonical(stored[field]);
  return missed.some((step) => field in step.fields && canonical(step.fields[field]) === held);
}

/** Every program, the seeds filled in on every read, in display order. */
export async function listOrSeedPrograms(ctx) {
  const programs = await ensureSeededPrograms(ctx, await ctx.listKind('program'));
  return programs.sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name))
  );
}
