import { test, expect } from '@playwright/test';

test.describe('Frontend Smoke Tests', () => {
  test('should load homepage', async ({ page }) => {
    await page.goto('/');

    // Verify page loaded with correct title
    await expect(page).toHaveTitle(/HCW|Hybrid Cloud Works|Personal Site/i);
  });

  test('should have accessible navigation', async ({ page }) => {
    await page.goto('/');

    // Check that navigation landmark is visible using role locator
    const nav = page.getByRole('navigation').first();
    await expect(nav).toBeVisible();
  });

  test('should have proper document structure', async ({ page }) => {
    await page.goto('/');

    // Check for semantic HTML landmarks and primary heading using role locators
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });

  test('should handle responsive viewport', async ({ page }) => {
    // Test mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');

    // Verify page is still functional on mobile
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('should not have console errors during load', async ({ page }) => {
    const errors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.goto('/');

    // Check that no critical errors occurred
    const criticalErrors = errors.filter(
      (e) => !e.includes('Non-Error promise rejection') && !e.includes('ResizeObserver loop')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
