import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('main pages have no automatically detected WCAG A/AA violations', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  for (const name of ['Mon espace', 'Mes documents', 'Mes notes', 'Mes démarches']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, message: node.failureSummary })) }))).toEqual([]);
  }
  for (const name of ['Aide et commandes', 'Accessibilité']) {
    await page.getByRole('button', { name, exact: true }).click();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(results.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
  }
});

test('capture desktop and mobile previews', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('Disponible')).toBeVisible();
  await page.screenshot({ path: 'reports/preview-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'reports/preview-mobile.png', fullPage: true });
});
