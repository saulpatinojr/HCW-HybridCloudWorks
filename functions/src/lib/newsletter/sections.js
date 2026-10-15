/**
 * sections.js — what goes in a weekly issue, one registered section at a time
 * (ADR 0030 §2a).
 *
 * ## Adding a section
 *
 * Write one entry and put it in SECTIONS. Nothing else changes: the builder
 * collects every registered section the owner has not turned off in
 * Newsletter settings → Content (a new one is on by default, appended after
 * the saved order), drops the empty ones, and the renderer
 * lays out whatever items come back. An entry is:
 *
 *   {
 *     id:      stable key, stored on the issue ('articles')
 *     title:   the heading readers see ('New on HybridCloudWorks')
 *     collect: async ({ store, since, until }) => Item[]
 *   }
 *
 * and an Item is `{ title, url, summary?, label? }` — plain text only. The
 * renderer escapes every field, so a section cannot put markup into the email,
 * and `url` must be absolute https or the item is dropped rather than rendered
 * as a link that goes nowhere.
 *
 * Every collector reads only what the public site already shows: published
 * articles, approved episodes, Microsoft's public feed, the comparison page's
 * price-change feed. A newsletter is a public surface, and nothing reaches it
 * that the site itself would not render.
 */
import { publicUrlOf } from '../cms/publish.js';
import { errorCode } from '../http/error-response.js';
// history.js, not refresh.js: the document id and container name without
// the three provider SDKs behind the refresh.
import { CACHE_CONTAINER, priceChangesDocId } from '../cloud-tools/history.js';
import { PROVIDER_LABELS, regionOption } from '../cloud-tools/pricing/regions.js';
import { readLabsWeek } from '../labs/rollup.js';

export const SITE_ORIGIN = 'https://hybridcloudworks.com';

/** Most items any one section may carry; the rest are a link to the site. */
export const MAX_ITEMS_PER_SECTION = 12;

const MAX_SUMMARY_LENGTH = 280;

/** Trim, collapse whitespace, cap. Never returns markup — callers escape. */
export function plainText(value, max = MAX_SUMMARY_LENGTH) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** An absolute https URL, or a site path made absolute; anything else is null. */
export function absoluteUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return `${SITE_ORIGIN}${raw}`;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Providers whose certifications have their own detail pages (App.jsx). */
const CERT_DETAIL_PROVIDERS = new Set(['aws', 'azure']);

const CERT_EVENT_LABELS = Object.freeze({
  ga_launch: 'Now available',
  beta_launch: 'Beta',
  retirement: 'Retiring',
  update: 'Updated',
});

export const articlesSection = Object.freeze({
  id: 'articles',
  title: 'New on HybridCloudWorks',
  async collect({ store, since, until }) {
    const rows = await store.queryDocs(
      'content',
      `SELECT TOP 50 c.Title, c.title, c.Summary, c.summary, c["Cloud Provider"], c.cloudProvider,
              c.publishedAt, c.publishedUrl, c.publicUrl, c.curatedSubpagePath, c.slugPageUrl
         FROM c WHERE c.Live = true AND c.publishedAt >= @since AND c.publishedAt < @until
         ORDER BY c.publishedAt DESC`,
      [
        { name: '@since', value: since.toISOString() },
        { name: '@until', value: until.toISOString() },
      ]
    );
    return (rows || [])
      .map((row) => ({
        title: plainText(row.Title || row.title, 160),
        summary: plainText(row.Summary || row.summary),
        // The URL publishing stored, never a guess: an article whose URL was
        // never recorded is left out rather than linked somewhere it is not.
        url: absoluteUrl(publicUrlOf(row)),
        label: plainText(row['Cloud Provider'] || row.cloudProvider, 40),
      }))
      .filter((item) => item.title && item.url);
  },
});

export const certificationNewsSection = Object.freeze({
  id: 'certification-news',
  title: 'Certification news',
  async collect({ store, since, until }) {
    const rows = await store.queryDocs(
      'certEvents',
      `SELECT TOP 50 c.type, c.certCodes, c.title, c.summary, c.link, c.pubDate, c.softDeletedAt
         FROM c WHERE c.pubDate >= @since AND c.pubDate < @until ORDER BY c.pubDate DESC`,
      [
        { name: '@since', value: since.toISOString() },
        { name: '@until', value: until.toISOString() },
      ]
    );
    return (rows || [])
      .filter((row) => !row.softDeletedAt)
      .map((row) => {
        const codes = Array.isArray(row.certCodes)
          ? row.certCodes.filter((c) => typeof c === 'string')
          : [];
        const kind = CERT_EVENT_LABELS[row.type] ?? 'News';
        return {
          title: plainText(row.title, 160),
          summary: plainText(row.summary),
          url: absoluteUrl(row.link),
          label: plainText([kind, codes.join(', ')].filter(Boolean).join(' · '), 80),
        };
      })
      .filter((item) => item.title && item.url);
  },
});

export const episodesSection = Object.freeze({
  id: 'episodes',
  title: 'Listen & learn',
  async collect({ store, since, until }) {
    const params = [
      { name: '@since', value: since.toISOString() },
      { name: '@until', value: until.toISOString() },
    ];
    const [episodes, podcasts] = await Promise.all([
      store.queryDocs(
        'listen_and_learn_episodes',
        `SELECT TOP 50 c.setId, c.provider, c.title, c.summary, c.approvedAt, c.audioUrl
           FROM c WHERE c.status = 'published' AND c.approvedAt >= @since AND c.approvedAt < @until
           ORDER BY c.approvedAt DESC`,
        params
      ),
      store.queryDocs(
        'podcasts',
        `SELECT TOP 50 c.provider, c.title, c.description, c.link, c.publishedAt, c.softDeletedAt, c.mediaUnavailableAt
           FROM c WHERE c.publishedAt >= @since AND c.publishedAt < @until ORDER BY c.publishedAt DESC`,
        params
      ),
    ]);

    // One read per certification, not per episode: a set usually publishes
    // several episodes at once.
    const setIds = [...new Set((episodes || []).map((e) => e.setId).filter(Boolean))];
    const sets = new Map(
      await Promise.all(
        setIds.map(async (id) => [
          id,
          await store.readDoc('listen_and_learn', id, id).catch(() => null),
        ])
      )
    );

    const study = (episodes || [])
      .filter((episode) => episode.audioUrl)
      .map((episode) => {
        const provider = String(episode.provider || '').toLowerCase();
        const set = sets.get(episode.setId);
        const path =
          CERT_DETAIL_PROVIDERS.has(provider) && set?.certSlug
            ? `/${provider}/education/${set.certSlug}`
            : `/${provider}/education`;
        return {
          title: plainText(episode.title, 160),
          summary: plainText(episode.summary),
          url: provider ? absoluteUrl(path) : null,
          label: plainText(
            set?.certTitle ? `Study episode · ${set.certTitle}` : 'Study episode',
            80
          ),
        };
      });

    const shows = (podcasts || [])
      .filter((row) => !row.softDeletedAt && !row.mediaUnavailableAt)
      .map((row) => {
        const provider = String(row.provider || '').toLowerCase();
        const page = provider && provider !== 'main' ? `/${provider}/audio` : '/azure/audio';
        return {
          title: plainText(row.title, 160),
          summary: plainText(row.description),
          url: absoluteUrl(row.link) ?? absoluteUrl(page),
          label: 'Podcast',
        };
      });

    return [...shows, ...study].filter((item) => item.title && item.url);
  },
});

/**
 * The region the newsletter's price changes are read for (#613 Phase 3). One
 * region, fixed: an email has no region picker, and US East is the page's
 * default and the region every link below opens on. The other two regions'
 * feeds exist and the page serves them; the newsletter does not read them.
 */
export const NEWSLETTER_PRICE_REGION = 'us-east-1';

/** The comparison window the section reports. The page also shows 30 days. */
const NEWSLETTER_PRICE_WINDOW = '7d';

/** Where every price-change item links: the comparison page, on the newsletter's region. */
export const PRICE_COMPARISON_URL = `${SITE_ORIGIN}/tools/comparison?region=${NEWSLETTER_PRICE_REGION}`;

/**
 * A list price as prose: four significant figures with trailing zeros
 * dropped, `$` for USD and the code after the number otherwise (Azure can
 * quote another currency). Not a number the reader computes with; a number
 * the reader recognises from the page.
 */
export function formatPrice(value, currency = 'USD') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const digits = String(Number(n.toPrecision(4)));
  return currency === 'USD' ? `$${digits}` : `${digits} ${currency}`;
}

/** "AWS · Virtual machines: $0.192 → $0.201 per hour (+4.7%)", or null for a row that cannot be read. */
export function priceChangeTitle(item) {
  const provider = PROVIDER_LABELS[item?.provider];
  const from = formatPrice(item?.from, item?.currency);
  const to = formatPrice(item?.to, item?.currency);
  const delta = Number(item?.deltaPct);
  const named = Boolean(provider && item?.label && item?.unit);
  const priced = Boolean(from && to && Number.isFinite(delta));
  if (!named || !priced) return null;
  const sign = delta > 0 ? '+' : '';
  return `${provider} · ${item.label}: ${from} → ${to} per ${item.unit} (${sign}${delta}%)`;
}

/**
 * Cloud price changes (#613 Phase 3): the 7-day window of the price-change
 * feed the pricing refresh derives from its daily snapshots
 * (cloud-tools/history.js), read from the same document the comparison page
 * shows. One point read; the refresh has already done the comparing.
 *
 * With no items — no comparison snapshot yet, or a week in which no live
 * price moved — this returns an empty list, and `collectSections` leaves the
 * section out of the issue entirely. There is deliberately no "no changes
 * this week" filler: a section that says nothing is a heading the reader
 * scrolls past, and issue.test.js asserts it is omitted.
 *
 * `since`/`until` are not used: the window is the feed's own, a fixed seven
 * days ending at the last refresh, not the issue's lookback.
 */
export const cloudPriceChangesSection = Object.freeze({
  id: 'cloud-price-changes',
  title: 'Cloud price changes',
  async collect({ store }) {
    const id = priceChangesDocId(NEWSLETTER_PRICE_REGION);
    const doc = await store.readDoc(CACHE_CONTAINER, id, id);
    const items = doc?.windows?.[NEWSLETTER_PRICE_WINDOW]?.items;
    if (!Array.isArray(items)) return [];
    const regionLabel = regionOption(NEWSLETTER_PRICE_REGION)?.label ?? NEWSLETTER_PRICE_REGION;
    return items
      .map((item) => ({
        title: plainText(priceChangeTitle(item), 160),
        summary: plainText(item?.sku, 120),
        url: PRICE_COMPARISON_URL,
        label: plainText(`${regionLabel} · last 7 days`, 40),
      }))
      .filter((item) => item.title && item.url);
  },
});

/**
 * Where every "Lab this week" item links: the cross-provider labs index. A
 * day document carries no provider, and the index groups every lab by its
 * provider hub (ADR 0033 §3), so it is the one page that fits every item.
 */
export const LABS_PAGE_URL = `${SITE_ORIGIN}/education/labs`;

const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * The week's job counts per type, summed over the day documents: `[{ type,
 * runs, succeeded, failed, timeout }]`, most-run first, types with no run
 * dropped. A count that is not a non-negative integer adds nothing.
 */
export function labWeekJobTotals(docs) {
  const totals = new Map();
  for (const doc of docs) {
    for (const [type, counts] of Object.entries(doc.jobsByType ?? {})) {
      const row = totals.get(type) ?? { succeeded: 0, failed: 0, timeout: 0 };
      for (const key of Object.keys(row)) {
        const n = counts?.[key];
        if (Number.isInteger(n) && n > 0) row[key] += n;
      }
      totals.set(type, row);
    }
  }
  return [...totals]
    .map(([type, c]) => ({ type, runs: c.succeeded + c.failed + c.timeout, ...c }))
    .filter((t) => t.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.type.localeCompare(b.type));
}

/**
 * The section's items from a week of day documents (labs/rollup.js), in the
 * order they read: Arc, then the job types by runs, then the Coder peak.
 * Empty — and so the section is omitted — when no day was observed and no
 * job ran: an Arc line that says "0 of 0 days" is the filler the price
 * section refuses too. The Coder peak alone does not carry the section; it
 * is a footnote to a lab that was used, not a reason to write about one that
 * was not.
 *
 * @param {object[]} days - day documents, any order
 * @returns {Array<{ title: string, url: string, summary?: string, label?: string }>}
 */
export function labWeekItems(days) {
  const docs = Array.isArray(days) ? days.filter((d) => d && typeof d === 'object') : [];
  const observed = docs.filter((d) => typeof d.arcConnected === 'boolean');
  const connected = observed.filter((d) => d.arcConnected === true).length;
  const types = labWeekJobTotals(docs);

  if (observed.length === 0 && types.length === 0) return [];

  const items = [];
  if (observed.length > 0) {
    items.push({
      title: `Azure Arc: connected ${connected} of ${plural(observed.length, 'day')} observed`,
      summary:
        'Days the lab host reported Connected to Azure Arc, out of the days the estate page saw it.',
      url: LABS_PAGE_URL,
      label: 'Hybrid lab host',
    });
  }
  for (const t of types) {
    const problems = [
      t.failed > 0 ? `${t.failed} failed` : null,
      t.timeout > 0 ? `${t.timeout} timed out` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    items.push({
      title: plainText(`${t.type}: ${plural(t.runs, 'run')}, ${t.succeeded} succeeded`, 160),
      summary: problems,
      url: LABS_PAGE_URL,
      label: 'Lab jobs',
    });
  }
  const peaks = docs.map((d) => d.coderRunningMax).filter((n) => Number.isInteger(n) && n >= 0);
  if (peaks.length > 0) {
    items.push({
      title: `Peak Coder workspaces: ${Math.max(...peaks)}`,
      summary: 'The most browser lab workspaces running at once, as sampled each day.',
      url: LABS_PAGE_URL,
      label: 'Coder',
    });
  }
  return items;
}

/**
 * Lab this week (#665, Phase 5 of #656): the hybrid lab host's week, from the
 * day documents the labsWeeklyRollup timer writes (labs/rollup.js) — seven
 * point reads, never a call to Azure or Coder. Omitted from the issue when no
 * day document exists, or when none of them observed the estate or a job.
 *
 * `since` is not used: the window is the seven UTC days before the build's
 * day, which is what the rollup has written, not the issue's lookback.
 */
export const labThisWeekSection = Object.freeze({
  id: 'lab-this-week',
  title: 'Lab this week',
  async collect({ store, until }) {
    const days = await readLabsWeek({ store, until: until instanceof Date ? until : new Date() });
    return labWeekItems(days);
  },
});

/** The registry, in the order sections appear in the email. */
export const SECTIONS = Object.freeze([
  articlesSection,
  certificationNewsSection,
  episodesSection,
  cloudPriceChangesSection,
  labThisWeekSection,
]);

/**
 * Collect the given sections, in the given order, for the window. A section
 * that throws is reported and left out rather than sinking the issue: one
 * unreadable container should cost a heading, not the week's newsletter.
 * `maxItems` caps a section by id (Newsletter settings → Content); a section it
 * does not name keeps MAX_ITEMS_PER_SECTION.
 */
export async function collectSections({
  store,
  since,
  until,
  sections = SECTIONS,
  maxItems = {},
  log,
}) {
  const out = [];
  const problems = [];
  for (const section of sections) {
    const limit = Object.hasOwn(maxItems, section.id)
      ? maxItems[section.id]
      : MAX_ITEMS_PER_SECTION;
    try {
      const items = (await section.collect({ store, since, until })).slice(0, limit);
      if (items.length > 0) out.push({ id: section.id, title: section.title, items });
    } catch (error) {
      // Stored on the issue and shown: the failure's code, never its
      // sentence; the log line is content-free too (#945).
      problems.push(`${section.id}: could not be collected (${errorCode(error)})`);
      log?.warn?.(`[newsletter] section ${section.id} failed (${errorCode(error)})`);
    }
  }
  return { sections: out, problems };
}
