/**
 * What the manifest fetch says when it fails.
 *
 * This exists because of one sentence. The failure message used to read "a 403
 * usually means the per-run origin window is closed or has not propagated;
 * anything else is the app itself", and on 2026-08-31 a 404 was read as "the
 * app itself" — so the investigation went at a Function App reporting 121
 * registered functions and every health row green. The app was fine. The route
 * had simply never been deployed.
 *
 * A message is not usually worth a test. This one is, because it is the only
 * thing the nightly job leaves behind: nobody watches the run, they read the
 * one line in the failure email. Getting it wrong does not fail loudly — it
 * sends a person somewhere else, which is more expensive than no message.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS,
  buildManifest,
  describeFetchFailure,
  describeSectionCounts,
  sectionCounts,
  INTERVIEW_FIELDS,
  INTERVIEW_LIST_FIELDS,
  INTERVIEWS_ROUTE,
} from './build-content-manifest.mjs';

// `dirname(fileURLToPath(...))` rather than `new URL('..', import.meta.url)`:
// this file declares its own `const URL` below, which shadows the global and
// puts it in the temporal dead zone up here. The suite failed to import at all.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const URL = 'https://func-site-prod-cus-01.azurewebsites.net/api/public/content-manifest';

describe('describeFetchFailure', () => {
  it('sends a 403 at the origin window and nowhere else', () => {
    const message = describeFetchFailure(403, URL);
    expect(message).toContain('403');
    expect(message).toContain('origin window');
    // The distinguishing claim: a 403 is not a deploy problem.
    expect(message).not.toContain('Deploy Functions');
  });

  it('sends a 404 at the deployed revision, not at the app', () => {
    const message = describeFetchFailure(404, URL);
    expect(message).toContain('404');
    expect(message).toContain('Deploy Functions');
    expect(message).toContain('public-content-manifest.js');
    // THE ASSERTION THIS FILE EXISTS FOR. The old message routed a 404 to "the
    // app itself"; saying the host answered is what separates a missing deploy
    // from an outage.
    expect(message).toMatch(/host answered/i);
    expect(message).not.toMatch(/this is the app itself/i);
  });

  it('sends anything else at the app, and says why it is neither of the other two', () => {
    const message = describeFetchFailure(500, URL);
    expect(message).toContain('500');
    expect(message).toMatch(/this is the app itself/i);
    expect(message).toContain('403');
    expect(message).toContain('404');
  });

  it('names the URL in every case, so the line stands alone in an email', () => {
    for (const status of [403, 404, 500, 502]) {
      expect(describeFetchFailure(status, URL)).toContain(URL);
    }
  });
});

describe('buildManifest', () => {
  const azure = (id, slug) => ({
    id,
    slug,
    cloudProvider: 'azure',
    title: `Item ${id}`,
  });

  it('lists one route per slug and names the duplicates it dropped', () => {
    // The live sitemap of 2026-09-06 carried one blog URL three times because
    // the published set held the same slug three times (issue #373).
    const manifest = buildManifest([
      azure('a1', 'enable-ai-powered-discovery'),
      azure('a2', 'enable-ai-powered-discovery'),
      azure('a3', 'another-article'),
      azure('a4', 'enable-ai-powered-discovery'),
    ]);

    expect(manifest.routes).toEqual([
      '/azure/blog/enable-ai-powered-discovery',
      '/azure/blog/another-article',
    ]);
    expect(manifest.skipped).toEqual([
      'enable-ai-powered-discovery: duplicate slug (item a2); first occurrence kept',
      'enable-ai-powered-discovery: duplicate slug (item a4); first occurrence kept',
    ]);
  });

  it('keeps the first occurrence, not the last', () => {
    const manifest = buildManifest([
      { ...azure('a1', 'same'), title: 'first' },
      { ...azure('a2', 'same'), title: 'second' },
    ]);
    expect(manifest.data['article:same'].title).toBe('first');
  });

  it('pre-renders a Docker article at /docker/blog/<slug> (#776)', () => {
    // `Docker` is how the CMS writes the provider; the URL segment is lower case.
    const manifest = buildManifest([
      { id: 'd1', slug: 'multi-stage-builds', cloudProvider: 'Docker', title: 'Multi-stage' },
    ]);
    expect(manifest.routes).toEqual(['/docker/blog/multi-stage-builds']);
    expect(manifest.data['article:multi-stage-builds'].title).toBe('Multi-stage');
    expect(manifest.skipped).toEqual([]);
  });
});

describe('PROVIDERS', () => {
  it('is exactly the providers the frontend routes, VALID_PROVIDERS', () => {
    // Read as text: the frontend module is JSX and imports React. A provider
    // the router serves but this list lacks gets no pre-rendered article
    // pages, which is how Docker's would have stayed shells.
    const source = readFileSync(
      join(REPO, 'frontend', 'src', 'context', 'ProviderContext.jsx'),
      'utf8'
    );
    const block = /export const VALID_PROVIDERS = \[([^\]]*)\]/.exec(source);
    expect(block, 'VALID_PROVIDERS not found in ProviderContext.jsx').not.toBeNull();
    const valid = [...block[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    expect(valid.length).toBeGreaterThan(5);
    expect([...PROVIDERS].sort()).toEqual([...valid].sort());
  });
});

describe('sectionCounts', () => {
  const doc = (provider, type) => ({
    id: `${provider}-${type}`,
    slug: `${provider}-${type}`,
    cloudProvider: provider,
    type,
  });

  it('is null when no item carries type — unknown must not read as zero', () => {
    expect(sectionCounts([{ id: 'a', slug: 'a', cloudProvider: 'azure' }])).toBeNull();
    expect(sectionCounts([])).toBeNull();
  });

  it('treats a null, non-string or empty type as absent, not as a type of nothing', () => {
    // Copilot review of #388: `type: null` used to count as present and return
    // a map of zeros, which would have dropped every frameworks page.
    expect(sectionCounts([{ id: 'a', slug: 'a', cloudProvider: 'azure', type: null }])).toBeNull();
    expect(sectionCounts([{ id: 'b', slug: 'b', cloudProvider: 'azure', type: 7 }])).toBeNull();
    expect(sectionCounts([{ id: 'c', slug: 'c', cloudProvider: 'azure', type: '  ' }])).toBeNull();
    const mixed = sectionCounts([
      { id: 'd', slug: 'd', cloudProvider: 'azure', type: null },
      doc('aws', 'framework'),
    ]);
    expect(mixed.aws.frameworks).toBe(1);
    expect(mixed.azure.frameworks).toBe(0);
  });

  it('counts framework items per provider, case-insensitively on type', () => {
    const sections = sectionCounts([
      doc('azure', 'framework'),
      doc('azure', 'Framework'),
      doc('aws', 'blog'),
      { id: 'x', slug: 'x', cloudProvider: 'gcp', type: 'framework' },
    ]);
    expect(sections.azure.frameworks).toBe(2);
    expect(sections.gcp.frameworks).toBe(1);
    expect(sections.aws.frameworks).toBe(0);
    expect(sections.finops.frameworks).toBe(0);
    expect(sections._unattributed.frameworks).toBe(0);
  });

  it('counts architecture items per provider, and not as frameworks', () => {
    // The fallback path can speak for architecture-designs for the same reason
    // it can speak for frameworks, and with a stronger claim: a zero it
    // produces only drops a route whose architecture-blueprints.js is also
    // empty, and the one provider that is true of — VMware — has a page that
    // reads the `content` container this script is handed and nothing else.
    const sections = sectionCounts([
      doc('azure', 'architecture'),
      doc('vmware', 'framework'),
      doc('aws', 'blog'),
    ]);
    expect(sections.azure['architecture-designs']).toBe(1);
    expect(sections.azure.frameworks).toBe(0);
    expect(sections.vmware['architecture-designs']).toBe(0);
    expect(sections.aws['architecture-designs']).toBe(0);
  });

  it('counts a framework with no recognised provider as unattributed', () => {
    const sections = sectionCounts([
      { id: 'u', slug: 'u', type: 'framework' },
      { id: 'v', slug: 'v', cloudProvider: 'Oracle', type: 'framework' },
    ]);
    expect(sections._unattributed.frameworks).toBe(2);
    expect(sections.azure.frameworks).toBe(0);
  });

  it('is carried on the manifest', () => {
    const manifest = buildManifest([doc('azure', 'framework')]);
    expect(manifest.sections.azure.frameworks).toBe(1);
    expect(buildManifest([{ id: 'a', slug: 'a', cloudProvider: 'azure' }]).sections).toBeNull();
  });
});

describe('sections the manifest route computed (issue #373)', () => {
  const doc = (provider, type) => ({
    id: `${provider}-${type}`,
    slug: `${provider}-${type}`,
    cloudProvider: provider,
    type,
  });

  /**
   * The sections the route's contract declares, read as TEXT from `functions/`.
   *
   * `scripts/` and `functions/` are independent npm packages with no workspace
   * between them, so this cannot import the constant — the same trade
   * `functions/src/lib/public-content-manifest.test.js` makes in the other
   * direction when it parses ARTICLE_FIELDS out of this package.
   *
   * Derived rather than restated because restating it failed exactly once and
   * silently: the fixture below was written out by hand, called itself "every
   * section", and omitted `audio-architecture` — so a section dropped from the
   * response would have passed this suite.
   */
  function routeSectionNames() {
    const source = readFileSync(
      join(REPO, 'functions', 'src', 'lib', 'public-section-counts.js'),
      'utf8'
    );
    const block = source.match(/SECTIONS = Object\.freeze\(\{([\s\S]*?)\}\);/);
    if (!block) {
      throw new Error('SECTIONS not found in functions/src/lib/public-section-counts.js');
    }
    return [...block[1].matchAll(/^\s*'?([a-z-]+)'?:\s*\{/gm)].map((m) => m[1]);
  }

  /** One provider's counts, every declared section present, zero unless named. */
  const counts = (values = {}) =>
    Object.fromEntries(routeSectionNames().map((section) => [section, values[section] ?? 0]));

  /** The route's answer: every section, across containers this script never sees. */
  const fromRoute = {
    azure: counts({ blog: 21 }),
    aws: counts({ blog: 1 }),
    _unattributed: counts(),
  };

  it('is shaped like the real response, section for section', () => {
    // The guard on the parse comes first: a regex that silently matched
    // nothing would make every assertion below vacuous, which is the failure
    // mode a derived fixture introduces in exchange for the one it removes.
    const names = routeSectionNames();
    expect(names.length).toBeGreaterThan(4);
    expect(names).toContain('audio-architecture');
    for (const provider of Object.keys(fromRoute)) {
      expect(Object.keys(fromRoute[provider]).sort()).toEqual([...names].sort());
    }
  });

  it('is preferred over the local count, which can only speak for frameworks', () => {
    // The local count sees the `content` corpus this script was handed and
    // nothing else — not the legacy `blogs` container the listing hooks fall
    // back to, not `podcasts`, not Listen & Learn. Its zero for those sections
    // would be a zero about the wrong set of documents.
    const manifest = buildManifest([doc('azure', 'framework')], fromRoute);
    expect(manifest.sections).toBe(fromRoute);
    expect(manifest.sections.aws.blog).toBe(1);
    expect(manifest.sections.azure.frameworks).toBe(0);
  });

  it('falls back to the local frameworks count when the route sent none', () => {
    // The route is deployed by hand and this script runs nightly, so the two
    // are briefly out of step every time. In that window the five frameworks
    // pages must not return to the sitemap.
    for (const absent of [undefined, null]) {
      expect(buildManifest([doc('azure', 'framework')], absent).sections.azure.frameworks).toBe(1);
    }
  });

  it('rejects a body that is not a map of counts rather than half-reading it', () => {
    // `sections[provider][section]` on a string or an array answers undefined,
    // which the pre-render reads as "no count for this section" — the same
    // answer as a healthy older manifest, and therefore invisible.
    for (const wrong of ['sections', 42, [], true]) {
      expect(buildManifest([doc('azure', 'framework')], wrong).sections.azure.frameworks).toBe(1);
    }
  });
});

describe('describeSectionCounts', () => {
  const doc = (provider, type) => ({
    id: `${provider}-${type}`,
    slug: `${provider}-${type}`,
    cloudProvider: provider,
    type,
  });

  it('says the route counted them, and how wide the map is', () => {
    const sections = { gcp: { blog: 0, frameworks: 0, audio: 2 } };
    const line = describeSectionCounts(sections, true);
    expect(line).toContain('from the route');
    expect(line).toContain('3 per provider');
  });

  it('reads the width off whatever provider it has, not off azure by name', () => {
    // Hardcoding `azure` reported 0 for a perfectly good map that happened not
    // to mention it — a zero-width claim about a map with counts in it.
    expect(describeSectionCounts({ vmware: { blog: 0, audio: 0 } }, true)).toContain(
      '2 per provider'
    );
  });

  it('says the local count ran only when it produced something', () => {
    const local = buildManifest([doc('azure', 'framework')]).sections;
    expect(local).not.toBeNull();
    expect(describeSectionCounts(local, false)).toContain('counted frameworks locally');
  });

  it('does not claim a local count when there was none', () => {
    // THE CASE THIS FUNCTION EXISTS FOR. `sectionCounts()` returns null when no
    // item carries a `type`, which is exactly what an older deployed revision
    // sends during the upgrade window this line is read in — and the message
    // used to say "counted frameworks locally" regardless.
    const none = buildManifest([{ id: 'a', slug: 'a', cloudProvider: 'azure' }]).sections;
    expect(none).toBeNull();
    const line = describeSectionCounts(none, false);
    expect(line).not.toContain('counted frameworks locally');
    expect(line).toContain('no item carries a type');
    // And it says what follows from that, which is the part a reader acts on.
    expect(line).toContain('no section page leaves the sitemap');
  });
});

describe('interviews on the manifest (ADR 0040, D6)', () => {
  const interview = (slug, over = {}) => ({
    id: `i-${slug}`,
    slug,
    title: `Interview ${slug}`,
    date: '2026-10-01',
    guest: { name: 'Test Guest' },
    tags: ['landing-zones'],
    qa: [{ q: 'Q?', a: 'A.' }],
    bio: 'A bio.',
    ...over,
  });

  it('lists the list page and one page per interview, newest first, with seeds keyed as usePublicData keys them', () => {
    const manifest = buildManifest(
      [],
      null,
      [interview('older-one', { date: '2026-03-01' }), interview('newest-one'), interview('also-newest')]
    );
    expect(manifest.routes).toEqual([
      INTERVIEWS_ROUTE,
      '/azure/interviews/also-newest',
      '/azure/interviews/newest-one',
      '/azure/interviews/older-one',
    ]);
    expect(manifest.data['interviews:list'].map((item) => item.slug)).toEqual([
      'also-newest',
      'newest-one',
      'older-one',
    ]);
    // The list carries the card fields only; the page seed carries the article.
    expect(Object.keys(manifest.data['interviews:list'][0]).sort()).toEqual(
      [...INTERVIEW_LIST_FIELDS].filter((f) => f !== 'subtitle' && f !== 'publishedAt').sort()
    );
    expect(manifest.data['interview:newest-one']).toEqual({
      slug: 'newest-one',
      title: 'Interview newest-one',
      date: '2026-10-01',
      guest: { name: 'Test Guest' },
      tags: ['landing-zones'],
      qa: [{ q: 'Q?', a: 'A.' }],
      bio: 'A bio.',
    });
  });

  it('lists no interview route while there is no interview: an empty list page would be thin content', () => {
    const manifest = buildManifest([], null, []);
    expect(manifest.routes.filter((route) => route.includes('interviews'))).toEqual([]);
    expect(manifest.data).not.toHaveProperty('interviews:list');
    expect(buildManifest([], null).routes).toEqual([]);
  });

  it('skips a bad or repeated slug and says so', () => {
    const manifest = buildManifest(
      [],
      null,
      [interview('first-one'), interview('first-one'), interview('Not A Slug'), { id: 'no-slug' }]
    );
    expect(manifest.routes).toEqual([INTERVIEWS_ROUTE, '/azure/interviews/first-one']);
    expect(manifest.skipped).toEqual([
      'interview first-one: duplicate slug; first occurrence kept',
      'interview i-Not A Slug: no usable slug',
      'interview no-slug: no usable slug',
    ]);
  });

  it('never pre-renders an interview as an article, however it arrived', () => {
    const manifest = buildManifest([
      { id: 'i1', slug: 'a-conversation', cloudProvider: 'azure', type: 'interview' },
      { id: 'a1', slug: 'a-post', cloudProvider: 'azure', type: 'blog' },
    ]);
    expect(manifest.routes).toEqual(['/azure/blog/a-post']);
    expect(manifest.skipped).toEqual(['a-conversation: an interview, not an article']);
  });

  it('keeps the list fields as the first of the detail fields, so the two projections agree', () => {
    expect([...INTERVIEW_FIELDS].slice(0, INTERVIEW_LIST_FIELDS.length)).toEqual([...INTERVIEW_LIST_FIELDS]);
    expect(INTERVIEW_FIELDS).toContain('qa');
    expect(INTERVIEW_FIELDS).not.toContain('consent');
  });
});
