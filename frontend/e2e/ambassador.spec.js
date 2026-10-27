import { test, expect } from './fixtures/entra.js';
import { DEFAULT_PROGRAMS } from '../../functions/src/lib/ambassador/programs.js';

test('public footer keeps site links without an ambassador credit', async ({ page }) => {
  await page.goto('/about');
  const footer = page.locator('footer');
  await footer.scrollIntoViewIfNeeded();
  await expect(footer.getByRole('link', { name: /ambassador/i })).toHaveCount(0);
  for (const name of ['About', 'Contact', 'Privacy Policy', 'Terms', 'Admin']) {
    await expect(footer.getByRole('link', { name, exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});

test('ambassador programme cards and GitKraken details fit desktop and mobile', async ({
  page,
  identity,
}, testInfo) => {
  const programs = DEFAULT_PROGRAMS.map((program, index) => ({
    ...program,
    enabled: true,
    order: index + 1,
    membershipStatus: program.provider === 'GitKraken' ? 'active' : 'none',
  }));
  identity.answerApi('cms/calendar-alerts', { alerts: [], today: '2026-10-27' });
  identity.answerApi('cms/ambassador/programs', { items: programs });
  identity.answerApi('cms/ambassador/applications', { items: [] });
  identity.answerApi('cms/ambassador/evidence', { items: [] });
  identity.answerApi('cms/ambassador/readiness/program-gitkraken-ambassador', {
    readiness: {
      programId: 'program-gitkraken-ambassador',
      score: 0,
      requirements: [],
      missing: [],
      explanation: 'No evidence filed for this quarter.',
    },
  });
  await identity.signIn('/admin/ambassador');
  await page.getByRole('tab', { name: 'Programs', exact: true }).click();
  const cards = page.getByTestId('program-card');
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThan(10);
  const card = cards.filter({ hasText: 'GitKraken Ambassador' });
  await expect(card.getByTestId('program-upkeep')).toContainText('0 of 2 filed here');
  await card.getByRole('button', { name: 'Details', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'GitKraken Ambassador', exact: true })
  ).toBeVisible();
  await expect(dialog.getByTestId('program-upkeep-details')).toContainText(
    'At least 2 every quarter'
  );
  await expect(dialog.getByText('No evidence filed for this quarter.')).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await dialog.boundingBox();
      return bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width;
    })
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('gitkraken-details.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});
