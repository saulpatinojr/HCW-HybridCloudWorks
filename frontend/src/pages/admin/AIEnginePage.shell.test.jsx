/**
 * The AI Engine page shell after ADR 0033 and ADR 0034: tabs from tabs.js
 * under `?tab=`, the Tasks tab where Site Services was, a failed seed said
 * with a retry, the Priority list above the cards, and the catalogue's
 * model list on each card.
 *
 * Separate from AIEnginePage.test.jsx because that file replaces
 * react-router wholesale for its component-level tests; this one needs a
 * real router for the tabs.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const seedAiEngineIfEmpty = vi.fn();
const subscribeProviders = vi.fn();
const subscribeMcpServers = vi.fn();
const getAiRouting = vi.fn();
const getEffectiveRouting = vi.fn();
const saveAiRouting = vi.fn();
const getAiFeatures = vi.fn();
const setEnabled = vi.fn();
const fetchModelCatalog = vi.fn();
const setModelHidden = vi.fn();
const refreshModelCatalog = vi.fn();
const removeMcpServer = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/aiEngine', () => ({
  aiEngine: {
    getAiRouting: (...a) => getAiRouting(...a),
    getEffectiveRouting: (...a) => getEffectiveRouting(...a),
    saveAiRouting: (...a) => saveAiRouting(...a),
    getAiFeatures: (...a) => getAiFeatures(...a),
    setEnabled: (...a) => setEnabled(...a),
    fetchModelCatalog: (...a) => fetchModelCatalog(...a),
    setModelHidden: (...a) => setModelHidden(...a),
    refreshModelCatalog: (...a) => refreshModelCatalog(...a),
    removeMcpServer: (...a) => removeMcpServer(...a),
    testAiTask: vi.fn(),
    testProvider: vi.fn(),
  },
  seedAiEngineIfEmpty: (...a) => seedAiEngineIfEmpty(...a),
  subscribeProviders: (...a) => subscribeProviders(...a),
  subscribeMcpServers: (...a) => subscribeMcpServers(...a),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const { default: AIEnginePage } = await import('./AIEnginePage.jsx');

// Stored documents from before #857 still carry a `models` array and a
// `defaultModel` pin; the page ignores both once the catalogue has answered.
const PROVIDERS = [
  {
    id: 'gemini',
    name: 'Gemini',
    enabled: true,
    order: 1,
    models: ['typed-into-the-seed'],
    defaultModel: null,
    status: 'connected',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    enabled: true,
    order: 2,
    models: ['gpt-5-mini'],
    defaultModel: 'gpt-5-mini',
    status: 'untested',
  },
];

const model = (id, over = {}) => ({
  id,
  status: 'live',
  hidden: false,
  unpriced: false,
  capabilities: ['text'],
  ...over,
});

/** The catalogue as the API answers it (ADR 0034 slice 2, #857). */
const CATALOG = {
  id: 'ai-model-catalog',
  providers: {
    gemini: {
      refresh: { lastOk: null, lastAttempt: null, lastError: null },
      stale: true,
      seeded: true,
      models: { 'gemini-3.6-flash': model('gemini-3.6-flash', { status: 'unknown' }) },
    },
    openai: {
      refresh: {
        lastOk: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        lastAttempt: null,
        lastError: null,
      },
      stale: false,
      models: {
        'gpt-5-mini': model('gpt-5-mini'),
        'gpt-5-nano': model('gpt-5-nano', { hidden: true }),
        'gpt-4o': model('gpt-4o', { status: 'retired' }),
        'o3-mini': model('o3-mini', { unpriced: true }),
        'gpt-4o-mini-tts': model('gpt-4o-mini-tts', { capabilities: [] }),
      },
    },
  },
};

/** The selection document and the resolver's answer (ADR 0034 §2, §4). */
const SELECTION = {
  version: 2,
  global: {
    priority: [
      { provider: 'gemini', model: null },
      { provider: 'openai', model: 'gpt-5-mini' },
    ],
  },
  tasks: {},
  updatedAt: 'r1',
};
const EFFECTIVE = {
  tasks: {
    forgeDrafting: {
      label: 'Forge drafting',
      description: 'Writes the draft.',
      modality: 'text',
      needs: ['text'],
      public: false,
      recommended: null,
      entry: { mode: 'global' },
      mode: 'global',
      chain: [{ provider: 'gemini', model: null, modalityModel: 'gemini-3.5-flash-lite' }],
      rejected: [],
      flags: [],
    },
  },
  priority: [
    {
      provider: 'gemini',
      model: null,
      keyed: true,
      enabled: true,
      defaults: {
        draft: 'gemini-3.5-flash-lite',
        general: 'gemini-3.5-flash-lite',
        multimodal: 'gemini-3.6-flash',
      },
      modality: { text: 'gemini-3.5-flash-lite', vision: 'gemini-3.6-flash' },
    },
    {
      provider: 'openai',
      model: 'gpt-5-mini',
      keyed: true,
      enabled: true,
      defaults: { draft: 'gpt-5-mini', general: 'gpt-5-nano', multimodal: 'gpt-5-mini' },
      modality: { text: 'gpt-5-nano', vision: 'gpt-5-mini' },
    },
  ],
  availability: { keyed: ['gemini', 'openai'], enabled: ['gemini', 'openai'], disabled: [] },
  updatedAt: 'r1',
};

/** A catalogue read the test settles by hand, so two can be made to cross. */
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Fail the first catalogue read, then press Try again twice, so two reads
 * are in flight for the test to settle in whichever order it chooses.
 */
async function twoRetriesInFlight() {
  const earlier = deferred();
  const later = deferred();
  fetchModelCatalog
    .mockRejectedValueOnce(new Error('503'))
    .mockImplementationOnce(() => earlier.promise)
    .mockImplementationOnce(() => later.promise);
  renderPage();
  const notice = (await screen.findByText('The model catalogue could not be loaded.')).closest(
    '[role="alert"]'
  );
  const retry = within(notice).getByRole('button', { name: 'Try again' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalledTimes(3));
  return { earlier, later };
}

/** The values the Priority row's model select offers for a provider. */
const modelOptions = (name) =>
  [...screen.getByLabelText(`Model for ${name}`).options].map((o) => o.value);

/** Mount the page under a real router, on the AI Engine route or one of its tabs. */
function renderPage(entry = '/admin/ai-engine') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/admin/ai-engine" element={<AIEnginePage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  seedAiEngineIfEmpty.mockReset().mockResolvedValue(undefined);
  subscribeProviders.mockReset().mockImplementation((cb) => {
    cb(PROVIDERS);
    return () => {};
  });
  subscribeMcpServers.mockReset().mockImplementation((cb) => {
    cb([]);
    return () => {};
  });
  getAiRouting.mockReset().mockResolvedValue({
    selection: SELECTION,
    migrated: false,
    catalogue: { forgeDrafting: { label: 'Forge drafting', description: 'd', route: 'r' } },
    providers: ['gemini', 'openai'],
    updatedAt: 'r1',
  });
  getEffectiveRouting.mockReset().mockResolvedValue(EFFECTIVE);
  saveAiRouting.mockReset().mockResolvedValue({ selection: SELECTION, updatedAt: 'r1' });
  getAiFeatures.mockReset().mockResolvedValue({ features: {}, catalogue: {} });
  fetchModelCatalog.mockReset().mockResolvedValue(CATALOG);
  setModelHidden.mockReset().mockResolvedValue({ id: 'gpt-5-mini', hidden: true });
  refreshModelCatalog.mockReset().mockResolvedValue({
    updatedAt: new Date().toISOString(),
    providers: {
      gemini: { listed: 4, added: 1, retired: 0, error: null },
      openai: { listed: 0, added: 0, retired: 0, error: 'HTTP 401: Incorrect API key' },
    },
  });
  toast.mockReset();
});

describe('AIEnginePage shell', () => {
  it('shows the five tabs with Tasks where Site Services was, and no Site Services or Routing at all', async () => {
    renderPage();
    expect(await screen.findByRole('tab', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'AI Services',
      'Tasks',
      'MCP Servers',
      'Playground',
      'Usage & Cost',
    ]);
    expect(screen.queryByText(/Site Services/)).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Routing' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: /AI Engine/ })).toBeInTheDocument();
  });

  it('the old Site Services address lands on Tasks, which reads the resolver’s answer', async () => {
    renderPage('/admin/ai-engine?tab=siteservices');
    expect(await screen.findByRole('tab', { selected: true })).toHaveTextContent('Tasks');
    expect(await screen.findByText('Forge drafting')).toBeInTheDocument();
    expect(getEffectiveRouting).toHaveBeenCalled();
    expect(screen.getByTestId('effective-forgeDrafting')).toHaveTextContent(
      'Provider default (gemini-3.5-flash-lite) via Gemini'
    );
  });

  it('a failed seed is said, with a retry that seeds again', async () => {
    seedAiEngineIfEmpty
      .mockRejectedValueOnce(new Error('403 from the API'))
      .mockResolvedValueOnce(undefined);
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('403 from the API');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(seedAiEngineIfEmpty).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Priority')).toBeInTheDocument();
  });

  it('the Priority list reads the document: P1 on the provider default, P2 on its named model, no card pin', async () => {
    renderPage();
    const gemini = await screen.findByLabelText('Model for Gemini');
    expect(gemini.value).toBe('__default__');
    expect(screen.getByLabelText('Model for OpenAI').value).toBe('gpt-5-mini');
    expect(screen.getByText('P1 — default')).toBeInTheDocument();
    expect(screen.getByTestId('priority-will-use-openai')).toHaveTextContent(
      'Will use gpt-5-mini for every task.'
    );
    // The one model control per provider is the Priority row's; the cards
    // carry no pin any more.
    expect(gemini.closest('[data-provider="gemini"]')).not.toBeNull();
    expect(screen.getAllByRole('combobox', { name: /^Model for/ })).toHaveLength(2);
    expect(screen.queryByText('Auto (per task)')).toBeNull();
  });

  it('moving a row saves the whole document with the updatedAt it read', async () => {
    renderPage();
    const down = await screen.findByRole('button', { name: 'Move Gemini down' });
    fireEvent.click(down);
    await waitFor(() => expect(saveAiRouting).toHaveBeenCalledTimes(1));
    expect(saveAiRouting.mock.calls[0][0]).toMatchObject({
      global: {
        priority: [
          { provider: 'openai', model: 'gpt-5-mini' },
          { provider: 'gemini', model: null },
        ],
      },
      updatedAt: 'r1',
    });
    // The resolver's answer is read again after the save.
    await waitFor(() => expect(getEffectiveRouting).toHaveBeenCalledTimes(2));
  });

  it('the cards list the catalogue’s models, not the stored array', async () => {
    renderPage();
    const disclosure = await screen.findByRole('button', { name: 'Models for Gemini' });
    await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalled());
    fireEvent.click(disclosure);
    // Once in the disclosure, once as an option on the Priority row's select.
    expect(screen.getAllByText('gemini-3.6-flash')).toHaveLength(2);
    expect(screen.queryByText('typed-into-the-seed')).toBeNull();
  });

  it('the Models disclosure shows every model with its badges, says when the list was refreshed, and hides on click', async () => {
    renderPage();
    const disclosure = await screen.findByRole('button', { name: 'Models for OpenAI' });
    expect(disclosure).toHaveTextContent('Models (5)');
    expect(disclosure).toHaveTextContent('List refreshed 2d ago');
    expect(screen.getByRole('button', { name: 'Models for Gemini' })).toHaveTextContent(
      'List not refreshed yet'
    );
    fireEvent.click(disclosure);
    expect(screen.getByText('retired')).toBeInTheDocument();
    expect(screen.getByText('unpriced')).toBeInTheDocument();
    expect(screen.getByText('hidden')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide gpt-5-mini for OpenAI' }));
    await waitFor(() => expect(setModelHidden).toHaveBeenCalledWith('openai', 'gpt-5-mini', true));
    // Re-read after the write, so the cards show what the API holds.
    await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Show gpt-5-nano for OpenAI' })).toBeInTheDocument();
  });

  it('Refresh model lists runs the refresh, says what happened, and re-reads the catalogue', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: /Refresh model lists/ });
    await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(refreshModelCatalog).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Model lists refreshed, with errors',
          description:
            '1 provider listed · 1 new · 0 retired · failed: openai (HTTP 401: Incorrect API key)',
          variant: 'destructive',
        })
      )
    );
    await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalledTimes(2));
  });

  it('the Model catalogue drawer opens from AI Services with every model, its price, and Hide', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Model catalogue' }));
    expect(await screen.findByRole('dialog', { name: 'Model catalogue' })).toBeInTheDocument();
    const table = screen.getByRole('region', { name: 'Models for OpenAI' });
    expect(table).toHaveTextContent('gpt-4o');
    expect(table).toHaveTextContent('unpriced');
    expect(screen.getByRole('button', { name: 'Hide gpt-5-mini for OpenAI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh now/ })).toBeInTheDocument();
  });

  it('a catalogue that cannot be read leaves the cards on their stored lists, with no model list to show, and says so', async () => {
    fetchModelCatalog.mockRejectedValueOnce(new Error('503'));
    const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    // The Priority list still renders from the document; its dropdown offers
    // only the provider default because the catalogue has no list.
    const gemini = await screen.findByLabelText('Model for Gemini');
    expect([...gemini.options].map((o) => o.value)).toEqual(['__default__']);
    await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Models for Gemini' })).toBeNull();

    // The failure is shown, with what still works, and Try again re-reads
    // (AP-F12, #936): the next read succeeds and the notice goes.
    const notice = (await screen.findByText('The model catalogue could not be loaded.')).closest(
      '[role="alert"]'
    );
    expect(notice).toHaveTextContent('503');
    expect(notice).toHaveTextContent(/every tab still works/);
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchModelCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText('The model catalogue could not be loaded.')).toBeNull()
    );
    expect(await screen.findByRole('button', { name: 'Models for Gemini' })).toBeInTheDocument();
    silenced.mockRestore();
  });

  it('an earlier read failing after a later one succeeded does not bring the notice back (AP-F12, #936)', async () => {
    const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { earlier, later } = await twoRetriesInFlight();

    // The later read answers first: the notice goes and the lists arrive.
    await act(async () => later.resolve(CATALOG));
    expect(screen.queryByText('The model catalogue could not be loaded.')).toBeNull();
    expect(modelOptions('Gemini')).toContain('gemini-3.6-flash');

    // The earlier read fails after it. It is logged, and nothing on the page
    // moves: the page stays on the later read's answer.
    await act(async () => earlier.reject(new Error('timed out')));
    expect(silenced).toHaveBeenCalledWith(
      '[aiEngine] model catalogue load failed:',
      expect.objectContaining({ message: 'timed out' })
    );
    expect(screen.queryByText('The model catalogue could not be loaded.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Models for Gemini' })).toBeInTheDocument();
    expect(modelOptions('Gemini')).toContain('gemini-3.6-flash');
    silenced.mockRestore();
  });

  it('an older catalogue landing after a newer one does not replace it (AP-F12, #936)', async () => {
    const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { earlier, later } = await twoRetriesInFlight();
    const older = {
      ...CATALOG,
      providers: {
        ...CATALOG.providers,
        gemini: { ...CATALOG.providers.gemini, models: { 'gemini-old': model('gemini-old') } },
      },
    };

    await act(async () => later.resolve(CATALOG));
    await act(async () => earlier.resolve(older));
    expect(modelOptions('Gemini')).toContain('gemini-3.6-flash');
    expect(modelOptions('Gemini')).not.toContain('gemini-old');
    silenced.mockRestore();
  });

  it('removing a custom MCP server asks in the modal, held busy while the request runs (AP-F12, #936)', async () => {
    subscribeMcpServers.mockImplementation((cb) => {
      cb([
        {
          id: 'my-mcp',
          name: 'My MCP',
          url: 'https://mcp.example.test/mcp',
          enabled: true,
          status: 'connected',
          authType: 'none',
          tools: [],
        },
      ]);
      return () => {};
    });
    let settle;
    removeMcpServer.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    renderPage('/admin/ai-engine?tab=mcp');
    fireEvent.click(await screen.findByTitle('Remove server'));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this MCP server?' });
    expect(dialog).toHaveTextContent('My MCP and its tool list leave the configuration');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(removeMcpServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Remove server'));
    const again = await screen.findByRole('dialog', { name: 'Remove this MCP server?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Remove' }));
    expect(removeMcpServer).toHaveBeenCalledWith('my-mcp');
    expect(await within(again).findByRole('button', { name: 'Removing…' })).toBeDisabled();
    settle(undefined);
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Server removed' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the catalogue notice is dismissible, and the page is otherwise whole', async () => {
    fetchModelCatalog.mockRejectedValue(new Error('offline'));
    const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    const notice = (await screen.findByText('The model catalogue could not be loaded.')).closest(
      '[role="alert"]'
    );
    expect(screen.getByRole('tab', { name: 'Tasks' })).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(screen.queryByText('The model catalogue could not be loaded.')).toBeNull()
    );
    expect(screen.getByLabelText('Model for Gemini')).toBeInTheDocument();
    silenced.mockRestore();
  });

  it('a rejected provider toggle is reported instead of left as an unhandled promise', async () => {
    setEnabled.mockRejectedValueOnce(new Error('nope'));
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Enable Gemini' });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Could not change the provider' })
      )
    );
  });
});
