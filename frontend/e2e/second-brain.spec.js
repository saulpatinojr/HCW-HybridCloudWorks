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
test.beforeEach(async ({ identity }) => {
  identity.answerApi('cms/calendar-alerts', { alerts: [], today: '2026-10-26' });
});
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

test('map supports exploration, dragging, zoom and relationship filtering', async ({
  page,
  identity,
}, testInfo) => {
  const topics = ['Docker delivery', 'Azure architecture', 'Creator workflow'];
  const nodes = Array.from({ length: 27 }, (_, index) => ({
    ...note,
    id: `map-${index}`,
    title: index < 3 ? topics[index] : `${topics[index % 3]} · Research ${index}`,
    type: index < 3 ? 'topic' : index < 6 ? 'note' : 'reference',
    tags: [topics[index % 3].split(' ')[0].toLowerCase()],
  }));
  const edges = nodes.slice(3).map((node, index) => ({
    from: node.id,
    to: nodes[index % 3].id,
    kind: index % 4 === 0 ? 'suggested' : 'membership',
  }));
  identity.answerApi('cms/brain/status', {
    enabled: true,
    aiEnabled: false,
    indexing: { status: 'complete' },
  });
  identity.answerApi('cms/brain/items', { items: [], after: null });
  identity.answerApi('cms/brain/graph', { nodes, edges, cursor: null });
  await identity.signIn('/admin/second-brain');
  const main = page.locator('#admin-main');
  await main.getByRole('button', { name: 'Map', exact: true }).click();
  await main.getByRole('button', { name: 'Pause layout' }).click();
  const node = main.getByRole('button', { name: 'Explore Docker delivery', exact: true });
  await node.click();
  await expect(main.getByRole('heading', { name: 'Docker delivery', exact: true })).toBeVisible();
  const before = await node.getAttribute('transform');
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 35, { steps: 8 });
  await page.mouse.up();
  await expect(node).not.toHaveAttribute('transform', before);
  const viewport = main.locator('.react-transform-component');
  const initial = await viewport.getAttribute('style');
  await main.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(viewport).not.toHaveAttribute('style', initial);
  await main.getByRole('button', { name: 'Reset map view' }).click();
  await main.getByLabel('Suggested links', { exact: true }).uncheck();
  await main.getByLabel('Selected neighborhood').check();
  await expect(
    main.getByRole('button', { name: 'Explore Azure architecture', exact: true })
  ).toHaveCount(0);
  await main.getByLabel('Selected neighborhood').uncheck();
  await main.getByRole('button', { name: 'Clear selected node' }).click();
  await main
    .getByRole('group', { name: 'Interactive knowledge graph' })
    .screenshot({ path: testInfo.outputPath('interactive-map.png') });
});

test('map appearance, two-line headings, double expansion and full-screen close work', async ({
  page,
  identity,
}, testInfo) => {
  const sample = {
    ...note,
    id: 'appearance-note',
    title: 'A long synthetic idea about testing a safe infrastructure restore',
    properties: { heading: 'State Recovery Practice' },
  };
  identity.answerApi('cms/brain/status', {
    enabled: true,
    aiEnabled: false,
    indexing: { status: 'complete' },
  });
  identity.answerApi('cms/brain/items', { items: [sample], after: null });
  identity.answerApi('cms/brain/graph', { nodes: [sample], edges: [], cursor: null });
  await identity.signIn('/admin/second-brain');
  await page.locator('#admin-main').getByRole('button', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Pause layout' }).click();
  const canvas = page.getByRole('region', { name: 'Knowledge canvas' });
  const graph = page.getByRole('group', { name: 'Interactive knowledge graph' });
  const node = graph.getByRole('button', { name: `Explore ${sample.title}` });
  await node.click();
  await expect(node.locator('text tspan')).toHaveCount(2);
  await expect(node.locator('text')).toHaveText('State RecoveryPractice');
  const before = await node.locator('text').boundingBox();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect
    .poll(async () => {
      const value = await canvas.locator('.react-transform-component').getAttribute('style');
      return Number(value.match(/scale\(([^)]+)\)/)?.[1] || 1);
    })
    .toBeGreaterThan(1.1);
  await expect
    .poll(async () => Math.abs((await node.locator('text').boundingBox()).height - before.height))
    .toBeLessThan(2);
  const compact = await canvas.boundingBox();
  await page.getByRole('button', { name: 'Expand canvas', exact: true }).click();
  await expect
    .poll(async () => (await canvas.boundingBox()).height)
    .toBeCloseTo(compact.height * 2, 0);
  await page.getByRole('button', { name: 'Compact canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Knowledge map' });
  await expect(dialog).toBeVisible();
  const screen = page.viewportSize();
  await expect
    .poll(async () => (await dialog.boundingBox()).width)
    .toBeGreaterThan(screen.width - 32);
  await dialog.getByText('Appearance', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Warm', exact: true }).click();
  const size = dialog.getByLabel('Map label size');
  await size.focus();
  await size.press('Home');
  await size.press('ArrowRight');
  await expect(size).toHaveValue('10');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Knowledge map' });
  await dialog.getByText('Appearance', { exact: true }).click();
  await expect(dialog.getByLabel('Map label size')).toHaveValue('10');
  await dialog.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await dialog.getByText('Appearance', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await dialog.screenshot({ path: testInfo.outputPath('map-full-screen.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
