/**
 * archive-progress.js — what the admin card shows about the yearly content
 * archive: the newest finished archive, and a run in progress (ADR 0046,
 * issue #1811). Re-exported by archive-job.js.
 */
import { archiveManifestName } from './archive-report.js';
import { ARCHIVE_TIER, archiveNames, count, isLate, noteMatches, validRun } from './archive-run-notes.js';

const textOrNull = (value) => (typeof value === 'string' ? value : null);

/**
 * The newest finished archive and the run in progress, for the Archive card.
 * Numbers, dates and container names only.
 *
 * @param {object} deps
 * @param {object} deps.backupBlobs
 * @param {object} deps.archiveBlobs
 * @param {number} deps.year - the year an archive taken today would be of
 * @param {boolean|null} deps.archived - whether that year's manifest exists
 * @param {Date} [deps.now]
 * @returns {Promise<{ lastArchive: object|null, run: object|null }>}
 */
export async function readArchiveProgress({ backupBlobs, archiveBlobs, year, archived, now = new Date() }) {
  const files = await archiveBlobs.listDetails('');
  const lastArchive = await readLastArchive(archiveBlobs, files);
  const run = archived === false ? await readRunInProgress({ backupBlobs, year, files, now }) : null;
  return { lastArchive, run };
}

/** The newest year that has a manifest, summed up; null when there is none. */
async function readLastArchive(archiveBlobs, files) {
  const years = files
    .map((file) => /^(\d{4})\/manifest\.json$/.exec(file.name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
  if (!years.length) return null;
  const newest = years[0];
  const manifest = (await archiveBlobs.readJson(archiveManifestName(newest))) || {};
  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  const tiers = new Map(files.map((file) => [file.name, file.tier]));
  return {
    year: newest,
    createdAt: textOrNull(manifest.createdAt),
    sourceRun: textOrNull(manifest.sourceBackup?.runId),
    containers: listed.length,
    records: count(manifest.totals?.records),
    bytes: count(manifest.totals?.bytes),
    // How many of its files are offline in the Archive tier, and how many are missing.
    inArchiveTier: listed.filter((file) => tiers.get(file?.name) === ARCHIVE_TIER).length,
    missingFiles: listed.filter((file) => !tiers.has(file?.name)).length,
  };
}

/** The pinned run of the year and what it still misses; null when there is no valid one. */
async function readRunInProgress({ backupBlobs, year, files, now }) {
  const pinned = await backupBlobs.readJson(archiveNames(year).run);
  if (!validRun(pinned, year)) return null;
  const missing = [];
  const mine = new Set();
  for (const container of pinned.containers) {
    const names = archiveNames(year, container);
    mine.add(names.data);
    const note = await backupBlobs.readJson(names.note);
    if (!noteMatches(note, pinned, container)) missing.push(container);
  }
  const prefix = archiveNames(year).dataPrefix;
  return {
    year,
    // Files in the year's folder that this run's list does not name. While there is one, the archive cannot finish.
    unlistedFiles: files.filter((file) => file.name.startsWith(prefix) && !mine.has(file.name)).length,
    startedAt: textOrNull(pinned.startedAt),
    sourceRun: pinned.backup.runId,
    expected: pinned.containers.length,
    done: pinned.containers.length - missing.length,
    // Container names only; they are this repository's own names.
    missing,
    late: isLate(pinned.startedAt, new Date(now).getTime()),
  };
}
