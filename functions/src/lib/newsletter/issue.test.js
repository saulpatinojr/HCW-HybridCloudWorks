/**
 * The weekly issue: what the sections collect, what the builder stores, and
 * what the renderer puts in front of a reader.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LABS_PAGE_URL,
  NEWSLETTER_PRICE_REGION,
  PRICE_COMPARISON_URL,
  SECTIONS,
  absoluteUrl,
  articlesSection,
  certificationNewsSection,
  cloudPriceChangesSection,
  collectSections,
  episodesSection,
  formatPrice,
  labThisWeekSection,
  labWeekItems,
  plainText,
  priceChangeTitle,
} from './sections.js';
import {
  INTRO_INSTRUCTION,
  SUBJECT_INSTRUCTION,
  createIssueBuilder,
  draftIntro,
  introInstruction,
  planSections,
  stripMarkdown,
  suggestSubjects,
} from './issue.js';
import { INTRO_TONES } from './settings.js';
import { AiFeatureDisabledError } from '../ai/router.js';
import { UNSUBSCRIBE_PLACEHOLDER, renderIssue } from './render.js';

const NOW = new Date('2026-09-14T12:00:00Z');
const SINCE = new Date('2026-09-07T12:00:00Z');

/** A store that answers each container's query from fixed rows and records writes. */
function makeStore(rowsByContainer = {}, docs = {}) {
  const written = new Map(Object.entries(docs));
  return {
    written,
    queryDocs: vi.fn(async (container) => rowsByContainer[container] ?? []),
    readDoc: vi.fn(async (container, id) => written.get(`${container}/${id}`) ?? null),
    upsertDoc: vi.fn(async (container, doc) => {
      written.set(`${container}/${doc.id}`, doc);
      return doc;
    }),
  };
}

const article = {
  Title: 'Landing zones in 2026',
  Summary: '<p>What   changed</p>',
  'Cloud Provider': 'Azure',
  publishedAt: '2026-09-10T00:00:00Z',
  publishedUrl: 'https://hybridcloudworks.com/azure/blog/landing-zones-2026',
};

describe('sections', () => {
  it('links articles to the URL publishing stored, and drops one that has none', async () => {
    const store = makeStore({ content: [article, { Title: 'No URL', publishedAt: '2026-09-11T00:00:00Z' }] });
    const items = await articlesSection.collect({ store, since: SINCE, until: NOW });
    expect(items).toEqual([
      {
        title: 'Landing zones in 2026',
        summary: 'What changed',
        url: 'https://hybridcloudworks.com/azure/blog/landing-zones-2026',
        label: 'Azure',
      },
    ]);
    const [, sql, params] = store.queryDocs.mock.calls[0];
    expect(sql).toMatch(/c\.Live = true/);
    expect(params).toEqual([
      { name: '@since', value: SINCE.toISOString() },
      { name: '@until', value: NOW.toISOString() },
    ]);
  });

  it('labels certification news by kind and exam code, and skips soft-deleted events', async () => {
    const store = makeStore({
      certEvents: [
        { type: 'retirement', certCodes: ['AZ-900'], title: 'AZ-900 retires', link: 'https://learn.microsoft.com/x', pubDate: '2026-09-09T00:00:00Z' },
        { type: 'ga_launch', certCodes: [], title: 'Deleted', link: 'https://learn.microsoft.com/y', softDeletedAt: '2026-09-10' },
      ],
    });
    expect(await certificationNewsSection.collect({ store, since: SINCE, until: NOW })).toEqual([
      { title: 'AZ-900 retires', summary: '', url: 'https://learn.microsoft.com/x', label: 'Retiring · AZ-900' },
    ]);
  });

  it('links a study episode to its certification page where one exists, and a podcast to its episode', async () => {
    const store = makeStore(
      {
        listen_and_learn_episodes: [
          { setId: 'azure_az-104', provider: 'azure', title: 'Networking', summary: 'VNets', approvedAt: '2026-09-12T00:00:00Z', audioUrl: '/api/public/media/x.mp3' },
          { setId: 'gcp_ace', provider: 'gcp', title: 'IAM', approvedAt: '2026-09-12T00:00:00Z', audioUrl: '/api/public/media/y.mp3' },
          { setId: 'azure_az-104', provider: 'azure', title: 'No audio', approvedAt: '2026-09-12T00:00:00Z' },
        ],
        podcasts: [
          { provider: 'main', title: 'Episode 12', description: 'Talk', link: 'https://media.rss.com/show/ep-12', publishedAt: '2026-09-13T00:00:00Z' },
          { provider: 'aws', title: 'Gone', link: 'https://x.example/g', mediaUnavailableAt: '2026-09-13' },
        ],
      },
      { 'listen_and_learn/azure_az-104': { certSlug: 'az-104', certTitle: 'Azure Administrator' } }
    );
    const items = await episodesSection.collect({ store, since: SINCE, until: NOW });
    expect(items.map((i) => [i.title, i.url, i.label])).toEqual([
      ['Episode 12', 'https://media.rss.com/show/ep-12', 'Podcast'],
      ['Networking', 'https://hybridcloudworks.com/azure/education/az-104', 'Study episode · Azure Administrator'],
      ['IAM', 'https://hybridcloudworks.com/gcp/education', 'Study episode'],
    ]);
  });

  describe('cloud price changes (#613 Phase 3)', () => {
    const change = (over = {}) => ({
      serviceId: 'compute-vm',
      label: 'Virtual machines',
      provider: 'aws',
      unit: 'hour',
      sku: 'm5.xlarge',
      from: 0.192,
      to: 0.201,
      deltaPct: 4.7,
      ...over,
    });
    const feed = (items, over = {}) => ({
      'tool_service_cache/price-changes:us-east-1': {
        id: 'price-changes:us-east-1',
        region: 'us-east-1',
        asOf: '2026-09-14T02:00:00.000Z',
        windows: {
          '7d': { since: '2026-09-07', sampleDay: '2026-09-07', items },
          '30d': { since: '2026-08-15', sampleDay: null, items: [] },
        },
        sampleDays: 1,
        ...over,
      },
    });

    it('reads the fixed region’s 7-day window from the page’s own document, by one point read', async () => {
      expect(NEWSLETTER_PRICE_REGION).toBe('us-east-1');
      expect(PRICE_COMPARISON_URL).toBe('https://hybridcloudworks.com/tools/comparison?region=us-east-1');
      const store = makeStore({}, feed([change(), change({ provider: 'gcp', unit: 'GB-month', label: 'Object storage', serviceId: 'storage-object', sku: 'Standard', from: 0.02, to: 0.018, deltaPct: -10 })]));
      const items = await cloudPriceChangesSection.collect({ store, since: SINCE, until: NOW });
      expect(items).toEqual([
        {
          title: 'AWS · Virtual machines: $0.192 → $0.201 per hour (+4.7%)',
          summary: 'm5.xlarge',
          url: 'https://hybridcloudworks.com/tools/comparison?region=us-east-1',
          label: 'US East · last 7 days',
        },
        {
          title: 'Google Cloud · Object storage: $0.02 → $0.018 per GB-month (-10%)',
          summary: 'Standard',
          url: 'https://hybridcloudworks.com/tools/comparison?region=us-east-1',
          label: 'US East · last 7 days',
        },
      ]);
      expect(store.readDoc).toHaveBeenCalledWith('tool_service_cache', 'price-changes:us-east-1', 'price-changes:us-east-1');
      expect(store.queryDocs).not.toHaveBeenCalled();
    });

    it('formats prices to four significant figures and names a non-USD currency after the number', () => {
      expect(formatPrice(0.192)).toBe('$0.192');
      expect(formatPrice(0.0855)).toBe('$0.0855');
      expect(formatPrice(85)).toBe('$85');
      expect(formatPrice(2.4)).toBe('$2.4');
      expect(formatPrice(0.123456)).toBe('$0.1235');
      expect(formatPrice(0.2, 'EUR')).toBe('0.2 EUR');
      expect(formatPrice('n/a')).toBe('');
      expect(priceChangeTitle(change({ deltaPct: 0 }))).toBe('AWS · Virtual machines: $0.192 → $0.201 per hour (0%)');
      expect(priceChangeTitle(change({ provider: 'oracle' }))).toBeNull();
      expect(priceChangeTitle(change({ from: undefined }))).toBeNull();
    });

    it('drops a row it cannot read rather than rendering a broken line', async () => {
      const store = makeStore({}, feed([change({ provider: 'oracle' }), change({ label: '' }), change()]));
      const items = await cloudPriceChangesSection.collect({ store, since: SINCE, until: NOW });
      expect(items).toHaveLength(1);
    });

    it('is empty with no document, an empty window, or a malformed one', async () => {
      for (const docs of [{}, feed([]), feed(null), { 'tool_service_cache/price-changes:us-east-1': { id: 'price-changes:us-east-1' } }]) {
        const store = makeStore({}, docs);
        expect(await cloudPriceChangesSection.collect({ store, since: SINCE, until: NOW })).toEqual([]);
      }
    });

    it('is left out of the issue entirely when there are no changes — no heading, no filler', async () => {
      const store = makeStore({ content: [article] }, feed([]));
      const result = await createIssueBuilder({ store, drafter: null, now: () => NOW }).build({});
      expect(result.success).toBe(true);
      expect(result.sections).toEqual(['articles']);
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.sections.map((s) => s.id)).toEqual(['articles']);
      expect(doc.problems).toEqual([]);
      const { html, text } = renderIssue(doc, { postalAddress: 'x' });
      expect(html).not.toContain('Cloud price changes');
      expect(text).not.toContain('CLOUD PRICE CHANGES');
      expect(html).not.toMatch(/no (price )?changes/i);
    });

    it('renders in the issue, HTML and text, as its siblings do when there are changes', async () => {
      const store = makeStore({ content: [article] }, feed([change()]));
      const result = await createIssueBuilder({ store, drafter: null, now: () => NOW }).build({});
      expect(result.sections).toEqual(['articles', 'cloud-price-changes']);
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.itemCount).toBe(2);
      const { html, text } = renderIssue(doc, { postalAddress: 'x' });
      expect(html).toContain('<h2 style="margin:0 0 16px;font-size:20px;color:#111827">Cloud price changes</h2>');
      expect(html).toContain('AWS · Virtual machines: $0.192 → $0.201 per hour (+4.7%)');
      expect(html).toContain('href="https://hybridcloudworks.com/tools/comparison?region=us-east-1"');
      expect(text).toContain('CLOUD PRICE CHANGES');
      expect(text).toContain('- AWS · Virtual machines: $0.192 → $0.201 per hour (+4.7%)\n  US East · last 7 days\n  m5.xlarge\n  https://hybridcloudworks.com/tools/comparison?region=us-east-1');
    });

    it('is capped by the saved item count like any other section', async () => {
      const many = Array.from({ length: 5 }, (_, i) => change({ sku: `sku-${i}`, to: 0.2 + i / 100 }));
      const store = makeStore({ content: [article] }, {
        ...feed(many),
        'admin_config/newsletter_settings': {
          id: 'newsletter_settings',
          sections: [{ id: 'cloud-price-changes', enabled: true, maxItems: 2 }],
        },
      });
      await createIssueBuilder({ store, drafter: null, now: () => NOW }).build({});
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.sections.find((s) => s.id === 'cloud-price-changes').items).toHaveLength(2);
    });
  });

  describe('lab this week (#665)', () => {
    const dayDoc = (day, over = {}) => ({
      id: `labs:day:${day}`,
      kind: 'labs-day',
      day,
      arcConnected: true,
      jobsByType: {},
      coderRunningMax: null,
      asOf: `${day}T23:55:00.000Z`,
      ttl: 5184000,
      ...over,
    });
    const week = (docs) => Object.fromEntries(docs.map((d) => [`tool_service_cache/${d.id}`, d]));

    it('is registered last, on by default like every section', () => {
      expect(SECTIONS.at(-1)).toBe(labThisWeekSection);
      expect(labThisWeekSection.id).toBe('lab-this-week');
      expect(LABS_PAGE_URL).toBe('https://hybridcloudworks.com/education/labs');
    });

    it('reads the seven days before the build day by point read, never a query, and never Azure', async () => {
      const store = makeStore(
        {},
        week([
          dayDoc('2026-09-13', { jobsByType: { 'terraform-validate': { succeeded: 4, failed: 1, timeout: 0 } }, coderRunningMax: 2 }),
          dayDoc('2026-09-12', { arcConnected: false, jobsByType: { 'terraform-validate': { succeeded: 2, failed: 0, timeout: 1 }, 'shell-echo': { succeeded: 1, failed: 0, timeout: 0 } }, coderRunningMax: 3 }),
          dayDoc('2026-09-10', { arcConnected: null }),
          dayDoc('2026-09-07'),
          // Today's document and one older than the week are not read.
          dayDoc('2026-09-14', { arcConnected: false }),
          dayDoc('2026-09-06', { arcConnected: false }),
        ])
      );
      const items = await labThisWeekSection.collect({ store, since: SINCE, until: NOW });
      expect(items).toEqual([
        {
          title: 'Azure Arc: connected 2 of 3 days observed',
          summary: 'Days the lab host reported Connected to Azure Arc, out of the days the estate page saw it.',
          url: 'https://hybridcloudworks.com/education/labs',
          label: 'Hybrid lab host',
        },
        {
          title: 'terraform-validate: 8 runs, 6 succeeded',
          summary: '1 failed · 1 timed out',
          url: 'https://hybridcloudworks.com/education/labs',
          label: 'Lab jobs',
        },
        {
          title: 'shell-echo: 1 run, 1 succeeded',
          summary: '',
          url: 'https://hybridcloudworks.com/education/labs',
          label: 'Lab jobs',
        },
        {
          title: 'Peak Coder workspaces: 3',
          summary: 'The most browser lab workspaces running at once, as sampled each day.',
          url: 'https://hybridcloudworks.com/education/labs',
          label: 'Coder',
        },
      ]);
      expect(store.queryDocs).not.toHaveBeenCalled();
      expect(store.readDoc).toHaveBeenCalledTimes(7);
      expect(store.readDoc.mock.calls.map(([c, id]) => `${c}/${id}`)).toEqual([
        'tool_service_cache/labs:day:2026-09-13',
        'tool_service_cache/labs:day:2026-09-12',
        'tool_service_cache/labs:day:2026-09-11',
        'tool_service_cache/labs:day:2026-09-10',
        'tool_service_cache/labs:day:2026-09-09',
        'tool_service_cache/labs:day:2026-09-08',
        'tool_service_cache/labs:day:2026-09-07',
      ]);
    });

    it('is empty with no day documents, and with days that observed nothing — even with a Coder sample', async () => {
      expect(await labThisWeekSection.collect({ store: makeStore(), since: SINCE, until: NOW })).toEqual([]);
      const unobserved = makeStore({}, week([dayDoc('2026-09-13', { arcConnected: null }), dayDoc('2026-09-12', { arcConnected: null, coderRunningMax: 2 })]));
      expect(await labThisWeekSection.collect({ store: unobserved, since: SINCE, until: NOW })).toEqual([]);
      expect(labWeekItems([])).toEqual([]);
      expect(labWeekItems([{ arcConnected: null, jobsByType: { 'shell-echo': { succeeded: 0, failed: 0, timeout: 0 } } }])).toEqual([]);
    });

    it('carries the section on jobs alone, or on Arc alone', () => {
      const jobsOnly = labWeekItems([{ arcConnected: null, jobsByType: { 'ansible-check': { succeeded: 1, failed: 0, timeout: 0 } } }]);
      expect(jobsOnly.map((i) => i.label)).toEqual(['Lab jobs']);
      const arcOnly = labWeekItems([{ arcConnected: false, jobsByType: {} }]);
      expect(arcOnly.map((i) => i.title)).toEqual(['Azure Arc: connected 0 of 1 day observed']);
    });

    it('is left out of the issue entirely when there is nothing to say — no heading, no filler', async () => {
      const store = makeStore({ content: [article] });
      const result = await createIssueBuilder({ store, drafter: null, now: () => NOW }).build({});
      expect(result.success).toBe(true);
      expect(result.sections).toEqual(['articles']);
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.problems).toEqual([]);
      const { html, text } = renderIssue(doc, { postalAddress: 'x' });
      expect(html).not.toContain('Lab this week');
      expect(text).not.toContain('LAB THIS WEEK');
    });

    it('renders in the issue, HTML and text, as its siblings do', async () => {
      const store = makeStore({ content: [article] }, week([dayDoc('2026-09-13', { jobsByType: { 'terraform-validate': { succeeded: 3, failed: 0, timeout: 0 } } })]));
      const result = await createIssueBuilder({ store, drafter: null, now: () => NOW }).build({});
      expect(result.sections).toEqual(['articles', 'lab-this-week']);
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.itemCount).toBe(3);
      const { html, text } = renderIssue(doc, { postalAddress: 'x' });
      expect(html).toContain('<h2 style="margin:0 0 16px;font-size:20px;color:#111827">Lab this week</h2>');
      expect(html).toContain('Azure Arc: connected 1 of 1 day observed');
      expect(html).toContain('href="https://hybridcloudworks.com/education/labs"');
      expect(text).toContain('LAB THIS WEEK');
      expect(text).toContain('- terraform-validate: 3 runs, 3 succeeded\n  Lab jobs\n  https://hybridcloudworks.com/education/labs');
    });
  });

  it('keeps a failing section from sinking the issue, and reports it', async () => {
    const warn = vi.fn();
    const broken = { id: 'broken', title: 'Broken', collect: async () => { throw new Error('container gone'); } };
    const ok = { id: 'ok', title: 'OK', collect: async () => [{ title: 'A', url: 'https://x.example/a' }] };
    const empty = { id: 'empty', title: 'Empty', collect: async () => [] };
    const result = await collectSections({ store: {}, since: SINCE, until: NOW, sections: [broken, ok, empty], log: { warn } });
    expect(result.sections.map((s) => s.id)).toEqual(['ok']);
    // The failure's code, never its sentence: problems are stored and shown (#945).
    expect(result.problems).toEqual(['broken: could not be collected (Error)']);
    expect(warn).toHaveBeenCalled();
  });

  it('only accepts https or site paths as links, and never passes markup through', () => {
    expect(absoluteUrl('/azure/blog/x')).toBe('https://hybridcloudworks.com/azure/blog/x');
    for (const bad of ['//evil.example/x', 'javascript:alert(1)', 'http://plain.example', '', null]) {
      expect(absoluteUrl(bad), String(bad)).toBeNull();
    }
    expect(plainText('<b>bold</b>   text')).toBe('bold text');
    expect(plainText('x'.repeat(400))).toHaveLength(280);
  });
});

describe('createIssueBuilder', () => {
  const drafter = (overrides = {}) => ({
    generateDraft: vi.fn(async () => ({ title: '## Landing zones, again', postContent: '**This week** we looked at [zones](https://x).', ...overrides })),
  });

  it('stores a draft with the sections, an AI subject and a plain-text intro', async () => {
    const store = makeStore({ content: [article] });
    const d = drafter();
    const result = await createIssueBuilder({ store, drafter: d, now: () => NOW }).build({});

    expect(result).toMatchObject({ success: true, issueId: 'issue-2026-09-14', itemCount: 1, sections: ['articles'] });
    const doc = store.written.get('newsletters/issue-2026-09-14');
    expect(doc).toMatchObject({
      kind: 'weekly_issue',
      status: 'draft',
      subject: 'Landing zones, again',
      intro: 'This week we looked at zones.',
      customNote: '',
      periodStart: SINCE.toISOString(),
      periodEnd: NOW.toISOString(),
    });
    const call = d.generateDraft.mock.calls[0][0];
    expect(call.customInstructionPrompt).toBe(introInstruction('professional'));
    expect(call.markdown).toContain('Landing zones in 2026');
  });

  it('builds nothing, and asks no model, when the week had nothing new', async () => {
    const store = makeStore();
    const d = drafter();
    const result = await createIssueBuilder({ store, drafter: d, now: () => NOW }).build({ days: 7 });
    expect(result).toMatchObject({ success: false, itemCount: 0 });
    expect(d.generateDraft).not.toHaveBeenCalled();
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('still builds the issue when the AI is off, with a dated subject and no intro', async () => {
    const store = makeStore({ content: [article] });
    const d = { generateDraft: vi.fn(async () => { throw new AiFeatureDisabledError('forgeDrafting'); }) };
    const result = await createIssueBuilder({ store, drafter: d, now: () => NOW, log: { warn: vi.fn() } }).build({});
    expect(result.success).toBe(true);
    // The page is Newsletter Hub in the menu (#566); the message names it that way.
    expect(result.message).toMatch(/Review and approve it in the Newsletter Hub\.$/);
    const doc = store.written.get('newsletters/issue-2026-09-14');
    expect(doc.subject).toBe('HybridCloudWorks Weekly: Sep 7 – Sep 14');
    expect(doc.intro).toBe('');
    expect(doc.introError).toMatch(/turned off/);
  });

  it('refreshes a same-day draft but keeps the owner’s note', async () => {
    const store = makeStore({ content: [article] }, {
      'newsletters/issue-2026-09-14': { id: 'issue-2026-09-14', status: 'draft', customNote: 'Conference next week!', createdAt: '2026-09-14T08:00:00Z' },
    });
    await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({});
    expect(store.written.get('newsletters/issue-2026-09-14')).toMatchObject({
      customNote: 'Conference next week!',
      createdAt: '2026-09-14T08:00:00Z',
    });
  });

  it('never rebuilds over an issue saved to Drafts', async () => {
    const store = makeStore({ content: [article] }, {
      'newsletters/issue-2026-09-14': { id: 'issue-2026-09-14', status: 'draft', savedAt: '2026-09-14T09:00:00Z' },
    });
    const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/saved in Drafts/);
    expect(store.upsertDoc).not.toHaveBeenCalled();
  });

  it('lands the issue in Drafts when asked to keep it, still as a draft', async () => {
    const store = makeStore({ content: [article] });
    const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({
      days: 7,
      keep: true,
      keptBy: 'auto-build',
    });
    expect(result).toMatchObject({
      success: true,
      kept: true,
      issueId: 'issue-2026-09-14',
      subject: 'Landing zones, again',
      itemCount: 1,
      introError: null,
    });
    expect(store.written.get('newsletters/issue-2026-09-14')).toMatchObject({
      status: 'draft',
      savedAt: NOW.toISOString(),
      savedBy: 'auto-build',
    });
  });

  it('does not mark a build as saved unless asked to keep it', async () => {
    const store = makeStore({ content: [article] });
    const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({});
    expect(result.kept).toBe(false);
    const doc = store.written.get('newsletters/issue-2026-09-14');
    expect(doc).not.toHaveProperty('savedAt');
    expect(doc).not.toHaveProperty('savedBy');
  });

  it('keeping still refuses to overwrite a kept or approved issue, and says why', async () => {
    const kept = makeStore({ content: [article] }, {
      'newsletters/issue-2026-09-14': { id: 'issue-2026-09-14', status: 'draft', savedAt: '2026-09-14T09:00:00Z', subject: 'Mine' },
    });
    const keptResult = await createIssueBuilder({ store: kept, drafter: drafter(), now: () => NOW }).build({ keep: true, keptBy: 'auto-build' });
    expect(keptResult).toMatchObject({ success: false, reason: 'kept' });
    expect(kept.upsertDoc).not.toHaveBeenCalled();
    expect(kept.written.get('newsletters/issue-2026-09-14').subject).toBe('Mine');

    const sent = makeStore({ content: [article] }, { 'newsletters/issue-2026-09-14': { id: 'issue-2026-09-14', status: 'sent' } });
    const sentResult = await createIssueBuilder({ store: sent, drafter: drafter(), now: () => NOW }).build({ keep: true });
    expect(sentResult).toMatchObject({ success: false, reason: 'locked', status: 'sent' });
    expect(sent.upsertDoc).not.toHaveBeenCalled();

    const empty = makeStore();
    expect(await createIssueBuilder({ store: empty, drafter: drafter(), now: () => NOW }).build({ keep: true })).toMatchObject({
      success: false,
      reason: 'empty',
    });
  });

  it('builds a deleted issue again from scratch', async () => {
    const store = makeStore({ content: [article] }, {
      'newsletters/issue-2026-09-14': {
        id: 'issue-2026-09-14',
        status: 'deleted',
        customNote: 'Old note',
        createdAt: '2026-09-14T08:00:00Z',
      },
    });
    const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({});
    expect(result.success).toBe(true);
    const doc = store.written.get('newsletters/issue-2026-09-14');
    expect(doc).toMatchObject({ status: 'draft', customNote: '', createdAt: NOW.toISOString() });
  });

  it('never rebuilds an issue that has been approved', async () => {
    for (const status of ['sending', 'scheduled', 'sent']) {
      const store = makeStore({ content: [article] }, { 'newsletters/issue-2026-09-14': { id: 'issue-2026-09-14', status } });
      const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({});
      expect(result.success, status).toBe(false);
      expect(store.upsertDoc, status).not.toHaveBeenCalled();
    }
  });

  describe('Newsletter settings → Content (#557)', () => {
    const articles = (n) =>
      Array.from({ length: n }, (_, i) => ({
        ...article,
        Title: `Article ${i + 1}`,
        publishedUrl: `https://hybridcloudworks.com/azure/blog/a-${i + 1}`,
      }));
    const certEvent = { type: 'update', certCodes: ['AZ-104'], title: 'AZ-104 updated', link: 'https://learn.microsoft.com/az-104', pubDate: '2026-09-10T00:00:00Z' };
    const podcast = { provider: 'azure', title: 'Episode 3', link: 'https://media.rss.com/show/ep-3', publishedAt: '2026-09-11T00:00:00Z' };
    const rows = (n = 3) => ({ content: articles(n), certEvents: [certEvent], podcasts: [podcast] });
    const withSettings = (settings, content = rows()) =>
      makeStore(content, { 'admin_config/newsletter_settings': { id: 'newsletter_settings', ...settings } });

    it('builds from every section in registry order, 7 days back, when nothing is saved', async () => {
      const store = makeStore(rows());
      const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build();
      expect(result.sections).toEqual(['articles', 'certification-news', 'episodes']);
      expect(store.written.get('newsletters/issue-2026-09-14').periodStart).toBe(SINCE.toISOString());
    });

    it('collects only enabled sections, in the saved order, each capped at its saved count', async () => {
      const store = withSettings(
        {
          sections: [
            { id: 'episodes', enabled: true, maxItems: 5 },
            { id: 'certification-news', enabled: false, maxItems: 12 },
            { id: 'articles', enabled: true, maxItems: 2 },
          ],
        },
        rows(6)
      );
      const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build();
      expect(result.sections).toEqual(['episodes', 'articles']);
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.sections.map((s) => [s.id, s.items.length])).toEqual([
        ['episodes', 1],
        ['articles', 2],
      ]);
      expect(doc.itemCount).toBe(3);
      expect(store.queryDocs.mock.calls.map(([container]) => container)).not.toContain('certEvents');
    });

    it('looks back the saved number of days when the caller names none', async () => {
      const store = withSettings({ windowDays: 14 });
      await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({});
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc.periodStart).toBe('2026-08-31T12:00:00.000Z');
      const [, , params] = store.queryDocs.mock.calls[0];
      expect(params[0]).toEqual({ name: '@since', value: '2026-08-31T12:00:00.000Z' });
    });

    it('lets an explicit days win over the saved window, still clamped', async () => {
      const store = withSettings({ windowDays: 14 });
      await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build({ days: 3 });
      expect(store.written.get('newsletters/issue-2026-09-14').periodStart).toBe('2026-09-11T12:00:00.000Z');

      const wide = withSettings({ windowDays: 14 });
      await createIssueBuilder({ store: wide, drafter: drafter(), now: () => NOW }).build({ days: 365 });
      expect(wide.written.get('newsletters/issue-2026-09-14').periodStart).toBe('2026-08-14T12:00:00.000Z');
    });

    it('writes no intro, asks no model and records no error when the intro is off', async () => {
      const store = withSettings({ introEnabled: false });
      const d = drafter();
      const result = await createIssueBuilder({ store, drafter: d, now: () => NOW }).build({});
      expect(result).toMatchObject({ success: true, introError: null });
      expect(d.generateDraft).not.toHaveBeenCalled();
      const doc = store.written.get('newsletters/issue-2026-09-14');
      expect(doc).toMatchObject({ intro: '', introError: null, subject: 'HybridCloudWorks Weekly: Sep 7 – Sep 14' });
    });

    it('gives the drafter the saved tone, after the unchanged instruction', async () => {
      const store = withSettings({ introTone: 'friendly' });
      const d = drafter();
      await createIssueBuilder({ store, drafter: d, now: () => NOW }).build({});
      const prompt = d.generateDraft.mock.calls[0][0].customInstructionPrompt;
      expect(prompt).toBe(`${INTRO_INSTRUCTION} ${INTRO_TONES.friendly}`);
    });

    it('builds with the defaults, and says so on the issue, when the settings cannot be read', async () => {
      const store = makeStore(rows());
      const read = store.readDoc.getMockImplementation();
      store.readDoc.mockImplementation(async (container, id) => {
        if (container === 'admin_config') throw new Error('Cosmos unavailable');
        return read(container, id);
      });
      const warn = vi.fn();
      const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW, log: { warn } }).build();
      expect(result.success).toBe(true);
      expect(result.sections).toEqual(['articles', 'certification-news', 'episodes']);
      expect(result.problems[0]).toMatch(/settings: could not be read/);
      expect(warn).toHaveBeenCalled();
    });

    it('records why when the stored settings are invalid, and builds with the defaults', async () => {
      const store = makeStore(rows(), {
        'admin_config/newsletter_settings': { id: 'newsletter_settings', windowDays: 'a fortnight' },
      });
      const result = await createIssueBuilder({ store, drafter: drafter(), now: () => NOW }).build();
      expect(result.success).toBe(true);
      expect(result.sections).toEqual(['articles', 'certification-news', 'episodes']);
      expect(result.problems[0]).toMatch(/saved newsletter settings are invalid \(.*windowDays.*\)/);
    });

    it('plans a registered section the saved list does not name after the saved ones', () => {
      const a = { id: 'a' };
      const b = { id: 'b' };
      const c = { id: 'c' };
      expect(planSections([a, b, c], [{ id: 'c', enabled: true, maxItems: 4 }, { id: 'a', enabled: false, maxItems: 1 }, { id: 'zz', enabled: true }])).toEqual({
        sections: [c, b],
        maxItems: { c: 4 },
      });
    });

    it('uses an unknown tone as the default rather than sending nothing', () => {
      expect(introInstruction('sarcastic')).toBe(introInstruction('professional'));
    });
  });

  it('strips markdown a model still emits', () => {
    expect(stripMarkdown('# Title\n- one\n- **two**\n1. three `code` _it_ [link](https://x)')).toBe(
      'Title\none\ntwo\nthree code it link'
    );
  });
});

describe('renderIssue', () => {
  const issue = {
    id: 'issue-2026-09-14',
    subject: 'Landing <zones> & more',
    periodStart: SINCE.toISOString(),
    periodEnd: NOW.toISOString(),
    intro: 'We covered a lot.\n\nSecond paragraph.',
    customNote: 'See you at <Ignite>.',
    sections: [
      { id: 'articles', title: 'New on HybridCloudWorks', items: [{ title: 'A "quoted" <title>', summary: 's', url: 'https://hybridcloudworks.com/a?x=1&y=2', label: 'Azure' }] },
    ],
  };

  it('escapes every stored value, so nothing in an issue becomes markup', () => {
    const { html } = renderIssue(issue, { postalAddress: '1 Main <St>' });
    expect(html).not.toContain('<zones>');
    expect(html).not.toContain('<Ignite>');
    expect(html).not.toContain('<title>A');
    expect(html).toContain('Landing &lt;zones&gt; &amp; more');
    expect(html).toContain('A &quot;quoted&quot; &lt;title&gt;');
    expect(html).toContain('href="https://hybridcloudworks.com/a?x=1&amp;y=2"');
    expect(html).toContain('1 Main &lt;St&gt;');
  });

  it('carries the postal address and Resend’s per-recipient unsubscribe link, in both parts', () => {
    const { html, text, subject } = renderIssue(issue, { postalAddress: 'PO Box 1\nAustin, TX' });
    expect(subject).toBe(issue.subject);
    expect(html).toContain(`href="${UNSUBSCRIBE_PLACEHOLDER}"`);
    expect(html).toContain('PO Box 1<br>Austin, TX');
    expect(text).toContain(`Unsubscribe: ${UNSUBSCRIBE_PLACEHOLDER}`);
    expect(text).toContain('PO Box 1\nAustin, TX');
    expect(text).toContain('https://hybridcloudworks.com/a?x=1&y=2');
  });

  it('re-checks every link at render, dropping unsafe items and emptied sections', () => {
    const unsafe = {
      ...issue,
      sections: [
        {
          id: 'articles',
          title: 'New on HybridCloudWorks',
          items: [
            { title: 'Script', url: 'javascript:alert(1)' },
            { title: 'Data', url: 'data:text/html,<b>x</b>' },
            { title: 'Plain http', url: 'http://example.com/x' },
            { title: 'Site path', url: '/azure/blog/ok' },
          ],
        },
        { id: 'gone', title: 'Only bad links', items: [{ title: 'Bad', url: 'vbscript:x' }] },
      ],
    };
    const { html, text } = renderIssue(unsafe, { postalAddress: 'x' });
    for (const bad of ['javascript:', 'data:text', 'http://example.com', 'vbscript:', 'Only bad links']) {
      expect(html, bad).not.toContain(bad);
      expect(text, bad).not.toContain(bad);
    }
    expect(html).toContain('href="https://hybridcloudworks.com/azure/blog/ok"');
  });

  it('dates the week it covers', () => {
    expect(renderIssue(issue, { postalAddress: 'x' }).html).toContain('HybridCloudWorks Weekly · Sep 7 – Sep 14');
  });

  it('puts the preheader first in the body as a hidden, escaped block followed by filler', () => {
    const { html, text } = renderIssue({ ...issue, preheader: 'Zones <b>& more</b>' }, { postalAddress: 'x' });
    const body = html.slice(html.indexOf('<body'));
    const firstDiv = body.indexOf('<div style="display:none');
    expect(firstDiv).toBeGreaterThan(-1);
    expect(firstDiv).toBeLessThan(body.indexOf('<table'));
    expect(body).toContain('>Zones &lt;b&gt;&amp; more&lt;/b&gt;</div>');
    expect(body).not.toContain('<b>');
    expect(body).toContain('&zwnj;&nbsp;');
    // Preview text is for the inbox list; the plain-text part does not repeat it.
    expect(text).not.toContain('Zones');
  });

  it('emits no preheader block when there is none', () => {
    for (const preheader of [undefined, '', '   ']) {
      expect(renderIssue({ ...issue, preheader }, { postalAddress: 'x' }).html, String(preheader)).not.toContain('display:none');
    }
  });

  it('renders a test send with an inert unsubscribe link and a note saying why', () => {
    const { html, text } = renderIssue(issue, { postalAddress: 'x', testSend: true });
    expect(html).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    expect(text).not.toContain(UNSUBSCRIBE_PLACEHOLDER);
    expect(html).toContain('href="#"');
    expect(html).toContain('unsubscribe link is inactive');
    expect(text).toContain('Unsubscribe: #');
    expect(renderIssue(issue, { postalAddress: 'x' }).html).not.toContain('unsubscribe link is inactive');
  });
});

describe('draftIntro and suggestSubjects', () => {
  const sections = [{ id: 'articles', title: 'New', items: [{ title: 'Zones', url: 'https://hybridcloudworks.com/z', summary: 'What changed' }] }];

  it('drafts the intro from the sections with the intro instruction, the same call the builder makes', async () => {
    const drafter = { generateDraft: vi.fn(async () => ({ title: '## Zones', postContent: '**We** wrote.' })) };
    expect(await draftIntro({ drafter, sections, subject: 'Fallback' })).toEqual({ subject: 'Zones', intro: 'We wrote.' });
    expect(drafter.generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ customInstructionPrompt: introInstruction(), markdown: '## New\n- Zones — What changed', scrapedTitle: 'Fallback' })
    );
    const untitled = { generateDraft: vi.fn(async () => ({ postContent: 'x' })) };
    expect((await draftIntro({ drafter: untitled, sections, subject: 'Fallback' })).subject).toBe('Fallback');
  });

  it('suggests subjects through the drafter, and throws rather than return too few', async () => {
    const drafter = { generateDraft: vi.fn(async () => ({ title: 'One', keyTopics: ['Two', 'Three'] })) };
    expect(await suggestSubjects({ drafter, sections, subject: 's' })).toEqual(['One', 'Two', 'Three']);
    expect(drafter.generateDraft.mock.calls[0][0].customInstructionPrompt).toBe(SUBJECT_INSTRUCTION);
    const few = { generateDraft: vi.fn(async () => ({ title: 'One', keyTopics: 'not a list' })) };
    await expect(suggestSubjects({ drafter: few, sections, subject: 's' })).rejects.toThrow(/at least 3/);
  });

  it("passes the route's time budget to the drafter, and none for the Monday build", async () => {
    const drafter = { generateDraft: vi.fn(async () => ({ title: 'One', postContent: 'x', keyTopics: ['Two', 'Three'] })) };
    await draftIntro({ drafter, sections, subject: 's' });
    await draftIntro({ drafter, sections, subject: 's', budgetMs: 12_000 });
    await suggestSubjects({ drafter, sections, subject: 's', budgetMs: 11_000 });
    expect(drafter.generateDraft.mock.calls.map(([call]) => call.budgetMs)).toEqual([null, 12_000, 11_000]);
  });
});
