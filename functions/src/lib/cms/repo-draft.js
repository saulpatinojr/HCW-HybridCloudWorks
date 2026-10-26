/**
 * repo-draft.js — the pure half of reading a `blog-*.md` draft: which paths
 * pass the allow-list, how the front matter is read, and the content document
 * a draft becomes. It began as the import of `docs/content/blog-*.md` files
 * from the repository (owner request 2026-09-28). That import was removed on
 * 2026-10-25 because pre-publish drafts do not live in the public repository;
 * the parser stays because the markdown upload (./drafts-markdown.js) reads
 * every draft with it, and documents imported earlier keep their ids and
 * provenance fields.
 *
 * Nothing here does I/O. The pinned GitHub fetch is ./repo-draft-source.js and
 * the HTTP shape ./drafts-handlers.js.
 *
 * THE ALLOW-LIST IS A PATTERN, NOT A LOOKUP. `^docs/content/blog-[a-z0-9-]+\.md$`
 * admits no `.`, `/`, `%` or `\` after the directory, so a traversal
 * (`docs/content/../x`), another directory, an encoded separator and a
 * Windows separator all fail the same test, before any URL is built. The two
 * contract documents in the same directory (blog-template.md, blog-machine.md)
 * match the pattern and are refused by name: they describe articles, they are
 * not articles.
 *
 * THE FRONT-MATTER READER IS A PORT, NOT A NEW PARSER. The repository has one
 * front-matter reader, `frontmatter()` in tooling/workflow.py: an anchored
 * `---` block, one `key: value` per line, a value starting with `#` skipped,
 * a trailing ` #` comment dropped, surrounding quotes stripped. That is ported
 * here line for line, with two additions the blog contract needs and the
 * agent files it was written for do not: a quoted value is taken whole (so a
 * title in quotes may contain ` #`, as YAML allows), and `tags` is read as the
 * inline list every post in docs/content writes (`[azure, terraform]`). The
 * keys interpreted are exactly the seven in docs/content/blog-template.md's
 * "Front matter" section — title, subtitle, date, track, part, tags,
 * reading — and no others.
 *
 * THE BODY IS NOT TRANSFORMED. The text after the closing `---` goes into the
 * document as written, so a `landing-zone` or `pricing-scenario` fence reaches
 * the review board and the publish renderer byte for byte. The one change is
 * the one every content writer makes, made when the draft is sent to In
 * Review (./drafts.js buildSendToReviewPatch): normalizeContentBodyFields,
 * which trims and moves a TL;DR section to the end.
 */
import { createHash } from 'node:crypto';
import { slugify } from './publish.js';
import { normalizeProviderName } from './content-update-validation.js';

/**
 * Where the repository lives. It moved from the HybridCloudWorks organisation
 * to saulpatinojr on 2026-10-07, and every request here refuses a redirect
 * (`redirect: 'error'`, ./repo-draft-source.js), so the import could not
 * reach the old address once it only redirected (#1009). The `github_org`
 * default in infra/variables.tf is the same owner, and repo-draft.test.js
 * holds the two equal.
 */
export const REPO_OWNER = 'saulpatinojr';
export const REPO_NAME = 'HCW-HybridCloudWorks';
/** The branch every import reads. A draft on another branch is not reviewable here yet. */
export const REPO_REF = 'main';
export const REPO_DRAFT_DIR = 'docs/content';

export const RAW_ORIGIN = 'https://raw.githubusercontent.com';
export const API_ORIGIN = 'https://api.github.com';
/** Every raw fetch starts with this, and nothing else is fetched from raw. */
export const RAW_PATH_PREFIX = `/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}/${REPO_DRAFT_DIR}/`;
/** Every API call starts with this. */
export const API_PATH_PREFIX = `/repos/${REPO_OWNER}/${REPO_NAME}/`;

export const REPO_DRAFT_PATH_PATTERN = /^docs\/content\/blog-[a-z0-9-]+\.md$/;

/** The article contract and the Blog Machine program — same directory, not articles. */
export const CONTRACT_DOC_PATHS = Object.freeze([
  'docs/content/blog-template.md',
  'docs/content/blog-machine.md',
]);

/** Longer than any real path under the pattern; a cap before the regex runs. */
export const MAX_REPO_PATH_LENGTH = 120;

export const MAX_TITLE_CHARS = 300;
export const MAX_SUBTITLE_CHARS = 500;
export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 40;

/** Fence languages that render as embeds (blog-template.md "Code blocks"). */
export const EMBED_FENCE_LANGUAGES = Object.freeze(['landing-zone', 'pricing-scenario']);

/**
 * May this path be imported? Pure; the only gate between a request body and
 * a URL.
 *
 * @param {unknown} value
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function checkRepoDraftPath(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'path must be a string' };
  if (value.length === 0 || value.length > MAX_REPO_PATH_LENGTH) {
    return { ok: false, reason: `path must be 1-${MAX_REPO_PATH_LENGTH} characters` };
  }
  if (!REPO_DRAFT_PATH_PATTERN.test(value)) {
    return {
      ok: false,
      reason: 'path must match docs/content/blog-<lowercase-name>.md',
    };
  }
  if (CONTRACT_DOC_PATHS.includes(value)) {
    return { ok: false, reason: `${value} is the article contract, not an article` };
  }
  return { ok: true, path: value };
}

/** The one raw URL a path may be fetched from. Call only with a checked path. */
export function rawUrlFor(path) {
  return `${RAW_ORIGIN}/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}/${path}`;
}

/** The GitHub page for the file, for the review board's Source URL link. */
export function blobUrlFor(path) {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${REPO_REF}/${path}`;
}

/** sha256 of a string or buffer, hex. Detects "the file has not changed since". */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The namespace for repoDraftContentId. Fixed forever: changing it would give
 * every already-imported draft a different id, and the next import would find
 * the old document by repoPath and the new id would never be used — harmless,
 * but it would make the id meaningless as a key.
 */
export const REPO_DRAFT_ID_NAMESPACE = '8bccdb11-a980-4071-bc3a-805c389b371b';

/**
 * The repository as it was named when drafts were first imported, which is
 * part of every draft's id. Fixed for the namespace's reason: when the
 * repository moved to saulpatinojr (2026-10-07) the id had to stay what it
 * was, or a draft imported before the move would be imported again under a
 * second id. This is an id seed, not an address; REPO_OWNER is the address.
 */
export const REPO_DRAFT_ID_REPOSITORY = 'HybridCloudWorks/HCW-HybridCloudWorks';

/**
 * A deterministic, UUID-shaped document id for a repository path (RFC 9562
 * version 5: SHA-1 over the namespace and the name).
 *
 * Why not randomUUID, which every other creator uses: the create is the one
 * write in the import that has no document to condition on. With a fresh
 * random id, two imports of the same path racing each other (a double click)
 * would both find nothing by repoPath and both create, and every later import
 * would then find two. With the id derived from the path, both race to the
 * same id and the create is create-only (drafts-handlers.js), so the second one
 * is refused rather than duplicated. UUID-shaped so nothing downstream — the
 * slug suffix a colliding publish takes, the preview route — sees a
 * difference.
 */
export function repoDraftContentId(path) {
  const namespace = Buffer.from(REPO_DRAFT_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const name = Buffer.from(`${REPO_DRAFT_ID_REPOSITORY}:${path}`, 'utf8');
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `\A---\s*\n(.*?)\n---\s*\n` from workflow.py, on LF-normalised text. */
const FRONT_MATTER_BLOCK = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/;
/**
 * `^([A-Za-z_][\w-]*):\s*(.+?)\s*$` from workflow.py, with the value trimmed
 * in code instead of by `\s*(.+?)\s*$`: that pattern backtracks quadratically
 * on a long run of spaces inside a value, and a front-matter block can now
 * arrive in a request body (drafts-markdown.js), not only from the
 * repository. An empty value is skipped, as the original's `.+?` did.
 */
const FRONT_MATTER_LINE = /^([A-Za-z_][\w-]*):(.*)$/;

const isQuote = (char) => char === '"' || char === "'";

/**
 * `value.replace(/^["']+|["']+$/g, '')` without the regex: the second
 * alternative rescans a long run of quotes from every position, which is
 * quadratic on a value such as `x''''…'x`.
 */
function stripQuotes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && isQuote(value[start])) start += 1;
  while (end > start && isQuote(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function readScalar(raw) {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, 1);
    if (close > 0) return raw.slice(1, close);
  }
  // workflow.py: `value.split(" #", 1)[0].strip().strip("\"'")`
  return stripQuotes(raw.split(' #')[0].trim());
}

/**
 * The front-matter block of a markdown file, as flat string fields, and the
 * text after it. `fields` is null when the file does not open with a block.
 *
 * @param {string} text
 * @returns {{ fields: Record<string, string> | null, body: string }}
 */
export function parseFrontMatter(text) {
  const source = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');
  const match = FRONT_MATTER_BLOCK.exec(source);
  if (!match) return { fields: null, body: source };
  const fields = {};
  for (const line of match[1].split('\n')) {
    const entry = FRONT_MATTER_LINE.exec(line);
    const value = entry ? entry[2].trim() : '';
    if (value && !value.startsWith('#')) fields[entry[1]] = readScalar(value);
  }
  return { fields, body: source.slice(match[0].length) };
}

/** `[a, b]` or `a, b` → ['a', 'b'], trimmed, unquoted, capped. */
export function parseInlineList(value) {
  const raw = String(value || '').trim();
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return inner
    .split(',')
    .map((item) => stripQuotes(item.trim()).slice(0, MAX_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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

/** How many embed fences of each kind the body carries. */
export function countEmbedFences(body) {
  const counts = {};
  for (const language of EMBED_FENCE_LANGUAGES) {
    const fence = new RegExp(`^\`\`\`${language}[^\\S\\n]*$`, 'gm');
    counts[language] = (String(body || '').match(fence) || []).length;
  }
  return counts;
}

/**
 * The first tag that names a provider the CMS knows, else null.
 *
 * Docker only when no other provider is tagged, the rule `docker` being last
 * in frontend/src/lib/providers.js states: a post about Docker on Azure, in a
 * GitHub workflow or with Terraform belongs to that provider's blog.
 */
export function inferProviderFromTags(tags = []) {
  let docker = null;
  for (const tag of tags) {
    const provider = normalizeProviderName(tag);
    if (provider === 'Docker') docker = provider;
    else if (provider) return provider;
  }
  return docker;
}

const refuse = (code, error) => ({ ok: false, code, error });

/**
 * A draft file → the fields the content document is built from, or the
 * reason it cannot be one. Pure.
 *
 * @param {string} text the file as fetched
 * @returns {{ ok: true, draft: object } | { ok: false, code: string, error: string }}
 */
export function parseRepoDraft(text) {
  const { fields, body } = parseFrontMatter(text);
  if (!fields) {
    return refuse(
      'NO_FRONT_MATTER',
      'The file does not open with a --- front-matter block (docs/content/blog-template.md, "Front matter").'
    );
  }
  const title = String(fields.title || '').trim();
  if (!title) return refuse('NO_TITLE', 'The front matter has no title.');
  if (title.length > MAX_TITLE_CHARS) {
    return refuse(
      'TITLE_TOO_LONG',
      `The title is ${title.length} characters; at most ${MAX_TITLE_CHARS}.`
    );
  }
  const articleBody = body.replace(/^\n+/, '').trimEnd();
  if (!articleBody.trim()) return refuse('EMPTY_BODY', 'The file has front matter and no article.');

  const warnings = [];
  const date = String(fields.date || '').trim();
  if (date && !isCalendarDate(date))
    warnings.push(`date "${date}" is not YYYY-MM-DD and was ignored`);
  const readingRaw = String(fields.reading || '').trim();
  const reading =
    /^\d{1,3}$/.test(readingRaw) && Number(readingRaw) > 0 ? Number(readingRaw) : null;
  if (readingRaw && reading === null)
    warnings.push(`reading "${readingRaw}" is not a number of minutes and was ignored`);
  const relativeLinks = findRepoRelativeLinks(articleBody);
  if (relativeLinks.length) {
    warnings.push(
      `links to repository files will not resolve on the site: ${relativeLinks.join(', ')}`
    );
  }

  const tags = parseInlineList(fields.tags);
  return {
    ok: true,
    draft: {
      title,
      subtitle: String(fields.subtitle || '')
        .trim()
        .slice(0, MAX_SUBTITLE_CHARS),
      date: date && isCalendarDate(date) ? date : null,
      track: String(fields.track || '').trim() || null,
      part: String(fields.part || '').trim() || null,
      tags,
      reading,
      body: articleBody,
      // What the first publish will assign, absent a collision: processPublishContent
      // takes slugify(title) on a first publish and ignores a stored slug. It is
      // reported, not stored — see buildRepoDraftData.
      slug: slugify(title),
      provider: inferProviderFromTags(tags),
      embeds: countEmbedFences(articleBody),
      warnings,
    },
  };
}

/** The front matter as read, kept on the document for provenance. */
function frontMatterRecord(draft) {
  return {
    title: draft.title,
    subtitle: draft.subtitle,
    date: draft.date,
    track: draft.track,
    part: draft.part,
    tags: draft.tags,
    reading: draft.reading,
  };
}

/** Where the bytes came from. `commitSha` null means the lookup failed and `ref` is all there is. */
function provenance({ path, source }) {
  return {
    repoPath: path,
    repoRef: REPO_REF,
    repoCommitSha: source.commitSha || null,
    repoRawUrl: source.rawUrl,
    repoContentSha256: source.contentSha256,
  };
}

/**
 * The document an imported file becomes, shaped like every other draft (the
 * Publish-Ready Builder's persistStage.js payload and draft-from-recording.js
 * are the two it follows) so createContentDocument would accept it as is.
 *
 * The Drafts import (./drafts.js asImportedDraft) lays the Drafts stage's
 * status and stamping over it: `contentStatus: 'drafting'`, `Live: false`,
 * asserted again where the write happens. The `in_review` below is the
 * state the original import wrote, and the state Send to In Review produces
 * from the draft, so the two documents imported before the Drafts page
 * existed and every one sent from it look alike on the review board.
 *
 * Deliberate choices, each against a specific failure:
 *   - `contentStatus: 'in_review'` and `Live: false` as the review state.
 *     `in_review` is outside
 *     QUALITY_ENFORCED_STATUSES, so the quality gate reports without blocking,
 *     and its only forward edges are approved/published/rejected — every one
 *     a human's transition.
 *   - No `slug`/`Slug`. The slug-holders probe a publish runs is not filtered
 *     by status, so an unpublished document holding a slug would push any
 *     other article that wants the URL onto a suffix. A first publish assigns
 *     slugify(title) regardless (parseRepoDraft reports it).
 *   - `inspectTrigger: false`: the change-feed inspector would rewrite a
 *     finished article with a model's summary of it.
 *   - The front-matter `date` is recorded, not mapped to a publish-date
 *     field: the publish pipeline would take it as the article's published
 *     date, and when to date it is the reviewer's decision.
 *   - `Cloud Provider` only when a tag names one. Otherwise the review board
 *     shows "Unknown Provider - Select One", which is the honest state.
 */
export function buildRepoDraftData({ path, draft, source, editor, now = () => new Date() }) {
  const stamp = now().toISOString();
  return {
    type: 'blog',
    publishTarget: 'blog',
    Title: draft.title,
    title: draft.title,
    Summary: draft.subtitle,
    summary: draft.subtitle,
    Content: draft.body,
    content: draft.body,
    postContent: draft.body,
    Author: 'Hybrid Cloud Works',
    ...(draft.provider && { 'Cloud Provider': draft.provider, cloudProvider: draft.provider }),
    Tags: draft.tags,
    keyTopics: draft.tags,
    ...(draft.reading && { readTime: `${draft.reading} min` }),
    Live: false,
    approvedForBlog: false,
    approvedForNews: false,
    Status: 'Draft',
    contentStatus: 'in_review',
    inspectTrigger: false,
    source: 'repo',
    sourceTrustLevel: 'manual',
    trustedSource: true,
    sourceUrl: blobUrlFor(path),
    ...provenance({ path, source }),
    frontMatter: frontMatterRecord(draft),
    repoImportedAt: stamp,
    repoImportedBy: editor,
    fetchedAt: stamp,
  };
}
