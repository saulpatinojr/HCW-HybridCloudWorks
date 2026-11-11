/**
 * The address topic list (#1628). The server keeps the same list in
 * functions/src/lib/cms/article-topics.js and its test holds the two equal;
 * this one pins the frontend's own helper.
 */
import { describe, expect, it } from 'vitest';
import { ARTICLE_TOPICS, isArticleTopic } from './articleTopics';

describe('ARTICLE_TOPICS', () => {
  it('is a frozen list of fourteen lowercase words', () => {
    expect(Object.isFrozen(ARTICLE_TOPICS)).toBe(true);
    expect(ARTICLE_TOPICS).toHaveLength(14);
    for (const topic of ARTICLE_TOPICS) expect(topic).toMatch(/^[a-z]+$/);
  });
});

describe('isArticleTopic', () => {
  it('accepts a word from the list and nothing else', () => {
    expect(isArticleTopic('hybrid')).toBe(true);
    for (const value of ['', 'Hybrid', 'kubernetes', null, undefined, 3, ['ai']]) {
      expect(isArticleTopic(value)).toBe(false);
    }
  });
});
