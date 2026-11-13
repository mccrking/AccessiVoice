import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const viewport of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
  test(`compact assistant and enlarged settings fit ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const launcher = page.getByRole('button', { name: 'Ouvrir l’assistant', exact: true });
    await launcher.click();
    const dialog = page.getByRole('dialog', { name: 'Assistant', exact: true });
    await expect(dialog).toBeVisible();
    const input = page.getByLabel('Votre demande à l’assistant');
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
    const bounds = await input.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.map(item => item.id)).toEqual([]);
    if (viewport.width === 320) await page.screenshot({ path: 'reports/preview-mobile-assistant.png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
    await page.getByRole('switch', { name: 'Texte agrandi' }).click();
    await page.getByRole('switch', { name: 'Contraste renforcé' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await launcher.click();
    const enlargedBounds = await input.boundingBox();
    expect(enlargedBounds!.y + enlargedBounds!.height).toBeLessThanOrEqual(viewport.height);
  });
}

test('mobile navigation, guided fields and confirmation stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const open = () => page.getByRole('button', { name: 'Ouvrir l’assistant', exact: true }).click();
  const input = page.getByLabel('Votre demande à l’assistant');
  await open();
  await input.fill('Je veux mes notes');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Mes démarches' }).click();
  await open();
  await input.fill('champ suivant');
  await input.press('Enter');
  await expect(page.getByLabel('Nom complet', { exact: true })).toBeFocused();
  await open();
  await input.fill('écris Amine Démo');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Fermer l’assistant' }).click();
  await expect(page.getByLabel('Nom complet', { exact: true })).toHaveValue('Amine Démo');
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Mes documents' }).click();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Je confirme', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  expect(downloads).toBe(0);
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
});
