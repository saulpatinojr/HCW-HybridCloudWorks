/**
 * The three rules of the Learn catalogue updater (the sync date, a source
 * that fails, lifecycle only moving forward) and the summary it prints.
 * Split out of update-applied-skills.mjs, which explains the rules in its
 * header and re-exports everything here.
 */

/**
 * The lifecycle, in the only order it may move. A source that places an
 * entry earlier than the file does is stale, not news.
 */
export const LIFECYCLE_RANK = Object.freeze({ beta: 0, active: 1, expiring: 2, retired: 3 });

/**
 * Exam codes this catalogue must not carry, because another one owns them.
 *
 * GitHub certification moved onto Microsoft Learn, so GH-100, GH-200, GH-300,
 * GH-500, GH-600 and GH-900 are on the Microsoft Certifications poster and in
 * the Learn browse API. Both are this script's sources, so it added all six to
 * the Azure catalogue — where they duplicated
 * `src/data/github/certifications.js` and contradicted it: four of the six
 * disagreed about the level, and GH-200 rendered as Fundamentals under Azure
 * and Associate under GitHub on the same /education screen.
 *
 * The owner decided on 2026-09-11 that the GitHub catalogue owns them (issue
 * #496); PR #507 implemented the removal. The first dispatch of the refreshed
 * workflow (run 34627119281, the same day) put all six straight back, because
 * a decision recorded in a file header is invisible to a script. THAT is what
 * this constant is for: the Monday cron is the thing that has to know, not the
 * reader of the file it writes.
 *
 * A PREFIX, not the six codes. GitHub adding a GH-700 would recreate the
 * duplication exactly, and it belongs to /github/education for the same
 * reason the six do. The Azure `LEVEL_META` has no Professional rung, so a
 * GitHub exam cannot even be stated truthfully here.
 *
 * Skipped entries are reported in the summary rather than dropped silently —
 * a source offering something this catalogue refuses is worth a line in the
 * pull request, or the next person wonders why the poster and the file differ.
 */
export const FOREIGN_CODE_PATTERN = /^GH-\d+$/;

/** Which catalogue owns a code this one refuses, for the summary line. */
export function foreignOwnerFor(code) {
  return FOREIGN_CODE_PATTERN.test(String(code)) ? 'src/data/github/certifications.js' : null;
}

/** A source that cannot be read. Its message is the whole report. */
export class SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SourceError';
  }
}

/** `YYYY-MM-DD` on the UTC calendar — the workflow runs on a UTC runner. */
export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Rule 2. Zero items from a source that answered is as much a failure as no
 * answer: the browse API returning `{ count: 0 }` would otherwise write an
 * empty catalogue, and nothing downstream would notice until the page did.
 */
export function assertSourceItems(label, items, url) {
  const count = Array.isArray(items) ? items.length : String(items || '').trim().length;
  if (count > 0) return items;
  throw new SourceError(
    `The ${label} (${url}) was fetched but parsed to zero items, so the catalogue was not written.`
  );
}

/**
 * Rule 1. Both markers must be present: the header line is what a reader
 * sees first and `DATA_AS_OF` is what the page renders, and they must agree.
 */
export function stampSyncDate(source, today) {
  const headerRe = /^\/\/ Last manual sync: \d{4}-\d{2}-\d{2}$/m;
  const constRe = /^export const DATA_AS_OF = '\d{4}-\d{2}-\d{2}';$/m;
  if (!headerRe.test(source) || !constRe.test(source)) {
    throw new Error(
      'certifications.js no longer carries both the "// Last manual sync: YYYY-MM-DD" header ' +
        'line and the "export const DATA_AS_OF = \'YYYY-MM-DD\';" constant, so the sync date ' +
        'could not be stamped.'
    );
  }
  return source
    .replace(headerRe, `// Last manual sync: ${today}`)
    .replace(constRe, `export const DATA_AS_OF = '${today}';`);
}

/**
 * Rule 3. `existing` is the entry as the file has it; `sourced` is what the
 * sources say today, where `status` may be undefined when the source has no
 * opinion (the certification sources say "(beta)" or nothing; they never
 * announce a retirement). Returns the `{ status, expiryDate }` to write and
 * pushes one line per disagreement onto `report`.
 */
export function reconcileLifecycle({ existing = {}, sourced = {}, label, report = [] }) {
  const fileStatus = existing.status in LIFECYCLE_RANK ? existing.status : undefined;
  const sourceStatus = sourced.status in LIFECYCLE_RANK ? sourced.status : undefined;
  const keepFile = {
    status: fileStatus || 'active',
    ...(existing.expiryDate ? { expiryDate: existing.expiryDate } : {}),
  };

  if (!fileStatus) {
    return {
      status: sourceStatus || 'active',
      ...(sourced.expiryDate ? { expiryDate: sourced.expiryDate } : {}),
    };
  }

  if (sourceStatus && LIFECYCLE_RANK[sourceStatus] < LIFECYCLE_RANK[fileStatus]) {
    const when = existing.expiryDate ? ` (${existing.expiryDate})` : '';
    report.push(
      `${label}: the source says '${sourceStatus}' but the file says '${fileStatus}'${when}; kept the file's value.`
    );
    return keepFile;
  }

  if (existing.expiryDate && sourced.expiryDate && existing.expiryDate !== sourced.expiryDate) {
    report.push(
      `${label}: the source gives retirement date ${sourced.expiryDate} but the file has ${existing.expiryDate}; kept the file's value.`
    );
    return keepFile;
  }

  return {
    status: sourceStatus || fileStatus,
    ...(sourced.expiryDate || existing.expiryDate
      ? { expiryDate: sourced.expiryDate || existing.expiryDate }
      : {}),
  };
}

/**
 * The lines a pull request body needs: what was added, what changed status
 * or date, what the sources no longer list, and where they disagreed with
 * the file. Keyed on `code` because ids and slugs are derived from it.
 */
export function summarizeChanges({
  before,
  after,
  today,
  kept = [],
  disagreements = [],
  unverified = [],
  foreign = [],
}) {
  const lines = [];
  const section = (title, items) => {
    if (!items.length) return;
    lines.push(`### ${title}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };

  const diffList = (label, prev, next) => {
    const prevByCode = new Map(prev.map((e) => [e.code, e]));
    const nextByCode = new Map(next.map((e) => [e.code, e]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [code, entry] of nextByCode) {
      const old = prevByCode.get(code);
      if (!old) {
        added.push(`${code} — ${entry.title} (${entry.status})`);
        continue;
      }
      const deltas = [];
      for (const field of ['status', 'expiryDate', 'betaEndDate', 'gaDate', 'title', 'level']) {
        if ((old[field] ?? null) !== (entry[field] ?? null)) {
          deltas.push(`${field} ${old[field] ?? '—'} → ${entry[field] ?? '—'}`);
        }
      }
      if (deltas.length) changed.push(`${code}: ${deltas.join(', ')}`);
    }
    for (const [code, entry] of prevByCode) {
      if (!nextByCode.has(code)) removed.push(`${code} — ${entry.title}`);
    }
    section(`${label} added`, added);
    section(`${label} changed`, changed);
    section(`${label} removed`, removed);
    return added.length + changed.length + removed.length;
  };

  lines.push(`Catalogue checked against Microsoft Learn on ${today}.`, '');
  const certCount = diffList('Certifications', before.certifications, after.certifications);
  const skillCount = diffList('Applied Skills', before.appliedSkills, after.appliedSkills);
  if (certCount + skillCount === 0) {
    lines.push('No entry changed; only the sync date moved.', '');
  }
  section('Kept from the file (absent from the current sources)', kept);
  section('Source disagreed with the file (file kept)', disagreements);
  section('On the poster but in neither the Learn catalogue nor the file (not added)', unverified);
  section('Refused because another catalogue owns the exam (#496)', foreign);
  return lines.join('\n').trimEnd() + '\n';
}
