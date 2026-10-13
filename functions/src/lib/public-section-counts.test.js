/**
 * The per-section counts that decide which section pages the sitemap
 * advertises (issue #373).
 *
 * A zero here removes a URL from `sitemap.xml`, so the assertions below are
 * mostly about the cases where a zero would be a lie: a document the count
 * cannot attribute, a container the count forgot, a read that was truncated.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  CONTENT_COUNT_FIELDS,
  CONTENT_COUNT_QUERY,
  LISTEN_AND_LEARN_COUNT_QUERY,
  LISTEN_AND_LEARN_EPISODE_CONTAINER,
  PODCAST_COUNT_QUERY,
  PROVIDERS,
  SECTIONS,
  SECTION_COUNT_WINDOW,
  UNATTRIBUTED,
  countContentDocs,
  countListenAndLearnDocs,
  countPodcastDocs,
  countSections,
  emptySections,
  providersOfContent,
} from './public-section-counts.js';
import { MAIN_PODCAST_PROVIDER, SQL_NOT_SOFT_DELETED, SQL_PUBLIC_CLAUSE } from './public-reads.js';

/** A published `content` row, in the shape isPublicDocument accepts. */
const published = (fields) => ({ contentStatus: 'published', ...fields });

describe('the shape the pre-render reads', () => {
  it('covers every provider with section pages', () => {
    // Mirrors VALID_PROVIDERS in frontend/src/context/ProviderContext.jsx. A
    // provider missing here has no counts, and a section page with no count is
    // never dropped — safe, but silently unfixed.
    expect([...PROVIDERS].sort()).toEqual(
      ['ansible', 'aws', 'azure', 'docker', 'finops', 'gcp', 'github', 'terraform', 'vmware'].sort()
    );
  });

  it('guards only the sections whose page infers a provider', () => {
    // The asymmetry is load-bearing in both directions: dropping the guard on
    // blog would let an untitled, unattributed article's page leave the
    // sitemap, and adding it to audio would keep sixteen pages advertised on
    // behalf of two provider-less podcast rows that no page can reach.
    //
    // architecture-designs is guarded for a different reason than the text
    // inference blog and frameworks do: four of the five architecture pages
    // filter with their OWN slug as the default —
    // `(doc.cloudProvider || doc['Cloud Provider'] || 'aws')` — so a document
    // naming no recognised provider shows up on all four.
    const inferred = Object.entries(SECTIONS)
      .filter(([, rule]) => rule.providerInferred)
      .map(([section]) => section);
    expect(inferred.sort()).toEqual(['architecture-designs', 'blog', 'frameworks']);
    expect(Object.keys(SECTIONS).sort()).toEqual(
      [
        'architecture-designs',
        'audio',
        'audio-architecture',
        'blog',
        'code',
        'coder-corner',
        'frameworks',
      ].sort()
    );
  });

  it('counts architecture-designs, which only the static half makes safe', () => {
    // This count was deliberately absent until the blueprint lists moved to
    // src/pages/<provider>/architecture-blueprints.js, because a zero was true
    // of all five architecture pages and right about only VMware. It is safe
    // now because sitemapRoutes drops a route only when this count AND that
    // module are both empty — see frontend/scripts/prerender.mjs.
    expect(Object.keys(SECTIONS)).toContain('architecture-designs');

    const sections = countContentDocs(emptySections(), [
      published({ type: 'architecture', cloudProvider: 'Azure' }),
      published({ type: 'architecture', 'Cloud Provider': 'VMware' }),
      published({ type: 'architecture', cloudProvider: 'Azure' }),
    ]);
    expect(sections.azure['architecture-designs']).toBe(2);
    expect(sections.vmware['architecture-designs']).toBe(1);
    expect(sections.aws['architecture-designs']).toBe(0);
    expect(sections[UNATTRIBUTED]['architecture-designs']).toBe(0);
  });

  it('keeps an architecture document out of the blog count', () => {
    // The blog listing excludes architecture and framework types, so counting
    // one as a blog post would keep an empty /vmware/blog advertised.
    const sections = countContentDocs(emptySections(), [
      published({ type: 'architecture', cloudProvider: 'Azure' }),
    ]);
    expect(sections.azure.blog).toBe(0);
    expect(sections.azure['architecture-designs']).toBe(1);
  });

  it('parks an architecture document naming no provider in the unattributed bucket', () => {
    // It would render on the AWS, Azure, FinOps and GCP pages alike, each of
    // which defaults an unattributed document to its own provider. VMware is
    // the exception and the guard is therefore conservative there — which is
    // the direction to be wrong in, since it only keeps a URL advertised.
    const sections = countContentDocs(emptySections(), [
      published({ type: 'architecture' }),
      published({ type: 'architecture', cloudProvider: 'Oracle' }),
    ]);
    expect(sections[UNATTRIBUTED]['architecture-designs']).toBe(2);
    expect(sections.aws['architecture-designs']).toBe(0);
  });

  it('starts every provider and the unattributed bucket at zero', () => {
    const sections = emptySections();
    for (const provider of [...PROVIDERS, UNATTRIBUTED]) {
      expect(Object.keys(sections[provider]).sort()).toEqual(Object.keys(SECTIONS).sort());
      expect(Object.values(sections[provider])).toEqual(Object.keys(SECTIONS).map(() => 0));
    }
  });
});

describe('providersOfContent', () => {
  it('matches the alias spellings the list endpoint matches', () => {
    expect(providersOfContent({ cloudProvider: 'Azure' })).toEqual(['azure']);
    expect(providersOfContent({ cloudProvider: 'azure' })).toEqual(['azure']);
    expect(providersOfContent({ 'Cloud Provider': 'Google Cloud' })).toEqual(['gcp']);
    expect(providersOfContent({ 'Cloud Provider': 'VMware' })).toEqual(['vmware']);
  });

  it('attributes nothing to a spelling the endpoint would not return', () => {
    // ARRAY_CONTAINS is an exact string match, so `AZURE` is served to nobody
    // and must be attributed to nobody here either.
    expect(providersOfContent({ cloudProvider: 'AZURE' })).toEqual([]);
    expect(providersOfContent({ cloudProvider: 'Oracle' })).toEqual([]);
    expect(providersOfContent({})).toEqual([]);
    expect(providersOfContent(null)).toEqual([]);
  });

  it('returns both when the two provider fields disagree', () => {
    // The endpoint ORs the two fields, so such a document is returned for both
    // providers and shows on both pages. Counting it once would hand one of
    // them a zero it has not earned.
    expect(providersOfContent({ 'Cloud Provider': 'Azure', cloudProvider: 'AWS' }).sort()).toEqual([
      'aws',
      'azure',
    ]);
  });
});

describe('countContentDocs', () => {
  const count = (docs) => countContentDocs(emptySections(), docs);

  it('counts a blog article for its provider', () => {
    const sections = count([published({ type: 'blog', cloudProvider: 'Azure' })]);
    expect(sections.azure.blog).toBe(1);
    expect(sections.aws.blog).toBe(0);
  });

  it('counts a document with no type as a blog article, because the page does', () => {
    // useBlogData excludes architecture and framework by denylist; everything
    // else, typed or not, renders on the blog listing.
    expect(count([published({ cloudProvider: 'Azure' })]).azure.blog).toBe(1);
  });

  it('keeps architecture and framework documents off the blog count', () => {
    const sections = count([
      published({ type: 'architecture', cloudProvider: 'Azure' }),
      published({ type: 'Framework', cloudProvider: 'Azure' }),
    ]);
    expect(sections.azure.blog).toBe(0);
    expect(sections.azure.frameworks).toBe(1);
  });

  it('gives coder-corner and code the same number — one query behind two routes', () => {
    const sections = count([published({ type: 'coder_corner', cloudProvider: 'Github' })]);
    expect(sections.github['coder-corner']).toBe(1);
    expect(sections.github.code).toBe(1);
    expect(sections.terraform.code).toBe(0);
  });

  it('ignores an unpublished or soft-deleted document', () => {
    const sections = count([
      { type: 'blog', cloudProvider: 'Azure', contentStatus: 'draft' },
      published({ type: 'blog', cloudProvider: 'Azure', softDeletedAt: '2026-09-01' }),
    ]);
    expect(sections.azure.blog).toBe(0);
  });

  it('accepts every publication spelling the listing accepts', () => {
    const sections = count([
      { type: 'blog', cloudProvider: 'Azure', Live: true },
      { type: 'blog', cloudProvider: 'Azure', Status: 'Live' },
      { type: 'blog', cloudProvider: 'Azure', contentStatus: 'published_blog' },
    ]);
    expect(sections.azure.blog).toBe(3);
  });

  it('sends an unattributable blog or framework to the bucket that blocks zeros', () => {
    const sections = count([
      published({ type: 'blog', cloudProvider: 'Broadcom' }),
      published({ type: 'framework' }),
    ]);
    expect(sections[UNATTRIBUTED].blog).toBe(1);
    expect(sections[UNATTRIBUTED].frameworks).toBe(1);
    expect(sections.vmware.blog).toBe(0);
  });

  it('counts an unattributable coder_corner nowhere at all', () => {
    // The page sends its provider to the API and the API matches a stored
    // field, so this document is fetched by no page. Putting it in the
    // unattributed bucket would keep eleven reachable-by-nobody pages in the
    // sitemap.
    const sections = count([published({ type: 'coder_corner', cloudProvider: 'Oracle' })]);
    expect(sections[UNATTRIBUTED]['coder-corner']).toBe(0);
    expect(sections[UNATTRIBUTED].code).toBe(0);
    expect(sections.aws['coder-corner']).toBe(0);
  });

  it('adds the legacy container into the same map, which is the whole point', () => {
    // The hooks fall back to `blogs` on exactly the providers this mechanism
    // is about to call empty, so a provider with nothing in `content` and
    // something in `blogs` must not read as zero. Called twice, once per
    // container, because that is how countSections uses it.
    const sections = emptySections();
    countContentDocs(sections, [published({ type: 'architecture', cloudProvider: 'Aws' })]);
    expect(sections.aws.blog).toBe(0);
    countContentDocs(sections, [published({ type: 'blog', cloudProvider: 'Aws' })]);
    expect(sections.aws.blog).toBe(1);
  });
});

describe('countPodcastDocs', () => {
  const count = (docs) => countPodcastDocs(emptySections(), docs);

  it('counts one row for both audio routes', () => {
    const sections = count([{ provider: 'azure', mediaUrl: 'https://cdn.example/a.mp3' }]);
    expect(sections.azure.audio).toBe(1);
    expect(sections.azure['audio-architecture']).toBe(1);
  });

  it('drops the rows the public listing drops', () => {
    const sections = count([
      { provider: 'azure', softDeletedAt: '2026-09-01' },
      { provider: 'azure', mediaUrl: 'https://mcdn.podbean.com/x.mp3', updatedAt: '2026-09-04T10:00:00.000Z' },
      { provider: 'azure', mediaUnavailableAt: '2026-09-05' },
    ]);
    expect(sections.azure.audio).toBe(0);
  });

  it('counts a row on a host the show returned to once the feed has refreshed it', () => {
    const sections = count([
      { provider: 'azure', mediaUrl: 'https://mcdn.podbean.com/y.mp3', updatedAt: '2026-10-13T06:30:00.000Z' },
    ]);
    expect(sections.azure.audio).toBe(1);
  });

  it('counts a provider-less row nowhere — the two live rows this is about', () => {
    // `c.provider = @provider` never matches them, so no provider page shows
    // them. Were they treated as unattributed, all sixteen audio pages would
    // stay advertised.
    const sections = count([{ id: 'a', mediaUrl: '' }, { provider: 'Azure' }]);
    expect(sections.azure.audio).toBe(0);
    expect(sections[UNATTRIBUTED].audio).toBe(0);
  });

  it("counts one episode of the site's show for every provider", () => {
    // The mirror image of #373: a page that HAS content and is not advertised.
    // `listPodcasts` returns a `main` row to every provider, so every
    // provider's audio page shows it — and a count that dropped it as an
    // unrecognised provider would keep all sixteen audio URLs out of the
    // sitemap while the pages played the show.
    const sections = count([{ provider: MAIN_PODCAST_PROVIDER, mediaUrl: 'https://cdn/x.mp3' }]);
    for (const provider of PROVIDERS) {
      expect(sections[provider].audio).toBe(1);
      expect(sections[provider]['audio-architecture']).toBe(1);
    }
    // Named, not guessed: the show is not an item of unknown provenance.
    expect(sections[UNATTRIBUTED].audio).toBe(0);
  });

  it("applies the listing's filters to the show as well", () => {
    // A retired-media or soft-deleted show episode is off every page, so it
    // must not hold sixteen URLs in the sitemap on its own.
    const sections = count([
      { provider: MAIN_PODCAST_PROVIDER, softDeletedAt: '2026-09-01' },
      { provider: MAIN_PODCAST_PROVIDER, mediaUrl: 'https://mcdn.podbean.com/x.mp3' },
    ]);
    expect(sections.azure.audio).toBe(0);
    expect(sections.aws.audio).toBe(0);
  });

  it('adds the show to a provider that also has its own episodes', () => {
    const sections = count([
      { provider: 'azure', mediaUrl: 'https://cdn/a.mp3' },
      { provider: MAIN_PODCAST_PROVIDER, mediaUrl: 'https://cdn/b.mp3' },
    ]);
    expect(sections.azure.audio).toBe(2);
    expect(sections.aws.audio).toBe(1);
  });
});

describe('countListenAndLearnDocs', () => {
  const count = (docs) => countListenAndLearnDocs(emptySections(), docs);

  it('counts a published episode that has audio', () => {
    const sections = count([{ provider: 'aws', status: 'published', audioUrl: '/api/x.mp3' }]);
    expect(sections.aws.audio).toBe(1);
    expect(sections.aws['audio-architecture']).toBe(1);
  });

  it('counts retired-host audio as none (#1119)', () => {
    const sections = count([
      { provider: 'azure', status: 'published', audioUrl: 'https://storage.googleapis.com/b/x.mp3' },
    ]);
    expect(sections.azure.audio).toBe(0);
  });

  it('drops an episode the listing omits', () => {
    const sections = count([
      { provider: 'aws', status: 'published' },
      { provider: 'aws', status: 'published', audioUrl: '' },
      { provider: 'aws', status: 'approved', audioUrl: '/api/x.mp3' },
      { provider: 'aws', status: 'published', audioUrl: '/api/x.mp3', softDeleteExpiresAt: '1' },
    ]);
    expect(sections.aws.audio).toBe(0);
  });
});

describe('the counting queries', () => {
  it('asks the content containers the same public question the listing asks', () => {
    // Two different definitions of published would count a different set of
    // documents than the page shows, and the failure is a page full of
    // articles dropped from the sitemap.
    expect(CONTENT_COUNT_QUERY).toContain(SQL_PUBLIC_CLAUSE);
    expect(CONTENT_COUNT_QUERY).toContain(SQL_NOT_SOFT_DELETED);
  });

  it('projects instead of selecting whole documents', () => {
    for (const query of [CONTENT_COUNT_QUERY, PODCAST_COUNT_QUERY, LISTEN_AND_LEARN_COUNT_QUERY]) {
      expect(query).not.toMatch(/SELECT TOP \d+ \*/);
      expect(query).toContain(`SELECT TOP ${SECTION_COUNT_WINDOW}`);
    }
  });

  it('fetches every field the JS filters read after the projection', () => {
    // A field dropped from the projection reads as absent, which turns
    // isPublicDocument false and empties every count silently.
    for (const field of ['Live', 'Status', 'contentStatus', 'softDeletedAt', 'type']) {
      expect(CONTENT_COUNT_FIELDS).toContain(field);
      expect(CONTENT_COUNT_QUERY).toContain(`c["${field}"]`);
    }
    for (const field of ['provider', 'mediaUrl', 'mediaUnavailableAt', 'updatedAt']) {
      expect(PODCAST_COUNT_QUERY).toContain(`c["${field}"]`);
    }
    for (const field of ['provider', 'status', 'audioUrl']) {
      expect(LISTEN_AND_LEARN_COUNT_QUERY).toContain(`c["${field}"]`);
    }
  });

  it('quotes the spaced provider field so the SQL is legal', () => {
    expect(CONTENT_COUNT_QUERY).toContain('c["Cloud Provider"]');
  });
});

describe('countSections', () => {
  /** A store whose rows depend on the container asked for. */
  const storeOf = (byContainer) => ({
    queryDocs: vi.fn(async (container) => byContainer[container] ?? []),
  });

  it('reads all four containers a section page can read', async () => {
    const store = storeOf({});
    await countSections({ store });
    const containers = store.queryDocs.mock.calls.map(([container]) => container);
    expect(containers.sort()).toEqual(
      ['blogs', 'content', LISTEN_AND_LEARN_EPISODE_CONTAINER, 'podcasts'].sort()
    );
    expect(store.queryDocs).toHaveBeenCalledWith(
      LISTEN_AND_LEARN_EPISODE_CONTAINER,
      LISTEN_AND_LEARN_COUNT_QUERY,
      [{ name: '@status', value: 'published' }]
    );
  });

  it('adds both content containers and both audio containers together', async () => {
    const store = storeOf({
      content: [published({ type: 'blog', cloudProvider: 'Azure' })],
      blogs: [published({ type: 'blog', cloudProvider: 'Aws' })],
      podcasts: [{ provider: 'gcp', mediaUrl: 'https://cdn.example/a.mp3' }],
      [LISTEN_AND_LEARN_EPISODE_CONTAINER]: [
        { provider: 'gcp', status: 'published', audioUrl: '/api/x.mp3' },
      ],
    });
    const sections = await countSections({ store });
    expect(sections.azure.blog).toBe(1);
    expect(sections.aws.blog).toBe(1);
    expect(sections.gcp.audio).toBe(2);
    expect(sections.ansible.blog).toBe(0);
    expect(sections[UNATTRIBUTED].blog).toBe(0);
  });

  it('answers null rather than a truncated count when a read fills its window', async () => {
    // The rows past the window are indistinguishable from rows that do not
    // exist, and the difference is whether a provider's page keeps its URL.
    const store = storeOf({
      content: Array.from({ length: SECTION_COUNT_WINDOW }, () =>
        published({ type: 'blog', cloudProvider: 'Azure' })
      ),
    });
    await expect(countSections({ store })).resolves.toBeNull();
  });

  it('treats a non-array response as no rows rather than throwing', async () => {
    const store = { queryDocs: vi.fn(async () => null) };
    const sections = await countSections({ store });
    expect(sections.azure.blog).toBe(0);
  });
});
