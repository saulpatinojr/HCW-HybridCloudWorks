/**
 * One uploaded file → the fields of a document (markdown.js).
 *
 * Pinned, in the order the owner asked for it: front matter title, category
 * and tags are read (Obsidian's block-list tags included); a file with none
 * takes a title from its heading or its name; a key such as contentStatus,
 * Live, id, slug, partitionKey or __proto__ can never set a privileged field;
 * a file that is not text, is empty or is too large is refused with a
 * sentence that does not repeat it; and no input makes the parser slow.
 */
import { describe, it, expect } from 'vitest';
import {
  FILE_EXTENSIONS,
  FRONT_MATTER_ALLOWANCE_BYTES,
  MAX_FILE_BYTES,
  describeFilename,
  parseVaultFile,
} from './markdown.js';
import { EDITABLE_FIELDS, MAX_BODY_BYTES } from './model.js';

const parse = (text, extra = {}) => parseVaultFile({ filename: 'note.md', text, ...extra });

const FULL = [
  '---',
  'title: "Cover letter: Azure MVP"',
  'category: letter',
  'tags: [Outreach, "#mvp", azure]',
  'link: https://example.com/role',
  '---',
  '',
  'Dear team,',
  '',
  'I would like to apply.',
  '',
].join('\n');

describe('describeFilename', () => {
  it.each(['a.md', 'A.MD', 'notes.markdown', 'plain.txt', 'x.text', 'C:\\Users\\me\\Outreach\\letter.md', 'dir/letter.md'])(
    'reads %s',
    (name) => {
      expect(describeFilename(name)).not.toBeNull();
    }
  );

  it('keeps the stem of the last path segment', () => {
    expect(describeFilename('C:\\Users\\me\\My Letter.md')).toEqual({ stem: 'My Letter' });
    expect(describeFilename('dir/sub/a.b.txt')).toEqual({ stem: 'a.b' });
  });

  it.each(['letter.docx', 'letter.pdf', 'letter', '.md', 'a.md\u0000', '', 'x'.repeat(256) + '.md', null, undefined, 5])(
    'refuses %j',
    (name) => {
      expect(describeFilename(name)).toBeNull();
    }
  );

  it('names the four extensions it reads', () => {
    expect(FILE_EXTENSIONS).toEqual(['.md', '.markdown', '.txt', '.text']);
  });
});

describe('front matter', () => {
  it('reads title, category, tags and link, and keeps the rest as the text', () => {
    const result = parse(FULL);
    expect(result).toMatchObject({ ok: true, titleFrom: 'front matter' });
    expect(result.fields).toEqual({
      title: 'Cover letter: Azure MVP',
      category: 'Letter',
      tags: ['Outreach', 'mvp', 'azure'],
      body: 'Dear team,\n\nI would like to apply.',
      relatedLink: 'https://example.com/role',
    });
    expect(result.warnings).toEqual([]);
  });

  it('reads Obsidian\'s one-per-line tags, with or without a leading #', () => {
    const result = parse(
      ['---', 'title: Notes', 'tags:', '  - outreach', '  - "#mvp"', '  -   azure ', 'aliases:', '  - nope', '---', 'Body'].join('\n')
    );
    expect(result.fields.tags).toEqual(['outreach', 'mvp', 'azure']);
    expect(result.fields.body).toBe('Body');
    expect(result.warnings.join(' ')).toContain('aliases');
  });

  it('reads a comma-separated tag line and the alternative link keys', () => {
    expect(parse('---\ntitle: T\ntags: a, b ,#c\nurl: https://example.com/u\n---\nbody').fields).toMatchObject({
      tags: ['a', 'b', 'c'],
      relatedLink: 'https://example.com/u',
    });
    expect(parse('---\ntitle: T\nrelated: /admin/ambassador\n---\nbody').fields.relatedLink).toBe('/admin/ambassador');
  });

  it('ignores a trailing comment and single quotes in a value, and keeps a colon in the title', () => {
    expect(parse("---\ntitle: 'A: B' # not this\n---\nbody").fields.title).toBe('A: B');
    expect(parse('---\ntitle: Plain # not this\n---\nbody').fields.title).toBe('Plain');
  });

  it('takes the first of a repeated key', () => {
    expect(parse('---\ntitle: First\ntitle: Second\n---\nbody').fields.title).toBe('First');
  });

  it('accepts ... as the closing line, and trailing spaces on the fences', () => {
    expect(parse('---  \ntitle: T\n...\nbody').fields).toMatchObject({ title: 'T', body: 'body' });
  });

  it('reads a block that never closes as text, and says so', () => {
    const result = parse('---\ntitle: T\nstill going\n');
    expect(result.ok).toBe(true);
    expect(result.fields.body).toContain('title: T');
    expect(result.warnings[0]).toMatch(/never closes/);
  });

  it('does not treat a --- that is not the first line as front matter', () => {
    const result = parse('Intro\n---\ntitle: Not this\n---\nrest');
    expect(result.fields.body).toBe('Intro\n---\ntitle: Not this\n---\nrest');
    expect(result.fields.title).toBe('note');
  });

  it('gives up on a block that does not close within 200 lines', () => {
    const lines = ['---', ...Array.from({ length: 300 }, (_, i) => `k${i}: v`), '---', 'body'];
    const result = parse(lines.join('\n'));
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatch(/never closes/);
  });

  it('skips a line in the block that is not key: value', () => {
    expect(parse('---\n  indented: x\nno colon here\n: leading\ntitle: T\n---\nbody').fields.title).toBe('T');
  });
});

describe('the title', () => {
  it('comes from the first heading when the front matter has none', () => {
    const result = parse('\n# My Heading ##\n\nText');
    expect(result).toMatchObject({ ok: true, titleFrom: 'heading' });
    expect(result.fields.title).toBe('My Heading');
    // The heading stays in the text: nothing is taken out of a document.
    expect(result.fields.body).toBe('# My Heading ##\n\nText');
  });

  it('does not take a later heading, a second-level heading or an empty one', () => {
    expect(parse('Intro\n# Later\nx', { filename: 'from-name.md' }).fields.title).toBe('from-name');
    expect(parse('## Second level\nx', { filename: 'from-name.md' }).titleFrom).toBe('file name');
    expect(parse('# \nx', { filename: 'from-name.md' }).fields.title).toBe('from-name');
  });

  it('falls back to the file name without its extension', () => {
    expect(parse('just text', { filename: 'dir/Reference Notes.txt' })).toMatchObject({
      titleFrom: 'file name',
      fields: { title: 'Reference Notes' },
    });
  });

  it('is refused over 200 characters, and a title with no letter is refused by the document rules', () => {
    expect(parse(`---\ntitle: ${'x'.repeat(201)}\n---\nbody`)).toMatchObject({ ok: false, status: 422, code: 'TITLE_TOO_LONG' });
    expect(parse('body', { filename: '!!!.md' })).toMatchObject({ ok: false, status: 422, code: 'INVALID' });
  });
});

describe('the category', () => {
  it('is the file\'s own when it names one, whatever the case', () => {
    expect(parse('---\ncategory: APPLICATION\n---\nx').fields.category).toBe('Application');
  });

  it('falls back to the one chosen for the batch, then Other, and says when the file named another', () => {
    expect(parse('x', { defaultCategory: 'notes' }).fields.category).toBe('Notes');
    expect(parse('x').fields.category).toBe('Other');
    expect(parse('x', { defaultCategory: '' }).fields.category).toBe('Other');
    const unknown = parse('---\ncategory: Poem\n---\nx', { defaultCategory: 'Letter' });
    expect(unknown.fields.category).toBe('Letter');
    expect(unknown.warnings[0]).toMatch(/not one the Doc Vault has/);
  });

  it('refuses a chosen category the vault does not have', () => {
    expect(parse('x', { defaultCategory: 'Poem' })).toMatchObject({ ok: false, status: 400, code: 'INVALID' });
  });
});

describe('the tags and the link, leniently', () => {
  it('keeps the first twelve tags and shortens a long one, saying both', () => {
    const many = Array.from({ length: 15 }, (_, i) => `t${i}`).join(', ');
    const result = parse(`---\ntitle: T\ntags: [${many}, ${'x'.repeat(60)}]\n---\nbody`);
    expect(result.fields.tags).toHaveLength(12);
    expect(result.warnings.join(' ')).toMatch(/first 12 tags/);

    const long = parse(`---\ntitle: T\ntags: [${'y'.repeat(60)}]\n---\nbody`);
    expect(long.fields.tags).toEqual(['y'.repeat(40)]);
    expect(long.warnings.join(' ')).toMatch(/shortened to 40/);
  });

  it('drops a link the page could not show safely, and says so', () => {
    const result = parse('---\ntitle: T\nlink: javascript:alert(1)\n---\nbody');
    expect(result.fields.relatedLink).toBeNull();
    expect(result.warnings[0]).toMatch(/left out/);
  });
});

describe('front matter cannot set a privileged field', () => {
  const HOSTILE = [
    '---',
    'title: Honest title',
    'id: stolen-id',
    'docType: version',
    'version: 99',
    'createdBy: someone-else',
    'createdAt: 1999-01-01',
    'updatedBy: someone-else',
    'deletedAt: 2000-01-01',
    'dedupeKey: forced|key',
    'source: pasted',
    'contentStatus: published',
    'Live: true',
    'Status: Published',
    'slug: public-slug',
    'partitionKey: other',
    'ttl: 1',
    '_etag: forged',
    '__proto__: polluted',
    'constructor: polluted',
    'prototype: polluted',
    'toString: polluted',
    '---',
    'Body text',
  ].join('\n');

  it('yields exactly the five document fields, with none of those values anywhere', () => {
    const result = parse(HOSTILE);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.fields).sort()).toEqual([...EDITABLE_FIELDS].sort());
    const text = JSON.stringify(result.fields);
    for (const forged of ['stolen-id', 'someone-else', 'forced|key', 'public-slug', 'forged', 'polluted', '1999-01-01', '2000-01-01']) {
      expect(text, forged).not.toContain(forged);
    }
    expect(result.fields.title).toBe('Honest title');
    expect(result.fields.body).toBe('Body text');
  });

  it('names the keys it left out, and no more than five of them', () => {
    const result = parse(HOSTILE);
    const warning = result.warnings.find((w) => w.startsWith('Front matter not kept'));
    expect(warning).toMatch(/and \d+ more/);
    const named = /not kept: (.*?) and \d+ more\. Only/.exec(warning)[1].split(', ');
    // Keys are read without regard to case, so they are named in lower case.
    expect(named).toEqual(['id', 'doctype', 'version', 'createdby', 'createdat']);
  });

  it('touches no prototype', () => {
    parse(HOSTILE);
    parse('---\n__proto__: x\nconstructor: y\n---\nz');
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect({}.toString()).toBe('[object Object]');
  });

  it('shortens a key it names, so a long one cannot fill a warning', () => {
    const result = parse(`---\ntitle: T\n${'k'.repeat(5000)}: v\n---\nbody`);
    expect(result.warnings.join(' ').length).toBeLessThan(200);
  });
});

describe('files that are not documents', () => {
  it('refuses a name that is not a text file, naming the four it reads', () => {
    const result = parseVaultFile({ filename: 'letter.docx', text: 'x' });
    expect(result).toMatchObject({ ok: false, status: 400, code: 'BAD_FILENAME' });
    expect(result.error).toContain('.md');
  });

  it('refuses text that is not a string', () => {
    expect(parseVaultFile({ filename: 'a.md', text: 5 })).toMatchObject({ ok: false, status: 400, code: 'INVALID' });
    expect(parseVaultFile({ filename: 'a.md' })).toMatchObject({ ok: false, status: 400, code: 'INVALID' });
  });

  it('refuses binary data, without repeating any of it', () => {
    const result = parse('SECRET\u0000bytes');
    expect(result).toMatchObject({ ok: false, status: 422, code: 'NOT_TEXT' });
    expect(result.error).not.toContain('SECRET');
  });

  it('refuses a file with front matter and nothing else, or nothing at all', () => {
    expect(parse('---\ntitle: T\n---\n\n  \n')).toMatchObject({ ok: false, status: 422, code: 'EMPTY_BODY' });
    expect(parse('   \n\n')).toMatchObject({ ok: false, status: 422, code: 'EMPTY_BODY' });
  });

  it('refuses a file over the cap, counted in bytes, and keeps one at the cap', () => {
    expect(MAX_FILE_BYTES).toBe(MAX_BODY_BYTES + FRONT_MATTER_ALLOWANCE_BYTES);
    expect(parse('x'.repeat(MAX_FILE_BYTES + 1))).toMatchObject({ ok: false, status: 413, code: 'TOO_LARGE' });
    expect(parse('€'.repeat(100_000))).toMatchObject({ ok: false, status: 413, code: 'TOO_LARGE' });
    // Under the file cap but over the document cap: the document rules say so.
    expect(parse('x'.repeat(MAX_BODY_BYTES + 1))).toMatchObject({ ok: false, status: 422, code: 'INVALID' });
    expect(parse('x'.repeat(MAX_BODY_BYTES)).ok).toBe(true);
  });

  it('keeps the text of a document with control characters out of the refusal', () => {
    const result = parse('before \u0007 SECRET-TEXT');
    expect(result).toMatchObject({ ok: false, status: 422, code: 'INVALID' });
    expect(result.error).not.toContain('SECRET-TEXT');
  });
});

describe('line endings and the byte-order mark', () => {
  it('reads a Windows file the same as a Unix one', () => {
    const unix = parse(FULL);
    const windows = parse(`\uFEFF${FULL.replace(/\n/g, '\r\n')}`);
    expect(windows.fields).toEqual(unix.fields);
  });
});

describe('linear time', () => {
  /**
   * How the time is measured (changed for #1431, after this test failed once in
   * CI with a ratio of 11.9 on a change that touched no code).
   *
   * One parse of a few thousand characters takes between two microseconds and a
   * tenth of a millisecond: too little to time alone, and shorter than the slow
   * spells of a shared machine (a busy neighbour, another test file running
   * beside this one). The first version timed five batches of one parse for the
   * large input, all inside about two milliseconds. The worst readings measured
   * for this change were not random single pauses: all five large timings were
   * slow together (1.6 to 1.9 times their usual), which lifted a ratio of about
   * 3.5 to between 5.8 and 6.3, and nothing in the small timings, taken earlier,
   * could cancel that. So now:
   *
   *  - A batch repeats the parse until it lasts at least BATCH_MS, so every
   *    timing is several milliseconds whatever the input. Running the batches
   *    to find that count also warms the parser up before anything is kept.
   *  - The small and the large input are timed in alternating rounds, so a slow
   *    spell falls on both of them and the ratio of the two cancels it.
   *  - Each input keeps its fastest of ROUNDS rounds: noise only ever adds time.
   *  - No floor under the small timing: it is now measured, not rounded up.
   *
   * A quadratic parser must still be found by a test that finishes in seconds,
   * so an input stops taking rounds after BUDGET_MS once it has had MIN_ROUNDS.
   * A single synchronous parse cannot be interrupted by a test timeout, so
   * these sizes keep a quadratic one to about a second a run, not minutes.
   */
  const BATCH_MS = 4;
  const ROUNDS = 9;
  const MIN_ROUNDS = 3;
  const BUDGET_MS = 1_000;
  const MAX_REPS = 2 ** 20;

  function timeBatch(input, reps) {
    const start = performance.now();
    for (let rep = 0; rep < reps; rep += 1) parse(input);
    return performance.now() - start;
  }

  /**
   * How many parses make a batch of at least BATCH_MS, taking the faster of
   * two timings at each count, so one slow first batch (the parser not yet
   * compiled, or a pause) cannot settle on too few.
   */
  function repsFor(input) {
    let reps = 1;
    while (reps < MAX_REPS && Math.min(timeBatch(input, reps), timeBatch(input, reps)) < BATCH_MS)
      reps *= 2;
    return reps;
  }

  /** Time per parse of the large input over the small one, and each in ms. */
  function measureGrowth(small, large) {
    const smallReps = repsFor(small);
    const largeReps = repsFor(large);
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

  // A quadratic parser takes 16x as long for 4x the input; a linear one 4x.
  // Only the ratio is asserted, never a number of milliseconds.
  const SMALL = 8_000;
  const LARGE = 32_000;
  const SHAPES = {
    'a long run of spaces in a value': (n) => `---\ntitle: a${' '.repeat(n)}b\n---\nbody`,
    'a long run of quotes': (n) => `---\ntitle: x${"'".repeat(n)}x\ntags: [${'"'.repeat(n)}]\n---\nbody`,
    'a long run of fence-like lines': (n) => `---\n${'---   \n'.repeat(Math.floor(n / 7))}`,
    'many colons': (n) => `---\n${':'.repeat(n)}\ntitle: ${':'.repeat(n)}\n---\nbody`,
    'many list items': (n) => `---\ntags:\n${'  - a\n'.repeat(Math.floor(n / 6))}---\nbody`,
    'many short lines': (n) => `---\n${'k: v\n'.repeat(190)}---\n${'x\n'.repeat(Math.floor(n / 2))}`,
    'a long heading': (n) => `# ${'#'.repeat(n)} x\n${'y'.repeat(10)}`,
    'a long comma list': (n) => `---\ntags: ${'a,'.repeat(Math.floor(n / 2))}\n---\nbody`,
  };

  it.each(Object.entries(SHAPES))('grows in step with the input for %s', (name, shape) => {
    const { ratio, smallMs, largeMs } = measureGrowth(shape(SMALL), shape(LARGE));
    expect(
      ratio,
      `${name}: 4x the input took ${ratio.toFixed(1)}x the time (${smallMs.toFixed(4)} ms -> ${largeMs.toFixed(4)} ms a parse)`
    ).toBeLessThan(9);
  });
});
