import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('consented correction is remembered, automatically trained, paused and erased', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  let token: string | null = null;
  try {
    await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
    const enable = page.getByRole('button', { name: 'Activer l’apprentissage', exact: true });
    await expect(enable).toBeDisabled();
    await page.getByRole('checkbox', { name: /J’accepte que mes corrections/ }).check();
    await enable.click();
    await expect(page.getByText('Apprentissage activé', { exact: true })).toBeVisible();
    token = await page.evaluate(() => localStorage.getItem('accessivoice-learning-token'));
    expect(token).toBeTruthy();
    const input = page.getByLabel('Votre demande à l’assistant');
    await input.fill('mon carnet du campus');
    await input.press('Enter');
    await page.getByRole('button', { name: 'Corriger ma demande' }).click();
    await page.getByRole('combobox', { name: 'La bonne action' }).selectOption('grades');
    const save = page.getByRole('button', { name: 'Retenir cette expression' });
    await expect(save).toBeDisabled();
    await page.getByRole('checkbox', { name: /J’autorise l’enregistrement/ }).check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: 'reports/preview-learning.png', fullPage: true });
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(accessibility.violations.map(row => ({ id: row.id, targets: row.nodes.map(node => node.target) }))).toEqual([]);
    await save.click();
    await expect(page.getByRole('log')).toContainText('Votre formulation est retenue');
    const memoryResponse = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().method() === 'POST');
    await input.fill('mon carnet du campus');
    await input.press('Enter');
    await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
    expect((await (await memoryResponse).json()).prediction_source).toBe('personal_memory');
    await expect.poll(async () => (await (await page.request.post('/api/learning/status', { data: { token } })).json()).state, { timeout: 30000 }).toBe('ready');
    const modelResponse = page.waitForResponse(response => response.url().endsWith('/api/commands') && response.request().method() === 'POST');
    await input.fill('je voudrais mon carnet du campus');
    await input.press('Enter');
    expect((await (await modelResponse).json()).prediction_source).toBe('personal_model');
    await page.reload();
    await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
    await expect(page.getByText('Apprentissage activé', { exact: true })).toBeVisible();
    await expect(page.getByText('Vos expressions sont à jour.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mettre en pause', exact: true }).click();
    await expect(page.getByText('Apprentissage en pause', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Effacer mes apprentissages', exact: true }).click();
    await page.getByRole('button', { name: 'Oui, effacer mes apprentissages', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Effacer mes apprentissages', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('accessivoice-learning-token'))).toBeNull();
    expect((await page.request.post('/api/learning/status', { data: { token } })).status()).toBe(404);
    token = null;
  } finally {
    if (token) await page.request.post('/api/learning/forget', { data: { token } });
  }
});

test('mobile learning settings remain within viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click();
  await page.getByRole('button', { name: 'Accessibilité', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Apprendre avec vous' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a missing stored profile can be replaced without getting stuck', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('accessivoice-learning-token', 'obsolete-profile-token-that-does-not-exist-000000'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
  await expect(page.getByText('Le profil précédent n’est plus disponible. Vous pouvez activer un nouvel apprentissage.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('accessivoice-learning-token'))).toBeNull();
  await page.getByRole('checkbox', { name: /J’accepte que mes corrections/ }).check();
  await expect(page.getByRole('button', { name: 'Activer l’apprentissage', exact: true })).toBeEnabled();
});
