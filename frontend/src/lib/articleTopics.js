/**
 * The topic words an article's web address may start with, as in
 * `/azure/blog/hybrid-cpjhv5a3` (#1628). A copy of the list in
 * functions/src/lib/cms/article-topics.js; a server test reads this file and
 * holds the two equal, so change both together. Add to the end; never rename one.
 */

// prettier-ignore
export const ARTICLE_TOPICS = Object.freeze(['ai', 'compute', 'network', 'storage', 'data', 'security', 'identity', 'hybrid', 'migration', 'governance', 'finops', 'devops', 'certification', 'sovereignty']);

/** Is this one of the topic words above? */
export function isArticleTopic(value) {
  return typeof value === 'string' && ARTICLE_TOPICS.includes(value);
}

/** The one line under a topic dropdown, in plain words. */
export const ARTICLE_TOPIC_HINT =
  'Sets the first word of the page address, e.g. hybrid-cpjhv5a3. It is fixed when the page is first published.';
