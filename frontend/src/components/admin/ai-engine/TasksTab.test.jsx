/**
 * The Tasks tab (ADR 0034 §4, #859): one row per task from the resolver's
 * answer, the effective model as the API reports it, a mode change saved as
 * the whole document with the updatedAt it read, a Custom chain filtered by
 * the task's needs, a refused save said inline with the API's sentence, a
 * 409 reloaded rather than overwritten, and the per-task Test's verdict.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const getAiRouting = vi.fn();
const getEffectiveRouting = vi.fn();
const saveAiRouting = vi.fn();
const testAiTask = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/aiEngine', () => ({
  aiEngine: {
    getAiRouting: (...a) => getAiRouting(...a),
    getEffectiveRouting: (...a) => getEffectiveRouting(...a),
    saveAiRouting: (...a) => saveAiRouting(...a),
    testAiTask: (...a) => testAiTask(...a),
  },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const { default: TasksTab } = await import('./TasksTab.jsx');

const PROVIDERS = [
  { id: 'gemini', name: 'Gemini', enabled: true },
  { id: 'openai', name: 'OpenAI', enabled: true },
  { id: 'foundry', name: 'Foundry', enabled: true },
];

const model = (id, capabilities = ['text']) => ({
  id,
  status: 'live',
  hidden: false,
  capabilities,
});
const CATALOG = {
  providers: {
    gemini: {
      models: { 'gemini-3.6-flash': model('gemini-3.6-flash', ['text', 'json', 'vision']) },
    },
    openai: {
      models: {
        'gpt-5-mini': model('gpt-5-mini', ['text', 'json', 'vision']),
        'gpt-5-nano': model('gpt-5-nano', ['text', 'json']),
      },
    },
    foundry: { models: { 'gpt-5-mini': model('gpt-5-mini', ['text', 'json', 'vision']) } },
  },
};

const SELECTION = {
  version: 2,
  global: {
    priority: [
      { provider: 'foundry', model: null },
      { provider: 'gemini', model: null },
    ],
  },
  tasks: { altText: { mode: 'recommended' } },
  updatedAt: 'r1',
};

const task = (over) => ({
  description: 'd',
  route: 'r',
  modality: 'text',
  needs: ['text'],
  public: false,
  recommended: null,
  entry: { mode: 'global' },
  mode: 'global',
  chain: [{ provider: 'foundry', model: null, modalityModel: 'gpt-5-nano', selection: 'global' }],
  rejected: [],
  flags: [],
  ...over,
});

const EFFECTIVE = {
  tasks: {
    forgeDrafting: task({ label: 'Forge drafting' }),
    altText: task({
      label: 'Image alt text',
      modality: 'vision',
      needs: ['text', 'vision'],
      recommended: {
        provider: 'foundry',
        model: 'gpt-5-mini',
        reason: 'Reads the image.',
        asOf: '2026-10-05',
      },
      entry: { mode: 'recommended' },
      mode: 'recommended',
      chain: [{ provider: 'foundry', model: 'gpt-5-mini', selection: 'recommended' }],
    }),
    pricingExplain: task({
      label: 'Pricing explanations',
      public: true,
      chain: [
        {
          provider: 'gemini',
          model: null,
          modalityModel: 'gemini-3.5-flash-lite',
          selection: 'global',
        },
      ],
      rejected: [
        {
          provider: 'foundry',
          model: null,
          code: 'policy',
          selection: 'global',
          why: 'not eligible: trial tier on a public route',
        },
      ],
    }),
  },
  priority: [],
  availability: {
    keyed: ['gemini', 'openai', 'foundry'],
    enabled: ['gemini', 'openai', 'foundry'],
    disabled: [],
  },
  updatedAt: 'r1',
};

const routingAnswer = (selection = SELECTION) => ({
  selection,
  migrated: false,
  catalogue: {},
  providers: ['gemini', 'openai', 'anthropic', 'nvidia', 'foundry'],
  updatedAt: selection.updatedAt,
});

beforeEach(() => {
  getAiRouting.mockReset().mockResolvedValue(routingAnswer());
  getEffectiveRouting.mockReset().mockResolvedValue(EFFECTIVE);
  saveAiRouting.mockReset();
  testAiTask.mockReset();
  toast.mockReset();
});

const renderTab = () => render(<TasksTab providers={PROVIDERS} catalog={CATALOG} />);

describe('TasksTab', () => {
  it('renders one row per task with the effective model the API reports, badges and the first rejection', async () => {
    renderTab();
    expect(await screen.findByText('Forge drafting')).toBeInTheDocument();
    expect(screen.getByTestId('effective-forgeDrafting')).toHaveTextContent(
      'Provider default via Foundry'
    );
    expect(screen.getByTestId('effective-altText')).toHaveTextContent('gpt-5-mini via Foundry');
    expect(screen.getByTestId('rejected-pricingExplain')).toHaveTextContent(
      'Foundry: not eligible: trial tier on a public route'
    );
    expect(screen.getByText('public')).toBeInTheDocument();
    expect(screen.getByText('vision')).toBeInTheDocument();
    // The recommendation's reason and date sit beside the radio.
    expect(screen.getByText(/Reads the image\. \(as of 2026-10-05\)/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Recommended/, checked: true })).toBeInTheDocument();
  });

  it('saves a mode change as the whole document with the updatedAt it read, then re-reads the answer', async () => {
    saveAiRouting.mockResolvedValue({
      selection: {
        ...SELECTION,
        tasks: { ...SELECTION.tasks, forgeDrafting: { mode: 'recommended' } },
        updatedAt: 'r2',
      },
      updatedAt: 'r2',
    });
    renderTab();
    const row = (await screen.findByText('Forge drafting')).closest('[data-task]');
    fireEvent.click(within(row).getByLabelText(/Global \(P1\)/));
    fireEvent.click(within(row).getByLabelText(/Custom/));
    fireEvent.click(within(row).getByRole('button', { name: 'Save Forge drafting' }));
    await waitFor(() => expect(saveAiRouting).toHaveBeenCalledTimes(1));
    expect(saveAiRouting.mock.calls[0][0]).toEqual({
      version: 2,
      global: SELECTION.global,
      tasks: {
        altText: { mode: 'recommended' },
        forgeDrafting: { mode: 'custom', chain: [], thenGlobal: true },
      },
      updatedAt: 'r1',
    });
    await waitFor(() => expect(getEffectiveRouting).toHaveBeenCalledTimes(2));
  });

  it('Custom opens the chain editor, filters models by the task’s needs, and offers then-the-Priority-list', async () => {
    renderTab();
    const row = (await screen.findByText('Image alt text')).closest('[data-task]');
    fireEvent.click(within(row).getByLabelText(/Custom/));
    fireEvent.click(within(row).getByRole('button', { name: 'Add step' }));
    const provider = within(row).getByLabelText('Step 1');
    fireEvent.change(provider, { target: { value: 'openai' } });
    const modelSelect = within(row).getByLabelText('Model', { selector: '#chain-altText-0-model' });
    // nano carries no vision, so a vision task never sees it.
    expect([...modelSelect.options].map((o) => o.value)).toEqual(['__default__', 'gpt-5-mini']);
    fireEvent.change(modelSelect, { target: { value: 'gpt-5-mini' } });
    const thenGlobal = within(row).getByRole('switch', {
      name: 'Then the Priority list for Image alt text',
    });
    expect(thenGlobal.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(thenGlobal);
    fireEvent.click(within(row).getByLabelText('Gemini', { selector: '#exclude-altText-gemini' }));
    saveAiRouting.mockResolvedValue({ selection: SELECTION, updatedAt: 'r1' });
    fireEvent.click(within(row).getByRole('button', { name: 'Save Image alt text' }));
    await waitFor(() => expect(saveAiRouting).toHaveBeenCalledTimes(1));
    expect(saveAiRouting.mock.calls[0][0].tasks.altText).toEqual({
      mode: 'custom',
      chain: [{ provider: 'openai', model: 'gpt-5-mini' }],
      thenGlobal: false,
      exclude: ['gemini'],
    });
  });

  it('a save the API refuses is said on the row with the API’s sentence, and the draft stays', async () => {
    saveAiRouting.mockRejectedValue(
      Object.assign(
        new Error(
          'tasks.forgeDrafting: this task would have no model — no entry of its custom chain is eligible'
        ),
        { status: 400 }
      )
    );
    renderTab();
    const row = (await screen.findByText('Forge drafting')).closest('[data-task]');
    fireEvent.click(within(row).getByLabelText(/Custom/));
    fireEvent.click(within(row).getByRole('button', { name: 'Save Forge drafting' }));
    expect(await within(row).findByTestId('save-error-forgeDrafting')).toHaveTextContent(
      'this task would have no model'
    );
    expect(within(row).getByRole('radio', { name: /Custom/ }).checked).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('a 409 reloads the document and says so rather than overwriting', async () => {
    saveAiRouting.mockRejectedValue(Object.assign(new Error('changed'), { status: 409 }));
    const elsewhere = {
      ...SELECTION,
      tasks: { forgeDrafting: { mode: 'recommended' } },
      updatedAt: 'r9',
    };
    getAiRouting
      .mockResolvedValueOnce(routingAnswer())
      .mockResolvedValueOnce(routingAnswer(elsewhere));
    getEffectiveRouting.mockResolvedValueOnce(EFFECTIVE).mockResolvedValueOnce({
      ...EFFECTIVE,
      tasks: {
        ...EFFECTIVE.tasks,
        forgeDrafting: task({ label: 'Forge drafting', entry: { mode: 'recommended' } }),
      },
    });
    renderTab();
    const row = (await screen.findByText('Forge drafting')).closest('[data-task]');
    fireEvent.click(within(row).getByLabelText(/Custom/));
    fireEvent.click(within(row).getByRole('button', { name: 'Save Forge drafting' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Changed elsewhere' }))
    );
    await waitFor(() => expect(getAiRouting).toHaveBeenCalledTimes(2));
    // The row now shows what was stored elsewhere, not the draft.
    const reloaded = (await screen.findByText('Forge drafting')).closest('[data-task]');
    await waitFor(() =>
      expect(within(reloaded).getByRole('radio', { name: /Recommended/ }).checked).toBe(true)
    );
  });

  it('Test runs the effective chain and says who answered and why the ones above did not', async () => {
    testAiTask.mockResolvedValue({
      ok: true,
      answeredBy: { provider: 'gemini', model: 'gemini-3.5-flash-lite', latencyMs: 512 },
      skipped: [{ provider: 'foundry', model: null, why: 'timeout after 45000 ms' }],
      rejected: [],
      flags: [],
    });
    renderTab();
    const row = (await screen.findByText('Pricing explanations')).closest('[data-task]');
    fireEvent.click(within(row).getByRole('button', { name: 'Test Pricing explanations' }));
    expect(testAiTask).toHaveBeenCalledWith('pricingExplain');
    const result = await within(row).findByTestId('task-test-result');
    expect(result).toHaveTextContent('Answered by gemini-3.5-flash-lite via Gemini in 512 ms.');
    expect(result).toHaveTextContent('Foundry: timeout after 45000 ms');
  });

  it('shows an error state with a retry when the answer cannot be read', async () => {
    getEffectiveRouting
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(EFFECTIVE);
    renderTab();
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Forge drafting')).toBeInTheDocument();
  });
});

describe('the media tasks (ADR 0034 slice 5, #860)', () => {
  const MEDIA_EFFECTIVE = {
    ...EFFECTIVE,
    tasks: {
      ...EFFECTIVE.tasks,
      podcastVoice: task({
        label: 'Podcast voice',
        modality: 'tts',
        needs: ['tts'],
        media: true,
        planned: false,
        only: ['elevenlabs'],
        recommended: {
          provider: 'elevenlabs',
          model: 'eleven_v3',
          reason: 'The one model the dialogue endpoint serves.',
          asOf: '2026-10-05',
        },
        entry: { mode: 'recommended' },
        mode: 'recommended',
        chain: [
          {
            provider: 'elevenlabs',
            model: 'eleven_v3',
            modalityModel: 'eleven_v3',
            selection: 'recommended',
            why: 'recommended for this task: The one model the dialogue endpoint serves.',
          },
        ],
      }),
      embeddings: task({
        label: 'Embeddings',
        modality: 'embedding',
        needs: ['embedding'],
        media: true,
        planned: true,
        only: null,
        chain: [],
        rejected: [
          {
            provider: 'gemini',
            model: null,
            code: 'capability',
            why: 'not eligible: gemini cannot carry embedding',
          },
        ],
      }),
    },
    availability: {
      keyed: ['gemini', 'openai', 'foundry', 'elevenlabs'],
      enabled: ['gemini', 'openai', 'foundry', 'elevenlabs'],
      disabled: [],
      media: ['elevenlabs', 'replicate'],
      capabilities: {
        gemini: ['text', 'json', 'vision', 'grounding', 'tts'],
        openai: ['text', 'json', 'vision'],
        anthropic: ['text', 'json', 'vision'],
        nvidia: ['text', 'json'],
        foundry: ['text', 'json', 'vision'],
        elevenlabs: ['tts'],
        replicate: ['image'],
      },
    },
  };

  beforeEach(() => {
    getEffectiveRouting.mockReset().mockResolvedValue(MEDIA_EFFECTIVE);
  });

  it('renders a media row with its modality, the effective model via the media provider, and "no eligible model" for a planned task', async () => {
    renderTab();
    expect(await screen.findByText('Podcast voice')).toBeInTheDocument();
    expect(screen.getByText('tts')).toBeInTheDocument();
    expect(screen.getByTestId('effective-podcastVoice')).toHaveTextContent(
      'eleven_v3 via ElevenLabs'
    );
    expect(screen.getByTestId('effective-embeddings')).toHaveTextContent('Not connected yet');
    const planned = screen.getByTestId('effective-embeddings').closest('[data-task]');
    expect(within(planned).getByText('planned')).toBeInTheDocument();
    expect(within(planned).queryByRole('button')).toBeNull();
    expect(within(planned).queryByRole('radio')).toBeNull();
    expect(within(planned).queryByText('no eligible model')).toBeNull();
    const row = screen.getByText('Podcast voice').closest('[data-task]');
    expect(within(row).getByText(/makes no audio or image/)).toBeInTheDocument();
  });

  it('offers a media task only the providers under its product rule, ElevenLabs among them, in the chain editor and the exclusions', async () => {
    renderTab();
    const row = (await screen.findByText('Podcast voice')).closest('[data-task]');
    expect(within(row).getByLabelText('ElevenLabs')).toBeInTheDocument();
    expect(within(row).queryByLabelText('Gemini')).toBeNull();
    fireEvent.click(within(row).getByRole('radio', { name: /Custom/ }));
    fireEvent.click(within(row).getByRole('button', { name: 'Add step' }));
    const provider = within(row).getByLabelText('Step 1');
    expect([...provider.options].map((o) => o.textContent)).toEqual(['ElevenLabs']);
  });

  it('the Test of a media task is a dry run: the candidate it would use, the reason, and nothing made', async () => {
    testAiTask.mockResolvedValue({
      ok: true,
      task: 'podcastVoice',
      mode: 'recommended',
      dryRun: true,
      wouldUse: { provider: 'elevenlabs', model: 'eleven_v3', why: 'recommended for this task' },
      answeredBy: null,
      skipped: [],
      rejected: [],
      flags: [],
    });
    renderTab();
    const row = (await screen.findByText('Podcast voice')).closest('[data-task]');
    fireEvent.click(within(row).getByRole('button', { name: 'Test Podcast voice' }));
    expect(testAiTask).toHaveBeenCalledWith('podcastVoice');
    const result = await within(row).findByTestId('task-test-result');
    expect(result).toHaveTextContent(
      'Would use eleven_v3 via ElevenLabs — recommended for this task. No audio or image was made.'
    );
  });
});
