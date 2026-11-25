/**
 * repo-draft-links.js — finding the links in a repository draft that are
 * written relative to the repository, so the import can say they will not
 * work on the site. Re-exported by repo-draft.js, which reads the drafts.
 */

/**
 * The longest link target looked at. A real relative link to a draft is a
 * file name; the cap is what keeps the scan below linear in the body.
 */
const MAX_LINK_TARGET_CHARS = 200;

const isSpace = (char) => {
  const code = char.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(char));
};

/** The target after `](` up to its `)`, or null when it has no `)` within the cap or holds a space. */
function linkTargetAt(text, start) {
  const limit = Math.min(text.length, start + MAX_LINK_TARGET_CHARS + 1);
  for (let end = start; end < limit; end += 1) {
    const char = text[end];
    if (char === ')') return text.slice(start, end);
    if (isSpace(char)) return null;
  }
  return null;
}

/** `x.md` or `x.md#fragment` with a non-empty `x`: the first `.md` that ends the target or opens a fragment. */
function markdownFileOf(target) {
  for (let at = target.indexOf('.md', 1); at !== -1; at = target.indexOf('.md', at + 1)) {
    const next = target[at + 3];
    if (next === undefined || next === '#') return target.slice(0, at + 3);
  }
  return null;
}

/**
 * Links written relative to the repository (`[Part 2](blog-lab-02-x.md)`).
 * They work on GitHub and resolve to nothing on the site, so the import says
 * so rather than rewriting prose it does not own.
 *
 * A scan, not a pattern: the pattern this replaced
 * (`/\]\(((?!https?:\/\/|mailto:|#|\/)[^)\s]+?\.md)(?:#[^)\s]*)?\)/g`) took
 * cubic time on a body of repeated `](a.md#`, and 18 s on 130 000 bare `](`
 * (a 256 KB body, which a request can now carry). Each `](` here costs at
 * most MAX_LINK_TARGET_CHARS characters.
 */
export function findRepoRelativeLinks(body) {
  const text = String(body || '');
  const targets = new Set();
  let at = text.indexOf('](');
  while (at !== -1) {
    // Past the `](` normally; past the whole link when one matched, as the
    // pattern's global match did.
    let next = at + 2;
    const target = linkTargetAt(text, next);
    if (target !== null && !/^(?:https?:\/\/|mailto:|#|\/)/.test(target)) {
      const file = markdownFileOf(target);
      if (file) {
        targets.add(file);
        next += target.length + 1;
      }
    }
    at = text.indexOf('](', next);
  }
  return [...targets];
}
