import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORMAT_TO_TRACK,
  IDEA_FORMATS,
  checkNote,
  draftName,
  findObsidianOnly,
  frontMatterValue,
  parseNote,
  planPromotion,
} from './idea-notes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const note = (properties, body = 'An outline.\n') =>
  `---\n${properties.join('\n')}\n---\n${body}`;

const GOOD = ['type: blog', 'theme: landing-zones', 'format: how-to', 'status: outlined'];

/** The normalised idea for a note that follows the format. */
const idea = (properties = GOOD, body = 'An outline.\n', name = 'Landing zones for small teams.md') => {
  const { issues, note: normalised } = checkNote(name, note(properties, body));
  expect(issues).toEqual([]);
  return normalised;
};

const messages = (result) => result.issues.map((issue) => issue.message);

describe('parseNote', () => {
  it('reads scalars, inline lists and the block lists Obsidian writes', () => {
    const parsed = parseNote(
      note(['type: blog', 'tags: [a, "b c"]', 'aliases:', '  - one', '  - two', 'theme: x # comment'])
    );
    expect(parsed.fields.get('type')).toMatchObject({ kind: 'scalar', value: 'blog', line: 2 });
    expect(parsed.fields.get('tags').items).toEqual(['a', 'b c']);
    expect(parsed.fields.get('aliases')).toMatchObject({ kind: 'list', items: ['one', 'two'] });
    expect(parsed.fields.get('theme').value).toBe('x');
    expect(parsed.body).toBe('An outline.\n');
    expect(parsed.bodyLine).toBe(9);
  });

  it('reads a list the way Obsidian writes it, with the hyphens in column 0', () => {
    // https://obsidian.md/help/properties, "tags:" then "- journal", read 2026-10-24
    const parsed = parseNote(note(['tags:', '- journal', '- personal', 'type: blog']));
    expect(parsed.fields.get('tags')).toMatchObject({ kind: 'list', items: ['journal', 'personal'] });
    expect(parsed.fields.get('type').value).toBe('blog');
  });

  it('survives a byte-order mark and Windows line endings', () => {
    const parsed = parseNote(`﻿---\r\ntype: blog\r\n---\r\nBody\r\n`);
    expect(parsed.fields.get('type').value).toBe('blog');
    expect(parsed.body).toBe('Body\n');
  });

  it('says so when there is no block, or it never closes', () => {
    expect(parseNote('# Just a note').fields).toBeNull();
    expect(parseNote('---\ntype: blog\nno end').unclosed).toBe(true);
  });

  it('leaves alone any property name Obsidian allows: spaces, accents, a space before the colon', () => {
    const parsed = parseNote(
      note([
        'type: blog',
        'date created: 2026-01-01',
        'année: 2026',
        'related notes:',
        '- one',
        '- two',
        'status : outlined',
        'title: Landing zones: why not',
      ])
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.fields.get('date created').value).toBe('2026-01-01');
    expect(parsed.fields.get('année').value).toBe('2026');
    expect(parsed.fields.get('related notes').items).toEqual(['one', 'two']);
    expect(parsed.fields.get('status').value).toBe('outlined');
    expect(parsed.fields.get('title').value).toBe('Landing zones: why not');
  });

  it('still refuses a line that is not name: value', () => {
    const parsed = parseNote(note(['type:blog', 'just some words']));
    expect(parsed.problems.map((problem) => problem.line)).toEqual([2, 3]);
  });

  it('does not stumble on nested keys it does not need', () => {
    const parsed = parseNote(note(['type: blog', 'cssclasses:', '  nested: thing', '  more: stuff']));
    expect(parsed.problems).toEqual([]);
  });
});

describe('checkNote', () => {
  it('accepts a minimal note and takes the title from the file name', () => {
    const { issues, note: normalised } = checkNote('Landing zones for small teams.md', note(GOOD));
    expect(issues).toEqual([]);
    expect(normalised).toMatchObject({
      title: 'Landing zones for small teams',
      type: 'blog',
      theme: 'landing-zones',
      format: 'how-to',
      status: 'outlined',
      tags: [],
      reading: null,
      part: null,
      date: null,
    });
  });

  it('accepts every optional property and block-style tags', () => {
    const normalised = idea([
      ...GOOD,
      'title: A real title',
      'subtitle: One sentence.',
      'tags:',
      '  - azure',
      '  - "#terraform"',
      '  - azure',
      'reading: 12',
      'part: 1 of 2',
      'date: 2026-10-24',
    ]);
    expect(normalised).toMatchObject({
      title: 'A real title',
      subtitle: 'One sentence.',
      tags: ['azure', 'terraform'],
      reading: 12,
      part: '1 of 2',
      date: '2026-10-24',
    });
  });

  it('names each missing required property', () => {
    const result = checkNote('x.md', note(['title: only a title']));
    expect(messages(result)).toEqual([
      'type is missing',
      'format is missing',
      'status is missing',
      'theme is missing',
    ]);
    expect(result.note).toBeNull();
  });

  it('refuses a value outside the vocabulary and says what is allowed', () => {
    const result = checkNote('x.md', note(['type: post', 'theme: t', 'format: how-to', 'status: outline']));
    expect(messages(result)).toEqual([
      'type: "post" is not one of blog, framework, architecture, coder_corner',
      'status: "outline" is not one of idea, outlined, drafted, published, parked',
    ]);
    expect(result.issues[0]).toMatchObject({ field: 'type', line: 2 });
  });

  it('holds theme, tags, reading, part and date to their shapes', () => {
    const result = checkNote(
      'x.md',
      note([
        ...GOOD.slice(0, 1),
        'theme: Landing Zones',
        'format: how-to',
        'status: idea',
        'tags: [Azure, ok]',
        'reading: 0',
        'part: first',
        'date: 2026-02-30',
      ])
    );
    expect(messages(result)).toEqual([
      expect.stringContaining('theme: "Landing Zones" must be lower-case words'),
      expect.stringContaining('tag "Azure" must be lower-case words'),
      expect.stringContaining('reading: "0"'),
      expect.stringContaining('part: "first" must be written like "1 of 2"'),
      expect.stringContaining('date: "2026-02-30" must be a real date'),
    ]);
  });

  it('refuses a list where one value is needed, and a duplicate key', () => {
    const result = checkNote('x.md', note(['type: blog', 'type: blog', 'theme:', '  - a', 'format: how-to', 'status: idea']));
    expect(messages(result)).toEqual(['type is written twice', 'theme must be one value, not a list']);
  });

  it('refuses a value that starts with a quote and carries on, which would be cut off', () => {
    const result = checkNote('x.md', note([...GOOD, 'title: "Quoted" at the start']));
    expect(messages(result)).toEqual([
      expect.stringContaining('title starts with a quote mark and carries on after it ("at the start")'),
    ]);
    expect(checkNote('x.md', note([...GOOD, "title: '\"Quoted\" at the start'"])).issues).toEqual([]);
    expect(checkNote('x.md', note([...GOOD, 'title: "Whole value" # a comment'])).issues).toEqual([]);
  });

  it('points at a key written in the wrong case', () => {
    const result = checkNote('x.md', note(['Type: blog', 'theme: t', 'format: how-to', 'status: idea']));
    expect(messages(result)).toContain('write "Type" in lower case, as "type"');
    expect(messages(result)).toContain('type is missing');
  });

  it('holds the title and subtitle to the import limits', () => {
    const result = checkNote(
      'x.md',
      note([...GOOD, `title: ${'t'.repeat(301)}`, `subtitle: ${'s'.repeat(501)}`])
    );
    expect(messages(result)).toEqual([
      'title is 301 characters; at most 300',
      'subtitle is 501 characters; at most 500',
    ]);
  });

  it('wants an outline once the idea is outlined, and not before', () => {
    expect(messages(checkNote('x.md', note(GOOD, '\n\n')))).toEqual([
      expect.stringContaining('status is "outlined" but nothing is written'),
    ]);
    expect(checkNote('x.md', note(['type: blog', 'theme: t', 'format: how-to', 'status: idea'], '')).issues).toEqual([]);
  });

  it('says what is wrong with a note that has no properties at all', () => {
    expect(messages(checkNote('x.md', '# Heading'))[0]).toContain('must start with a --- line');
    expect(messages(checkNote('x.md', '---\ntype: blog\n'))[0]).toContain('never closes');
  });
});

describe('findObsidianOnly', () => {
  it('finds wikilinks, embeds, comments and query blocks, with file line numbers', () => {
    const found = findObsidianOnly(
      ['fine', 'see [[Other note]]', '![[diagram.png]]', 'a %%private%% bit', '```dataview', 'LIST', '```'].join('\n'),
      10
    );
    expect(found.map((hit) => hit.line)).toEqual([11, 12, 13, 14]);
    expect(found[3].what).toContain('dataview block');
  });

  it('leaves code alone: a shell test in a fence or inline code is not a wikilink', () => {
    const body = ['```bash', 'if [[ -f x ]]; then echo %% ; fi', '```', 'use `[[` in bash'].join('\n');
    expect(findObsidianOnly(body)).toEqual([]);
  });
});

describe('frontMatterValue and draftName', () => {
  it('leaves a plain value plain and quotes only what the import would misread', () => {
    expect(frontMatterValue('A production platform for $150')).toBe('A production platform for $150');
    expect(frontMatterValue('Landing zones: why not')).toBe('"Landing zones: why not"');
    expect(frontMatterValue('Cost # not a comment')).toBe('"Cost # not a comment"');
    expect(frontMatterValue('"Quoted" start')).toBe("'\"Quoted\" start'");
    expect(frontMatterValue(`It's "both"`)).toBeNull();
  });

  it('makes a file name of lower-case words', () => {
    expect(draftName('Landing zones: why not?')).toBe('landing-zones-why-not');
    expect(draftName('Café — résumé')).toBe('cafe-resume');
    expect(draftName('日本語')).toBe('');
    expect(draftName('a'.repeat(120)).length).toBe(80);
  });
});

describe('planPromotion', () => {
  const when = () => new Date('2026-10-24T12:00:00Z');

  it('writes the draft the import reads, with the note body as the article', () => {
    const plan = planPromotion(
      idea([...GOOD, 'subtitle: One sentence.', 'tags: [azure, terraform]', 'reading: 12', 'part: 1 of 2'], 'Intro.\n\n## Step\n'),
      { now: when }
    );
    expect(plan).toEqual({
      ok: true,
      name: 'landing-zones-for-small-teams',
      fileName: 'blog-landing-zones-for-small-teams.md',
      text: [
        '---',
        'title: Landing zones for small teams',
        'subtitle: One sentence.',
        'date: 2026-10-24',
        'track: how-to',
        'part: 1 of 2',
        'tags: [azure, terraform]',
        'reading: 12',
        '---',
        '',
        'Intro.\n\n## Step',
        '',
      ].join('\n'),
    });
  });

  it('keeps the idea’s own date, takes a name from the caller and maps build-log', () => {
    const plan = planPromotion(
      idea(['type: blog', 'theme: t', 'format: build-log', 'status: outlined', 'date: 2026-09-01']),
      { name: 'my-name', now: when }
    );
    expect(plan.fileName).toBe('blog-my-name.md');
    expect(plan.text).toContain('date: 2026-09-01\ntrack: build-log\n');
  });

  it('says every reason it refuses, not just the first', () => {
    const plan = planPromotion(
      idea(['type: framework', 'theme: t', 'format: video', 'status: idea'], 'See [[Another]]\n')
    );
    expect(plan.ok).toBe(false);
    expect(plan.reasons).toEqual([
      'status is "idea"; only an outlined idea is promoted',
      expect.stringContaining('type is "framework"'),
      'format is "video"; a blog draft is a how-to or a build-log',
      expect.stringContaining('line 7: a [[wikilink]]'),
    ]);
  });

  it('refuses a name or title that cannot be a draft', () => {
    expect(planPromotion(idea(), { name: 'Bad Name' }).reasons).toEqual([
      '--name "Bad Name" must be lower-case words joined by hyphens',
    ]);
    const noName = planPromotion(idea(GOOD, 'x\n', '日本語.md'));
    expect(noName.reasons[0]).toContain('pass --name');
    const both = planPromotion(idea([...GOOD, `title: It's "both"`]));
    expect(both.reasons).toEqual(['the title holds both kinds of quote mark; reword it']);
  });

  it('only ever offers the two formats that are blog tracks', () => {
    expect(Object.keys(FORMAT_TO_TRACK).every((format) => IDEA_FORMATS.includes(format))).toBe(true);
  });
});

describe('the two scripts, run for real', () => {
  let dir;
  let vault;
  let out;

  const run = (script, args) => {
    try {
      const stdout = execFileSync(process.execPath, [join(HERE, script), ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hcw-ideas-'));
    vault = join(dir, 'vault');
    out = join(dir, 'out');
    mkdirSync(join(vault, 'sub'), { recursive: true });
    mkdirSync(join(vault, '.obsidian'));
    mkdirSync(out);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('print usage for --help, so we know the entry-point guard fires', () => {
    for (const script of ['check-idea-notes.mjs', 'promote-idea.mjs']) {
      const got = run(script, ['--help']);
      expect(got.code).toBe(0);
      expect(got.stdout).toContain(`Usage: node scripts/ideas/${script}`);
    }
  });

  it('check: reads good and bad notes, skips dot and underscore names, and changes nothing', () => {
    writeFileSync(join(vault, 'Good.md'), note(GOOD));
    writeFileSync(join(vault, 'sub', 'Bad.md'), note(['type: post', 'theme: t', 'format: how-to', 'status: idea']));
    writeFileSync(join(vault, '.obsidian', 'workspace.md'), 'not a note');
    writeFileSync(join(vault, '_Template.md'), 'not a note either');
    const before = sha(join(vault, 'Good.md'));
    const got = run('check-idea-notes.mjs', [vault]);
    expect(got.code).toBe(1);
    expect(got.stdout).toContain('sub/Bad.md\n  line 2: type: "post" is not one of');
    expect(got.stdout).toContain('2 notes checked: 1 fine, 1 with problems.');
    expect(got.stdout).toContain('Fine notes by status: outlined 1.');
    expect(got.stdout).not.toContain('workspace.md');
    expect(sha(join(vault, 'Good.md'))).toBe(before);
  });

  it('check: exits 0 when every note is fine, and 2 when it cannot run', () => {
    writeFileSync(join(vault, 'Good.md'), note(GOOD));
    expect(run('check-idea-notes.mjs', [vault]).stdout).toContain('1 notes checked, all fine.');
    expect(run('check-idea-notes.mjs', [join(dir, 'missing')]).code).toBe(2);
    expect(run('check-idea-notes.mjs', [join(vault, 'sub')]).code).toBe(2);
    expect(run('check-idea-notes.mjs', []).code).toBe(2);
  });

  it('promote: writes the draft with LF line endings, leaves the note alone, never overwrites', () => {
    const source = join(vault, 'Landing zones for small teams.md');
    writeFileSync(source, note([...GOOD, 'tags: [azure]'], 'Intro.\r\n'));
    const before = sha(source);
    const got = run('promote-idea.mjs', [source, '--out-dir', out]);
    expect(got.code).toBe(0);
    expect(got.stdout).toContain('Read the draft through');
    const written = join(out, 'blog-landing-zones-for-small-teams.md');
    const text = readFileSync(written, 'utf8');
    expect(text).toContain('title: Landing zones for small teams\n');
    expect(text).not.toContain('\r');
    expect(sha(source)).toBe(before);

    const again = run('promote-idea.mjs', [source, '--out-dir', out]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('never overwrites');
    expect(readFileSync(written, 'utf8')).toBe(text);

    const renamed = run('promote-idea.mjs', [source, '--out-dir', out, '--name', 'second-try']);
    expect(renamed.code).toBe(0);
    expect(existsSync(join(out, 'blog-second-try.md'))).toBe(true);
  });

  it('promote: --dry-run writes nothing, and a note that is not ready is refused with the reasons', () => {
    const ready = join(vault, 'Ready.md');
    writeFileSync(ready, note(GOOD));
    const dry = run('promote-idea.mjs', [ready, '--out-dir', out, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Would write');
    expect(readdirSync(out)).toEqual([]);

    const early = join(vault, 'Early.md');
    writeFileSync(early, note(['type: blog', 'theme: t', 'format: how-to', 'status: idea']));
    const refused = run('promote-idea.mjs', [early, '--out-dir', out]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('only an outlined idea is promoted');

    const broken = join(vault, 'Broken.md');
    writeFileSync(broken, '# no properties');
    const bad = run('promote-idea.mjs', [broken, '--out-dir', out]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('does not follow the idea-note format');
    expect(readdirSync(out)).toEqual([]);
  });

  it('a file over 1 MB is not an idea note: the check says so, and promote will not read it', () => {
    const huge = join(vault, 'Huge.md');
    writeFileSync(huge, note(GOOD, 'x'.repeat(1024 * 1024 + 10)));
    writeFileSync(join(vault, 'Good.md'), note(GOOD));
    const checked = run('check-idea-notes.mjs', [vault]);
    expect(checked.code).toBe(1);
    expect(checked.stdout).toContain('Huge.md\n  the file is over 1 MB, which is not an idea note');
    expect(checked.stdout).toContain('2 notes checked: 1 fine, 1 with problems.');
    const promoted = run('promote-idea.mjs', [huge, '--out-dir', out]);
    expect(promoted.code).toBe(2);
    expect(promoted.stderr).toContain('the file is over 1 MB');
    expect(readdirSync(out)).toEqual([]);
  });

  it('a folder where a note belongs is refused, not read', () => {
    expect(run('promote-idea.mjs', [vault, '--out-dir', out]).code).toBe(2);
  });

  it('promote: an option missing its value is an error, never a guess at the current folder', () => {
    const ready = join(vault, 'Ready.md');
    writeFileSync(ready, note(GOOD));
    for (const args of [
      [ready, '--out-dir'],
      [ready, '--out-dir', '--dry-run'],
      [ready, '--name'],
      [ready, '--name', '--dry-run'],
    ]) {
      const got = run('promote-idea.mjs', args);
      expect(got.code, args.join(' ')).toBe(2);
      expect(got.stderr).toMatch(/--(out-dir needs a folder|name needs a value)/);
    }
    expect(readdirSync(out)).toEqual([]);
  });

  it('promote: exit 2 for a missing note, an unknown option or no note at all', () => {
    expect(run('promote-idea.mjs', [join(vault, 'none.md')]).code).toBe(2);
    expect(run('promote-idea.mjs', ['--bogus']).code).toBe(2);
    expect(run('promote-idea.mjs', []).code).toBe(2);
  });
});
