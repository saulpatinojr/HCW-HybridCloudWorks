/**
 * An article's web address: one topic word and eight characters of its
 * document id, e.g. `/azure/blog/hybrid-cpjhv5a3` (owner decision of
 * 2026-11-11, #1628).
 *
 * WHY NOT THE TITLE. Title slugs were long, and the publish step's suffix (the
 * first characters of the document id) carried capital letters, so five live
 * addresses failed the strict lowercase rule interviews and designs already
 * follow. This shape is short, always lowercase, and fixed at first publish: a
 * republish keeps the stored slug (publish.js), so a later change of topic
 * never moves a page.
 *
 * WHERE THE TOPIC COMES FROM, first match wins:
 *   1. `topic` on the document, set by the drafting step's AI suggestion or
 *      chosen on the admin Drafts page;
 *   2. the keyword table below, read from the title, key topics and tags,
 *      for content that arrived without one;
 *   3. the provider (`azure`, `aws` ...), or `article` without one, so an
 *      address always has a word. These two are the only words outside the
 *      list that an address can start with.
 *
 * The frontend keeps a copy of the list in frontend/src/lib/articleTopics.js
 * for the Drafts page dropdown; article-topics.test.js holds the two equal.
 */

/** The topic words an address may start with. Add to the end; never rename one. */
export const ARTICLE_TOPICS = Object.freeze([
  "ai",
  "compute",
  "network",
  "storage",
  "data",
  "security",
  "identity",
  "hybrid",
  "migration",
  "governance",
  "finops",
  "devops",
  "certification",
  "sovereignty",
]);

/** How many characters of the document id an address carries. */
export const ARTICLE_ID_CHARS = 8;

export function isArticleTopic(value) {
  return typeof value === "string" && ARTICLE_TOPICS.includes(value);
}

/**
 * Keyword → topic, tried in order, first hit wins. Ordered most specific
 * first: an "Azure Arc" article that mentions AI is about hybrid, and a
 * certification about AI is a certification. Each needle is matched as a
 * whole word or phrase, case-insensitive.
 */
const KEYWORD_TOPICS = Object.freeze([
  ["certification", ["certification", "certified", "exam"]],
  ["sovereignty", ["sovereign", "sovereignty", "data residency"]],
  ["migration", ["migrate", "migration", "azure migrate", "aws transform"]],
  [
    "hybrid",
    [
      "azure arc",
      "arc-enabled",
      // Not bare "hybrid" or "edge": "hybrid search", "hybrid work" and
      // "cutting-edge" are not about hybrid cloud.
      "hybrid cloud",
      "hybrid multicloud",
      "multicloud",
      "azure local",
      "azure stack",
      "azure vmware solution",
      "on-prem",
      "on-premises",
      "edge computing",
    ],
  ],
  ["finops", ["finops", "cost optimization", "cost management", "tco"]],
  ["identity", ["entra", "identity", "conditional access"]],
  [
    "security",
    [
      "security",
      "zero trust",
      "defender",
      "sentinel",
      "cybersecurity",
      "secure by design",
    ],
  ],
  [
    "governance",
    [
      "governance",
      "azure policy",
      "compliance",
      "release communications",
      "azure updates",
    ],
  ],
  [
    "devops",
    [
      "devops",
      "ansible",
      "terraform",
      "github actions",
      "ci/cd",
      "azure pipelines",
    ],
  ],
  [
    "ai",
    [
      "ai",
      "foundry",
      "copilot",
      "openai",
      "llm",
      "agents",
      "agentic",
      "machine learning",
      "generative",
    ],
  ],
  [
    "network",
    [
      "network",
      "networking",
      "vnet",
      "virtual network",
      "firewall",
      "dns",
      "load balancer",
    ],
  ],
  ["storage", ["storage", "blob", "azure files", "file share", "file shares"]],
  [
    "data",
    ["database", "sql", "cosmos db", "microsoft fabric", "analytics", "data"],
  ],
  [
    "compute",
    [
      "virtual machine",
      "virtual machines",
      "compute",
      "aks",
      "kubernetes",
      "container",
      "containers",
      "app service",
      "functions",
    ],
  ],
]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KEYWORD_MATCHERS = KEYWORD_TOPICS.map(([topic, needles]) => [
  topic,
  new RegExp(
    `(?:^|[^a-z0-9])(?:${needles.map(escapeRegExp).join("|")})(?:$|[^a-z0-9])`,
    "i",
  ),
]);

function textOf(value) {
  if (Array.isArray(value))
    return value.map((v) => String(v ?? "")).join(" \n ");
  return String(value ?? "");
}

/**
 * The topic the keyword table gives a document, or null. The titles are read
 * first and on their own, because they say what the article is about more
 * reliably than a tag list that names every product it touches. `title` (the
 * article's own) before `Title`: on ingested articles `Title` is often the
 * source's headline, which can be about something else.
 *
 * @param {object} doc a content document
 * @returns {string|null}
 */
export function suggestArticleTopic(doc = {}) {
  const titles = [textOf(doc.title), textOf(doc.Title)];
  const rest = [doc.keyTopics, doc.Tags || doc.tags].map(textOf).join(" \n ");
  for (const text of [...titles, rest]) {
    if (!text.trim()) continue;
    for (const [topic, matcher] of KEYWORD_MATCHERS) {
      if (matcher.test(text)) return topic;
    }
  }
  return null;
}

/**
 * The first ARTICLE_ID_CHARS of the document id, lowercase, letters and
 * digits only. Older ids are random mixed-case strings (`LSzyB6gbiLyXtjQUcgGv`),
 * newer ones are UUIDs (8 hex characters here); either way that is unique
 * enough at this size, and the publish probe catches the rare clash.
 */
export function articleIdPart(contentId = "") {
  return String(contentId)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, ARTICLE_ID_CHARS);
}

/**
 * The address a FIRST publish gives an article: `<topic>-<id part>`.
 *
 * @param {object} args
 * @param {object} args.contentData the document
 * @param {string} args.contentId its id
 * @param {string} [args.provider] the resolved provider, the last fallback word
 * @returns {string} '' when the id gives nothing to build on
 */
export function articleSlugFor({
  contentData = {},
  contentId = "",
  provider = "",
}) {
  const idPart = articleIdPart(contentId);
  if (!idPart) return "";
  const stored = String(contentData.topic ?? "").trim();
  const providerWord = String(provider || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const topic = isArticleTopic(stored)
    ? stored
    : suggestArticleTopic(contentData) || providerWord || "article";
  return `${topic}-${idPart}`;
}
