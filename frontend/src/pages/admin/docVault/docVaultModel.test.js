/**
 * The Doc Vault page's pure functions (docVaultModel.js): sizes and dates,
 * the link rule, the form, the filters, copy as plain text and the upload
 * result lines.
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  byteLength,
  describeUploadResult,
  docRoute,
  emptyForm,
  filterDocuments,
  formFromDocument,
  formProblem,
  formatBytes,
  formatWhen,
  isDirty,
  isSafeLink,
  markdownToPlainText,
  parseTags,
  payloadFromForm,
  restoreVersionRoute,
  summarizeBatch,
  untrashRoute,
  versionRoute,
} from './docVaultModel';

describe('routes', () => {
  it('encode an id, so it can only ever be one path segment', () => {
    expect(docRoute('abc-123')).toBe('cms/doc-vault/abc-123');
    expect(docRoute('a/b?c')).toBe('cms/doc-vault/a%2Fb%3Fc');
    expect(versionRoute('abc', 3)).toBe('cms/doc-vault/abc/versions/3');
    expect(restoreVersionRoute('abc')).toBe('cms/doc-vault/abc/restore-version');
    expect(untrashRoute('abc')).toBe('cms/doc-vault/abc/untrash');
  });
});

describe('sizes and dates', () => {
  it('counts UTF-8 bytes, as the API does', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('€')).toBe(3);
    expect(byteLength('')).toBe(0);
    expect(byteLength(null)).toBe(0);
    expect(MAX_FILE_BYTES).toBe(MAX_BODY_BYTES + 16 * 1024);
  });

  it('prints a size in plain units', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(532)).toBe('532 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024)).toBe('250 KB');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes('x')).toBe('');
  });

  it('prints a date, with the time on request, and nothing for a bad one', () => {
    expect(formatWhen('2026-10-26T12:30:00.000Z')).toMatch(/2026/);
    expect(formatWhen('2026-10-26T12:30:00.000Z', { withTime: true })).toMatch(/\d{1,2}:\d{2}/);
    expect(formatWhen('')).toBe('');
    expect(formatWhen(null)).toBe('');
    expect(formatWhen('not a date')).toBe('');
  });
});

describe('isSafeLink (the same rule as the API)', () => {
  it.each(['https://example.com', 'https://example.com/a?b=c#d', '/admin', '/admin/ambassador'])(
    'accepts %s',
    (link) => {
      expect(isSafeLink(link)).toBe(true);
    }
  );

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,x',
    '//evil.example.com',
    '/administrator',
    '/admin//x',
    '/admin\\x',
    'https://user:pass@example.com',
    'https://exa mple.com',
    'https://example.com/\n',
    'ftp://example.com',
    '',
    null,
    42,
    `https://example.com/${'a'.repeat(500)}`,
  ])('refuses %j', (link) => {
    expect(isSafeLink(link)).toBe(false);
  });
});

describe('the form', () => {
  const doc = {
    title: 'Cover letter',
    category: 'Letter',
    tags: ['outreach', 'mvp'],
    body: 'Dear team',
    relatedLink: 'https://example.com/role',
  };

  it('starts blank in a category, and shows a document with its tags on one line', () => {
    expect(emptyForm()).toEqual({
      title: '',
      category: 'Other',
      tags: '',
      body: '',
      relatedLink: '',
    });
    expect(emptyForm('Letter').category).toBe('Letter');
    expect(formFromDocument(doc)).toEqual({
      title: 'Cover letter',
      category: 'Letter',
      tags: 'outreach, mvp',
      body: 'Dear team',
      relatedLink: 'https://example.com/role',
    });
    expect(formFromDocument({ title: 'x', body: 'y' })).toMatchObject({
      category: 'Other',
      tags: '',
      relatedLink: '',
    });
  });

  it('reads the tag line: trimmed, without a leading #, no repeats in any case', () => {
    expect(parseTags(' a, #B ,b,, ,c ')).toEqual(['a', 'B', 'c']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });

  it('sends exactly the five editable fields, and null for an empty link', () => {
    const payload = payloadFromForm({
      ...formFromDocument(doc),
      title: '  Cover letter ',
      relatedLink: '  ',
    });
    expect(payload).toEqual({
      title: 'Cover letter',
      category: 'Letter',
      tags: ['outreach', 'mvp'],
      body: 'Dear team',
      relatedLink: null,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'body',
      'category',
      'relatedLink',
      'tags',
      'title',
    ]);
  });

  it('is dirty only when something the owner can type differs from where it started', () => {
    const start = formFromDocument(doc);
    expect(isDirty(start, formFromDocument(doc))).toBe(false);
    for (const field of ['title', 'category', 'tags', 'body', 'relatedLink']) {
      expect(isDirty({ ...start, [field]: `${start[field]}x` }, start), field).toBe(true);
    }
  });

  it('says in plain words why it cannot be saved yet, and nothing when it can', () => {
    const ok = formFromDocument(doc);
    expect(formProblem(ok)).toBeNull();
    expect(formProblem({ ...ok, title: '  ' })).toMatch(/title/);
    expect(formProblem({ ...ok, title: 'x'.repeat(201) })).toMatch(/at most 200/);
    expect(formProblem({ ...ok, category: 'Poem' })).toMatch(/category/i);
    expect(formProblem({ ...ok, body: ' \n' })).toMatch(/no text/);
    expect(formProblem({ ...ok, body: 'x'.repeat(MAX_BODY_BYTES + 1) })).toMatch(/256 KB/);
    expect(
      formProblem({ ...ok, tags: Array.from({ length: 13 }, (_, i) => `t${i}`).join(',') })
    ).toMatch(/at most 12/);
    expect(formProblem({ ...ok, tags: 'x'.repeat(41) })).toMatch(/at most 40/);
    expect(formProblem({ ...ok, relatedLink: 'javascript:alert(1)' })).toMatch(/https address/);
    expect(CATEGORIES.every((category) => formProblem({ ...ok, category }) === null)).toBe(true);
  });
});

describe('filterDocuments', () => {
  const docs = [
    { id: '1', title: 'Cover letter', category: 'Letter', tags: ['outreach', 'MVP'] },
    { id: '2', title: 'MVP application', category: 'Application', tags: ['mvp'] },
    { id: '3', title: 'Notes on Azure', category: 'Notes', tags: [] },
  ];
  const ids = (filters) => filterDocuments(docs, filters).map((doc) => doc.id);

  it('matches the search words against title, category and tags, without regard to case', () => {
    expect(ids({ q: 'azure' })).toEqual(['3']);
    expect(ids({ q: 'APPLIC' })).toEqual(['2']);
    expect(ids({ q: 'outreach' })).toEqual(['1']);
    expect(ids({ q: 'mvp' })).toEqual(['1', '2']);
    expect(ids({ q: '  ' })).toEqual(['1', '2', '3']);
    expect(ids({})).toEqual(['1', '2', '3']);
  });

  it('filters by category and by tag exactly, and the three together', () => {
    expect(ids({ category: 'Notes' })).toEqual(['3']);
    expect(ids({ tag: 'mvp' })).toEqual(['1', '2']);
    expect(ids({ tag: 'mv' })).toEqual([]);
    expect(ids({ category: 'Letter', tag: 'outreach', q: 'cover' })).toEqual(['1']);
    expect(ids({ category: 'Letter', tag: 'azure' })).toEqual([]);
  });
});

describe('markdownToPlainText', () => {
  const plain = markdownToPlainText;

  it('drops heading marks', () => {
    expect(plain('# Title\n\n## Sub ##\n\nText')).toBe('Title\n\nSub\n\nText');
    expect(plain('#hashtag stays')).toBe('#hashtag stays');
    expect(plain('# C# is a language')).toBe('C# is a language');
  });

  it('drops bold, italic, strike and code marks, and keeps symbols that are not marks', () => {
    expect(plain('**bold** and __bold__ and *it* and _it_ and ~~gone~~ and `code`')).toBe(
      'bold and bold and it and it and gone and code'
    );
    expect(plain('***both***')).toBe('both');
    expect(plain('snake_case_name and 2 * 3 and a ** b')).toBe(
      'snake_case_name and 2 * 3 and a ** b'
    );
    expect(plain('5 * 4 * 3')).toBe('5 * 4 * 3');
    expect(plain('an unclosed **bold')).toBe('an unclosed bold');
  });

  it('turns a link into its words and its address, an image into its words, an autolink into its address', () => {
    expect(plain('See [the role](https://example.com/role) now')).toBe(
      'See the role (https://example.com/role) now'
    );
    expect(plain('[https://example.com](https://example.com)')).toBe('https://example.com');
    expect(plain('![A diagram](https://example.com/d.png)')).toBe('A diagram');
    expect(plain('<https://example.com/x>')).toBe('https://example.com/x');
    expect(plain('[text](https://example.com "A title")')).toBe('text (https://example.com)');
    expect(plain('[broken](no close')).toBe('[broken](no close');
    expect(plain('[**bold** link](https://e.com)')).toBe('bold link (https://e.com)');
  });

  it('keeps lists as dash lines, with their nesting, and numbered lists as they are', () => {
    expect(plain('* one\n+ two\n  - nested\n1. first\n2. second')).toBe(
      '- one\n- two\n  - nested\n1. first\n2. second'
    );
  });

  it('drops quote marks and rules, and squeezes blank lines', () => {
    expect(plain('> quoted\n> > deeper\n\n\n\n---\n\nend')).toBe('quoted\ndeeper\n\nend');
  });

  it('keeps a fenced code block as written, marks and all, without the fences', () => {
    expect(plain('before\n```js\nconst **a** = 1;\n```\nafter')).toBe(
      'before\nconst **a** = 1;\nafter'
    );
    expect(plain('~~~\n# not a heading\n~~~')).toBe('# not a heading');
  });

  it('unescapes a backslash-escaped mark', () => {
    expect(plain('2 \\* 3 \\# not')).toBe('2 * 3 # not');
  });

  it('reads plain text, line endings and nothing as themselves', () => {
    expect(plain('Dear team,\r\n\r\nThank you.')).toBe('Dear team,\n\nThank you.');
    expect(plain('')).toBe('');
    expect(plain(null)).toBe('');
    expect(plain(undefined)).toBe('');
  });

  describe('is linear: pathological input grows in step with its size', () => {
    /**
     * How the time is measured: the same method as the server's twin of this
     * test, functions/src/lib/doc-vault/markdown.test.js, group "linear time"
     * (changed for #1431 after it failed once in CI with a ratio of 11.9 on a
     * change that touched no code, and copied here for #1433, since the two
     * packages share no test helpers).
     *
     * The first version timed five batches of one conversion for the large
     * input, all inside a few milliseconds, against a small input floored at
     * 0.02 ms. A slow spell on a shared machine is longer than that, slows all
     * five large timings at once, and nothing in the small timings, taken
     * earlier, cancels it. The floor also hid the real time of "ticks", which
     * takes about 0.005 ms for the small input. So now:
     *
     *  - A batch repeats the conversion until it lasts at least BATCH_MS, so
     *    every timing is several milliseconds whatever the input. Finding that
     *    count also warms the converter up before anything is kept.
     *  - The small batch reads at least as much text as the large one (one
     *    addition to the server's method, explained in measureGrowth).
     *  - The small and the large input are timed in alternating rounds, so a
     *    slow spell falls on both of them and the ratio of the two cancels it.
     *  - Each input keeps its fastest of ROUNDS rounds: noise only ever adds time.
     *  - No floor under the small timing: it is now measured, not rounded up.
     *
     * A quadratic converter must still be found by a test that finishes in
     * seconds, so an input stops taking rounds after BUDGET_MS once it has had
     * MIN_ROUNDS. A synchronous conversion cannot be cut short by a test
     * timeout, so these sizes keep a quadratic one to seconds, not minutes.
     */
    const BATCH_MS = 4;
    const ROUNDS = 9;
    const MIN_ROUNDS = 3;
    const BUDGET_MS = 1_000;
    const MAX_REPS = 2 ** 20;

    function timeBatch(input, reps) {
      const start = performance.now();
      for (let rep = 0; rep < reps; rep += 1) markdownToPlainText(input);
      return performance.now() - start;
    }

    /**
     * How many conversions make a batch of at least BATCH_MS, taking the faster
     * of two timings at each count, so one slow first batch (the converter not
     * yet compiled, or a pause) cannot settle on too few.
     */
    function repsFor(input) {
      let reps = 1;
      while (reps < MAX_REPS && Math.min(timeBatch(input, reps), timeBatch(input, reps)) < BATCH_MS)
        reps *= 2;
      return reps;
    }

    /** Time per conversion of the large input over the small one, and each in ms. */
    function measureGrowth(small, large) {
      const largeReps = repsFor(large);
      // The small batch reads at least as much text as the large one, so for a
      // linear converter both batches last about as long and a pause on a busy
      // machine is as likely to fall in either. Without this, "brackets" (about
      // 11 ms and 47 ms a conversion) timed one conversion of each: the short
      // one could slip between pauses and the long one could not, and with
      // other programs fighting for the processors the ratio reached 9.5.
      const sizeFactor = Math.max(1, Math.round(large.length / small.length));
      const smallReps = Math.max(repsFor(small), largeReps * sizeFactor);
      let smallMs = Infinity;
      let largeMs = Infinity;
      const began = performance.now();
      for (let round = 1; round <= ROUNDS; round += 1) {
        smallMs = Math.min(smallMs, timeBatch(small, smallReps) / smallReps);
        largeMs = Math.min(largeMs, timeBatch(large, largeReps) / largeReps);
        if (round >= MIN_ROUNDS && performance.now() - began > BUDGET_MS) break;
      }
      return { ratio: largeMs / smallMs, smallMs, largeMs };
    }

    // A quadratic converter takes 16x as long for 4x the input; a linear one 4x.
    // Only the ratio is asserted, never a number of milliseconds.
    const SMALL = 8_000;
    const LARGE = 32_000;
    const SHAPES = {
      brackets: (n) => '['.repeat(n),
      ticks: (n) => '`'.repeat(n),
      stars: (n) => '*a'.repeat(n / 2),
      links: (n) => '[a](b'.repeat(n / 5),
      angle: (n) => '<'.repeat(n),
      underscores: (n) => '_a'.repeat(n / 2),
    };

    it.each(Object.entries(SHAPES))('grows in step with the input for %s', (name, shape) => {
      const { ratio, smallMs, largeMs } = measureGrowth(shape(SMALL), shape(LARGE));
      expect(
        ratio,
        `${name}: 4x the input took ${ratio.toFixed(1)}x the time (${smallMs.toFixed(4)} ms -> ${largeMs.toFixed(4)} ms a conversion)`
      ).toBeLessThan(9);
    });
  });
});

describe('describeUploadResult and summarizeBatch', () => {
  const doc = { category: 'Letter', version: 2 };

  it('says in plain words what became of each file', () => {
    expect(
      describeUploadResult('a.md', {
        answer: { outcome: 'created', document: doc, warnings: ['w'] },
      })
    ).toEqual({
      name: 'a.md',
      kind: 'created',
      tone: 'ok',
      text: 'Added as a new document in Letter',
      warnings: ['w'],
    });
    expect(
      describeUploadResult('b.md', { answer: { outcome: 'versioned', document: doc } })
    ).toMatchObject({
      kind: 'versioned',
      text: 'Saved as version 2 of a document already here in Letter',
    });
    expect(
      describeUploadResult('c.md', { answer: { outcome: 'unchanged', document: doc } })
    ).toMatchObject({
      kind: 'unchanged',
      tone: 'skip',
    });
    expect(
      describeUploadResult('d.md', { answer: { outcome: 'restored', document: doc } })
    ).toMatchObject({
      kind: 'restored',
      tone: 'ok',
    });
  });

  it('reports a failure as a line and an answer it does not know as a failure too', () => {
    expect(
      describeUploadResult('e.docx', { error: new Error('Only text files are read here.') })
    ).toMatchObject({
      kind: 'failed',
      tone: 'bad',
      text: 'Not added: Only text files are read here.',
    });
    expect(describeUploadResult('f.md', { error: {} }).text).toMatch(/something went wrong/);
    expect(describeUploadResult('g.md', { answer: { outcome: 'strange' } }).kind).toBe('failed');
    expect(describeUploadResult('h.md', {}).kind).toBe('failed');
  });

  it('sums a batch', () => {
    const lines = [
      { kind: 'created' },
      { kind: 'restored' },
      { kind: 'versioned' },
      { kind: 'unchanged' },
      { kind: 'failed' },
    ];
    expect(summarizeBatch(lines)).toBe(
      '5 files: 2 added, 1 new version, 1 already here, 1 not added.'
    );
    expect(summarizeBatch([{ kind: 'created' }])).toBe(
      '1 file: 1 added, 0 new versions, 0 already here, 0 not added.'
    );
  });
});
