/**
 * The pure rules behind the speaking widget (ADR 0033, Spotlight slice):
 * how a stored row is read, how Sessionize's list and the published snapshot
 * merge, how events sort and group into the About page's sections, and how a
 * location reads. No fetch and no React, so sessionizeEvents.test.js pins
 * each without a DOM. Dates, the upcoming rule and the id-then-name match are
 * lib/speakingEvents, shared with the admin hub.
 *
 * LOCATION DISPLAY FORMAT STANDARD
 * ================================
 * Every speaking engagement shows its location as:
 * - US cities: "City, State" (e.g. "Chicago, IL")
 * - other cities: "City, Country" (e.g. "Toronto, Canada")
 * - virtual events: "Virtual"
 * - bare coordinates: "lat, lng (GPS)"
 *
 * `formatLocationFromAddress` reads a Nominatim address into that form,
 * `normalizeLocationLabel` trims a free-text label to it, and
 * sessionizeGeocode.js turns coordinates and place names into addresses.
 */
import {
  getDateTimestamp,
  isTombstone,
  isUpcoming,
  matchStoredRow,
  parseDateValue,
} from '@/lib/speakingEvents';

// ── Coordinates ──────────────────────────────────────────────────────────────

/** The field pairs a stored coordinate object may use, in the order tried. */
const COORD_KEYS = [
  ['lat', 'lng'],
  ['latitude', 'longitude'],
  ['_lat', '_long'],
];

function coordsFromString(value) {
  const parts = value.split(',').map((s) => parseFloat(s.trim()));
  const pair = parts.length === 2 && parts.every(Number.isFinite);
  return pair ? { lat: parts[0], lng: parts[1] } : null;
}

function coordsFromObject(value) {
  const keys = COORD_KEYS.find(
    ([lat, lng]) => value[lat] !== undefined && value[lng] !== undefined
  );
  return keys ? { lat: Number(value[keys[0]]), lng: Number(value[keys[1]]) } : null;
}

/** `{ lat, lng }` from "lat, lng", `{ lat, lng }`, `{ latitude, longitude }` or a GeoPoint; null otherwise. */
export function parseCoords(value) {
  if (typeof value === 'string') return coordsFromString(value);
  if (value && typeof value === 'object') return coordsFromObject(value);
  return null;
}

// ── Location labels ──────────────────────────────────────────────────────────

const CITY_KEYS = [
  'city',
  'town',
  'village',
  'hamlet',
  'municipality',
  'suburb',
  'neighbourhood',
  'county',
];
const US_NAMES = /^(united states|united states of america|usa|us|u\.s\.|u\.s\.a\.)$/i;
const COORD_PAIR = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;

export const isVirtual = (text) => /^(virtual)$/i.test(text);

const firstOf = (address, keys) => keys.map((key) => address[key]).find(Boolean) || '';

/** "City, State" for the United States, "City, Country" elsewhere, from a Nominatim address. */
export function formatLocationFromAddress(address) {
  const city = firstOf(address, CITY_KEYS);
  const state = firstOf(address, ['state', 'region']);
  const country = address.country || '';
  const region = country === 'United States' ? state : country;
  return city && region ? `${city}, ${region}` : city || country;
}

/** "City, State, United States" → "City, State"; "City, Region, Country" → "City, Country". */
function shortenParts(parts) {
  const [city, state = ''] = parts;
  const last = parts.at(-1);
  if (!US_NAMES.test(last)) return `${city}, ${last}`;
  return parts.length >= 3 ? `${city}, ${state}` : city;
}

/** A free-text label in the display format; anything that is not a comma-separated place is left alone. */
export function normalizeLocationLabel(label) {
  if (typeof label !== 'string') return label;
  const trimmed = label.trim();
  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 || isVirtual(trimmed) || COORD_PAIR.test(trimmed)) return trimmed;
  return shortenParts(parts);
}

export function formatDateLabel(value) {
  const date = parseDateValue(value);
  if (!date) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Stored rows ──────────────────────────────────────────────────────────────

/** The first of `keys` the object carries a value for. */
function pick(obj, keys) {
  const key = keys.find((candidate) => obj[candidate] !== undefined);
  return key === undefined ? undefined : obj[key];
}

const lowerFirst = (key) =>
  key && typeof key === 'string' ? key.charAt(0).toLowerCase() + key.slice(1) : key;

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The object with every key's first letter lowered, so `Name` and `name` read the same. */
function normalizeObjectKeys(obj) {
  if (!isPlainObject(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [lowerFirst(key), value]));
}

/** The leading `YYYY-MM-DD` of a string, or the trimmed string when it has none. */
function leadingDay(text) {
  const trimmed = text.trim();
  const day = trimmed.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : trimmed;
}

/** A stored date as the widget keeps it: the plain day, or an ISO stamp for a Date-like value. */
function toDay(value) {
  if (!value) return undefined;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date || typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') return leadingDay(value);
  return undefined;
}

/** The stored image (populated from eventImageUrl by the importer), from any shape it was written in. */
function storedImageOf(imagesRaw) {
  const first = Array.isArray(imagesRaw) ? imagesRaw[0] : imagesRaw;
  if (typeof first === 'string') return first;
  return first?.downloadURL || first?.url || first?.src || null;
}

/** The raw external image URL, the fallback when the stored copy fails. */
const externalImageOf = (imageRaw) =>
  Array.isArray(imageRaw) ? imageRaw[0]?.downloadURL : imageRaw?.downloadURL || imageRaw;

const firstSlides = (sessions) => (Array.isArray(sessions) ? sessions[0]?.slidesUrl : null);

/** One snapshot row as the widget reads it, whichever spelling the row was written with. */
export function normalizeEvent(raw) {
  const row = normalizeObjectKeys(raw);
  const sessionizeId = pick(row, ['eventId', 'sessionizeId', 'SessionizeId', 'sessionize_id']);
  return {
    id: row.id || raw.id,
    sessionizeId: sessionizeId ? Number(sessionizeId) : null,
    name: (pick(row, ['eventName', 'name', 'Name']) || '').trim(),
    description: pick(row, ['description', 'Description']),
    date: toDay(pick(row, ['date', 'Date'])),
    location: pick(row, ['location', 'locationLabel']),
    location_coords: pick(row, ['locationCoords', 'coords', 'coordinates']),
    eventUrl: pick(row, ['eventUrl']),
    presentationUrl: pick(row, ['presentationUrl']) || firstSlides(row.sessions) || null,
    image: storedImageOf(pick(row, ['images', 'Images'])),
    eventImageUrl:
      externalImageOf(pick(row, ['eventImageUrl', 'imageUrl', 'eventImageURL'])) || null,
    isManualEntry: true,
    display: pick(row, ['display', 'Display']) === true,
  };
}

// ── Merging ──────────────────────────────────────────────────────────────────

const eventName = (event) => (event.name || event.title || '').trim();
const eventStart = (event) => event.startsAt || event.eventStartDate || null;
const eventSite = (event) => event.eventUrl || event.website || null;
const eventDate = (event) => event.date || event.startsAt;

/** The first value that is set, or null. */
const first = (...values) => values.find(Boolean) ?? null;

/** A Sessionize event with a stored row: the row wins on any field it has set; Sessionize fills the rest. */
export function mergeStoredRow(sessionizeEvent, storedRow) {
  const startsAt = eventStart(sessionizeEvent);
  return {
    id: sessionizeEvent.id || storedRow.id,
    name: storedRow.name || eventName(sessionizeEvent),
    startsAt,
    date: storedRow.date || startsAt,
    location: first(storedRow.location, sessionizeEvent.location),
    location_coords: storedRow.location_coords || null,
    description: first(storedRow.description, sessionizeEvent.description),
    eventUrl: storedRow.eventUrl || eventSite(sessionizeEvent),
    presentationUrl: first(storedRow.presentationUrl, storedRow.sessions?.[0]?.slidesUrl),
    image: storedRow.image || null,
    eventImageUrl: storedRow.eventImageUrl || null,
    isManualEntry: false,
  };
}

/** A Sessionize event with no stored row, as-is. */
const sessionizeOnly = (event) => ({
  ...event,
  startsAt: eventStart(event),
  eventUrl: eventSite(event),
  name: eventName(event),
});

/**
 * Upcoming events soonest first, then past events most recent first; undated
 * rows sink to the end.
 */
export function compareEventDates(a, b) {
  const dateA = getDateTimestamp(eventDate(a));
  const dateB = getDateTimestamp(eventDate(b));
  if (!dateA || !dateB) return dateA ? -1 : 1;
  const comingSoon = isUpcoming(eventDate(a)) || isUpcoming(eventDate(b));
  return comingSoon ? dateA - dateB : dateB - dateA;
}

/**
 * Sessionize's events merged with the published snapshot's rows: a tombstone
 * drops its event (functions/src/lib/snapshots-publish.js); a stored row
 * matched by Sessionize id, then by name — the same two steps the admin hub
 * takes — overrides the fields it has set; an unmatched row shown on the
 * About page is a manual entry. Sorted by `compareEventDates`.
 */
export function combineEvents(sessionizeEvents, snapshotItems) {
  const rows = (snapshotItems || []).filter((item) => item && typeof item === 'object');
  const hidden = new Set(rows.filter(isTombstone).map((item) => Number(item.sessionizeId)));
  const stored = rows.filter((item) => !isTombstone(item)).map(normalizeEvent);
  const candidates = stored.map((e) => ({ ...e, eventId: e.sessionizeId }));
  const matched = new Set();
  const combined = sessionizeEvents
    .filter((event) => !hidden.has(Number(event.id)))
    .map((event) => {
      const storedRow = matchStoredRow({ id: event.id, name: eventName(event) }, candidates);
      if (!storedRow) return sessionizeOnly(event);
      matched.add(storedRow.id);
      return mergeStoredRow(event, storedRow);
    });
  const manual = stored
    .filter((e) => !matched.has(e.id) && e.display === true)
    .map((entry) => ({ ...entry, isManualEntry: true }));
  return [...combined, ...manual].sort(compareEventDates);
}

// ── Sections ─────────────────────────────────────────────────────────────────

const byTimestamp = (a, b) => getDateTimestamp(eventDate(a)) - getDateTimestamp(eventDate(b));

/**
 * How many months into a new calendar year the page keeps the layout of the
 * year that just ended. One: through January the past sections are the ones
 * shown on 31 December, and the page rolls over on 1 February (owner decision
 * 2026-11-24, #1777: "keep the previous year an extra month").
 */
export const SPEAKING_YEAR_GRACE_MONTHS = 1;

/**
 * The year the page treats as "this year". The calendar year from 1 February
 * on, and still the year before through January. Read in the visitor's own
 * time zone, like every other date on this page.
 */
export function speakingYear(now = new Date()) {
  const year = now.getFullYear();
  return now.getMonth() < SPEAKING_YEAR_GRACE_MONTHS ? year - 1 : year;
}

/**
 * The About page's sections: coming soon (today or later, the same rule as
 * the admin's Upcoming tab), this year's past talks and last year's, each
 * soonest first. Undated rows are in none. "This year" is `speakingYear`, so
 * in January it is still the year that just ended.
 *
 * `newYear` is only ever filled in January: a talk already given in the new
 * calendar year is past, so it is not coming soon, and it does not belong to
 * the year that just ended. It gets a section of its own so it does not
 * vanish; on 1 February it becomes part of `thisYear`.
 */
export function groupSessions(sessions, now = new Date()) {
  const year = speakingYear(now);
  const dated = sessions
    .map((session) => ({ session, date: parseDateValue(eventDate(session)) }))
    .filter((row) => row.date);
  const section = (keep) =>
    dated
      .filter(({ date }) => keep(date))
      .map(({ session }) => session)
      .sort(byTimestamp);
  const past = (date) => !isUpcoming(date, now);
  return {
    year,
    comingSoon: section((date) => isUpcoming(date, now)),
    newYear: section((date) => past(date) && date.getFullYear() > year),
    thisYear: section((date) => past(date) && date.getFullYear() === year),
    lastYear: section((date) => past(date) && date.getFullYear() === year - 1),
  };
}

// ── One card ─────────────────────────────────────────────────────────────────

/** The location as text: coordinates become "lat, lng"; labels are normalised. */
export function locationText(location) {
  const coords = typeof location === 'string' ? null : parseCoords(location);
  const text = coords ? `${coords.lat}, ${coords.lng}` : location;
  return typeof text === 'string' ? normalizeLocationLabel(text) : text;
}

const MAPS = 'https://www.google.com/maps/search/';

/** A Google Maps search for a place name or a coordinate pair; none for a virtual event. */
export function locationLink(location) {
  if (!location) return null;
  if (typeof location === 'string') {
    return location.toLowerCase().includes('virtual')
      ? null
      : `${MAPS}${encodeURIComponent(location)}`;
  }
  const coords = parseCoords(location);
  return coords ? `${MAPS}${encodeURIComponent(`${coords.lat},${coords.lng}`)}` : null;
}

/** Everything a card shows for one session, derived once. */
export function sessionView(session, index, currentYear) {
  const date = eventDate(session);
  const parsed = parseDateValue(date);
  const location = locationText(session.location);
  return {
    key: session.id || `${session.name || 'session'}-${index}`,
    name: session.name || session.title || 'Event Title',
    description: session.description || 'Event description not available',
    date,
    dateLabel: formatDateLabel(date),
    location,
    locationLink: locationLink(location),
    imageUrl: session.image || session.eventImageUrl,
    imageFallback: session.eventImageUrl || null,
    presentationUrl: session.presentationUrl,
    eventUrl: session.eventUrl,
    isPreviousYear: Boolean(parsed) && parsed.getFullYear() === currentYear - 1,
  };
}
