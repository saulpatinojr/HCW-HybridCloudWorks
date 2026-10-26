/**
 * Guard: no draft article may sit in docs/content.
 *
 * Owner rule 2026-10-25. This repository is public, and the documentation site
 * (docs.hybridcloudworks.com) is built from docs/, so a `blog-*.md` file
 * committed to docs/content is readable by everyone the moment it merges, long
 * before the owner decides to publish it. Seventeen of them were removed in
 * #1381. This test fails if one is added again.
 *
 * Only the two contract files are allowed: blog-template.md and
 * blog-machine.md describe how an article is written and contain no article
 * text. Everything else that starts with `blog-` and ends in `.md` is treated
 * as a draft, in any sub-folder and in any letter case, because the check that
 * matters is "could a reader of the public site see an unfinished article".
 *
 * The CI row that runs this (functions (azure)) watches docs/content/, so the
 * test runs on a pull request that only adds such a file.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS_CONTENT = fileURLToPath(new URL('../../docs/content/', import.meta.url));

/** The only blog-*.md files that may live in docs/content. */
export const ALLOWED_CONTRACT_FILES = Object.freeze(['blog-template.md', 'blog-machine.md']);

/**
 * The paths (relative to docs/content, with `/` separators) that look like a
 * draft article: a file named blog-<something>.md, other than the two
 * contract files.
 *
 * @param {string[]} relativePaths - every file under docs/content
 * @returns {string[]}
 */
export function strayDrafts(relativePaths) {
  return relativePaths.filter((path) => {
    const name = path.split('/').at(-1).toLowerCase();
    // Draft detection ignores letter case, but the allowance is an exact match
    // on the path: only the two contract files, spelt exactly so, at the top of
    // docs/content. A case variant such as BLOG-TEMPLATE.MD is a draft.
    return /^blog-.+\.md$/.test(name) && !ALLOWED_CONTRACT_FILES.includes(path);
  });
}

/** The message a person sees when the guard fails: what the rule is and what to do. */
export function failureMessage(strays) {
  return [
    '',
    `Draft article(s) found in docs/content: ${strays.join(', ')}`,
    '',
    'This repository is public, and the documentation site is built from docs/.',
    'A file committed here is readable by everyone as soon as it is merged, long',
    "before the owner decides to publish it. Pre-publish drafts are the owner's",
    'content and must not live in this repository (owner rule 2026-10-25).',
    '',
    'What to do: remove the file from this pull request. A draft belongs in the',
    "owner's private vault, in its Drafts folder, and is then uploaded on the",
    'admin Drafts page (https://hybridcloudworks.com/admin/drafts).',
    'scripts/ideas/promote-idea.mjs writes it to the vault and refuses repository',
    'paths. See docs/runbooks/obsidian-idea-notes.md and .claude/CLAUDE.md.',
    '',
    `Only ${ALLOWED_CONTRACT_FILES.join(' and ')} may match blog-*.md here. They`,
    'describe how articles are written and hold no article text. If a test needs',
    'a sample article, put a made-up one in functions/src/lib/cms/__fixtures__.',
    'Do not add the new name to ALLOWED_CONTRACT_FILES to make this pass.',
    '',
  ].join('\n');
}

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath.slice(directory.length)}/${entry.name}`
        .replaceAll('\\', '/')
        .replace(/^\/+/, '')
    );
}

describe('docs/content holds no draft articles', () => {
  it('lists the two contract files, so the check is looking at the right folder', () => {
    const names = filesUnder(DOCS_CONTENT);
    for (const contract of ALLOWED_CONTRACT_FILES) expect(names).toContain(contract);
  });

  it('has no blog-*.md file besides blog-template.md and blog-machine.md', () => {
    const strays = strayDrafts(filesUnder(DOCS_CONTENT));
    expect(strays, failureMessage(strays)).toEqual([]);
  });
});

describe('the rule itself', () => {
  it('lets the two contract files through', () => {
    expect(strayDrafts(['blog-template.md', 'blog-machine.md'])).toEqual([]);
  });

  it.each([
    ['a new draft', 'blog-test.md'],
    ['a numbered draft', 'blog-lab-01-landing-zone.md'],
    ['a draft in a sub-folder', 'drafts/blog-x.md'],
    ['a different letter case', 'Blog-Test.MD'],
    ['a contract file name in a sub-folder', 'old/blog-template.md'],
    ['a case variant of a contract file', 'BLOG-TEMPLATE.MD'],
    ['a case variant of the other contract file', 'Blog-Machine.md'],
  ])('flags %s', (_label, path) => {
    expect(strayDrafts([path])).toEqual([path]);
  });

  it.each([
    ['a file that is not a blog draft', 'README.md'],
    ['a blog file that is not markdown', 'blog-test.txt'],
    ['a name that only contains blog-', 'my-blog-test.md'],
  ])('does not flag %s', (_label, path) => {
    expect(strayDrafts([path])).toEqual([]);
  });

  it('says what the rule is and where drafts go', () => {
    const message = failureMessage(['blog-test.md']);
    expect(message).toContain('blog-test.md');
    expect(message).toContain('public');
    expect(message).toContain("private vault");
    expect(message).toContain('https://hybridcloudworks.com/admin/drafts');
  });
});
