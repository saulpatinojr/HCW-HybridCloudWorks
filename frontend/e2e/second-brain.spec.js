import { test, expect } from './fixtures/entra.js';

const note = {
  id: 'sample-note',
  type: 'note',
  title: 'Terraform state research',
  body: 'A synthetic research note for the browser test.',
  tags: ['terraform'],
  links: [],
  collections: [],
  urls: [],
  version: 1,
  seq: 1,
  archived: false,
  inbox: true,
};
test('owner captures a note and explores its map inside the real admin shell', async ({
  page,
  identity,
}, testInfo) => {
  identity.answerApi('cms/brain/status', {
    enabled: true,
    aiEnabled: false,
    indexing: { status: 'complete', count: 1 },
  });
  identity.answerApi('cms/brain/items', { items: [note], after: null });
  identity.answerApi(`cms/brain/items/${note.id}`, { item: note, backlinks: [] });
  identity.answerApi('cms/brain/graph', { nodes: [note], edges: [], cursor: null });
  await identity.signIn('/admin/second-brain');
  const main = page.locator('#admin-main');
  await expect(main.getByRole('heading', { level: 1, name: 'Second Brain' })).toBeVisible();
  await main.getByRole('button', { name: 'Capture an idea' }).click();
  await main.getByLabel('Title', { exact: true }).fill('A new synthetic idea');
  await main
    .getByRole('textbox', { name: 'Markdown', exact: true })
    .fill('Private research stays behind the owner API.');
  identity.answerApi('cms/brain/items', {
    item: {
      ...note,
      title: 'A new synthetic idea',
      body: 'Private research stays behind the owner API.',
      version: 2,
    },
    items: [note],
    after: null,
  });
  const saved = page.waitForRequest(
    (r) => r.url().endsWith('/api/cms/brain/items') && r.method() === 'POST'
  );
  await main.getByRole('button', { name: 'Save note', exact: true }).click();
  const request = await saved;
  expect(request.postDataJSON().item.body).toBe('Private research stays behind the owner API.');
  expect(request.postDataJSON().version).toBe(0);
  await expect(main.getByText('note · Version 2')).toBeVisible();
  await main.getByRole('button', { name: 'Close', exact: true }).click();
  await main.getByRole('button', { name: 'Map', exact: true }).click();
  await main.getByRole('button', { name: `Open ${note.title}`, exact: true }).click();
  await expect(main.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(note.body);
  await expect(main.getByRole('textbox', { name: 'Markdown', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('second-brain.png'), fullPage: true });
});

test('an admin without the owner capability sees no private workspace or note requests', async ({
  page,
  identity,
}) => {
  const privateReads = [];
  page.on('request', (request) => {
    if (/\/api\/cms\/brain\/(items|search|graph)/.test(request.url()))
      privateReads.push(request.url());
  });
  identity.answerApi('cms/brain/status', { enabled: false });
  await identity.signIn('/admin/second-brain');
  await expect(page.getByText(/unavailable for this account/)).toBeVisible();
  expect(privateReads).toEqual([]);
});
