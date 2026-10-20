/**
 * Ambassador — programs, applications, evidence and readiness (ADR 0033 §4,
 * the Spotlight slice). One Cosmos container, `ambassador`, partitioned on
 * `/id`, with three document kinds told apart by `docType`:
 *
 *   program      a community program (Microsoft MVP, AWS Hero, …) with its
 *                requirements[]; seeded on first read, editable, disable-able
 *   application  one pursuit of one program, with a status machine, the
 *                responses, files, decision dates and a history of every
 *                status change; private by default and never published
 *   evidence     one thing that happened (a talk, a cert, an article) that an
 *                application can point at, linked to its source module by
 *                {sourceModule, sourceId} and carrying a snapshot of what the
 *                source said at link time
 *
 * Everything here exists to culminate in a credible application, which is
 * why readiness explains how it was computed and never promises acceptance:
 * the programs decide, and their published criteria change.
 *
 * Soft deletes everywhere (`softDeletedAt`); audit rows to admin_audit_logs
 * in the shape admin-crud.js writes. Roles: editor reads and writes,
 * publisher deletes, super_admin changes program settings (roles.js).
 *
 * UNTIL `terraform apply` CREATES THE CONTAINER the API answers 503
 * `{ code: 'NOT_PROVISIONED' }` (ADR 0033 §6 item 4) and nothing else
 * breaks; the hub renders that state with the owner's plan command.
 *
 * This module is the public surface; the parts live under ./ambassador/ —
 * model (the container, the status machine, dates and URLs), programs (the
 * seeds), validate (one schema per kind), readiness (the arithmetic),
 * import-readers (how a source document becomes evidence) and handlers (the
 * routes). Importers and the test read everything from here.
 */
export {
  APPLICATION_STATUSES,
  APPLICATION_TRANSITIONS,
  CONTAINER,
  EVIDENCE_SOURCES,
  NOT_PROVISIONED,
  QUESTION_KINDS,
  SCORING_UNITS,
  UNLOCKING_MEMBERSHIP,
  VERIFICATION_STATUSES,
  canTransition,
  isHttpUrl,
  programGate,
  toCalendarDate,
} from './ambassador/model.js';
export {
  DEFAULT_PROGRAMS,
  SUPERSEDED_SEED_VALUES,
  currentSeedRevision,
} from './ambassador/programs.js';
export { validateApplication, validateEvidence, validateProgram } from './ambassador/validate.js';
export {
  computeReadiness,
  evidenceRelevant,
  parsePeriod,
  readinessUnit,
} from './ambassador/readiness.js';
export {
  CSV_IMPORT_MAX_CHARS,
  CSV_READERS,
  IMPORT_READERS,
  SKIP_REASONS,
  csvDate,
  mctClassesToEvidence,
  parseCsv,
} from './ambassador/import-readers.js';
export { importedEvidenceId } from './ambassador/evidence.js';
export { ensureSeededPrograms, seedBackfillFor } from './ambassador/steps.js';
export { createAmbassadorHandlers, isNotProvisioned } from './ambassador/handlers.js';
