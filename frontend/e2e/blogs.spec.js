import { test, expect } from './fixtures/entra.js';

test.beforeEach(async ({ identity }) => {
  identity.answerApi('cms/calendar-alerts', { today: '2026-10-27', alerts: [] });
});

const source = {
  id: 'blog-source-kiro',
  name: 'Kiro Blog',
  provider: 'aws',
  kind: 'rss',
  url: 'https://kiro.dev/blog/feed.rss',
  official: true,
  builtIn: true,
  enabled: true,
  maxItems: 10,
  fallbackImageUrl: '',
  _etag: 'v1',
  lastRun: { status: 'succeeded', fetchedAt: '2026-10-27T10:00:00Z' },
};

test('Blogs exposes source settings, gallery defaults and manual intake within the viewport', async ({
  page,
  identity,
}, testInfo) => {
  identity.answerApi('cms/blog-sources', { sources: [source] });
  identity.answerApi('cms/blog-sources/blog-source-kiro', {
    source: { ...source, enabled: false },
  });
  identity.answerApi('cms/images', {
    items: [
      {
        id: 'hero',
        title: 'AWS default',
        imageUrl: '/api/public/media/covers/default.png',
        source: 'upload',
      },
    ],
  });
  await page.route('**/api/public/media/covers/default.png', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#24496b"/></svg>',
    })
  );
  identity.answerApi('enqueueJob', { ok: true, jobId: 'sync1' });
  identity.answerApi('getJob', {
    ok: true,
    job: { id: 'sync1', status: 'succeeded', result: { newContent: 2, errors: [] } },
  });
  await identity.signIn('/admin/blogs');
  await expect(page.getByRole('heading', { name: 'Blogs', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Blog sources', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kiro Blog', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 new articles' })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Edit source', exact: true }).click();
  await expect(page.getByLabel('RSS feed URL')).toHaveValue(source.url);
  await page.getByLabel('Source name').fill('Kiro engineering');
  await page.getByLabel('Enabled for intake').uncheck();
  await page.getByRole('button', { name: 'Choose default image' }).click();
  await page.getByRole('button', { name: 'Add Image', exact: true }).click();
  await expect(page.getByLabel('Fallback image URL')).toHaveValue(
    '/api/public/media/covers/default.png'
  );
  await expect(page.getByRole('button', { name: 'Choose default image' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: testInfo.outputPath('blog-source-editor.png'), fullPage: true });
  const saved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && request.url().includes('/cms/blog-sources/blog-source-kiro')
  );
  await page.getByRole('button', { name: 'Save source', exact: true }).click();
  expect((await saved).postDataJSON()).toMatchObject({
    name: 'Kiro engineering',
    enabled: false,
    fallbackImageUrl: '/api/public/media/covers/default.png',
    _etag: 'v1',
  });
  await expect(page.getByRole('status').filter({ hasText: 'Source saved' })).toBeVisible();
  await page.getByLabel('Search sources').fill('no match');
  await expect(page.getByText('No sources match these filters.')).toBeVisible();
});

test('blog article links use the established review and editor workflow', async ({
  page,
  identity,
}) => {
  identity.answerApi('cms/content', {
    items: [
      {
        id: 'article1',
        Title: 'Kiro release',
        contentStatus: 'ingested',
        type: 'blog',
        'Cloud Provider': 'Aws',
      },
    ],
  });
  await identity.signIn('/admin/blogs');
  await expect(page.getByRole('link', { name: 'Review article' })).toHaveAttribute(
    'href',
    '/admin/review-queue/article1?source=content'
  );
  await expect(page.getByRole('link', { name: 'Edit article' })).toHaveAttribute(
    'href',
    '/admin/editor/article1'
  );
  await page.getByLabel('Search article titles and summaries').fill('older Kiro article');
  const searched = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('search') === 'older Kiro article'
  );
  await page.getByRole('button', { name: 'Search articles', exact: true }).click();
  expect(new URL((await searched).url()).searchParams.get('type')).toBe('blog');
  await page.getByRole('button', { name: 'Publishing workflow', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'From source to published article' })
  ).toBeVisible();
});
