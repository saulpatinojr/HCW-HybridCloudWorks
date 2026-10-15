/**
 * Forge Studio as a workspace (ADR 0033 §7 slice 2): Start → Brief → Draft
 * → Finish over one session, with the voice configuration whole under its
 * own tab and the fixes the move brought (zero values kept, chips disabled
 * while saving, today's count shown).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ForgeStudioPage from './ForgeStudioPage';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const runJob = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/lib/jobs', () => ({ runJob: (...args) => runJob(...args) }));

const CONFIG = {
  ok: true,
  profile: {
    wordSoup: 'I run a homelab.',
    interestAreas: [
      { key: 'hybrid_arch', label: 'Hybrid Architecture', weight: 90, keywords: ['vmware'] },
    ],
    certifications: [],
    speakingTopics: [],
  },
  suggestions: {
    generatedAt: '2026-08-28T00:00:00Z',
    postCount: 4,
    wordSoupAdditions: ['Prefers boring technology'],
    styleHints: ['Short sentences'],
    recurringPhrases: ['blast radius'],
  },
  prompts: {
    masterPrompt: 'Write like me.',
    extraBannedPhrases: ['delve'],
    styleRules: { noEmDash: true, noHyphenTells: true, custom: [] },
    publishThreshold: 80,
    autoForge: { enabled: false, dailyLimit: 3 },
  },
  formats: [{ key: 'how_to', label: 'How-To / Tutorial', wordRange: [1000, 1500] }],
  stats: {
    totals: { forged: 7, costUsd: 1.23456 },
    formats: {},
    today: { date: '2026-10-03', forged: 2 },
    updatedAt: null,
  },
};

const DOC = {
  id: 'c1',
  Title: 'Hub and spoke',
  Summary: 'A summary',
  content: '# Hub and spoke\n\nBody text.',
  contentStatus: 'forge_ready',
  forgeGrade: { overall: 88 },
  forgeMeta: { threshold: 80 },
  kind: 'article',
  ideaOrigin: 'manual',
  activity: [],
  _etag: 'e1',
};

const QUEUE_ITEMS = [
  {
    id: 'q-1',
    url: 'https://www.finops.org/insights/agentic-finops-adoption/',
    title: '',
    status: 'queued',
    kind: '',
    ideaOrigin: 'imported-source',
    brief: {
      mode: 'url',
      sourceUrl: 'https://www.finops.org/insights/agentic-finops-adoption/',
      objective: '',
    },
    addedAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
  },
  {
    id: 'q-2',
    url: 'https://learn.microsoft.com/azure/thing',
    title: '',
    status: 'queued',
    kind: 'guide',
    ideaOrigin: 'imported-source',
    brief: {
      mode: 'url',
      sourceUrl: 'https://learn.microsoft.com/azure/thing',
      objective: 'Teach',
      tone: 'Opinionated',
    },
    addedAt: '2026-10-06T10:01:00.000Z',
    updatedAt: '2026-10-06T10:01:00.000Z',
  },
  {
    id: 'q-3',
    url: 'https://aws.amazon.com/blogs/x',
    title: 'Forged one',
    status: 'forged',
    contentId: 'c1',
    kind: '',
    ideaOrigin: 'imported-source',
    brief: { mode: 'url', sourceUrl: 'https://aws.amazon.com/blogs/x' },
    addedAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T11:00:00.000Z',
  },
  {
    id: 'q-4',
    url: 'https://cloud.google.com/blog/y',
    title: '',
    status: 'forging',
    jobId: 'j-4',
    kind: '',
    ideaOrigin: 'imported-source',
    brief: { mode: 'url', sourceUrl: 'https://cloud.google.com/blog/y' },
    addedAt: '2026-10-06T08:00:00.000Z',
    updatedAt: '2026-10-06T11:30:00.000Z',
  },
];

function renderPage(entry = '/admin/forge-studio') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/forge-studio" element={<ForgeStudioPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const selectedTab = () => screen.getByRole('tab', { selected: true }).textContent;

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  sendJSON.mockReset();
  runJob.mockReset();
  getJSON.mockImplementation(async (route) => {
    if (route === 'getForgeConfig') return CONFIG;
    if (route.startsWith('cms/content/item')) return { success: true, item: DOC };
    if (route.startsWith('cms/platform-settings')) return { value: null };
    if (route === 'cms/forge/queue')
      return { ok: true, items: QUEUE_ITEMS, total: QUEUE_ITEMS.length, max: 200 };
    if (route.startsWith('cms/content?')) {
      return {
        items: [{ id: 'old-1', Title: 'An older piece', contentStatus: 'published', Live: true }],
      };
    }
    return {};
  });
});

describe('the workspace', () => {
  it('opens on Start with the five ways a piece begins, and an idea leads to the Brief', async () => {
    renderPage();
    expect(await screen.findByText('Forge Studio')).toBeInTheDocument();
    expect(selectedTab()).toBe('Start');
    for (const label of [
      'From an idea',
      'From a template',
      'From existing content',
      'From a URL',
      'Blank',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: /From an idea/ }));
    expect(selectedTab()).toBe('Brief');
    expect(screen.getByLabelText('Working title')).toBeInTheDocument();
  });

  it('a template seeds the brief with its format; existing content is listed and picked', async () => {
    renderPage();
    await screen.findByText('Forge Studio');
    fireEvent.click(screen.getByRole('button', { name: /From a template/ }));
    fireEvent.click(await screen.findByRole('button', { name: /How-To \/ Tutorial/ }));
    expect(selectedTab()).toBe('Brief');
    expect(screen.getByText(/From a template · How-To \/ Tutorial/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Start' }));
    fireEvent.click(screen.getByRole('button', { name: /From existing content/ }));
    fireEvent.click(await screen.findByRole('button', { name: /An older piece/ }));
    expect(selectedTab()).toBe('Brief');
    expect(screen.getByLabelText('Working title')).toHaveValue('An older piece (repurposed)');
  });

  it('Draft creates the document, saves the brief, runs the forge and shows the graded result; Finish links every destination', async () => {
    postJSON.mockImplementation(async (route) => {
      if (route === 'cms/drafts') return { ok: true, draft: { id: 'c1', etag: 'e0' } };
      if (route === 'cms/forge/brief') return { ok: true, contentId: 'c1' };
      return { ok: true };
    });
    runJob.mockResolvedValue({
      status: 'succeeded',
      result: { success: true, contentId: 'c1', status: 'forge_ready', overall: 88 },
    });
    renderPage();
    await screen.findByText('Forge Studio');
    fireEvent.click(screen.getByRole('button', { name: /From an idea/ }));
    fireEvent.change(screen.getByLabelText('Working title'), {
      target: { value: 'Hub and spoke' },
    });
    // Nothing to work from yet: Continue stays off until the brief says something.
    expect(screen.getByRole('button', { name: /Continue to Draft/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Teach hub-spoke' } });
    fireEvent.change(screen.getByLabelText('SEO keywords'), {
      target: { value: 'azure, hub-spoke' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue to Draft/ }));
    expect(selectedTab()).toBe('Draft');

    fireEvent.click(screen.getByRole('button', { name: /Generate the first draft/ }));

    await waitFor(() => expect(runJob).toHaveBeenCalled());
    // The document first (Drafting, on the Drafts page), then the brief on it, then the job.
    expect(postJSON.mock.calls[0][0]).toBe('cms/drafts');
    expect(postJSON.mock.calls[0][1]).toEqual({
      fields: {
        title: 'Hub and spoke',
        body: expect.stringContaining('**Objective:** Teach hub-spoke'),
        tags: ['azure', 'hub-spoke'],
      },
    });
    expect(postJSON.mock.calls[1][0]).toBe('cms/forge/brief');
    expect(postJSON.mock.calls[1][1]).toMatchObject({
      contentId: 'c1',
      kind: 'article',
      ideaOrigin: 'manual',
      brief: expect.objectContaining({
        objective: 'Teach hub-spoke',
        seoKeywords: ['azure', 'hub-spoke'],
      }),
    });
    expect(runJob).toHaveBeenCalledWith(
      'forge-article',
      { sourceContentId: 'c1' },
      expect.any(Object)
    );

    // The result: the document reloaded, its grade and body on screen.
    expect(await screen.findByLabelText('Body (markdown)')).toHaveValue(DOC.content);
    expect(screen.getByText(/Grade/).textContent).toMatch(/88.*threshold 80.*clears it/);
    expect(screen.getByRole('status', { name: '' }).textContent || '').toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Next steps for this piece/ }));
    expect(selectedTab()).toBe('Finish');
    expect(screen.getByRole('link', { name: 'Open in Editor' })).toHaveAttribute(
      'href',
      '/admin/editor/c1'
    );
    expect(screen.getByRole('link', { name: 'Open the Social Hub' })).toHaveAttribute(
      'href',
      '/admin/social-hub?tab=compose&contentId=c1'
    );
    expect(screen.getByRole('link', { name: 'Open Image Prompts' })).toHaveAttribute(
      'href',
      '/admin/image-prompts?contentId=c1'
    );
    expect(screen.getByRole('link', { name: 'Open Listen & Learn' })).toHaveAttribute(
      'href',
      '/admin/listen-and-learn?contentId=c1'
    );
    expect(screen.getByRole('link', { name: 'Open Publish' })).toHaveAttribute(
      'href',
      '/admin/publish'
    );
    // Staged by the forge, so review happens on the Queue rather than through the Drafts edge.
    expect(screen.getByRole('link', { name: 'Open on the Review Queue' })).toHaveAttribute(
      'href',
      '/admin/review-queue/c1'
    );
  });

  it('an AI action is one call recorded on the document, and its result is applied only by choice', async () => {
    postJSON.mockImplementation(async (route, body) => {
      if (route === 'cms/forge/assist') {
        return {
          ok: true,
          action: body.action,
          label: 'Suggest titles',
          result: { titles: ['Alpha title', 'Beta title'] },
          provider: 'gemini',
          model: 'gemini-3.6-flash',
          activity: {
            at: '2026-10-03T10:00:00Z',
            actor: 'owner',
            action: 'forge_assist',
            provider: 'gemini',
            model: 'gemini-3.6-flash',
          },
        };
      }
      return { ok: true };
    });
    renderPage('/admin/forge-studio?tab=draft&contentId=c1');
    expect(await screen.findByLabelText('Body (markdown)')).toHaveValue(DOC.content);
    expect(getJSON).toHaveBeenCalledWith('cms/content/item?contentId=c1');

    fireEvent.click(screen.getByRole('button', { name: 'Suggest title' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith(
        'cms/forge/assist',
        expect.objectContaining({ contentId: 'c1', action: 'title', text: DOC.content })
      )
    );
    expect(await screen.findByText('Alpha title')).toBeInTheDocument();
    expect(screen.getByText(/gemini \/ gemini-3.6-flash/)).toBeInTheDocument();
    // Not applied until chosen.
    expect(screen.getByLabelText('Title')).toHaveValue('Hub and spoke');
    fireEvent.click(screen.getAllByRole('button', { name: 'Use this title' })[0]);
    expect(screen.getByLabelText('Title')).toHaveValue('Alpha title');
    // The activity list carries the entry.
    fireEvent.click(screen.getByRole('button', { name: /Activity \(1\)/ }));
    expect(screen.getByText('forge_assist')).toBeInTheDocument();
  });

  it('Save writes the edited text under the ETag and says so when the version moved', async () => {
    postJSON
      .mockResolvedValueOnce({ ok: true, etag: 'e2', activity: [] })
      .mockRejectedValueOnce(Object.assign(new Error('moved'), { status: 412, code: 'CONFLICT' }));
    renderPage('/admin/forge-studio?tab=draft&contentId=c1');
    const body = await screen.findByLabelText('Body (markdown)');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(body, { target: { value: 'Edited body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/forge/save', {
        contentId: 'c1',
        etag: 'e1',
        title: 'Hub and spoke',
        summary: 'A summary',
        body: 'Edited body',
      })
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    fireEvent.change(body, { target: { value: 'Edited again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Reload the latest' })).toBeInTheDocument();
    // The ETag the second save carried is the one the first save returned.
    expect(postJSON.mock.calls[1][1].etag).toBe('e2');
  });

  it('Send to review is offered only while the document is Drafting, and carries the ETag', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'getForgeConfig') return CONFIG;
      if (route.startsWith('cms/content/item')) {
        return {
          success: true,
          item: { ...DOC, contentStatus: 'drafting', forgeGrade: undefined },
        };
      }
      return { value: null };
    });
    postJSON.mockResolvedValue({ ok: true, draft: { id: 'c1' } });
    renderPage('/admin/forge-studio?tab=finish&contentId=c1');
    // Generous waits: the Finish tab mounts behind a document read and a
    // config read, and under the full suite's load the default second was
    // not always enough (PR #841).
    const button = await screen.findByRole(
      'button',
      { name: /Send to In Review/ },
      { timeout: 5000 }
    );
    fireEvent.click(button);
    await waitFor(
      () => expect(postJSON).toHaveBeenCalledWith('cms/drafts/c1/send-to-review', { etag: 'e1' }),
      { timeout: 5000 }
    );
    expect(await screen.findByText(/Sent to In Review/, {}, { timeout: 5000 })).toBeInTheDocument();
    // The three waits above allow 5 s each, and vitest's own limit for a test
    // is 5 s, so under load the test was killed before its waits could be
    // used (CI on acbbd716, 2026-10-08). The limit has to cover all three.
  }, 20000);

  it('Draft and Finish say what to do when nothing exists yet', async () => {
    renderPage('/admin/forge-studio?tab=draft');
    expect(await screen.findByText('No brief yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Finish' }));
    expect(screen.getByText('Nothing to finish yet')).toBeInTheDocument();
  });
});

describe('Voice & profile (the configuration, moved whole)', () => {
  const open = () => renderPage('/admin/forge-studio?tab=voice');

  it('loads and renders the voice configuration, with today’s count and formatted totals', async () => {
    open();
    expect(await screen.findByLabelText(/Word soup/)).toHaveValue('I run a homelab.');
    expect(screen.getByLabelText('Master prompt')).toHaveValue('Write like me.');
    expect(screen.getByLabelText(/Publish threshold/)).toHaveValue(80);
    expect(screen.getByText('How-To / Tutorial')).toBeInTheDocument();
    expect(getJSON).toHaveBeenCalledWith('getForgeConfig');
    expect(screen.getByTestId('forged-today')).toHaveTextContent('2 (2026-10-03)');
    expect(screen.getByText('$1.23')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('saves the whitelisted payload shape and applies the response', async () => {
    postJSON.mockResolvedValue({ ...CONFIG, prompts: { ...CONFIG.prompts, publishThreshold: 85 } });
    open();
    await screen.findByLabelText(/Word soup/);
    fireEvent.change(screen.getByLabelText(/Publish threshold/), { target: { value: '85' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(postJSON).toHaveBeenCalled());
    expect(postJSON.mock.calls[0][0]).toBe('updateForgeConfig');
    expect(postJSON.mock.calls[0][1].prompts.publishThreshold).toBe(85);
    expect(postJSON.mock.calls[0][1].profile.wordSoup).toBe('I run a homelab.');
    expect(postJSON.mock.calls[0][1].profile.interestAreas[0]).toEqual({
      key: 'hybrid_arch',
      label: 'Hybrid Architecture',
      weight: 90,
      keywords: ['vmware'],
    });
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  it('keeps a 0 threshold and a 0 daily limit, and sends an emptied interest-area list as empty', async () => {
    postJSON.mockResolvedValue(CONFIG);
    open();
    await screen.findByLabelText(/Word soup/);
    fireEvent.change(screen.getByLabelText(/Publish threshold/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/Daily limit/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove row 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await waitFor(() => expect(postJSON).toHaveBeenCalled());
    const [[, payload]] = postJSON.mock.calls;
    expect(payload.prompts.publishThreshold).toBe(0);
    expect(payload.prompts.autoForge.dailyLimit).toBe(0);
    expect(payload.profile.interestAreas).toEqual([]);
  });

  it('accepting a suggestion appends it to the word soup, trims the chip list, and disables the chips while saving', async () => {
    let release;
    postJSON.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ...CONFIG,
              profile: {
                ...CONFIG.profile,
                wordSoup: 'I run a homelab.\nPrefers boring technology',
              },
              suggestions: { ...CONFIG.suggestions, wordSoupAdditions: [] },
            });
        })
    );
    open();
    await screen.findByLabelText(/Word soup/);
    const accept = screen.getByRole('button', {
      name: 'Accept suggestion: Prefers boring technology',
    });
    fireEvent.click(accept);
    expect(accept).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    release();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Accept suggestion/ })).toBeNull()
    );
    expect(postJSON.mock.calls[0][1].profile.wordSoup).toBe(
      'I run a homelab.\nPrefers boring technology'
    );
    expect(postJSON.mock.calls[0][1].profile.suggestionsKept).toEqual([]);
  });

  it('removing the first row keeps the remaining row’s values (stable keys)', async () => {
    getJSON.mockImplementation(async (route) =>
      route === 'getForgeConfig'
        ? {
            ...CONFIG,
            profile: {
              ...CONFIG.profile,
              interestAreas: [],
              certifications: [
                { name: 'AZ-104', issuer: 'Microsoft', keywords: ['azure'] },
                { name: 'SAA-C03', issuer: 'AWS', keywords: ['aws'] },
              ],
            },
          }
        : { value: null }
    );
    open();
    await screen.findByLabelText(/Word soup/);
    const nameInputs = () => screen.getAllByLabelText('Name');
    expect(nameInputs().map((input) => input.value)).toEqual(['AZ-104', 'SAA-C03']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove row 1' })[0]);
    expect(nameInputs().map((input) => input.value)).toEqual(['SAA-C03']);
  });

  it('calibration runs the job and reloads the config', async () => {
    runJob.mockResolvedValue({ status: 'succeeded', result: {} });
    open();
    await screen.findByLabelText(/Word soup/);
    getJSON.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Calibrate from my published posts/ }));
    await waitFor(() =>
      expect(runJob).toHaveBeenCalledWith('voice-calibration', {}, expect.any(Object))
    );
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith('getForgeConfig'));
    expect(await screen.findByText(/Calibration complete/)).toBeInTheDocument();
  });

  it('shows the error with a retry when the configuration cannot be read', async () => {
    getJSON.mockImplementation(async (route) => {
      if (route === 'getForgeConfig') throw new Error('offline');
      return { value: null };
    });
    open();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('offline')).toBeInTheDocument();
    getJSON.mockImplementation(async (route) =>
      route === 'getForgeConfig' ? CONFIG : { value: null }
    );
    fireEvent.click(within(alert).getByRole('button', { name: /Try again/ }));
    expect(await screen.findByLabelText(/Word soup/)).toBeInTheDocument();
  });
});

describe('From a URL with many URLs, and the Forge Studio Queue (owner request 2026-10-06)', () => {
  const delta = (changed, extra = {}) => ({ ok: true, changed, removed: [], max: 5000, ...extra });
  const openUrl = async () => {
    renderPage();
    await screen.findByText('Forge Studio');
    fireEvent.click(screen.getByRole('button', { name: /From a URL/ }));
    return screen.getByLabelText('Source URL, or several');
  };

  it('one URL still continues to the Brief with it as the source', async () => {
    const box = await openUrl();
    fireEvent.change(box, { target: { value: 'https://a.test/one' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue to the brief/ }));
    expect(selectedTab()).toBe('Brief');
    expect(screen.getByText(/https:\/\/a\.test\/one/)).toBeInTheDocument();
  });

  it('several URLs become rows with Remove each, Remove all, and Add all sends them to the queue', async () => {
    postJSON.mockImplementation(async (route, body) => {
      if (route === 'cms/forge/queue') {
        return delta(
          body.urls.map((url, i) => ({ ...QUEUE_ITEMS[0], id: `n-${i}`, url })),
          { added: body.urls.map((u, i) => `n-${i}`), skipped: [] }
        );
      }
      return { ok: true };
    });
    const box = await openUrl();
    fireEvent.change(box, {
      target: { value: 'Read https://a.test/one and https://b.test/two#frag\nhttps://a.test/one' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Detect URLs' }));
    const list = within(screen.getByTestId('detected-urls'));
    expect(list.getByText('2 URLs detected')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: 'Remove b.test/two' }));
    expect(list.getByText('1 URL detected')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'https://c.test/three' } });
    fireEvent.click(screen.getByRole('button', { name: 'Detect URLs' }));
    expect(list.getByText('2 URLs detected')).toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: /Add all to the queue/ }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/forge/queue', {
        urls: ['https://a.test/one', 'https://c.test/three'],
      })
    );
    expect(await screen.findByText(/2 added to the queue\./)).toBeInTheDocument();
    expect(screen.queryByTestId('detected-urls')).not.toBeInTheDocument();
    // The two created entries joined the queue the page holds: the card counts them.
    expect(screen.getByRole('button', { name: /Queue · 5/ })).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'https://d.test/4 https://e.test/5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Detect URLs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(screen.queryByTestId('detected-urls')).not.toBeInTheDocument();
  });

  it('the Queue card counts the entries still to forge and opens the Queue tab', async () => {
    renderPage();
    await screen.findByText('Forge Studio');
    const card = await screen.findByRole('button', { name: /Queue · 3/ });
    fireEvent.click(card);
    expect(selectedTab()).toBe('Queue');
    expect(await screen.findAllByTestId('queue-row')).toHaveLength(4);
  });

  it('selecting one entry shows its fields; Save applies them and starts its forge job, and the delta merges', async () => {
    postJSON.mockImplementation(async (route, body) => {
      const picked = QUEUE_ITEMS.filter((i) => body.ids.includes(i.id));
      if (route === 'cms/forge/queue/update') return delta(picked, { applied: body.ids });
      if (route === 'cms/forge/queue/forge') {
        return delta(
          picked.map((i) => ({ ...i, status: 'forging' })),
          { started: body.ids.map((id) => ({ id, jobId: `j-${id}` })) }
        );
      }
      return { ok: true };
    });
    renderPage('/admin/forge-studio?tab=queue');
    expect(await screen.findAllByTestId('queue-row')).toHaveLength(4);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select learn.microsoft.com/azure/thing' })
    );
    expect(screen.getByText('Fields for learn.microsoft.com/azure/thing')).toBeInTheDocument();
    expect(screen.getByLabelText('Objective')).toHaveValue('Teach');
    expect(screen.getByLabelText('Tone')).toHaveValue('Opinionated');
    fireEvent.change(screen.getByLabelText('Key message'), { target: { value: 'One thing' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith(
        'cms/forge/queue/update',
        expect.objectContaining({
          ids: ['q-2'],
          fields: expect.objectContaining({
            objective: 'Teach',
            keyMessage: 'One thing',
            tone: 'Opinionated',
            kind: 'guide',
          }),
        })
      )
    );
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/forge/queue/forge', { ids: ['q-2'] })
    );
    // q-4 was forging already; q-2 joins it, and the other two rows are untouched.
    await waitFor(() => expect(screen.getAllByText('Forging')).toHaveLength(2));
    expect(screen.getAllByTestId('queue-row')).toHaveLength(4);
  });

  it('every row but a forging one has its own remove; the header removes the selection, counting only what can go, and the delta merges', async () => {
    postJSON.mockImplementation(async (route, body) => delta([], { removed: body.ids }));
    renderPage('/admin/forge-studio?tab=queue');
    expect(await screen.findAllByTestId('queue-row')).toHaveLength(4);
    expect(
      screen.queryByRole('button', { name: 'Remove cloud.google.com/blog/y' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove aws.amazon.com/blogs/x' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/forge/queue/update', {
        ids: ['q-3'],
        remove: true,
      })
    );
    await waitFor(() => expect(screen.getAllByTestId('queue-row')).toHaveLength(3));
    expect(screen.getByRole('button', { name: /Remove selected/ })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select www.finops.org/insights/agentic-finops-adoption',
      })
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select learn.microsoft.com/azure/thing' })
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select cloud.google.com/blog/y' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove selected \(2\)/ }));
    // The two editable ones go, in the list's newest-first order; the forging one is not sent.
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/forge/queue/update', {
        ids: ['q-2', 'q-1'],
        remove: true,
      })
    );
    await waitFor(() => expect(screen.getAllByTestId('queue-row')).toHaveLength(1));
  });

  it('selecting several shows the shared fields, sends only the filled ones, and a forged entry opens its draft', async () => {
    postJSON.mockImplementation(async (route, body) =>
      delta(
        QUEUE_ITEMS.filter((i) => body.ids.includes(i.id)),
        { applied: body.ids, started: [] }
      )
    );
    renderPage('/admin/forge-studio?tab=queue');
    await screen.findAllByTestId('queue-row');
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Select www.finops.org/insights/agentic-finops-adoption',
      })
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select learn.microsoft.com/azure/thing' })
    );
    expect(screen.getByText('Shared fields for 2 entries')).toBeInTheDocument();
    expect(screen.getByLabelText('Objective')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'Conversational' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save for later' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/forge/queue/update', {
        ids: ['q-1', 'q-2'],
        fields: { tone: 'Conversational' },
      })
    );
    expect(postJSON).not.toHaveBeenCalledWith('cms/forge/queue/forge', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: /^Open/ }));
    expect(selectedTab()).toBe('Draft');
  });
});
