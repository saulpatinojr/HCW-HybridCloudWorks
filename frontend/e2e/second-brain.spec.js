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

// The reviewed note-to-draft handoff (#1408). Everything the browser sends is
// asserted on, and every answer is a made-up fixture: the assistant's answer
// never comes from a model here, so what this proves is the plumbing around
// it (which idea the request names, how citations and missing evidence are
// shown, what the editor and the draft route receive), not answer quality.
const idea = {
  ...note,
  id: 'idea-rollback-plan',
  title: 'Rollback plan for a state restore',
  body: 'Synthetic idea: when a restore goes wrong, roll back in a fixed order.',
  tags: ['terraform', 'recovery'],
  version: 3,
};
const sourceA = {
  ...note,
  id: 'source-state-locks',
  title: 'State locks research',
  body: 'Synthetic source A: locks are released before the restore begins.',
  version: 2,
};
const sourceB = {
  ...note,
  id: 'source-backup-order',
  title: 'Backup order research',
  body: 'Synthetic source B: back up the newest state file first.',
  version: 2,
};
const outlineAnswer = {
  insufficientEvidence: false,
  partialRetrieval: false,
  needsContext: false,
  claims: [
    { text: 'Release the locks before restoring.', sourceIds: ['S1'] },
    { text: 'Back up the newest state file first.', sourceIds: ['S2'] },
  ],
  suggestions: [
    {
      text: 'Missing evidence: no indexed note covers how long a rollback takes.',
      sourceIds: [],
    },
  ],
  sources: [sourceA, sourceB].map((source, index) => ({
    id: source.id,
    citation: `S${index + 1}`,
    title: source.title,
    href: `/admin/second-brain?item=${encodeURIComponent(source.id)}`,
  })),
  usage: [],
  indexing: { status: 'complete' },
};
const question = 'Outline the next article on rolling back a restore';

test('an outline for the selected idea cites its sources, becomes a reviewed note and one draft', async ({
  page,
  identity,
}, testInfo) => {
  identity.answerApi('cms/brain/status', {
    enabled: true,
    aiEnabled: true,
    indexing: { status: 'complete', count: 3 },
  });
  identity.answerApi('cms/brain/items', { items: [idea, sourceA, sourceB], after: null });
  for (const item of [idea, sourceA, sourceB])
    identity.answerApi(`cms/brain/items/${item.id}`, { item, backlinks: [] });
  identity.answerApi('cms/brain/ask', outlineAnswer);
  const draftCalls = [];
  page.on('request', (request) => {
    if (/\/api\/cms\/brain\/draft\//.test(request.url()) && request.method() === 'POST')
      draftCalls.push({ url: request.url(), body: request.postDataJSON() });
  });
  await identity.signIn('/admin/second-brain');
  const main = page.locator('#admin-main');

  // (1) With the idea selected, the outline request names that idea and no other.
  await main.getByRole('button', { name: idea.title }).click();
  await expect(main.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(idea.body);
  await main.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(main.getByText(`Starting with: ${idea.title}`)).toBeVisible();
  await main.getByLabel('Action').selectOption('outline');
  await main.getByLabel('Your question').fill(question);
  const asked = page.waitForRequest(
    (r) => r.url().endsWith('/api/cms/brain/ask') && r.method() === 'POST'
  );
  await main.getByRole('button', { name: 'Ask my brain' }).click();
  expect((await asked).postDataJSON()).toEqual({ question, mode: 'outline', contextId: idea.id });

  // (2) Two citations, each a link to its own protected source, and the
  // missing-evidence item shown as a suggestion, not as a sourced claim.
  await expect(main.getByText('Release the locks before restoring.')).toBeVisible();
  await expect(main.getByText('Missing evidence: no indexed note covers')).toBeVisible();
  const citationA = main.getByRole('link', { name: `S1: ${sourceA.title}`, exact: true });
  const citationB = main.getByRole('link', { name: `S2: ${sourceB.title}`, exact: true });
  await expect(citationA).toHaveAttribute('href', `/admin/second-brain?item=${sourceA.id}`);
  await expect(citationB).toHaveAttribute('href', `/admin/second-brain?item=${sourceB.id}`);
  await citationA.click();
  await expect(main.getByRole('textbox', { name: 'Markdown', exact: true })).toHaveValue(
    sourceA.body
  );
  await expect(page).toHaveURL(/item=source-state-locks$/);

  // (3) "Review as a new note" fills the editor with the outline, and saving
  // sends that body with the two sources as the note's links.
  await main.getByRole('button', { name: 'Review as a new note' }).click();
  const editor = main.getByRole('textbox', { name: 'Markdown', exact: true });
  const outline = await editor.inputValue();
  expect(outline).toContain('## Source-backed answer');
  expect(outline).toContain('Release the locks before restoring. (S1)');
  expect(outline).toContain('Missing evidence: no indexed note covers');
  expect(outline).toContain(`[S1: ${sourceA.title}](/admin/second-brain?item=${sourceA.id})`);
  await expect(main.getByText('note · Version 0', { exact: true })).toBeVisible();
  // The same route answers the save (POST) and the list refresh (GET) that
  // follows it; the saved item is the one the browser sent, one version up.
  identity.answerApi('cms/brain/items', (request) =>
    request.method() === 'POST'
      ? { item: { ...request.postDataJSON().item, version: 1 } }
      : { items: [idea, sourceA, sourceB], after: null }
  );
  const saved = page.waitForRequest(
    (r) => r.url().endsWith('/api/cms/brain/items') && r.method() === 'POST'
  );
  await main.getByRole('button', { name: 'Save note', exact: true }).click();
  const saveBody = (await saved).postDataJSON();
  expect(saveBody.version).toBe(0);
  expect(saveBody.item.title).toBe(question);
  expect(saveBody.item.body).toBe(outline);
  expect(saveBody.item.links).toEqual([sourceA.id, sourceB.id]);
  const noteId = saveBody.item.id;
  await expect(main.getByText('note · Version 1', { exact: true })).toBeVisible();

  // (4) "Create draft" sends the reviewed title and text to the draft route
  // of that note (whose saved links are the provenance the API records). A
  // failed attempt and its retry carry the same requestId, so the API can
  // return the one draft instead of making a second; after success the
  // button is disabled, so a second click cannot send anything.
  await main.getByText('Create an article draft from this note').click();
  await expect(main.getByLabel('Draft title')).toHaveValue(question);
  await expect(main.getByLabel('Draft text')).toHaveValue(outline);
  const draftRoute = `cms/brain/draft/${noteId}`;
  identity.answerApi(draftRoute, { ok: false, error: 'Draft store unavailable.' }, { status: 500 });
  const createDraft = main.getByRole('button', { name: 'Create draft', exact: true });
  await createDraft.click();
  await expect(main.locator('details').getByRole('alert')).toContainText(
    'Draft store unavailable.'
  );
  identity.answerApi(draftRoute, { id: 'brain_fixture_draft', href: '/admin/drafts' });
  await createDraft.click();
  await expect(main.getByRole('link', { name: 'Open Drafts', exact: true })).toHaveAttribute(
    'href',
    '/admin/drafts'
  );
  await expect(createDraft).toBeDisabled();
  expect(draftCalls).toHaveLength(2);
  expect(draftCalls[0].url).toMatch(new RegExp(`/api/cms/brain/draft/${noteId}$`));
  expect(draftCalls[0].body.fields).toEqual({
    title: question,
    body: outline,
    tags: [],
    kind: 'article',
    ideaOrigin: 'manual',
  });
  expect(draftCalls[0].body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(draftCalls[1].body.requestId).toBe(draftCalls[0].body.requestId);
  expect(draftCalls[1].body).toEqual(draftCalls[0].body);
  await page.screenshot({ path: testInfo.outputPath('outline-to-draft.png'), fullPage: true });
});
