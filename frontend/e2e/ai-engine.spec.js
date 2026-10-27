import { test, expect } from './fixtures/entra.js';

const speechModel = 'gemini-3.8-flash-lite-tts';
const selection = {
  version: 2,
  global: { priority: [{ provider: 'gemini', model: null }] },
  tasks: {},
  updatedAt: 'r1',
};
const speech = {
  label: 'Listen & Learn speech',
  description: 'Reads a study episode aloud.',
  modality: 'tts',
  needs: ['tts'],
  media: true,
  only: ['gemini'],
  recommended: {
    provider: 'gemini',
    model: speechModel,
    reason: 'A voice for study episodes.',
    asOf: '2026-10-27',
  },
  entry: { mode: 'global' },
  mode: 'global',
  chain: [],
  rejected: [
    {
      provider: 'gemini',
      code: 'no-key',
      why: 'Gemini has no configured key. Configure its key before generating speech.',
    },
  ],
  flags: [],
};

test('routing explains unavailable and planned tasks and fits the viewport', async ({
  page,
  identity,
}, testInfo) => {
  identity.answerApi('cms/config/ai-providers', {
    items: [{ id: 'gemini', name: 'Gemini', enabled: true, schemaVersion: 2 }],
  });
  identity.answerApi('cms/ai-routing', { selection, providers: ['gemini'] });
  identity.answerApi('cms/ai-model-catalog', {
    catalog: {
      providers: {
        gemini: {
          models: {
            [speechModel]: {
              id: speechModel,
              status: 'live',
              capabilities: ['tts'],
              unpriced: true,
            },
          },
        },
      },
    },
  });
  identity.answerApi('cms/ai-routing/effective', {
    tasks: {
      listenAndLearnSpeech: speech,
      embeddings: {
        label: 'Embeddings',
        description: 'Turns text into vectors.',
        modality: 'embedding',
        planned: true,
      },
    },
    availability: { media: [], capabilities: { gemini: ['tts'] } },
  });
  await identity.signIn('/admin/ai-engine');
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  const active = page.locator('[data-task="listenAndLearnSpeech"]');
  await expect(active.getByTestId('effective-listenAndLearnSpeech')).toHaveText(
    'No eligible model'
  );
  await active.getByText('Routing details').click();
  await expect(active.getByText(/Configure its key/).last()).toBeVisible();
  await active.getByLabel('Custom', { exact: false }).check();
  await active.getByRole('button', { name: 'Add step' }).click();
  await active.locator('select[id$="-model"]').selectOption(speechModel);
  await expect(active.locator('select[id$="-model"]')).toHaveValue(speechModel);
  const planned = page.locator('[data-task="embeddings"]');
  await expect(planned.getByText('Not connected yet')).toBeVisible();
  await expect(planned.getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: testInfo.outputPath('routing.png'), fullPage: true });
});

test('usage separates missing costs from free calls and keeps tiny prices visible', async ({
  page,
  identity,
}) => {
  identity.answerApi('cms/ai-usage', {
    items: [
      { id: 'unknown', provider: 'gemini', model: speechModel, totalTokens: 100 },
      {
        id: 'tiny',
        provider: 'openai',
        model: 'gpt-5-nano',
        totalTokens: 1,
        estimatedCostUsd: 0.00000005,
      },
      { id: 'free', provider: 'nvidia', model: 'trial', totalTokens: 1, estimatedCostUsd: 0 },
    ],
  });
  await identity.signIn('/admin/ai-engine');
  await page.getByRole('tab', { name: 'Usage & Cost', exact: true }).click();
  await expect(
    page.getByText('1 call with unknown cost excluded; subtotal is incomplete')
  ).toBeVisible();
  await expect(page.getByText('unpriced', { exact: true })).toBeVisible();
  await expect(page.getByText('$0.00000005', { exact: true }).first()).toBeVisible();
});
