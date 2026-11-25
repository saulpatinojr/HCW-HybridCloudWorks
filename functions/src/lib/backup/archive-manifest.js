/**
 * archive-manifest.js — the last two steps of a yearly content archive:
 * write the year's `manifest.json`, then move the data files to the Archive
 * tier (ADR 0046 section 4, issue #1811). The whole job is described in
 * archive-job.js.
 *
 * Every function takes the worker's `deps` first:
 * `{ backupBlobs, archiveBlobs, env, now, log, notifier }` (see
 * createArchiveWorker in archive-worker.js).
 */
import { archivePlan } from './archive-classification.js';
import {
  ARCHIVE_NOTIFY_SOURCES,
  ARCHIVE_TIER,
  MANIFEST_FORMAT,
  archiveNames,
  count,
  noteMatches,
  switchOn,
  validRun,
} from './archive-run-notes.js';

const notWritten = (reason, extra = {}) => ({ written: false, reason, ...extra });

/**
 * Write the year's `manifest.json` if every container's file is written
 * and checked and nobody has written it yet, then move the files to the
 * Archive tier. Create-only, so two jobs finishing together cannot both
 * write it. Nothing is moved to the Archive tier before the manifest
 * exists.
 */
export async function completeIfLast(deps, { year }) {
  const { archiveBlobs, now, log, notifier } = deps;
  const names = archiveNames(year);
  const ready = await manifestReadiness(deps, year, names);
  if (ready.refusal) return ready.refusal;
  const { run, notes } = ready;

  const files = notes.map((note) => manifestFile(year, note));
  const manifest = {
    format: MANIFEST_FORMAT,
    year,
    createdAt: now().toISOString(),
    startedAt: run.startedAt || null,
    sourceBackup: { mode: 'full', runId: run.backup.runId },
    fileFormat: 'gzip-compressed NDJSON: one record per line as JSON',
    sha256Of: 'the bytes of each file as stored (compressed)',
    totals: manifestTotals(files),
    files,
    // Containers the list says to archive that the backup did not hold.
    notInBackup: Array.isArray(run.notInBackup) ? run.notInBackup : [],
  };
  const won = await archiveBlobs.putJson(names.manifest, manifest, { overwrite: false });
  if (!won) return notWritten('lost-race');
  log.log?.(
    `[contentArchive] archive of ${year} written: ${files.length} files, ${manifest.totals.records} records, ${manifest.totals.bytes} bytes gzip`
  );
  const tiering = await moveToArchiveTier(deps, { year });
  await notifier
    ?.notifyTelegram({
      title: `Content archive of ${year} written`,
      message: `The yearly archive of ${year} is written: ${files.length} files, ${manifest.totals.records} records, ${manifest.totals.bytes} bytes. ${tiering.moved + tiering.alreadyArchived} of ${tiering.files} files are in the Archive tier. The next step is the read-back check in the content archive runbook.`,
      severity: 'info',
      source: ARCHIVE_NOTIFY_SOURCES.written,
    })
    ?.catch?.(() => {});
  return { written: true, tiering };
}

/**
 * Everything that must hold before a manifest is written. Returns
 * `{ refusal }` with the answer completeIfLast gives when something does not,
 * otherwise `{ run, notes }`.
 */
async function manifestReadiness(deps, year, names) {
  const pinned = await pinnedRunFor(deps, year, names);
  if (pinned.refusal) return pinned;
  const notes = await checkedNotes(deps, year, pinned.run);
  if (!notes) return { refusal: notWritten('incomplete') };
  const filesProblem = await filesRefusal(deps, year, names, notes);
  if (filesProblem) return { refusal: filesProblem };
  return { run: pinned.run, notes };
}

/** The pinned run, if a manifest may be written for it: `{ run }` or `{ refusal }`. */
async function pinnedRunFor({ backupBlobs, archiveBlobs, env }, year, names) {
  // The switch is asked again here: a manifest is never written once the owner has switched the archive off.
  if (!switchOn(env)) return { refusal: notWritten('switch-off') };
  const run = await backupBlobs.readJson(names.run);
  // `validRun` also refuses a run pinned under other rules than today's.
  if (!validRun(run, year) || !run.containers.length) return { refusal: notWritten('no-run') };
  if ((await archiveBlobs.readJson(names.manifest)) !== null) return { refusal: notWritten('exists') };
  // The keep list is asked again, by name: a manifest never names a
  // container the list does not archive today, whatever the run says.
  const plan = archivePlan();
  if (!run.containers.every((container) => plan.includes(container))) return { refusal: notWritten('not-in-plan') };
  return { run };
}

/** Each container's note, in the run's order, or null as soon as one is missing or does not match. */
async function checkedNotes({ backupBlobs }, year, run) {
  const notes = [];
  for (const container of run.containers) {
    const note = await backupBlobs.readJson(archiveNames(year, container).note);
    if (!noteMatches(note, run, container)) return null;
    notes.push(note);
  }
  return notes;
}

/** Why the files in storage do not allow a manifest, or null when they do. */
async function filesRefusal({ archiveBlobs }, year, names, notes) {
  // Each file must still be there, in the very version that was checked.
  const listed = await archiveBlobs.listDetails(names.dataPrefix);
  const stamps = new Map(listed.map((file) => [file.name, file.etag]));
  const wanted = new Set(notes.map((note) => archiveNames(year, note.container).data));
  const changed = notes.some((note) => stamps.get(archiveNames(year, note.container).data) !== note.etag);
  if (changed) return notWritten('file-missing');
  // And nothing else may be in the year's folder. A file the manifest
  // would not name is one written under earlier rules (a container that
  // has since left the list): it must not sit in a finished archive
  // unlisted. Nothing here deletes it; the owner clears it by hand.
  const unlisted = listed.filter((file) => !wanted.has(file.name)).length;
  if (unlisted > 0) return notWritten('unlisted-file', { unlisted });
  return null;
}

/** One file's row in the manifest, from its note. */
function manifestFile(year, note) {
  return {
    name: archiveNames(year, note.container).data,
    container: note.container,
    // 'archive': every field kept. 'archive-changed': only listed fields or records.
    decision: note.decision,
    records: count(note.records),
    bytes: count(note.bytes),
    sha256: note.sha256,
    recordsInBackup: count(note.read),
    recordsLeftOut: count(note.leftOut),
    leftOutBy: note.leftOutBy || {},
    recordsWithFieldsRemoved: count(note.changed),
    // Names the classification itself writes, never a name read from a record.
    fieldsRemoved: Object.keys(note.removed || {}).sort(),
  };
}

function manifestTotals(files) {
  return {
    files: files.length,
    records: files.reduce((n, file) => n + file.records, 0),
    bytes: files.reduce((n, file) => n + file.bytes, 0),
    recordsLeftOut: files.reduce((n, file) => n + file.recordsLeftOut, 0),
  };
}

/**
 * Move every data file the year's manifest names to the Archive tier.
 * Does nothing without a manifest: a file is never taken offline before it
 * has been checked and listed. Safe to call again: a file already there is
 * left alone, and one that failed is tried again by the next daily check.
 */
export async function moveToArchiveTier({ archiveBlobs, log }, { year }) {
  const names = archiveNames(year);
  const manifest = await archiveBlobs.readJson(names.manifest);
  const listed = Array.isArray(manifest?.files) ? manifest.files : null;
  const result = { files: listed ? listed.length : 0, moved: 0, alreadyArchived: 0, failed: 0, missing: 0 };
  if (!listed) return { ...result, reason: 'no-manifest' };
  const tiers = new Map((await archiveBlobs.listDetails(names.dataPrefix)).map((file) => [file.name, file.tier]));
  for (const file of listed) {
    const outcome = await tierOne(archiveBlobs, file, tiers, names.dataPrefix);
    result[outcome] += 1;
  }
  if (result.moved || result.failed || result.missing) {
    const say = result.failed || result.missing ? log.warn : log.log;
    say?.(
      `[contentArchive] archive tier for ${year}: ${result.moved} moved, ${result.alreadyArchived} already there, ${result.failed} failed, ${result.missing} missing`
    );
  }
  return result;
}

/** Move one listed file; answers which count it adds to. */
async function tierOne(archiveBlobs, file, tiers, dataPrefix) {
  const name = typeof file?.name === 'string' ? file.name : '';
  if (!name.startsWith(dataPrefix) || !tiers.has(name)) return 'missing';
  if (tiers.get(name) === ARCHIVE_TIER) return 'alreadyArchived';
  try {
    await archiveBlobs.setTier(name, ARCHIVE_TIER);
    return 'moved';
  } catch {
    return 'failed';
  }
}
