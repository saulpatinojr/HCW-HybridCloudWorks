/**
 * The pure half of reading a draft: which paths pass the allow-list, how a
 * draft's front matter is read, and the document it becomes. The Drafts
 * page's markdown upload (drafts-markdown.js) uses the same parser.
 *
 * The three sample drafts are synthetic fixtures in ./__fixtures__, written
 * to the contract in docs/content/blog-template.md. They are .txt files because
 * the repository structure check allows Markdown only under docs/. They hold no real article
 * text: pre-publish drafts do not live in this public repository (owner rule
 * 2026-10-25), so the real files are not here to be read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_PATH_PREFIX,
  CONTRACT_DOC_PATHS,
  RAW_ORIGIN,
  RAW_PATH_PREFIX,
  REPO_DRAFT_ID_NAMESPACE,
  REPO_DRAFT_ID_REPOSITORY,
  REPO_OWNER,
  blobUrlFor,
  buildRepoDraftData,
  checkRepoDraftPath,
  countEmbedFences,
  findRepoRelativeLinks,
  inferProviderFromTags,
  parseFrontMatter,
  parseInlineList,
  parseRepoDraft,
  rawUrlFor,
  repoDraftContentId,
  sha256Hex,
} from './repo-draft.js';
import { createContentDocument } from './content-create.js';

const SAMPLE_DRAFTS = Object.freeze([
  'docs/content/blog-sample-01-first-part.md',
  'docs/content/blog-sample-02-second-part.md',
  'docs/content/blog-sample-03-third-part.md',
]);

/** A sample draft's text, from the fixture with the same file name. */
const readRepoFile = (path) =>
  readFileSync(
    new URL(`./__fixtures__/${path.split('/').at(-1).replace(/\.md$/, '.txt')}`, import.meta.url),
    'utf8'
  );

/** The fence every sample draft embeds, as written in the files. */
const EMBED_FENCE = '```landing-zone\nlz=mg,policy,mgmt,hub&corp=0&online=0\n```';

const SOURCE = Object.freeze({
  commitSha: '2fb230c9ac7118c4f87d4cf8031e0571d47e74d8',
  rawUrl:
    'https://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-sample-01-first-part.md',
  contentSha256: 'a'.repeat(64),
});
const FIXED_NOW = () => new Date('2026-09-28T12:00:00.000Z');

describe('checkRepoDraftPath — the allow-list', () => {
  it.each(SAMPLE_DRAFTS)('admits %s', (path) => {
    expect(checkRepoDraftPath(path)).toEqual({ ok: true, path });
  });

  it.each([
    ['a traversal out of the directory', 'docs/content/../../infra/main.tf'],
    [
      'a traversal that lands back on a blog name',
      'docs/content/../content/blog-sample-01-first-part.md',
    ],
    ['a leading traversal', '../docs/content/blog-sample-01-first-part.md'],
    ['an encoded traversal', 'docs/content/%2e%2e/blog-x.md'],
    ['a Windows separator', 'docs\\content\\blog-x.md'],
    ['an absolute path', '/docs/content/blog-sample-01-first-part.md'],
    ['a URL', 'https://raw.githubusercontent.com/x/y/main/docs/content/blog-x.md'],
    ['another directory', 'docs/architecture/blog-x.md'],
    ['a subdirectory', 'docs/content/drafts/blog-x.md'],
    ['a file that is not a blog post', 'docs/content/index.md'],
    ['another extension', 'docs/content/blog-x.mdx'],
    ['an upper-case name', 'docs/content/blog-Lab-01.md'],
    ['an upper-case extension', 'docs/content/blog-x.MD'],
    ['a trailing newline', 'docs/content/blog-x.md\n'],
    ['a query string', 'docs/content/blog-x.md?ref=dev'],
    ['the empty string', ''],
  ])('refuses %s', (_label, path) => {
    expect(checkRepoDraftPath(path).ok).toBe(false);
  });

  it.each(CONTRACT_DOC_PATHS)('refuses the contract document %s by name', (path) => {
    const check = checkRepoDraftPath(path);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/contract/);
  });

  it.each([[undefined], [null], [42], [['docs/content/blog-x.md']], [{ path: 'x' }]])(
    'refuses a non-string (%j)',
    (value) => {
      expect(checkRepoDraftPath(value).ok).toBe(false);
    }
  );

  it('refuses an over-long path before the pattern runs', () => {
    expect(checkRepoDraftPath(`docs/content/blog-${'a'.repeat(200)}.md`).ok).toBe(false);
  });

  it('builds the one raw URL a checked path may come from, and the GitHub page', () => {
    const url = new URL(rawUrlFor(SAMPLE_DRAFTS[0]));
    expect(url.origin).toBe(RAW_ORIGIN);
    expect(url.pathname.startsWith(RAW_PATH_PREFIX)).toBe(true);
    expect(url.href).toBe(
      'https://raw.githubusercontent.com/saulpatinojr/HCW-HybridCloudWorks/main/docs/content/blog-sample-01-first-part.md'
    );
    expect(blobUrlFor(SAMPLE_DRAFTS[0])).toBe(
      'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/content/blog-sample-01-first-part.md'
    );
  });
});

describe('parseFrontMatter — the tooling/workflow.py frontmatter() port', () => {
  it('reads key: value lines from an anchored block and returns the text after it', () => {
    const { fields, body } = parseFrontMatter('---\ntitle: One\nreading: 9\n---\n\nBody here.\n');
    expect(fields).toEqual({ title: 'One', reading: '9' });
    expect(body).toBe('\nBody here.\n');
  });

  it('drops a trailing " #" comment, skips a value that is only a comment, strips quotes', () => {
    const { fields } = parseFrontMatter(
      "---\ntitle: 'Quoted'\nsubtitle: plain text # a comment\ntrack: # how-to | build-log\n---\nx"
    );
    expect(fields).toEqual({ title: 'Quoted', subtitle: 'plain text' });
  });

  it('takes a quoted value whole, so a quoted title may contain " #"', () => {
    const { fields } = parseFrontMatter('---\ntitle: "Closing issue #400"\n---\nx');
    expect(fields.title).toBe('Closing issue #400');
  });

  it('keeps everything after the first colon in the value', () => {
    expect(parseFrontMatter('---\ntitle: Terraform: the plan\n---\nx').fields.title).toBe(
      'Terraform: the plan'
    );
  });

  it('reads CRLF files and a byte-order mark the same as LF ones', () => {
    const { fields, body } = parseFrontMatter('﻿---\r\ntitle: One\r\n---\r\nBody\r\n');
    expect(fields).toEqual({ title: 'One' });
    expect(body).toBe('Body\n');
  });

  it('returns null fields when the file does not open with a block', () => {
    expect(parseFrontMatter('# Title\n\n---\ntitle: late\n---\n').fields).toBeNull();
    expect(parseFrontMatter('').fields).toBeNull();
  });

  it('reads the inline tag list every post writes', () => {
    expect(parseInlineList('[azure, terraform, iac, landing-zone]')).toEqual([
      'azure',
      'terraform',
      'iac',
      'landing-zone',
    ]);
    expect(parseInlineList('[\'a\', "b", , c]')).toEqual(['a', 'b', 'c']);
    expect(parseInlineList('')).toEqual([]);
    expect(parseInlineList(Array.from({ length: 20 }, (_, i) => `t${i}`).join(','))).toHaveLength(
      12
    );
  });
});

describe('parseRepoDraft — refusals and warnings', () => {
  it.each([
    ['NO_FRONT_MATTER', '# Just a heading\n\nText.'],
    ['NO_TITLE', '---\nsubtitle: no title\n---\nText.'],
    ['EMPTY_BODY', '---\ntitle: Only front matter\n---\n\n\n'],
    ['TITLE_TOO_LONG', `---\ntitle: ${'x'.repeat(301)}\n---\nText.`],
  ])('refuses with %s', (code, text) => {
    const parsed = parseRepoDraft(text);
    expect(parsed).toMatchObject({ ok: false, code });
    expect(parsed.error).toEqual(expect.any(String));
  });

  it('ignores a malformed date or reading with a warning instead of refusing the article', () => {
    const parsed = parseRepoDraft('---\ntitle: T\ndate: 2026-13-45\nreading: soon\n---\nText.');
    expect(parsed.ok).toBe(true);
    expect(parsed.draft.date).toBeNull();
    expect(parsed.draft.reading).toBeNull();
    expect(parsed.draft.warnings).toEqual([
      'date "2026-13-45" is not YYYY-MM-DD and was ignored',
      'reading "soon" is not a number of minutes and was ignored',
    ]);
  });

  it('finds repository-relative links and leaves site and external links alone', () => {
    expect(
      findRepoRelativeLinks(
        '[a](blog-sample-02-second-part.md) [b](../content/x.md#part) [c](https://example.com/y.md) [d](/tools/landing-zone) [e](#local)'
      )
    ).toEqual(['blog-sample-02-second-part.md', '../content/x.md']);
  });

  it('counts embed fences by language', () => {
    expect(countEmbedFences(`${EMBED_FENCE}\n\n\`\`\`pricing-scenario\nscenario=x\n\`\`\``)).toEqual({
      'landing-zone': 1,
      'pricing-scenario': 1,
    });
  });

  it('takes the provider from the first tag that names one the CMS knows', () => {
    expect(inferProviderFromTags(['iac', 'azure', 'terraform'])).toBe('Azure');
    expect(inferProviderFromTags(['terraform', 'docker'])).toBe('Terraform');
    expect(inferProviderFromTags(['oracle', 'ai-agents'])).toBeNull();
  });

  it('files a docker-tagged post under Docker, unless another provider is tagged too', () => {
    expect(inferProviderFromTags(['docker', 'ai-agents'])).toBe('Docker');
    expect(inferProviderFromTags(['Docker', 'compose'])).toBe('Docker');
    // Docker last, as in frontend/src/lib/providers.js: Docker on Azure is Azure.
    expect(inferProviderFromTags(['docker', 'azure'])).toBe('Azure');
  });

  it('knows every provider the site routes, VMware and Ansible included', () => {
    expect(inferProviderFromTags(['homelab', 'vmware'])).toBe('Vmware');
    expect(inferProviderFromTags(['ansible', 'docker'])).toBe('Ansible');
  });
});

describe('repoDraftContentId', () => {
  it('is a deterministic RFC 9562 version-5 UUID per path', () => {
    const id = repoDraftContentId(SAMPLE_DRAFTS[0]);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(repoDraftContentId(SAMPLE_DRAFTS[0])).toBe(id);
    expect(new Set(SAMPLE_DRAFTS.map(repoDraftContentId)).size).toBe(3);
  });

  it('keeps its namespace — changing it re-keys every imported draft', () => {
    expect(REPO_DRAFT_ID_NAMESPACE).toBe('8bccdb11-a980-4071-bc3a-805c389b371b');
  });

  it('keeps every id it gave before the repository moved, while it fetches from the new owner (#1009)', () => {
    // The id this path had under HybridCloudWorks, computed before the move.
    // The path is the input of that fixed hash, so it is kept exactly (the
    // file itself is no longer in the repository); it is not read from disk.
    expect(repoDraftContentId('docs/content/blog-lab-01-landing-zone.md')).toBe(
      '2ccb2ae7-1eb7-5e70-9817-00d7c3a8019a'
    );
    expect(REPO_DRAFT_ID_REPOSITORY).toBe('HybridCloudWorks/HCW-HybridCloudWorks');
  });

  it('fetches from the owner infra/ names, because a redirect from the old one is refused', () => {
    const variables = readFileSync(join(process.cwd(), '..', 'infra', 'variables.tf'), 'utf8');
    const owner = variables.match(/variable\s+"github_org"\s*\{[\s\S]*?default\s*=\s*"([^"]+)"/)?.[1];
    expect(owner).toBe('saulpatinojr');
    expect(REPO_OWNER).toBe(owner);
    expect(RAW_PATH_PREFIX.startsWith(`/${owner}/`)).toBe(true);
    expect(API_PATH_PREFIX.startsWith(`/repos/${owner}/`)).toBe(true);
  });
});

describe('the three sample drafts, read from disk', () => {
  const expected = {
    'docs/content/blog-sample-01-first-part.md': {
      title: 'Sample article, first part',
      slug: 'sample-article-first-part',
      provider: 'Azure',
      part: '1 of 3',
    },
    'docs/content/blog-sample-02-second-part.md': {
      title: 'Sample article, second part',
      slug: 'sample-article-second-part',
      provider: 'Terraform',
      part: '2 of 3',
    },
    'docs/content/blog-sample-03-third-part.md': {
      title: 'Sample article, third part',
      slug: 'sample-article-third-part',
      provider: 'Terraform',
      part: '3 of 3',
    },
  };

  it.each(SAMPLE_DRAFTS)('%s parses into a titled, slugged article with its embed intact', (path) => {
    const text = readRepoFile(path);
    const parsed = parseRepoDraft(text);
    expect(parsed.ok).toBe(true);
    const { draft } = parsed;
    expect(draft).toMatchObject({
      ...expected[path],
      date: '2026-09-27',
      track: 'how-to',
      embeds: { 'landing-zone': 1, 'pricing-scenario': 0 },
    });
    expect(draft.subtitle.length).toBeGreaterThan(40);
    expect(draft.tags).toContain('landing-zone');
    expect(draft.reading).toBeGreaterThan(0);
    // The body is the file after its front matter, untouched: no `---` block,
    // the embed fence byte for byte, and every fence still paired.
    expect(draft.body.startsWith('---')).toBe(false);
    expect(draft.body).not.toMatch(/^title:/m);
    expect(draft.body).toContain(EMBED_FENCE);
    expect(text.replace(/\r\n/g, '\n')).toContain(draft.body);
    expect((draft.body.match(/^```/gm) || []).length % 2).toBe(0);
    // The sibling links point at the articles' site URLs now (2026-09-28), so
    // the drafts are publishable as imported: no repository-file link left.
    expect(draft.warnings.join(' ')).not.toMatch(/links to repository files will not resolve/);
  });

  it.each(SAMPLE_DRAFTS)(
    '%s becomes an in_review, never-published document through createContentDocument',
    async (path) => {
      const parsed = parseRepoDraft(readRepoFile(path));
      const data = buildRepoDraftData({
        path,
        draft: parsed.draft,
        source: { ...SOURCE, rawUrl: rawUrlFor(path) },
        editor: 'editor@hcw.dev',
        now: FIXED_NOW,
      });
      const written = [];
      const store = {
        queryDocs: async () => [],
        upsertDoc: async (c, doc) => written.push([c, doc]),
      };
      const result = await createContentDocument({
        store,
        user: { email: 'editor@hcw.dev' },
        data,
        runEditorialCritique: false,
        now: FIXED_NOW,
        uuid: () => repoDraftContentId(path),
      });

      expect(result).toEqual({
        status: 200,
        body: { success: true, contentId: repoDraftContentId(path) },
      });
      expect(written).toHaveLength(1);
      const [container, doc] = written[0];
      expect(container).toBe('content');
      expect(doc).toMatchObject({
        id: repoDraftContentId(path),
        contentStatus: 'in_review',
        Live: false,
        Status: 'Draft',
        type: 'blog',
        publishTarget: 'blog',
        storageCollection: 'content',
        Title: expected[path].title,
        title: expected[path].title,
        'Cloud Provider': expected[path].provider,
        source: 'repo',
        inspectTrigger: false,
        sourceUrl: blobUrlFor(path),
        repoPath: path,
        repoRef: 'main',
        repoCommitSha: SOURCE.commitSha,
        repoRawUrl: rawUrlFor(path),
        repoContentSha256: SOURCE.contentSha256,
        createdBy: 'editor@hcw.dev',
        frontMatter: { title: expected[path].title, part: expected[path].part, date: '2026-09-27' },
      });
      // Every body field the readers use carries the article, embed intact.
      for (const field of ['Content', 'content', 'postContent']) {
        expect(doc[field]).toContain(EMBED_FENCE);
        expect(doc[field]).toBe(parsed.draft.body);
      }
      // Never published, never dated for publishing, never holding a URL.
      for (const key of [
        'publishedAt',
        'Published At',
        'publishedDate',
        'datePublished',
        'slug',
        'Slug',
        'curatedSubpagePath',
        'publicUrl',
      ]) {
        expect(doc, key).not.toHaveProperty(key);
      }
      expect(doc.contentQuality).toEqual(expect.objectContaining({ ready: expect.any(Boolean) }));
    }
  );
});

describe('sha256Hex', () => {
  it('hashes bytes and strings alike', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')));
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── a body or front matter that arrives in a request must not stall the host ──
//
// POST cms/drafts/from-markdown hands this parser text from the network
// (drafts-markdown.js), up to 272 KB. Three patterns here took quadratic or
// cubic time on such text: measured on the old code, `](` repeated 130 000
// times kept the event loop busy for 18 s, `](a.md#` repeated 4 000 times for
// 110 s, and a front-matter value with 50 000 spaces or quotes for 0.7 s
// (quadratic: 270 000 is about 20 s). They are scans now.
//
// HOW IT IS TESTED. Not by an absolute time: CI also runs this file under V8
// coverage (`npm run test:coverage`, the "coverage (qlty)" job), which makes
// the same code about 30 times slower, and a shared runner's speed varies, so
// a fixed budget either fails on a healthy parser or passes a slow one. The
// assertion is the growth rate, which neither changes: run the parser on an
// input of size N and again on one 4N long and look at time(4N) / time(N).
// Linear code gives about 4; quadratic gives about 16; cubic about 64. The
// sizes are chosen so the OLD code took long enough at N to be measured.
// Measured when the parser was fixed (ratio, 4N over N):
//
//   input (N, 4N)                    old parser   new parser, plain   new parser, coverage
//   bare `](`          10k, 40k      16           4.1                 4.1
//   `](a`              10k, 40k      19           4.1                 4.1
//   `](a.md#` (cubic)  250, 1k       69           0.5 (under 1 ms)    4.4
//   spaces in a value  12.5k, 50k    20           0.3 (under 1 ms)    0.3
//   quotes in a value  12.5k, 50k    16           0.1 (under 1 ms)    0.1
//   quotes around tag  12.5k, 50k    18           0.3 (under 1 ms)    2.1
//
// The old parser is repo-draft.js at commit 742e0232. Those readings took the
// best of three single runs after a warm-up, with a 1 ms floor under time(N),
// so a new-parser time under 1 ms only said "not growing". Coverage
// instrumentation makes the same code 10-30 times slower in absolute terms
// (the bare `](` case: 21 ms plain, 249 ms under coverage) and leaves the
// ratio where it was.
//
// The measurement changed with the frontend's twin of #1431 (#1433) after
// `](a` failed once with 11.0x on a loaded machine: a single run of a few
// milliseconds is shorter than a pause on a busy machine, and three of them,
// taken one size after the other, cannot cancel one. It is now the method of
// the Doc Vault "linear time" test (doc-vault/markdown.test.js, #1431): each
// batch repeats the run until it lasts at least 4 ms, the two sizes are timed
// in alternating rounds, each keeps its fastest of nine, and there is no
// floor. One addition, also in the frontend's copy: the small batch reads at
// least as much text as the large one. Measured that way every case,
// including the three that sat under the floor, reads about 4.
// MAX_GROWTH sits between linear (about 4) and quadratic (about 16). One
// generous absolute ceiling at the real request size is kept as a backstop only.

describe('the parser stays linear on hostile text', () => {
  const MAX_GROWTH = 8;
  // The slowest of these took 2.4 s under coverage on a CI runner; the old
  // parser needed 18 s to hours.
  const BACKSTOP_MS = 15_000;

  // The same measurement as the Doc Vault "linear time" tests
  // (doc-vault/markdown.test.js, #1431): see "HOW IT IS TESTED" above.
  const BATCH_MS = 4;
  const ROUNDS = 9;
  const MIN_ROUNDS = 3;
  const BUDGET_MS = 1_000;
  const MAX_REPS = 2 ** 20;

  const timeBatch = (run, input, reps) => {
    const started = performance.now();
    for (let rep = 0; rep < reps; rep += 1) run(input);
    return performance.now() - started;
  };

  /** How many runs make a batch of at least BATCH_MS. Finding it also warms the parser up. */
  const repsFor = (run, input) => {
    let reps = 1;
    while (reps < MAX_REPS && timeBatch(run, input, reps) < BATCH_MS) reps *= 2;
    return reps;
  };

  /** time(4N) / time(N) for `run` over inputs `make(n)` and `make(4n)`, and each time in ms a run. */
  const growth = (make, run, n) => {
    const small = make(n);
    const large = make(4 * n);
    const largeReps = repsFor(run, large);
    // The small batch reads at least as much text as the large one, so for a
    // linear parser both last about as long and a pause on a busy machine is
    // as likely to fall in either (bare `](` can take 10 ms and 40 ms a run on
    // a busy machine, so without this each batch would be one run of each).
    const smallReps = Math.max(repsFor(run, small), largeReps * 4);
    let tSmall = Infinity;
    let tLarge = Infinity;
    const began = performance.now();
    for (let round = 1; round <= ROUNDS; round += 1) {
      tSmall = Math.min(tSmall, timeBatch(run, small, smallReps) / smallReps);
      tLarge = Math.min(tLarge, timeBatch(run, large, largeReps) / largeReps);
      if (round >= MIN_ROUNDS && performance.now() - began > BUDGET_MS) break;
    }
    return { ratio: tLarge / tSmall, tSmall, tLarge };
  };

  const message = (ratio, tSmall, tLarge) =>
    `4x the input took ${ratio.toFixed(1)}x the time (${tSmall.toFixed(4)} ms -> ${tLarge.toFixed(4)} ms a run)`;

  it.each([
    ['bare ](', (n) => ']('.repeat(n), 10_000],
    ['](a', (n) => '](a'.repeat(n), 10_000],
    ['](a.md# (the cubic case)', (n) => '](a.md#'.repeat(n), 250],
  ])('finds links in a body of repeated %s in time linear in its length', (_name, make, n) => {
    const { ratio, tSmall, tLarge } = growth(make, findRepoRelativeLinks, n);
    expect(ratio, message(ratio, tSmall, tLarge)).toBeLessThan(MAX_GROWTH);
  });

  it.each([
    ['a long run of spaces inside a value', (n) => `x${' '.repeat(n)}y`],
    ['a long run of quotes inside a value', (n) => `x${"'".repeat(n)}x`],
    ['a long run of quotes around a tag', (n) => `[${'"'.repeat(n)}x${"'".repeat(n)}]`],
  ])('reads front matter with %s in time linear in its length', (_name, value) => {
    const make = (n) => `---\ntitle: T\nsubtitle: ${value(n)}\ntags: ${value(n)}\n---\n\nBody\n`;
    const { ratio, tSmall, tLarge } = growth(make, parseRepoDraft, 12_500);
    expect(ratio, message(ratio, tSmall, tLarge)).toBeLessThan(MAX_GROWTH);
  });

  it('still finishes a request-sized hostile body well inside a generous ceiling', () => {
    // 256 KB bodies and 260 000-character values: the old parser needed from
    // 18 s to several minutes for these. A backstop only; the ratios above
    // are the test.
    const started = performance.now();
    const body = parseRepoDraft(`---\ntitle: T\n---\n\n${']('.repeat(130_000)}\n`);
    const links = findRepoRelativeLinks('](a.md#'.repeat(37_000));
    const front = parseRepoDraft(
      `---\ntitle: T\nsubtitle: x${' '.repeat(130_000)}y\ntags: [${'"'.repeat(65_000)}x${"'".repeat(65_000)}]\n---\n\nBody\n`
    );
    expect(performance.now() - started).toBeLessThan(BACKSTOP_MS);
    expect([body.ok, front.ok]).toEqual([true, true]);
    expect(links).toEqual([]);
  });
});

describe('the scans read what the patterns they replaced read', () => {
  // The pattern findRepoRelativeLinks used before, kept here as the reference.
  const OLD_LINKS = /\]\(((?!https?:\/\/|mailto:|#|\/)[^)\s]+?\.md)(?:#[^)\s]*)?\)/g;
  const oldLinks = (body) => [...new Set([...body.matchAll(OLD_LINKS)].map((m) => m[1]))];

  it.each([
    '[Part 2](blog-lab-02-x.md)',
    '[a](a.md#top) and [b](b.md)',
    '[x](https://example.com/a.md) [y](mailto:a.md) [z](#a.md) [w](/a.md)',
    '[a](docs/other.md#one#two)',
    '[a](.md) [b](x.md.md) [c](x.mdx) [d](x.mdx.md)',
    '[a](a b.md) [b](a.md ) [c]( a.md)',
    '[a](x](y.md)',
    '![img](pic.png) [no end](a.md',
    '[a](a.md)[b](b.md)[a](a.md)',
    '',
  ])('finds the same links in %j', (body) => {
    expect(findRepoRelativeLinks(body)).toEqual(oldLinks(body));
  });

  it('skips a link target longer than the cap, which no draft file name is', () => {
    expect(findRepoRelativeLinks(`[a](${'a'.repeat(300)}.md)`)).toEqual([]);
    expect(findRepoRelativeLinks(`[a](${'a'.repeat(150)}.md)`)).toHaveLength(1);
  });

  it('reads quoted and padded front-matter values as before', () => {
    const { fields } = parseFrontMatter(
      [
        '---',
        'title:    "Quoted # not a comment"   ',
        "subtitle: x''twice''",
        'track: how-to # a comment',
        'empty:    ',
        'part: ',
        '# comment: line',
        'tags: ["a", \'b\', ""]',
        '---',
        'x',
      ].join('\n')
    );
    expect(fields).toMatchObject({
      title: 'Quoted # not a comment',
      subtitle: "x''twice",
      track: 'how-to',
      tags: '["a", \'b\', ""]',
    });
    expect(fields.empty ?? '').toBe('');
    expect(parseInlineList('["a", \'b\', "", \'\'\'c\'\'\']')).toEqual(['a', 'b', 'c']);
  });
});
