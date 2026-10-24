/**
 * The draft that scripts/ideas/promote-idea.mjs writes is read by the real
 * import (repo-draft.js), and the limits the idea-note format states are the
 * import's own.
 *
 * WHY THIS LIVES IN functions/. The promote script is dependency-free and
 * lives in scripts/; the import pulls in the Cosmos client, which only this
 * package installs. A test here can hold the two to each other, and fails when
 * either side moves: a title limit changed in repo-draft.js, a content type
 * added to the publisher, a draft path rule tightened. CI's `functions` row
 * watches scripts/ideas/idea-notes.mjs for exactly that reason.
 */
import { describe, it, expect } from 'vitest';
import {
  IDEA_TYPES,
  LIMITS,
  checkNote,
  planPromotion,
} from '../../../../scripts/ideas/idea-notes.mjs';
import {
  MAX_REPO_PATH_LENGTH,
  MAX_SUBTITLE_CHARS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  MAX_TITLE_CHARS,
  checkRepoDraftPath,
  parseRepoDraft,
} from './repo-draft.js';
import { SUPPORTED_PUBLISH_TARGETS } from './publish-targets.js';

const WHEN = () => new Date('2026-10-24T12:00:00Z');

const promote = (properties, body, name = 'An idea.md', options = {}) => {
  const text = `---\n${properties.join('\n')}\n---\n${body}`;
  const { issues, note } = checkNote(name, text);
  expect(issues).toEqual([]);
  const plan = planPromotion(note, { now: WHEN, ...options });
  expect(plan.ok).toBe(true);
  return plan;
};

const BASE = ['type: blog', 'theme: landing-zones', 'format: how-to', 'status: outlined'];

describe('what promote-idea writes is a draft the import accepts', () => {
  it('reads back every field a full note carried', () => {
    const plan = promote(
      [
        ...BASE,
        'title: Landing zones for small teams',
        'subtitle: What to build first, and what to leave out.',
        'tags:',
        '  - azure',
        '  - terraform',
        'reading: 12',
        'part: 1 of 2',
        'date: 2026-10-01',
      ],
      'Intro paragraph.\n\n## First step\n\nDo it.\n'
    );
    expect(checkRepoDraftPath(`docs/content/${plan.fileName}`).ok).toBe(true);
    const parsed = parseRepoDraft(plan.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.draft).toMatchObject({
      title: 'Landing zones for small teams',
      subtitle: 'What to build first, and what to leave out.',
      date: '2026-10-01',
      track: 'how-to',
      part: '1 of 2',
      tags: ['azure', 'terraform'],
      reading: 12,
    });
    expect(parsed.warnings ?? parsed.draft.warnings ?? []).toEqual([]);
  });

  it('reads back a title the reader could misread: a colon, a hash, a leading quote', () => {
    // [how the title is written in the note, the title it means]
    for (const [written, title] of [
      ['Landing zones: why not?', 'Landing zones: why not?'],
      ['"Cost # not a comment"', 'Cost # not a comment'],
      ['\'"Quoted" at the start\'', '"Quoted" at the start'],
      ["Don't trust the default", "Don't trust the default"],
      ['Ends with a quote"', 'Ends with a quote"'],
    ]) {
      const plan = promote([...BASE, `title: ${written}`], 'Body.\n');
      expect(parseRepoDraft(plan.text).draft.title).toBe(title);
    }
  });

  it('takes the track from the format, and fills the date when the note has none', () => {
    const plan = promote(
      ['type: blog', 'theme: t', 'format: build-log', 'status: outlined'],
      'Body.\n'
    );
    const { draft } = parseRepoDraft(plan.text);
    expect(draft.track).toBe('build-log');
    expect(draft.date).toBe('2026-10-24');
  });

  it('keeps the whole note body as the article', () => {
    const body = '# Heading\n\nA paragraph with a [link](https://example.com).\n\n```bash\nif [[ -f x ]]; then echo ok; fi\n```\n';
    const plan = promote(BASE, body);
    expect(plan.text.endsWith(`${body.trimEnd()}\n`)).toBe(true);
  });
});

describe('the format states the import’s own limits', () => {
  it('matches the title, subtitle, tag and path limits in repo-draft.js', () => {
    expect(LIMITS.title).toBe(MAX_TITLE_CHARS);
    expect(LIMITS.subtitle).toBe(MAX_SUBTITLE_CHARS);
    expect(LIMITS.tags).toBe(MAX_TAGS);
    expect(LIMITS.tag).toBe(MAX_TAG_CHARS);
  });

  it('offers the content types the publisher supports, and no others', () => {
    expect([...IDEA_TYPES].sort()).toEqual([...SUPPORTED_PUBLISH_TARGETS].sort());
  });

  it('writes the longest draft name the import accepts, and refuses one character more', () => {
    const longest = 'a'.repeat(MAX_REPO_PATH_LENGTH - 'docs/content/blog-'.length - '.md'.length);
    const accepted = promote(BASE, 'Body.\n', 'x.md', { name: longest });
    expect(checkRepoDraftPath(`docs/content/${accepted.fileName}`).ok).toBe(true);

    const { note } = checkNote('x.md', `---\n${BASE.join('\n')}\n---\nBody.\n`);
    const refused = planPromotion(note, { name: `${longest}a` });
    expect(refused.ok).toBe(false);
    expect(checkRepoDraftPath(`docs/content/blog-${longest}a.md`).ok).toBe(false);
  });
});
