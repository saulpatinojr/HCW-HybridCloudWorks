/**
 * The page's pure derivations (#634).
 *
 * All of this was module-level in a 2,900-line page and none of it had a test,
 * despite being the easiest part of the file to cover: no state, no network.
 */
import { describe, it, expect } from 'vitest';

import {
  buildReadinessChecks,
  canGenerateDraftImages,
  getCurrentStep,
  getPreviewSection,
  getPromptLibraryPagePath,
  getPublishTargetLabel,
  getResolvedBlogLandingProvider,
  getResolvedProvider,
  inferProviderFromUrl,
  slugifyTitle,
  previewSlugFor,
} from './pageMeta';

const TYPES = ['blog', 'framework', 'architecture', 'coder_corner'];

describe('the content-type table', () => {
  it('gives every type a section and a label', () => {
    for (const type of TYPES) {
      expect(getPreviewSection(type)).toBeTruthy();
      expect(getPublishTargetLabel(type)).toBeTruthy();
    }
  });

  it('maps each type to the section it publishes into', () => {
    expect(getPreviewSection('blog')).toBe('blog');
    expect(getPreviewSection('framework')).toBe('frameworks');
    expect(getPreviewSection('architecture')).toBe('architecture-designs');
    expect(getPreviewSection('coder_corner')).toBe('code');
  });

  it('falls back to blog for anything unrecognised', () => {
    // Three functions used to carry their own copy of this default.
    expect(getPreviewSection('nonsense')).toBe('blog');
    expect(getPublishTargetLabel('nonsense')).toBe('Blog');
    expect(getPromptLibraryPagePath('nonsense', 'Azure')).toBe('/azure/blog');
  });

  it('builds the prompt library path from the provider and the section', () => {
    expect(getPromptLibraryPagePath('framework', 'Azure')).toBe('/azure/frameworks');
    expect(getPromptLibraryPagePath('coder_corner', '  GCP  ')).toBe('/gcp/code');
  });

  it('has no path at all without a provider', () => {
    // '' is the signal the prompt library uses to mean "no target yet".
    expect(getPromptLibraryPagePath('blog', '')).toBe('');
    expect(getPromptLibraryPagePath('blog', '   ')).toBe('');
    expect(getPromptLibraryPagePath('blog', undefined)).toBe('');
  });

  it('keeps the path consistent with the preview section', () => {
    // The two derive from one table now; this is what that buys.
    for (const type of TYPES) {
      expect(getPromptLibraryPagePath(type, 'aws')).toBe(`/aws/${getPreviewSection(type)}`);
    }
  });
});

describe('slugifyTitle', () => {
  it('lowercases, strips punctuation and joins on hyphens', () => {
    expect(slugifyTitle('  Hello, World! A Guide  ')).toBe('hello-world-a-guide');
  });

  it('caps at 80 characters', () => {
    expect(slugifyTitle('a'.repeat(200))).toHaveLength(80);
  });

  it('is empty for nothing', () => {
    expect(slugifyTitle()).toBe('');
    expect(slugifyTitle('!!!')).toBe('');
  });
});

describe('provider resolution', () => {
  it('prefers an explicit choice over an inferred one', () => {
    expect(getResolvedProvider('Aws', 'Azure')).toBe('Aws');
    expect(getResolvedProvider('', 'Azure')).toBe('Azure');
    expect(getResolvedProvider('', '')).toBe('');
  });

  it('only gives a blog its own landing zone', () => {
    expect(getResolvedBlogLandingProvider('blog', 'Gcp', 'Azure')).toBe('Gcp');
    expect(getResolvedBlogLandingProvider('blog', '', 'Azure')).toBe('Azure');
    // Everything else follows the provider, whatever the landing field says.
    expect(getResolvedBlogLandingProvider('framework', 'Gcp', 'Azure')).toBe('Azure');
  });
});

describe('inferProviderFromUrl', () => {
  it('reads the obvious markers', () => {
    expect(inferProviderFromUrl('https://learn.microsoft.com/azure/x')).toBe('Azure');
    expect(inferProviderFromUrl('https://docs.aws.amazon.com/x')).toBe('Aws');
    expect(inferProviderFromUrl('https://cloud.google.com/x')).toBe('Gcp');
    expect(inferProviderFromUrl('https://github.com/x')).toBe('Github');
    expect(inferProviderFromUrl('https://terraform.io/x')).toBe('Terraform');
    expect(inferProviderFromUrl('https://finops.org/x')).toBe('Finops');
    expect(inferProviderFromUrl('https://www.docker.com/blog/x')).toBe('Docker');
  });

  it('files Docker last, so a URL about Docker on another provider stays with it (#775)', () => {
    expect(inferProviderFromUrl('https://docs.docker.com/build/building/multi-stage/')).toBe(
      'Docker'
    );
    expect(
      inferProviderFromUrl('https://learn.microsoft.com/azure/container-apps/docker-images')
    ).toBe('Azure');
    expect(inferProviderFromUrl('https://github.com/docker/build-push-action')).toBe('Github');
    expect(
      inferProviderFromUrl('https://registry.terraform.io/providers/kreuzwerker/docker/latest')
    ).toBe('Terraform');
  });

  it('is case-insensitive', () => {
    expect(inferProviderFromUrl('HTTPS://AZURE.MICROSOFT.COM')).toBe('Azure');
  });

  it('keeps the original precedence when a URL matches more than one', () => {
    // Azure is tested before Aws, so a URL naming both is Azure. Preserved
    // from the if-chain this replaced; the table's order is the behaviour.
    expect(inferProviderFromUrl('https://example.com/azure-vs-aws')).toBe('Azure');
    expect(inferProviderFromUrl('https://example.com/aws-and-github')).toBe('Aws');
  });

  it('is empty when nothing matches', () => {
    expect(inferProviderFromUrl('https://example.com/x')).toBe('');
    expect(inferProviderFromUrl()).toBe('');
  });
});

describe('canGenerateDraftImages', () => {
  it('needs a draft and both prompts, not just whitespace', () => {
    expect(canGenerateDraftImages('a', 'b', true)).toBe(true);
    expect(canGenerateDraftImages('a', 'b', false)).toBe(false);
    expect(canGenerateDraftImages('   ', 'b', true)).toBe(false);
    expect(canGenerateDraftImages('a', '   ', true)).toBe(false);
  });
});

describe('getCurrentStep', () => {
  const at = (o) =>
    getCurrentStep({
      hasSourceUrls: false,
      draftReady: false,
      hasUploadedImages: false,
      hasSelectedGeneratedImages: false,
      ...o,
    });

  it('walks forward as each gate is met', () => {
    expect(at({})).toBe(1);
    expect(at({ hasSourceUrls: true })).toBe(2);
    expect(at({ hasSourceUrls: true, draftReady: true })).toBe(3);
    expect(at({ hasSourceUrls: true, draftReady: true, hasUploadedImages: true })).toBe(4);
  });

  it('accepts either kind of image to reach step 4', () => {
    expect(at({ hasSourceUrls: true, draftReady: true, hasSelectedGeneratedImages: true })).toBe(4);
  });
});

describe('buildReadinessChecks', () => {
  const SECTIONS = [
    { key: 'tldr', heading: '## TL;DR', title: 'TL;DR', required: true },
    { key: 'faq', heading: '## FAQ', title: 'FAQ', required: false },
  ];

  const checks = (o = {}) =>
    buildReadinessChecks({
      sourceUrl: 'https://kb.example.com/1',
      contentType: 'blog',
      frameworkSourceUrls: '',
      resolvedProvider: 'Azure',
      resolvedBlogLandingProvider: 'Azure',
      inferredProvider: '',
      previewSlug: 'a-long-enough-slug',
      previewPath: '/azure/blog/a-long-enough-slug',
      draftTitle: 'A sufficiently long title',
      title: '',
      draftSummary: 'x'.repeat(80),
      draftContent: `## TL;DR\n${'x'.repeat(700)}`,
      hasHeroSelected: true,
      sectionBlocks: SECTIONS,
      ...o,
    });

  const byKey = (rows, key) => rows.find((row) => row.key === key);

  it('passes everything for a complete draft', () => {
    expect(checks().every((row) => row.done)).toBe(true);
  });

  it('waives the framework sources for a non-framework type', () => {
    expect(byKey(checks(), 'framework-sources').done).toBe(true);
    expect(byKey(checks(), 'framework-sources').hint).toMatch(/Not required/);
  });

  it('requires at least one VALID framework source for a framework', () => {
    const bad = checks({ contentType: 'framework', frameworkSourceUrls: 'not-a-url' });
    expect(byKey(bad, 'framework-sources').done).toBe(false);
    const good = checks({ contentType: 'framework', frameworkSourceUrls: 'https://a.com' });
    expect(byKey(good, 'framework-sources').done).toBe(true);
  });

  it('waives the landing zone for a non-blog type', () => {
    expect(byKey(checks({ contentType: 'framework' }), 'landing-zone').done).toBe(true);
  });

  it('names the required sections still missing', () => {
    const row = byKey(checks({ draftContent: 'x'.repeat(700) }), 'schema-sections');
    expect(row.done).toBe(false);
    expect(row.hint).toBe('TL;DR');
  });

  it('ignores optional sections when judging completeness', () => {
    // FAQ is absent in every fixture and must never block readiness.
    expect(byKey(checks(), 'schema-sections').done).toBe(true);
  });

  it('holds the title, summary and content to their thresholds', () => {
    expect(byKey(checks({ draftTitle: 'short', title: '' }), 'title').done).toBe(false);
    expect(byKey(checks({ draftSummary: 'too short' }), 'summary').done).toBe(false);
    expect(byKey(checks({ draftContent: '## TL;DR' }), 'content').done).toBe(false);
  });

  it('falls back to the typed title when there is no generated one', () => {
    expect(
      byKey(checks({ draftTitle: '', title: 'A sufficiently long title' }), 'title').done
    ).toBe(true);
  });

  it('shows the detected provider in the hint when one was inferred', () => {
    expect(byKey(checks({ inferredProvider: 'Aws' }), 'provider').hint).toContain('Aws');
  });
});

describe('previewSlugFor (#1628)', () => {
  it('previews an article as <topic>-<id>, with x for the id not yet known', () => {
    expect(previewSlugFor({ section: 'blog', topic: 'hybrid', title: 'Azure Arc at scale' })).toBe(
      'hybrid-xxxxxxxx'
    );
    expect(previewSlugFor({ section: 'blog', topic: '', title: 'Azure Arc at scale' })).toBe(
      'topic-xxxxxxxx'
    );
  });

  it('keeps the title slug for other sections', () => {
    expect(previewSlugFor({ section: 'frameworks', title: 'Azure Arc at scale' })).toBe(
      'azure-arc-at-scale'
    );
  });
});
