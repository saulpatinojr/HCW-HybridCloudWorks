import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_PUBLISH_TARGETS,
  normalizeContentType,
  normalizePublishTarget,
} from './publish-targets.js';

describe('normalizeContentType', () => {
  it('accepts supported types case-insensitively and falls back to blog', () => {
    expect(normalizeContentType('Framework')).toBe('framework');
    expect(normalizeContentType(' coder_corner ')).toBe('coder_corner');
    // ADR 0040, D5: the interview is a publish target of its own.
    expect(normalizeContentType('interview')).toBe('interview');
    expect(normalizePublishTarget('INTERVIEW')).toBe('interview');
    expect(normalizeContentType('news')).toBe('blog');
    expect(normalizeContentType(undefined)).toBe('blog');
  });
});

describe('normalizePublishTarget', () => {
  it('collapses every news-era alias to blog', () => {
    for (const alias of ['published_news', 'approved_news', 'news', 'rss', 'both']) {
      expect(normalizePublishTarget(alias)).toBe('blog');
    }
  });

  it('passes supported targets through', () => {
    for (const target of SUPPORTED_PUBLISH_TARGETS) {
      expect(normalizePublishTarget(target)).toBe(target);
      expect(normalizePublishTarget(target.toUpperCase())).toBe(target);
    }
  });

  it('falls back to the normalized content type, then blog', () => {
    expect(normalizePublishTarget('unknown', 'architecture')).toBe('architecture');
    expect(normalizePublishTarget('', 'framework')).toBe('framework');
    expect(normalizePublishTarget('unknown', 'also-unknown')).toBe('blog');
    expect(normalizePublishTarget(undefined, undefined)).toBe('blog');
  });
});

describe('SUPPORTED_PUBLISH_TARGETS', () => {
  it('stays in sync with the publish contracts', async () => {
    const { CONTRACTS } = await import('./publish-contracts.js');
    expect([...SUPPORTED_PUBLISH_TARGETS].sort()).toEqual(Object.keys(CONTRACTS).sort());
  });
});
