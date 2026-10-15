/**
 * The manifest route, and the field list it must not let drift.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTICLE_FIELDS,
  OFF_SITE_STATUSES,
  PUBLISHED_PREDICATE,
  PUBLISHED_QUERY,
  createPublicContentManifestHandlers,
  projectArticle,
} from './public-content-manifest.js';
import { SQL_NOT_SOFT_DELETED, SQL_PUBLIC_CLAUSE, isPublicDocument } from './public-reads.js';
import { buildStatusUpdateData } from './cms/content-status.js';
import { evaluatePredicate } from '../../test/cosmos-predicate.js';

const REPO = join(fileURLToPath(new URL('../../..', import.meta.url)));

describe('ARTICLE_FIELDS stays in step with scripts/', () => {
  /**
   * Read as TEXT rather than imported: `scripts/` is a separate npm package
   * with its own dependencies, and importing across that boundary from a
   * functions test coupled two installs that are otherwise independent.
   */
  function scriptsFieldList() {
    const source = readFileSync(join(REPO, 'scripts', 'build-content-manifest.mjs'), 'utf8');
    const block = source.match(/ARTICLE_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    if (!block) throw new Error('ARTICLE_FIELDS not found in scripts/build-content-manifest.mjs');
    return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it('finds a plausible list at all — a silent parse failure would pass everything', () => {
    expect(scriptsFieldList().length).toBeGreaterThan(30);
  });

  it('is exactly the list scripts/ projects with, in the same order', () => {
    // Drift here is invisible: a field added there but not here is simply
    // absent from every pre-rendered article, which presents as a rendering
    // bug in the static HTML and nowhere else.
    expect([...ARTICLE_FIELDS]).toEqual(scriptsFieldList());
  });
});

describe('projectArticle', () => {
  it('keeps allowlisted fields and drops everything else', () => {
    const out = projectArticle({
      id: 'a1',
      slug: 'x',
      cloudProvider: 'azure',
      Title: 'T',
      internalReviewNotes: 'SECRET',
      forgeGrade: { overall: 9 },
      _etag: 'etag',
    });
    expect(out).toEqual({ id: 'a1', slug: 'x', cloudProvider: 'azure', Title: 'T' });
    expect(out.internalReviewNotes).toBeUndefined();
    expect(out.forgeGrade).toBeUndefined();
    expect(out._etag).toBeUndefined();
  });

  it('omits absent fields rather than emitting undefined', () => {
    expect(Object.keys(projectArticle({ id: 'a1' }))).toEqual(['id']);
  });

  it('survives null and undefined without throwing', () => {
    expect(projectArticle(null)).toEqual({});
    expect(projectArticle(undefined)).toEqual({});
  });
});

describe('getManifest', () => {
  const handlers = (queryDocs) => createPublicContentManifestHandlers({ store: { queryDocs } });

  it('asks for published documents in the query, not by filtering after', () => {
    // The distinction is the safety property: a filter applied after the fact
    // is one refactor away from being dropped, and the failure mode is an
    // unpublished article on a public URL.
    //
    // COMPARED WHOLE, against a string rebuilt from ARTICLE_FIELDS. Shape
    // assertions are not enough and this test learned it twice: substring
    // checks passed a query with the clause commented out (`-- WHERE ...`),
    // and the hardened version still passed `... OR true`. Nothing short of
    // comparing the entire string catches every permissive predicate, and this
    // is the string that decides whether an unpublished document reaches a
    // public URL.
    //
    // Rebuilding the expectation rather than pasting it keeps the field list
    // as the single source — a field added to ARTICLE_FIELDS updates both
    // sides — while still failing on any edit to the predicate or the shape.
    const projection = ARTICLE_FIELDS.map((f) => `c["${f}"]`).join(', ');
    expect(PUBLISHED_QUERY).toBe(
      `SELECT ${projection} FROM c WHERE ${PUBLISHED_PREDICATE}`
    );
    // Written out whole, not rebuilt from public-reads.js: a permissive edit
    // to the public clause has to fail here too, not ride in by import.
    const notSoftDeleted = (field) =>
      `(NOT IS_DEFINED(c.${field}) OR IS_NULL(c.${field}) OR c.${field} = "" OR c.${field} = false OR c.${field} = 0)`;
    expect(PUBLISHED_PREDICATE).toBe(
      '(c.Live = true OR c.Status = "Live" OR c.contentStatus IN ("published", "published_blog", "published_news", "published_both"))' +
        ` AND ${notSoftDeleted('softDeletedAt')}` +
        ` AND ${notSoftDeleted('softDeleteExpiresAt')}` +
        ' AND (NOT IS_STRING(c.contentStatus) OR NOT (c.contentStatus IN ("archived", "rejected", "drafting")))'
    );
    expect(PUBLISHED_QUERY).not.toMatch(/--/);
    expect(PUBLISHED_QUERY).not.toMatch(/\/\*/);
  });

  it('asks the public API’s own question, narrowed by nothing but the off-site statuses (AP-F13, #937)', () => {
    // By construction: the list route and the section counts query with these
    // two clauses, so the manifest cannot drift from them.
    expect(PUBLISHED_PREDICATE.startsWith(`${SQL_PUBLIC_CLAUSE} AND ${SQL_NOT_SOFT_DELETED} AND `)).toBe(
      true
    );
    expect(OFF_SITE_STATUSES).toEqual(['archived', 'rejected', 'drafting']);
  });

  it('projects in SQL so unlisted fields never leave Cosmos', () => {
    // The JS projection is defence in depth; this is the part that stops whole
    // documents — article bodies and internal fields alike — crossing the wire
    // for a daily bulk read.
    expect(PUBLISHED_QUERY).not.toMatch(/SELECT \*/);
    for (const field of ARTICLE_FIELDS) {
      expect(PUBLISHED_QUERY, `${field} missing from the projection`).toContain(`c["${field}"]`);
    }
    // Bracket quoting is what makes the spaced and cased names legal SQL.
    for (const spaced of ['Published At', 'Cloud Provider', 'Source URL', 'CD Url']) {
      expect(PUBLISHED_QUERY).toContain(`c["${spaced}"]`);
    }
  });

  it('projects every row and reports the count', async () => {
    const queryDocs = vi.fn().mockResolvedValue([
      { id: '1', slug: 'a', Title: 'A', internalNote: 'no' },
      { id: '2', slug: 'b', Title: 'B' },
    ]);
    const res = await handlers(queryDocs).getManifest({}, {});
    expect(res.status).toBe(200);
    expect(res.jsonBody.count).toBe(2);
    expect(res.jsonBody.items[0].internalNote).toBeUndefined();
    expect(queryDocs).toHaveBeenCalledWith('content', PUBLISHED_QUERY, []);
  });

  it('is uncacheable — a cached copy pre-renders yesterday’s corpus', () => {
    // Asserted on the constant rather than a live call so it cannot regress
    // behind a mocked store.
    return handlers(vi.fn().mockResolvedValue([])).getManifest({}, {}).then((res) => {
      expect(res.headers['Cache-Control']).toBe('no-store');
    });
  });

  it('returns an empty list rather than throwing when the store returns nothing', async () => {
    for (const empty of [[], null, undefined]) {
      const res = await handlers(vi.fn().mockResolvedValue(empty)).getManifest({}, {});
      expect(res.status).toBe(200);
      expect(res.jsonBody.items).toEqual([]);
    }
  });

  it('answers 500 without leaking the error, and logs it', async () => {
    const error = vi.fn();
    const res = await handlers(vi.fn().mockRejectedValue(new Error('cosmos exploded'))).getManifest(
      {},
      { error }
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain('cosmos exploded');
    expect(error).toHaveBeenCalled();
  });

  it('tolerates a bare invocation, as route-inventory makes', async () => {
    await expect(
      handlers(vi.fn().mockResolvedValue([])).getManifest(undefined, undefined)
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe('PUBLISHED_PREDICATE, evaluated against documents (AP-F13, #937)', () => {
  /** A page the site serves, saying so every way a document can. */
  const liveEveryWay = () => ({
    id: 'c1',
    contentStatus: 'published',
    Live: true,
    Status: 'Live',
    status: 'published',
  });
  /** The document after a transition's patch: patchDoc's `undefined` deletes. */
  const applyTransition = (doc, status) => {
    const patch = buildStatusUpdateData(doc, status, 'r', '', {
      now: new Date('2026-10-15T00:00:00.000Z'),
    });
    const next = { ...doc };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  };

  it.each(['archived', 'rejected'])('leaves out a page %s through the state machine', (status) => {
    const doc = applyTransition(liveEveryWay(), status);
    expect(evaluatePredicate(PUBLISHED_PREDICATE, doc)).toBe(false);
    expect(isPublicDocument(doc)).toBe(false);
  });

  it('leaves out an archived or rejected page whatever legacy word it still carries', () => {
    // Taken down before the appliers retired the legacy Status word, or by a
    // writer that never touched the lowercase one. The old predicate admitted
    // the first through `status = 'published'`; the other two still say live.
    for (const contentStatus of ['archived', 'rejected']) {
      for (const doc of [
        { contentStatus, Live: false, status: 'published' },
        { contentStatus, Live: false, Status: 'Live' },
        { contentStatus, Live: true },
      ]) {
        expect(evaluatePredicate(PUBLISHED_PREDICATE, doc), JSON.stringify(doc)).toBe(false);
      }
    }
  });

  it('leaves out what the API answers 404 for, and keeps what it serves', () => {
    const cases = [
      // The API does not serve these: only a legacy word, soft-deleted, a draft.
      [{ Status: 'Published' }, false],
      [{ status: 'published' }, false],
      [{ contentStatus: 'published', softDeletedAt: '2026-10-01T00:00:00.000Z' }, false],
      [{ contentStatus: 'published', softDeleteExpiresAt: '2026-10-02T00:00:00.000Z' }, false],
      [{ contentStatus: 'drafting', Live: true }, false],
      [{ contentStatus: 'in_review', Live: false }, false],
      // It does serve these, and so the pre-render lists them.
      [{ contentStatus: 'published' }, true],
      [{ contentStatus: 'published', Live: false }, true],
      [{ contentStatus: 'published_blog' }, true],
      [{ contentStatus: 'editing', Live: true }, true],
      [{ contentStatus: 'in_review', Status: 'Live' }, true],
      [{ Live: true }, true],
      [{ contentStatus: null, Live: true }, true],
      [{ contentStatus: 'published', softDeletedAt: '' }, true],
    ];
    for (const [doc, expected] of cases) {
      expect(evaluatePredicate(PUBLISHED_PREDICATE, doc), JSON.stringify(doc)).toBe(expected);
      // The API's own answer, so the two agree on every row here.
      expect(isPublicDocument(doc), JSON.stringify(doc)).toBe(expected);
    }
  });
});

describe('the section counts it carries (issue #373)', () => {
  /** A store that answers per container, as the real one does. */
  const storeOf = (byContainer) => vi.fn(async (container) => byContainer[container] ?? []);

  const published = (fields) => ({ contentStatus: 'published', ...fields });

  it('counts what the section pages read, across every container they read', async () => {
    const queryDocs = storeOf({
      content: [published({ id: '1', slug: 'a', type: 'blog', cloudProvider: 'Azure' })],
      blogs: [published({ id: '2', slug: 'b', type: 'blog', cloudProvider: 'Aws' })],
      podcasts: [{ provider: 'gcp', mediaUrl: 'https://cdn.example/a.mp3' }],
      listen_and_learn_episodes: [
        { provider: 'gcp', status: 'published', audioUrl: '/api/public/media/x.mp3' },
      ],
    });
    const res = await createPublicContentManifestHandlers({ store: { queryDocs } }).getManifest(
      {},
      {}
    );

    expect(res.status).toBe(200);
    // The corpus is still only `content` — the counts read wider, the items
    // do not.
    expect(res.jsonBody.count).toBe(1);
    expect(res.jsonBody.sections.azure.blog).toBe(1);
    // The legacy `blogs` container is reached by the listing hooks on exactly
    // the providers with nothing in `content` — the ones about to be declared
    // empty — so it has to be in the count.
    expect(res.jsonBody.sections.aws.blog).toBe(1);
    expect(res.jsonBody.sections.gcp.audio).toBe(2);
    expect(res.jsonBody.sections.ansible['coder-corner']).toBe(0);
  });

  it('fails the whole route when a counting read fails', async () => {
    // Deliberate: answering 200 with no counts is a quiet degradation whose
    // only visible effect is empty pages returning to the sitemap a deploy
    // later. A 500 fails the manifest workflow and leaves the committed
    // manifest — counts included — exactly where it was.
    const error = vi.fn();
    const queryDocs = vi.fn(async (container) => {
      if (container === 'podcasts') throw new Error('cosmos exploded');
      return [];
    });
    const res = await createPublicContentManifestHandlers({ store: { queryDocs } }).getManifest(
      {},
      { error }
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain('cosmos exploded');
  });
});
