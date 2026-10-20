/**
 * The monthly audience read (#1302): the previous calendar month's page
 * views and podcast downloads, filed as one evidence row per programme in
 * the Ambassador hub.
 *
 * ## Why this exists
 *
 * Owner decision 2026-10-20: the Docker Captain application goes in on the
 * Thought Leader track ("at least 5,000 monthly views across blogs, social
 * media, or other online avenues"), and the Microsoft MVP form asks for
 * impact metrics per contribution. The site published no traffic figure and
 * had never read the show's download count. This timer makes both a dated
 * fact in the hub, under the programmes that ask for reach, and nothing is
 * shown to visitors.
 *
 * ## The two reads
 *
 * PAGE VIEWS come from Cloudflare Web Analytics through the GraphQL Analytics
 * API, `POST https://api.cloudflare.com/client/v4/graphql`, with the
 * read-only API token in `Authorization: Bearer`. The dataset is
 * `rumPageloadEventsAdaptiveGroups`, which is ACCOUNT-scoped — it lives under
 * `viewer { accounts(filter: { accountTag: $accountTag }) { … } }` and an
 * unfiltered `viewer { accounts }` is refused for any account the token
 * cannot read — so the account id is read as well as the site tag. The
 * filter is `{ siteTag, datetime_geq, datetime_lt }` over the month's UTC
 * window, and the figure is the group's `count`: Cloudflare's own dashboard
 * reads the total as `rumPageloadEventsAdaptiveGroups(filter, limit: 1)
 * { count sum { visits } }`, where `count` is "the number of pages viewed
 * by end-users" and `sum.visits` the visits (page loads whose referrer was
 * another site). Field names as read on 2026-10-20 from the GraphQL schema
 * and from two independent clients of it (cloudflarer's analytics vignette
 * and a transcript of the dashboard's query); NOT measured against the live
 * API, which is why every name is listed here in one place.
 *
 * The site is registered with the lite option (infra/frontend.tf), which
 * asks Cloudflare not to measure visitors in the EU: documented for the
 * proxy-injected snippet, unverified for a hand-placed one until the owner
 * confirms the option on the site's Manage page. Either way the count is at
 * best a floor, and the row says so.
 *
 * PODCAST DOWNLOADS come from Podbean through the client the Recording Hub
 * already uses (lib/podcast/podbean.js): `GET /v1/podcastStats/stats` over
 * the month's days with `period: 'd'`, summed — the daily keys are the
 * documented `YYYY-MM-DD`, where the monthly bucket's key format is not
 * specified (host-stats.js says the same). The client's own scope, from the
 * client-credentials grant, includes `podcast_read`, which the stats read
 * needs; nothing new is requested. When the credential is absent or the read
 * fails, the podcast half is "unavailable" in the row — title included — and
 * the run still files the page-view figure. A missing download count must
 * never cost the month its page views.
 *
 * ## The rows
 *
 * One evidence row per programme per month, source `manual`, under a
 * deterministic id (`importedEvidenceId('manual', 'audience-<YYYY-MM>-
 * <programId>')`), so a re-run of a month UPDATES the row — title,
 * description, figures, snapshot — and never adds a second. A row the owner
 * soft-deleted stays deleted: the run reads it, sees the mark, and leaves it.
 * Other owner edits (notes, tags, verification) are not touched because the
 * update is a patch of the fields this file owns, on the stored ETag.
 *
 * ## Once a month, from a daily timer
 *
 * The registration runs daily (ambassador-audience.js says why: the overdue
 * alert cannot compute a monthly due time). So the run first asks whether
 * the previous month is recorded — a row, deleted or not, under each
 * programme's id — and when it is, logs one line and reads nothing. Only a
 * month with a row missing is read, and then every row of it is written or
 * refreshed, so a run that failed between its two writes is completed the
 * next day with figures read together.
 *
 * The row counts toward a programme's `reach` requirement the way every
 * evidence row counts (lib/ambassador/readiness.js): by `programIds` and by
 * `sourceModule` being one of the requirement's `evidenceTypes`. Docker
 * Captain's `reach` and the MVP's `reach` list `manual` for that reason
 * (programs.js, revision 2 of both seeds).
 *
 * ## Gating and telemetry
 *
 * Nothing runs without `CLOUDFLARE_ANALYTICS_TOKEN` (a Key Vault reference;
 * an unresolved one is "absent", read-setting.js), `CF_WEB_ANALYTICS_SITE_TAG`
 * and `CF_ACCOUNT_ID`: the run logs ONE line naming the missing settings and
 * writes nothing. The Cloudflare call goes through guarded-fetch.js (https
 * only, pinned address, 30 s deadline, a 256 KiB body cap — the answer is a
 * few hundred bytes). Every log line is content-free: counts and status
 * codes, never the token, never a response body.
 */
import { CONTAINER } from '../ambassador/model.js';
import { importedEvidenceId } from '../ambassador/evidence.js';
import { guardedFetch } from '../http/guarded-fetch.js';
import { readSetting } from '../http/read-setting.js';
import { sumCounts } from '../podcast/host-stats.js';
import { toRecordedError } from '../podcast/host-publish.js';

export const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** The read-only Cloudflare API token (Account Analytics: Read), as a Key Vault reference. */
export const TOKEN_SETTING = 'CLOUDFLARE_ANALYTICS_TOKEN';
/** The Web Analytics site's tag, `cloudflare_web_analytics_site.hcw.site_tag`; plain. */
export const SITE_TAG_SETTING = 'CF_WEB_ANALYTICS_SITE_TAG';
/** The Cloudflare account that owns the site; plain. The dataset is account-scoped. */
export const ACCOUNT_ID_SETTING = 'CF_ACCOUNT_ID';

/** The rows are manual evidence: nothing in the import picker lists them, and the hub shows them as the owner's. */
export const SOURCE_MODULE = 'manual';

/** The programmes that ask for reach, and the requirement each row is filed under. */
export const AUDIENCE_PROGRAMS = Object.freeze([
  Object.freeze({ programId: 'program-docker-captain', requirementId: 'reach' }),
  Object.freeze({ programId: 'program-microsoft-mvp', requirementId: 'reach' }),
]);

/** Who the rows say created them; the hub shows it beside the row. */
export const CREATED_BY = 'ambassadorAudienceMonthly';

/** The month's total: one group, no dimensions, as the Cloudflare dashboard reads it. */
export const PAGE_VIEWS_QUERY = `query AudienceMonth($accountTag: String!, $siteTag: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 1
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_lt: $until }
      ) {
        count
        sum { visits }
      }
    }
  }
}`;

/** Far more than the answer needs; a body past this is not the answer. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 30_000;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad = (n) => String(n).padStart(2, '0');

/**
 * The calendar month before `now`'s UTC month: its key, its label, the
 * GraphQL window (`since` inclusive, `until` exclusive, whole UTC days) and
 * the Podbean range (`start`, `end` inclusive days). January reads December
 * of the prior year.
 */
export function previousMonth(now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based; "this month"
  const first = new Date(Date.UTC(year, month - 1, 1));
  const next = new Date(Date.UTC(year, month, 1));
  const last = new Date(next.getTime() - 86_400_000);
  const key = `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}`;
  return {
    key,
    label: `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}`,
    since: `${key}-01T00:00:00Z`,
    until: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01T00:00:00Z`,
    start: `${key}-01`,
    end: `${key}-${pad(last.getUTCDate())}`,
  };
}

/** The (sourceModule, sourceId) pair a month's row for one programme is stored under. */
export const audienceSourceId = (monthKey, programId) => `audience-${monthKey}-${programId}`;
export const audienceEvidenceId = (monthKey, programId) =>
  importedEvidenceId(SOURCE_MODULE, audienceSourceId(monthKey, programId));

const count = (n) => Number(n).toLocaleString('en-US');

/** `Audience, September 2026: 5,100 page views, 210 podcast downloads` — or `…, podcast downloads unavailable`. */
export function audienceTitle({ label, pageViews, podcast }) {
  const downloads = podcast.available
    ? `${count(podcast.downloads)} podcast downloads`
    : 'podcast downloads unavailable';
  return `Audience, ${label}: ${count(pageViews)} page views, ${downloads}`;
}

/** The row's description: the two figures, how each was measured, and when it was read. */
export function audienceDescription({ month, pageViews, podcast, readAt }) {
  const lines = [
    `Page views: ${count(pageViews)}. Cloudflare Web Analytics page loads on the site, ` +
      `${month.start} to ${month.end} (UTC), read from the GraphQL Analytics API ` +
      `(rumPageloadEventsAdaptiveGroups, count); aggregate page views. The site's lite option ` +
      `asks Cloudflare to exclude EU visitors, so treat the figure as a floor.`,
    podcast.available
      ? `Podcast downloads: ${count(podcast.downloads)}. Podbean download count for the same ` +
        `days (podcastStats/stats, daily, summed).`
      : `Podcast downloads: unavailable this month (Podbean read ${podcast.code}` +
        `${podcast.status ? ` HTTP ${podcast.status}` : ''}); the page-view figure stands on its own.`,
    `Read on ${readAt.slice(0, 10)} by the monthly audience timer.`,
  ];
  return lines.join('\n');
}

/**
 * The evidence row for one programme and one month, whole: what a create
 * stores, and what an update patches the owned fields from.
 */
export function audienceRow({ programId, month, pageViews, podcast, readAt }) {
  const title = audienceTitle({ label: month.label, pageViews, podcast });
  return {
    id: audienceEvidenceId(month.key, programId),
    docType: 'evidence',
    title,
    description: audienceDescription({ month, pageViews, podcast, readAt }),
    date: month.end,
    sourceModule: SOURCE_MODULE,
    sourceId: audienceSourceId(month.key, programId),
    snapshot: { title, date: month.end, url: null, capturedAt: readAt },
    url: null,
    files: [],
    images: [],
    metrics: {
      reach: podcast.available ? podcast.downloads : null,
      attendees: null,
      views: pageViews,
      credits: null,
    },
    technology: [],
    programIds: [programId],
    qualificationPeriod: null,
    verificationStatus: 'unverified',
    notes: '',
    tags: ['audience'],
    createdAt: readAt,
    createdBy: CREATED_BY,
    updatedAt: readAt,
  };
}

/** The fields a re-run may change on a stored row; everything else is the owner's. */
const OWNED_FIELDS = ['title', 'description', 'date', 'snapshot', 'metrics', 'programIds'];

/** A failed Cloudflare read: the status code and nothing of the body. */
export class AudienceReadError extends Error {
  constructor(message, { status = null, code = 'CLOUDFLARE_READ' } = {}) {
    super(message);
    this.name = 'AudienceReadError';
    this.status = status;
    this.code = code;
  }
}

/**
 * The month's page views from Cloudflare, or a thrown AudienceReadError
 * carrying the HTTP status (or `GRAPHQL_ERRORS` / `BAD_SHAPE`) and no body.
 */
export async function readPageViews({
  env = process.env,
  month,
  fetch: fetchImpl,
  resolve,
  dispatcherFor,
  log,
}) {
  const token = readSetting(env, TOKEN_SETTING);
  const variables = {
    accountTag: readSetting(env, ACCOUNT_ID_SETTING),
    siteTag: readSetting(env, SITE_TAG_SETTING),
    since: month.since,
    until: month.until,
  };
  const deps = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: PAGE_VIEWS_QUERY, variables }),
    httpsOnly: true,
    maxRedirects: 0,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  };
  if (fetchImpl) deps.fetch = fetchImpl;
  if (resolve) deps.resolve = resolve;
  if (dispatcherFor) deps.dispatcherFor = dispatcherFor;
  const { response, text } = await guardedFetch(CF_GRAPHQL_URL, deps);
  const status = response.status;
  if (status !== 200) {
    throw new AudienceReadError(`Cloudflare GraphQL answered HTTP ${status}`, { status });
  }
  let body;
  try {
    body = JSON.parse(text());
  } catch {
    throw new AudienceReadError('Cloudflare GraphQL answered something other than JSON', {
      status,
      code: 'BAD_SHAPE',
    });
  }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    // Error COUNT, not the messages: a GraphQL error can quote the query's
    // variables back, and the log is content-free by rule.
    throw new AudienceReadError(`Cloudflare GraphQL returned ${body.errors.length} error(s)`, {
      status,
      code: 'GRAPHQL_ERRORS',
    });
  }
  const groups = body?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups;
  if (!Array.isArray(groups)) {
    throw new AudienceReadError('Cloudflare GraphQL answered without the dataset', {
      status,
      code: 'BAD_SHAPE',
    });
  }
  // No group for a month with no page loads is a legitimate zero.
  const pageViews = groups.reduce((sum, group) => sum + (Number(group?.count) || 0), 0);
  log?.(`cloudflare read: HTTP ${status}, ${groups.length} group(s)`);
  return pageViews;
}

/**
 * The month's downloads from Podbean, or why they are unavailable. Never
 * throws for Podbean: NOT_CONFIGURED, a rejected token and a rate limit all
 * arrive as `{ available: false, code, status }` through `toRecordedError`.
 */
export async function readPodcastDownloads({ client, month, log }) {
  try {
    const byDay = await client.getDownloadStats({ start: month.start, end: month.end, period: 'd' });
    const downloads = sumCounts(byDay);
    log?.(`podbean read: ok, ${Object.keys(byDay && typeof byDay === 'object' ? byDay : {}).length} day(s)`);
    return { available: true, downloads };
  } catch (error) {
    const recorded = toRecordedError(error);
    log?.(`podbean read: unavailable (${recorded.code}${recorded.status ? ` HTTP ${recorded.status}` : ''})`);
    return { available: false, code: recorded.code, status: recorded.status };
  }
}

/** The settings the run cannot start without, by name, in the order they are checked. */
export const REQUIRED_SETTINGS = Object.freeze([TOKEN_SETTING, SITE_TAG_SETTING, ACCOUNT_ID_SETTING]);

/** Names (never values) of the required settings that are absent, blank or unresolved. */
export function missingSettings(env = process.env) {
  return REQUIRED_SETTINGS.filter((name) => !readSetting(env, name));
}

/**
 * Whether the month has a row under every programme already — present or
 * soft-deleted, since a row the owner removed is still a month that was
 * recorded. The daily run reads nothing when this is true.
 */
export async function monthRecorded(store, monthKey) {
  for (const { programId } of AUDIENCE_PROGRAMS) {
    const id = audienceEvidenceId(monthKey, programId);
    if (!(await store.readDoc(CONTAINER, id, id))) return false;
  }
  return true;
}

/**
 * Store one month's row for one programme: create it, or patch the owned
 * fields of the stored one on its ETag. A 412 means the row changed between
 * the read and the write, so the row is read again: a soft-delete that
 * landed in between is honoured, otherwise the patch goes once more on the
 * fresh ETag, and a second 412 is thrown rather than written over. A row
 * the owner soft-deleted is left as it is.
 */
async function writeRow(store, doc) {
  const existing = await store.readDoc(CONTAINER, doc.id, doc.id);
  if (existing?.softDeletedAt) return 'skipped';
  if (!existing) {
    try {
      await store.createDoc(CONTAINER, doc);
      return 'created';
    } catch (error) {
      if (error?.code !== 409) throw error;
      // Lost the race to another run of the same month; fall through to patch.
    }
  }
  const patch = Object.fromEntries(OWNED_FIELDS.map((field) => [field, doc[field]]));
  patch.updatedAt = doc.updatedAt;
  const etag = existing?._etag;
  try {
    await store.patchDoc(CONTAINER, doc.id, patch, etag ? { ifMatch: etag } : {});
  } catch (error) {
    if (error?.code !== 412) throw error;
    // Never a blind write: the owner may have soft-deleted the row in the
    // gap, and a patch without the ETag would not see it. A row that is gone
    // outright is left for the next day's run, which reads the month again.
    const fresh = await store.readDoc(CONTAINER, doc.id, doc.id);
    if (!fresh || fresh.softDeletedAt) return 'skipped';
    await store.patchDoc(CONTAINER, doc.id, patch, { ifMatch: fresh._etag });
  }
  return 'updated';
}

/**
 * The run, built per invocation. `store` needs `readDoc`, `createDoc` and
 * `patchDoc` (the hub's own three, ambassador-http.js); `podbean` is the
 * Podbean client; `fetch`, `resolve` and `dispatcherFor` are the
 * guarded-fetch injections for tests and nothing else.
 */
export function createAudienceMonthlyRead({
  store,
  podbean,
  env = process.env,
  now = () => new Date(),
  fetch: fetchImpl,
  resolve,
  dispatcherFor,
  log = {},
  label = 'ambassadorAudienceMonthly',
}) {
  const line = (text) => log.log?.(`[${label}] ${text}`);
  return {
    async run() {
      const missing = missingSettings(env);
      if (missing.length > 0) {
        // One line, and nothing written: the beacon is not configured yet,
        // or the token has not been seeded. Names only.
        line(`not configured: ${missing.join(', ')} not set — nothing read, nothing written`);
        return { skipped: 'not-configured', missing };
      }
      const at = now();
      const month = previousMonth(at);
      if (await monthRecorded(store, month.key)) {
        line(`${month.key} already recorded — nothing read`);
        return { skipped: 'recorded', month: month.key };
      }
      const readAt = at.toISOString();
      let pageViews;
      try {
        pageViews = await readPageViews({
          env,
          month,
          fetch: fetchImpl,
          resolve,
          dispatcherFor,
          log: line,
        });
      } catch (error) {
        // The row needs the page-view figure, so none is written; the host
        // records the failed run, and the alert on exceptions carries it.
        log.error?.(
          `[${label}] cloudflare read failed for ${month.key}: ${error?.code || error?.name || 'error'}` +
            `${error?.status ? ` HTTP ${error.status}` : ''} — nothing written`
        );
        throw error;
      }
      const podcast = await readPodcastDownloads({ client: podbean, month, log: line });
      const rows = { created: 0, updated: 0, skipped: 0 };
      for (const { programId } of AUDIENCE_PROGRAMS) {
        const outcome = await writeRow(store, audienceRow({ programId, month, pageViews, podcast, readAt }));
        rows[outcome] += 1;
      }
      return {
        month: month.key,
        pageViews,
        podcastDownloads: podcast.available ? podcast.downloads : null,
        podcast: podcast.available ? 'ok' : `unavailable:${podcast.code}`,
        rows,
      };
    },
  };
}
