/**
 * The rules that turn a catalogue row and "today" into the status a page
 * shows, and the words on its badge. Split out of certStatus.js, which
 * re-exports everything here; see its header for why the status is worked
 * out from dates at render time.
 */
import { formatIsoDate, isIsoDate, isPastDate, todayIso } from './certDates';

// `upcoming` is a version a vendor has announced but nobody can sit yet (AWS
// SAP-C03 before 2026-11-17); it becomes `active` on its `availableDate`.
export const CERT_STATUSES = Object.freeze(['active', 'beta', 'upcoming', 'expiring', 'retired']);
/**
 * Rule 2 of `deriveStatus`: the status a row re-read ahead of its vendor's
 * day still shows on `today`, or null when the rule does not apply. Every date
 * must be a real calendar day, `today` included, or nothing is held.
 *
 * @param {{statusReadDate?: string, expiryDate?: string, availableDate?: string}} cert
 * @param {string} stored the row's status, already defaulted to `active`
 * @param {string} today `YYYY-MM-DD`
 * @returns {'expiring'|'upcoming'|null}
 */
function statusBeforeVendorDay(cert, stored, today) {
  const readOn = cert.statusReadDate;
  if (!isIsoDate(readOn) || !isIsoDate(today)) return null;
  const { expiryDate, availableDate } = cert;
  // The last day to test is the expiryDate itself, so a read on it is ahead.
  if (stored === 'retired' && isIsoDate(expiryDate) && readOn <= expiryDate) {
    return today <= expiryDate ? 'expiring' : null;
  }
  if (stored === 'active' && isIsoDate(availableDate) && readOn < availableDate) {
    return today < availableDate ? 'upcoming' : null;
  }
  return null;
}

/**
 * The status to render for a certification (or applied skill) on `today`.
 *
 * Rules, in order:
 *   1. `expiryDate` before today → `retired`, whatever the stored status says.
 *   2. A status re-read ahead of the vendor's day waits for that day (#1091).
 *      A row whose `statusReadDate` is before its day: stored `retired` with
 *      an `expiryDate` not yet passed → `expiring`; stored `active` with an
 *      `availableDate` still ahead → `upcoming`. The alarm in
 *      `findStaleStatuses` fires the day a stored status is overtaken by its
 *      own dates, and the re-read it asks for used to be unrecordable before
 *      then without the badge moving early. Now the re-read lands any time in
 *      the warning window and the badge still turns on the vendor's day.
 *      `statusReadDate` is what tells such a row from one stored after its
 *      day (AZ-800, `retired` once 2026-09-30 had passed): that one stays
 *      `retired` on every clock, including the earliest `DATA_AS_OF` the
 *      education index pre-renders with. Only these two dates: an `active`
 *      row reads neither `gaDate` nor `betaEndDate`, because several carry
 *      beta dates Microsoft gave only as months (the header of
 *      src/data/azure/certifications.js).
 *   3. Stored `beta` whose `gaDate` is today or earlier → `active`. Stored
 *      `beta` whose `betaEndDate` is before today → `active`, unless the row
 *      says `betaClosesBeforeGa: true`, in which case → `upcoming` (until its
 *      `gaDate`, if one is published). Microsoft's betas go live the moment
 *      the beta ends; Google's close a window and open GA later ("You can pass
 *      the beta or GA certification", with beta results 4-6 weeks after the
 *      windows close), so a closed Google beta is not something a visitor can
 *      book yet.
 *   4. Stored `upcoming` whose `availableDate` is today or earlier → `active`.
 *   5. Stored `active` with an `expiryDate` still ahead → `expiring`, because
 *      a published retirement date is what "expiring" means.
 *   6. Otherwise the stored status (`active` when absent).
 *
 * @param {{status?: string, expiryDate?: string, betaEndDate?: string, betaClosesBeforeGa?: boolean, gaDate?: string, availableDate?: string, statusReadDate?: string}} cert
 * @param {string} [today] `YYYY-MM-DD`; defaults to the local date
 * @returns {'active'|'beta'|'upcoming'|'expiring'|'retired'}
 */
export function deriveStatus(cert, today = todayIso()) {
  const stored = CERT_STATUSES.includes(cert?.status) ? cert.status : 'active';
  if (!cert) return stored;

  if (isPastDate(cert.expiryDate, today)) return 'retired';

  return statusBeforeVendorDay(cert, stored, today) || statusAfterDates(cert, stored, today);
}

// Every date that decides a status goes through isIsoDate, not the shape
// regex: an impossible day such as 2026-02-30 must not flip anything.
const reachedBy = (iso, today) => isIsoDate(iso) && isIsoDate(today) && iso <= today;

/** Steps 3 to 6 of `deriveStatus`, once retirement and the held cases are ruled out. */
function statusAfterDates(cert, stored, today) {
  if (stored === 'beta') return betaStatus(cert, today);

  if (stored === 'upcoming') {
    return reachedBy(cert.availableDate, today) ? 'active' : 'upcoming';
  }

  if (stored === 'active' && isIsoDate(cert.expiryDate)) {
    return 'expiring';
  }

  return stored;
}

function betaStatus(cert, today) {
  if (reachedBy(cert.gaDate, today)) return 'active';
  if (isPastDate(cert.betaEndDate, today)) {
    return cert.betaClosesBeforeGa === true ? 'upcoming' : 'active';
  }
  return 'beta';
}

/**
 * What a status badge should say for a row on `today`.
 *
 * `label` is the short word on the badge and `detail` the date phrase beside
 * it; both are `null` for an active exam so a caller can render nothing.
 * Dates are printed with `formatIsoDate`, never a local `new Date(iso)`.
 *
 * @param {object} cert
 * @param {string} [today] `YYYY-MM-DD`; defaults to the local date
 * @returns {{status: string, label: string|null, detail: string|null}}
 */
export function describeCertStatus(cert, today = todayIso()) {
  const status = deriveStatus(cert, today);
  const badge = BADGES[status];
  return badge
    ? { status, label: badge.label, detail: badge.detail(cert, today) }
    : { status, label: null, detail: null };
}

/** ` · replaced by CODE`, or '' for a row that names no replacement. */
const replacedBy = (cert) =>
  cert?.replacement?.code ? ` · replaced by ${cert.replacement.code}` : '';

/**
 * The badge word and date phrase for each status that has one. `active` has
 * neither, so a caller renders nothing. One small function per status keeps
 * `describeCertStatus` a single lookup.
 */
const BADGES = Object.freeze({
  expiring: {
    label: 'Retiring',
    detail: (cert) => `last day to test ${formatIsoDate(cert.expiryDate)}${replacedBy(cert)}`,
  },
  retired: {
    label: 'Retired',
    detail: (cert) => {
      const on = cert.retiredDate ?? cert.expiryDate;
      const text = `${isIsoDate(on) ? formatIsoDate(on) : ''}${replacedBy(cert)}`;
      return text.replace(/^ · /, '') || null;
    },
  },
  beta: { label: 'Beta', detail: betaDetail },
  upcoming: { label: 'Coming', detail: upcomingDetail },
});

/** A beta not yet open says when it opens; an open one, its GA date if known. */
function betaDetail(cert, today) {
  if (isIsoDate(cert.betaStartDate) && cert.betaStartDate > today) {
    return `from ${formatIsoDate(cert.betaStartDate)}`;
  }
  return isIsoDate(cert.gaDate) ? `GA ${formatIsoDate(cert.gaDate)}` : null;
}

/**
 * The date phrase beside a "Coming" badge: the first available day when one
 * is published; for a beta whose window closed ahead of GA (rule 2 in
 * `deriveStatus`), that it closed and when GA is, if known; otherwise none.
 */
function upcomingDetail(cert) {
  if (isIsoDate(cert.availableDate)) return `available ${formatIsoDate(cert.availableDate)}`;
  if (cert.status !== 'beta') return null;
  return isIsoDate(cert.gaDate)
    ? `beta closed · GA ${formatIsoDate(cert.gaDate)}`
    : 'beta closed · GA date not announced';
}
