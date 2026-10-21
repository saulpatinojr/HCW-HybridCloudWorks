/**
 * Evidence routes (ADR 0033 §4): one thing that happened, manual or imported
 * from a source module with a snapshot of what the source said at link time.
 * Import is idempotent on (sourceModule, sourceId).
 */
import { createHash } from 'node:crypto';
import { CSV_IMPORT_MAX_CHARS, CSV_READERS, IMPORT_READERS } from './import-readers.js';
import { CONTAINER } from './model.js';
import { evidenceRelevant, inPeriod, parsePeriod } from './readiness.js';
import { KINDS, byDateDesc, json, loadCreate, stamped } from './steps.js';
import { str, stringList } from './fields.js';

/** `?key=` filters on the evidence list: the query key, its length cap, the predicate it makes. */
const EVIDENCE_FILTERS = [
  ['sourceModule', 40, (value) => (e) => e.sourceModule === value],
  ['programId', 200, (value) => (e) => evidenceRelevant(e, value)],
  ['verificationStatus', 20, (value) => (e) => (e.verificationStatus || 'unverified') === value],
  [
    'period',
    40,
    (value) => {
      const period = parsePeriod(value);
      return period ? (e) => inPeriod(e.date, period) : null;
    },
  ],
];

/** GET cms/ambassador/evidence?sourceModule=&programId=&verificationStatus=&period= */
export async function listEvidence(ctx, request) {
  let items = await ctx.listKind('evidence');
  for (const [key, max, predicateFor] of EVIDENCE_FILTERS) {
    const value = str(request.query?.get?.(key), max);
    const keep = value ? predicateFor(value) : null;
    if (keep) items = items.filter(keep);
  }
  items.sort(byDateDesc);
  return json(200, { success: true, items, total: items.length });
}
const evidenceDefaults = () => ({
  description: '',
  sourceId: null,
  snapshot: null,
  url: null,
  files: [],
  images: [],
  metrics: { reach: null, attendees: null, views: null, credits: null },
  technology: [],
  programIds: [],
  requirementId: null,
  qualificationPeriod: null,
  verificationStatus: 'unverified',
  notes: '',
  tags: [],
});

/** POST cms/ambassador/evidence — manual evidence. */
export async function createEvidence(ctx, request, auth) {
  const loaded = await loadCreate(ctx, request, KINDS.evidence);
  if (loaded.error) return loaded.error;
  const doc = stamped(ctx, KINDS.evidence, { ...evidenceDefaults(), ...loaded.value }, auth);
  await ctx.store.upsertDoc(CONTAINER, doc);
  await ctx.audit('ambassador_evidence_created', auth, request, {
    evidenceId: doc.id,
    sourceModule: doc.sourceModule,
  });
  return json(200, { success: true, id: doc.id, item: doc });
}

/**
 * The id an imported row is stored under: one per (sourceModule, sourceId),
 * so two imports racing for the same source document collide on the store
 * instead of each persisting a row. Rows imported before this carry a UUID
 * id and are still recognised by their (sourceModule, sourceId).
 */
export const importedEvidenceId = (sourceModule, sourceId) =>
  `evidence-import-${createHash('sha1').update(`${sourceModule}:${sourceId}`).digest('hex')}`;

function importedEvidence(ctx, { seed, programIds, sourceModule, sourceId, stamp }, auth) {
  const doc = stamped(
    ctx,
    KINDS.evidence,
    {
      description: '',
      files: [],
      images: [],
      technology: [],
      qualificationPeriod: null,
      verificationStatus: 'unverified',
      notes: '',
      tags: [],
      ...seed,
      programIds,
      snapshot: { ...seed.snapshot, capturedAt: stamp },
      sourceModule,
      sourceId,
    },
    auth
  );
  return { ...doc, id: importedEvidenceId(sourceModule, sourceId) };
}

/**
 * Persist an imported row atomically. A 409 means another import landed the
 * same (sourceModule, sourceId) first; that row, owner edits included, is
 * kept as it is. Answers the stored row, or null when one already existed.
 */
async function createImported(ctx, doc) {
  try {
    return (await ctx.store.createDoc(CONTAINER, doc)) || doc;
  } catch (error) {
    if (error?.code !== 409) throw error;
    return null;
  }
}

/** The rows already imported from one source, by sourceId — UUID-era rows and deterministic ones alike. */
async function importedBySource(ctx, sourceModule) {
  const current = (await ctx.listKind('evidence')).filter((e) => e.sourceModule === sourceModule);
  return new Map(current.map((e) => [String(e.sourceId), e]));
}

/**
 * Import every id from one source: a row already imported is reported as
 * `existing`, a source document that is gone as `missing`, the rest created.
 */
async function importFromSource(ctx, { reader, sourceModule, ids, programIds }, auth) {
  const bySource = await importedBySource(ctx, sourceModule);
  const created = [];
  const existing = [];
  const missing = [];
  const stamp = ctx.nowIso();
  for (const sourceId of ids) {
    const already = bySource.get(sourceId);
    if (already) {
      existing.push(already.id);
      continue;
    }
    const source = await ctx.store.readDoc(reader.container, sourceId, sourceId);
    if (!source) {
      missing.push(sourceId);
      continue;
    }
    const seed = reader.toEvidence(source);
    const doc = importedEvidence(ctx, { seed, programIds, sourceModule, sourceId, stamp }, auth);
    const stored = await createImported(ctx, doc);
    if (stored) {
      bySource.set(sourceId, stored);
      created.push(stored);
    } else existing.push(doc.id);
  }
  return { created, existing, missing };
}

const unknownSource = () =>
  json(400, { error: `sourceModule must be one of ${Object.keys(IMPORT_READERS).join(', ')}` });

const count = (n) => n.toLocaleString('en-US');

/** The JSON around a CSV at the limit (escaped line breaks and quotes) still fits; past this the body is refused as not an object. */
const IMPORT_BODY_MAX = 4 * CSV_IMPORT_MAX_CHARS;

/**
 * Import the rows of a pasted file: every seed the reader produces becomes
 * one evidence row under the reader's source, idempotent on the seed's
 * `sourceId`; rows the reader could not read are counted as `skipped`, by
 * reason in `skippedReasons`.
 */
async function importFromCsv(ctx, request, { reader, readerId, text, programIds }, auth) {
  const { sourceModule } = reader;
  const { items, skipped, reasons } = reader.toEvidence(text);
  if (items.length === 0 && skipped === 0)
    return json(400, { error: 'text holds no rows under a header line' });
  const bySource = await importedBySource(ctx, sourceModule);
  const created = [];
  const existing = [];
  const stamp = ctx.nowIso();
  for (const { sourceId, ...rest } of items) {
    const already = bySource.get(sourceId);
    if (already) {
      existing.push(already.id);
      continue;
    }
    const seed = { ...rest, tags: [readerId] };
    const doc = importedEvidence(ctx, { seed, programIds, sourceModule, sourceId, stamp }, auth);
    const stored = await createImported(ctx, doc);
    if (stored) {
      bySource.set(sourceId, stored);
      created.push(stored);
    } else existing.push(doc.id);
  }
  await ctx.audit('ambassador_evidence_imported', auth, request, {
    reader: readerId,
    created: created.length,
    existing: existing.length,
    skipped,
  });
  return json(200, {
    success: true,
    created,
    existing,
    missing: [],
    skipped,
    skippedReasons: reasons,
  });
}

/** The CSV text of an import body, or the 413 that names the limit when it is over. */
function csvText(body) {
  const raw = typeof body.text === 'string' ? body.text : '';
  if (raw.length > CSV_IMPORT_MAX_CHARS) {
    return {
      error: json(413, {
        error: `text is ${count(raw.length)} characters; the limit is ${count(CSV_IMPORT_MAX_CHARS)}. Split the export and import each part.`,
        limit: CSV_IMPORT_MAX_CHARS,
      }),
    };
  }
  return { text: raw.trim() };
}

/**
 * POST cms/ambassador/evidence/import — two shapes on one route:
 * `{ sourceModule, ids[] }` imports documents from a source module, one
 * evidence row each with a snapshot of what the source said now;
 * `{ reader, text }` imports the rows of a pasted CSV through a CSV_READERS
 * entry; a text over CSV_IMPORT_MAX_CHARS is a 413 naming the limit, never
 * a clipped import. Both take `programIds[]` and are idempotent on
 * (sourceModule, sourceId): a row already imported is reported as
 * `existing`, never duplicated, and a row is stored under an id derived
 * from that pair so two imports racing for it cannot both create one.
 */
export async function importEvidence(ctx, request, auth) {
  const body = await ctx.readBody(request, IMPORT_BODY_MAX);
  if (!body) return json(400, { error: 'Body must be a JSON object' });
  const readerId = str(body.reader, 40);
  if (readerId) {
    const reader = CSV_READERS[readerId];
    if (!reader)
      return json(400, { error: `reader must be one of ${Object.keys(CSV_READERS).join(', ')}` });
    const checked = csvText(body);
    if (checked.error) return checked.error;
    if (!checked.text) return json(400, { error: 'text is required' });
    const programIds = stringList(body.programIds);
    return importFromCsv(ctx, request, { reader, readerId, text: checked.text, programIds }, auth);
  }
  const sourceModule = str(body.sourceModule, 40);
  const reader = IMPORT_READERS[sourceModule];
  if (!reader) return unknownSource();
  const ids = stringList(body.ids, 200);
  if (ids.length === 0) return json(400, { error: 'ids must be a non-empty array' });
  const programIds = stringList(body.programIds);
  const result = await importFromSource(ctx, { reader, sourceModule, ids, programIds }, auth);
  await ctx.audit('ambassador_evidence_imported', auth, request, {
    sourceModule,
    created: result.created.length,
    existing: result.existing.length,
    missing: result.missing.length,
  });
  return json(200, { success: true, ...result });
}

/** GET cms/ambassador/evidence/sources/{sourceModule} — what the import picker lists, with what is already imported. */
export async function listImportSources(ctx, request) {
  const sourceModule = str(request.params?.sourceModule, 40);
  const reader = IMPORT_READERS[sourceModule];
  if (!reader) return unknownSource();
  const rows = await ctx.store.queryDocs(reader.container, reader.listQuery, []);
  const imported = new Set(
    (await ctx.listKind('evidence'))
      .filter((e) => e.sourceModule === sourceModule)
      .map((e) => String(e.sourceId))
  );
  const items = rows
    .map((row) => {
      const seed = reader.toEvidence(row);
      return {
        id: row.id,
        title: seed.title,
        date: seed.date,
        url: seed.url,
        imported: imported.has(String(row.id)),
      };
    })
    .sort(byDateDesc);
  return json(200, { success: true, items, total: items.length });
}
