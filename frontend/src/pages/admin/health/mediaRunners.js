/**
 * The live runners that fetch media (ADR 0033 §1 Platform, §8): a default
 * cover through /api/public/media, and the covers of the newest published
 * items. Each answers one result in lib/status.js's vocabulary and never
 * throws. Moved out of probeRunners.js, which re-exports them, when that
 * file grew too long.
 */
import { getJSON } from '@/lib/api';
import { classifyFailure, plural, result } from './probeKit';
import { attempt, listOf } from './probeAttempt';

// ── Media route ──────────────────────────────────────────────────────────────

/** Read a URL's status without downloading its body. */
async function headStatus(url) {
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  try {
    await res.body?.cancel?.();
  } catch {
    // The status is what was wanted.
  }
  return res.status;
}

const servedByApi = (url) => typeof url === 'string' && /\/api\/public\/media\//.test(url);
const filledString = (value) => typeof value === 'string' && value.trim();

/** One default cover fetched through /api/public/media, as a result. */
async function coverVerdict(url) {
  const read = await attempt('The media route did not answer', () => headStatus(url));
  if (read.failure) return read.failure;
  const status = read.value;
  const answered = status >= 200 && status < 400;
  // A 404 is the route answering that the asset is gone (critical); a 502,
  // 503 or 504 is nothing answering behind it (offline).
  return result(
    answered ? 'healthy' : classifyFailure({ status, message: `HTTP ${status}` }),
    `A default cover answered HTTP ${status} through /api/public/media.`
  );
}

export async function runBlob() {
  const read = await attempt('The default covers could not be read', async () =>
    Object.values((await getJSON('cms/platform-settings/default-heroes'))?.value?.heroes ?? {})
  );
  if (read.failure) return read.failure;
  const urls = read.value.filter(filledString);
  if (urls.length === 0)
    return result(
      'unknown',
      'No default cover is configured, so there is no known asset to fetch.'
    );
  const probeable = urls.filter(servedByApi);
  if (probeable.length === 0) {
    return result(
      'unknown',
      'The default covers are served from another host, which this page cannot probe without CORS.'
    );
  }
  return coverVerdict(probeable[0]);
}

// ── Covers of published items ────────────────────────────────────────────────

/** The cover a public content item names, under the field each era used. */
const coverOf = (item) => ({
  id: item.id ?? item.slug,
  url: item.coverImage || item.imageUrl || item.contentImageUrl,
});

async function probeCover(row) {
  try {
    return { ...row, status: await headStatus(row.url) };
  } catch {
    return { ...row, status: 0 };
  }
}

const isBroken = (row) => [404, 410, 0].includes(row.status);

/** The verdict for the covers that could be fetched. */
async function coversVerdict(probeable) {
  const broken = (await Promise.all(probeable.map(probeCover))).filter(isBroken);
  if (broken.length === 0) {
    return result(
      'healthy',
      `${plural(probeable.length, 'cover')} of the 20 newest published items answered.`
    );
  }
  return result(
    'degraded',
    `${broken.length} of ${probeable.length} covers checked do not answer.`,
    {
      detail: broken.map((row) => `${row.id}: HTTP ${row.status}`).join('\n'),
    }
  );
}

export async function runBrokenRelationships() {
  const read = await attempt('The public content list could not be read', async () => {
    const res = await getJSON('public/content?limit=20');
    return listOf(Array.isArray(res) ? res : res?.items);
  });
  if (read.failure) return read.failure;
  const covers = read.value.map(coverOf).filter((row) => filledString(row.url));
  if (covers.length === 0)
    return result('unknown', 'None of the 20 newest published items carries a cover image URL.');
  const probeable = covers.filter((row) => servedByApi(row.url));
  if (probeable.length === 0) {
    return result(
      'unknown',
      `${plural(covers.length, 'cover')} found, all on hosts this page cannot probe without CORS.`
    );
  }
  return coversVerdict(probeable);
}
