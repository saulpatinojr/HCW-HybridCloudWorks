/**
 * The shared vocabulary of the Learn catalogue updater (moved out of
 * update-applied-skills.mjs by #1845): the lifecycle order and rule 3 that
 * keeps it moving forward, the title, slug and URL normalisers both
 * catalogues key on, the APL- code maker, and the duplicate-code check.
 * Pure; update-applied-skills.mjs re-exports the parts its test reads.
 */

const learnBaseUrl = 'https://learn.microsoft.com/en-us';

/**
 * The lifecycle, in the only order it may move. A source that places an
 * entry earlier than the file does is stale, not news.
 */
export const LIFECYCLE_RANK = Object.freeze({ beta: 0, active: 1, expiring: 2, retired: 3 });

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
  const keepFile = { status: fileStatus || 'active', ...expiryField(existing.expiryDate) };

  if (!fileStatus) {
    return { status: sourceStatus || 'active', ...expiryField(sourced.expiryDate) };
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
    ...expiryField(sourced.expiryDate || existing.expiryDate),
  };
}

/** `{ expiryDate }` when there is a date, and nothing when there is not. */
function expiryField(expiryDate) {
  return expiryDate ? { expiryDate } : {};
}

export function stripMicrosoftPrefix(title) {
  return title.replace(/^Microsoft Applied Skills:\s*/i, '').trim();
}

export function slugFromUrl(url) {
  return url.split('/').filter(Boolean).pop();
}

export function normalizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${learnBaseUrl}${url.startsWith('/') ? url : `/${url}`}`;
}

export function normalizeTitle(title) {
  return stripMicrosoftPrefix(title)
    .replace(/^Microsoft Certified:\s*/i, '')
    .replace(/^Microsoft 365 Certified:\s*/i, '')
    .replace(/^GitHub Certified:\s*/i, 'GitHub ')
    .replace(/\s+Certification\b/gi, '')
    .replace(/\s+\(beta\)/gi, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function makeCode(slug, usedCodes) {
  const words = slug
    .replace(/microsoft|azure|using|with|and|for|the|by|in|to|of/g, '')
    .split('-')
    .filter(Boolean);
  const acronym = words
    .slice(0, 5)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  let code = `APL-${acronym || 'SKILL'}`;
  let suffix = 2;
  while (usedCodes.has(code)) {
    code = `APL-${acronym || 'SKILL'}${suffix}`;
    suffix += 1;
  }
  usedCodes.add(code);
  return code;
}

export function assertUniqueCodes(items, label) {
  const seen = new Set();
  const seenOfficial = new Set();
  const duplicates = [];
  const officialDuplicates = [];
  for (const item of items) {
    if (!item.code) throw new Error(`${label} item is missing code: ${item.title}`);
    if (seen.has(item.code)) duplicates.push(item.code);
    seen.add(item.code);
    if (item.officialCode) {
      if (seenOfficial.has(item.officialCode)) officialDuplicates.push(item.officialCode);
      seenOfficial.add(item.officialCode);
    }
  }
  if (duplicates.length) {
    throw new Error(`${label} duplicate codes: ${duplicates.join(', ')}`);
  }
  if (officialDuplicates.length) {
    throw new Error(`${label} duplicate official codes: ${officialDuplicates.join(', ')}`);
  }
}
