/**
 * Publish-gate coverage per content type — ported from Site-Main
 * publishContracts.test.js.
 *
 * The payloads are copied from what each submission form in
 * src/pages/submissions/ actually writes to the `content` collection — not
 * idealized documents — so these tests answer the only question that matters:
 * can a real submission of this type reach a published page?
 *
 * Adapted for the Azure port: the source imported buildContentQualityReport /
 * buildImageReadinessReport from cms-functions.js (a 9,000-line CJS file);
 * here they come straight from the ported ESM content-quality module.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS,
  getContractBody,
  getMissingContractFields,
  getPublishContract,
} from './publish-contracts.js';
import {
  buildContentQualityReport,
  buildImageReadinessReport,
  ensureTldrSectionAtEnd,
  moveTldrSectionToEnd,
  normalizeContentBodyFields,
  countWords,
  countHeadings,
  computeContentQualityScore,
} from './content-quality.js';

const paragraph = (n) =>
  Array.from({ length: n }, (_, i) => `Sentence ${i} with concrete hybrid-cloud detail.`).join(' ');

/** What FrameworkSubmissionPage writes. */
const frameworkDoc = {
  type: 'framework',
  publishTarget: 'framework',
  Title: 'Migration Readiness Framework',
  summary: paragraph(6),
  Summary: paragraph(6),
  overviewHtml: paragraph(30),
  frameworkConcepts: [
    { label: 'Discover', summary: 'Inventory the estate and its dependencies.' },
    { label: 'Assess', summary: 'Score each workload for migration fit.' },
    { label: 'Mobilize', summary: 'Stand up the landing zone and guardrails.' },
  ],
  keyPillars: ['Discover', 'Assess', 'Mobilize'],
  patterns: ['Landing zone first'],
  terraformCode: 'resource "azurerm_resource_group" "lz" {}',
  category: 'Migration',
  complexity: 'Intermediate',
};

/** What ArchitectureSubmissionPage writes. */
const architectureDoc = {
  type: 'architecture',
  publishTarget: 'architecture',
  Title: 'Hybrid Landing Zone',
  summary: 'Hub-and-spoke bridging on-prem and cloud.',
  overviewHtml: paragraph(30),
  diagramUrl: 'https://example.com/diagram.png',
  technicalSpecs: { components: ['Hub VNet', 'Spoke VNet', 'ExpressRoute'], patterns: [] },
  costAnalysis: { estimatedMonthly: '$1,200', breakdown: [] },
  terraformCode: 'resource "azurerm_virtual_network" "hub" {}',
};

/** What CoderCornerSubmissionPage writes. */
const coderCornerDoc = {
  type: 'coder_corner',
  publishTarget: 'coder_corner',
  Title: 'Terraform for_each over a map of subnets',
  summary: 'A reusable subnet pattern.',
  explanation: paragraph(22),
  postContent: `${paragraph(22)}\n\n\`\`\`hcl\nresource "azurerm_subnet" "s" { for_each = var.subnets }\n\`\`\``,
  codeSnippet: 'resource "azurerm_subnet" "s" { for_each = var.subnets }',
  language: 'HCL',
};

describe('getPublishContract', () => {
  it('resolves every supported target and falls back to blog', () => {
    expect(getPublishContract('framework').target).toBe('framework');
    expect(getPublishContract('ARCHITECTURE').target).toBe('architecture');
    expect(getPublishContract('coder_corner').target).toBe('coder_corner');
    expect(getPublishContract('nonsense').target).toBe('blog');
    expect(getPublishContract(undefined).target).toBe('blog');
  });

  it('keeps the blog rubric strictest — other types must not be held to it', () => {
    const blog = CONTRACTS.blog.rubric;
    expect(blog).toEqual({ minWords: 650, minHeadings: 3, minModules: 2 });
    for (const key of ['framework', 'architecture', 'coder_corner', 'interview']) {
      expect(CONTRACTS[key].rubric.minWords).toBeLessThan(blog.minWords);
      expect(CONTRACTS[key].rubric.minModules).toBe(0);
    }
  });

  it('holds an interview to its Q&A, flattened to bodyText by the publish gate, with no hero (ADR 0040)', () => {
    const contract = getPublishContract('interview');
    expect(contract).toMatchObject({ section: 'interviews', bodyFields: ['bodyText', 'bio'] });
    expect(contract.imagery).toEqual({ requireHero: false, requirePromptLineage: false });
    expect(getMissingContractFields({ qa: [] }, contract)).toEqual(['at least one question and answer']);
    expect(getMissingContractFields({ qa: [{ q: 'q', a: 'a' }] }, contract)).toEqual([]);
    expect(getContractBody({ bodyText: 'Q\n\nA', bio: 'bio' }, contract)).toBe('Q\n\nA');
    expect(getContractBody({ bio: 'bio only' }, contract)).toBe('bio only');
  });
});

describe('getContractBody', () => {
  it('reads structured-only types from their real body field', () => {
    expect(getContractBody(frameworkDoc, getPublishContract('framework'))).toContain('Sentence 0');
    expect(getContractBody(architectureDoc, getPublishContract('architecture'))).toContain(
      'Sentence 0'
    );
  });

  it('returns empty when the type genuinely has no body', () => {
    expect(getContractBody({}, getPublishContract('framework'))).toBe('');
  });
});

describe('getMissingContractFields', () => {
  it('passes complete submissions', () => {
    expect(getMissingContractFields(frameworkDoc, getPublishContract('framework'))).toEqual([]);
    expect(getMissingContractFields(architectureDoc, getPublishContract('architecture'))).toEqual([]);
    expect(getMissingContractFields(coderCornerDoc, getPublishContract('coder_corner'))).toEqual([]);
  });

  it('names what a detail template would render empty', () => {
    expect(
      getMissingContractFields(
        {
          ...frameworkDoc,
          frameworkConcepts: [
            { label: 'One', summary: 'x' },
            { label: 'Two', summary: 'y' },
          ],
        },
        CONTRACTS.framework
      )
    ).toEqual(['at least 3 framework pillars']);

    expect(
      getMissingContractFields({ ...architectureDoc, diagramUrl: '' }, CONTRACTS.architecture)
    ).toEqual(['a diagram URL']);

    expect(
      getMissingContractFields(
        { ...coderCornerDoc, codeSnippet: '', language: '' },
        CONTRACTS.coder_corner
      )
    ).toEqual(['a code snippet', 'a language label']);
  });

  it('counts newline-delimited lists the way the forms submit them', () => {
    const doc = { ...frameworkDoc, keyPillars: 'Discover\nAssess\nMigrate' };
    expect(getMissingContractFields(doc, CONTRACTS.framework)).toEqual([]);
  });
});

describe('buildContentQualityReport per template', () => {
  it('clears a realistic framework submission', () => {
    const report = buildContentQualityReport(frameworkDoc, null, 'framework');
    expect(report.issues).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.publishTarget).toBe('framework');
  });

  it('clears a realistic architecture submission', () => {
    const report = buildContentQualityReport(architectureDoc, null, 'architecture');
    expect(report.issues).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('clears a realistic coder-corner submission', () => {
    const report = buildContentQualityReport(coderCornerDoc, null, 'coder_corner');
    expect(report.issues).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('still blocks a submission that is genuinely incomplete', () => {
    const thin = {
      ...frameworkDoc,
      overviewHtml: 'Too short.',
      summary: 'Too short.',
      Summary: 'Too short.',
      frameworkConcepts: [],
      keyPillars: [],
    };
    const report = buildContentQualityReport(thin, null, 'framework');
    expect(report.ready).toBe(false);
    expect(report.issues.join(' ')).toMatch(/too thin/i);
    expect(report.missingFields).toEqual([
      'at least 3 framework pillars',
      'a summary on every framework pillar',
    ]);
  });

  it('leaves the blog rubric untouched', () => {
    const thinBlog = { publishTarget: 'blog', postContent: '## One heading\n\nShort body.' };
    const report = buildContentQualityReport(thinBlog, null, 'blog');
    expect(report.ready).toBe(false);
    const joined = report.issues.join(' ');
    expect(joined).toMatch(/minimum 650/);
    expect(joined).toMatch(/minimum 3/);
    expect(joined).toMatch(/at least 2 inline modules/);
  });

  it('infers the target from the doc when the caller does not pass one', () => {
    expect(buildContentQualityReport(coderCornerDoc, null).publishTarget).toBe('coder_corner');
  });

  it('grades a framework on the overview now that the page renders it', () => {
    const richOverview = {
      ...frameworkDoc,
      summary: 'Short.',
      Summary: 'Short.',
      overviewHtml: paragraph(30),
    };
    expect(buildContentQualityReport(richOverview, null, 'framework').ready).toBe(true);

    const neither = { ...richOverview, overviewHtml: 'Too short.' };
    expect(buildContentQualityReport(neither, null, 'framework').ready).toBe(false);
  });

  it('penalises banned phrases and placeholder content in the score', () => {
    const clean = computeContentQualityScore({ wordCount: 700, headingCount: 3, moduleCount: 2 });
    const banned = computeContentQualityScore({
      wordCount: 700, headingCount: 3, moduleCount: 2, bannedPhraseHits: ['delve into'],
    });
    const placeholder = computeContentQualityScore({
      wordCount: 700, headingCount: 3, moduleCount: 2, placeholderContent: true,
    });
    expect(banned).toBeLessThan(clean);
    expect(placeholder).toBeLessThan(clean);
  });
});

describe('buildImageReadinessReport per template', () => {
  const withImagery = {
    heroImageUrl: 'https://example.com/hero.png',
    summaryPrompt: 'a',
    detailsPrompt: 'b',
    imagePromptSet: 's',
    imagePromptName: 'n',
    altText: 'A descriptive alt text',
    secondaryImageUrls: ['https://example.com/2.png'],
  };

  it('requires a hero and prompt lineage for a blog post', () => {
    const report = buildImageReadinessReport({ publishTarget: 'blog' }, 'blog');
    expect(report.ready).toBe(false);
    expect(report.issues.join(' ')).toMatch(/Hero image is required/);
    expect(buildImageReadinessReport({ ...withImagery }, 'blog').ready).toBe(true);
  });

  it('requires neither from a framework, whose page renders no image', () => {
    const report = buildImageReadinessReport(frameworkDoc, 'framework');
    expect(report.issues).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('requires neither from an architecture, whose image is its diagram', () => {
    const report = buildImageReadinessReport(architectureDoc, 'architecture');
    expect(report.issues).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('lets a coder-corner snippet publish without a hero image', () => {
    const report = buildImageReadinessReport(coderCornerDoc, 'coder_corner');
    expect(report.issues).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('still rejects a malformed hero URL on any type', () => {
    const report = buildImageReadinessReport(
      { ...frameworkDoc, heroImageUrl: 'http://insecure.example/hero.png' },
      'framework'
    );
    expect(report.issues.join(' ')).toMatch(/https URL/);
  });
});

describe('TL;DR shaping and counters', () => {
  it('moves a TL;DR section to the end of the document', () => {
    const md = '## TL;DR\n\nQuick summary.\n\n## Body\n\nThe actual content.';
    const moved = moveTldrSectionToEnd(md);
    expect(moved.indexOf('TL;DR')).toBeGreaterThan(moved.indexOf('Body'));
  });

  it('ensureTldrSectionAtEnd is a no-op on empty and idempotent', () => {
    expect(ensureTldrSectionAtEnd('')).toBe('');
    const md = '## Body\n\nText.\n\n## TL;DR\n\nSummary.';
    expect(ensureTldrSectionAtEnd(ensureTldrSectionAtEnd(md))).toBe(ensureTldrSectionAtEnd(md));
  });

  it('normalizeContentBodyFields shapes only the string body fields', () => {
    const out = normalizeContentBodyFields({ postContent: '## TL;DR\n\nx\n\n## Body\n\ny', tags: ['a'] });
    expect(out.tags).toEqual(['a']);
    expect(out.postContent.indexOf('TL;DR')).toBeGreaterThan(out.postContent.indexOf('Body'));
  });

  it('countWords strips module tags and HTML before counting', () => {
    const withModule = 'Real words here <module type="code">ignored ignored ignored</module> and more.';
    // 'Real words here' (3) + 'and more.' (2) = 5, module body excluded
    expect(countWords(withModule)).toBe(5);
  });

  it('countHeadings counts h2-h4 only', () => {
    expect(countHeadings('# h1\n## h2\n### h3\n#### h4\n##### h5')).toBe(3);
  });
});
