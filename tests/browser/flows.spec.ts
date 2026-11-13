import { test, expect } from '@playwright/test';

test('written command opens notes, unknown command is rejected', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Votre demande à l’assistant').fill('Je veux mes notes');
  await page.getByRole('button', { name: 'Envoyer la demande', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Machine Learning');
  await page.getByLabel('Votre demande à l’assistant').fill('achète une pizza');
  await page.getByRole('button', { name: 'Envoyer la demande', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Je n’ai pas compris');
});

test('PDF download needs confirmation; cancel does not download', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Mes documents' }).click();
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toBeVisible();
  expect(downloads).toBe(0);
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
  expect(downloads).toBe(0);
  await page.getByRole('button', { name: 'Télécharger', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('attestation-demo.pdf');
  expect(downloads).toBe(1);
});

test('form preview matches input and submission remains simulated', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Mes démarches' }).click();
  await page.getByLabel('Nom complet', { exact: true }).fill('Amine Démo');
  await page.getByLabel('Numéro étudiant', { exact: true }).fill('ETU-001');
  await page.getByLabel('Motif de la demande', { exact: true }).fill('Dossier de stage');
  await page.getByRole('button', { name: 'Vérifier ma demande' }).click();
  const confirmation = page.getByRole('region', { name: 'Confirmation de l’action' });
  await expect(confirmation).toContainText('Amine Démo');
  await expect(confirmation).toContainText('Dossier de stage');
  await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('DEMO-');
  await expect(page.getByRole('status')).toContainText('Aucune transmission externe');
});

test('keyboard navigation, guided dictation and persistent preferences', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Disponible')).toBeVisible();
  await page.keyboard.press('Alt+k');
  await expect(page.getByLabel('Votre demande à l’assistant')).toBeFocused();
  await page.keyboard.type('Ouvre mes demarches');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mes démarches', exact: true })).toBeVisible();
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill('champ suivant');
  await input.press('Enter');
  await expect(page.getByLabel('Nom complet', { exact: true })).toBeFocused();
  await input.fill('écris Amine Démo');
  await input.press('Enter');
  await expect(page.getByLabel('Nom complet', { exact: true })).toHaveValue('Amine Démo');
  await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
  await page.getByRole('switch', { name: 'Texte agrandi' }).click();
  await page.getByRole('switch', { name: 'Contraste renforcé' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-large', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'true');
});

test('mobile layout has no horizontal overflow and menu opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Mes documents' }).click();
  await expect(page.getByRole('heading', { name: 'Mes documents', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('uncertain confirmation invalidates a pending action without a download', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('Votre demande à l’assistant');
  let downloads = 0;
  page.on('download', () => downloads++);
  await input.fill('Télécharge mon attestation');
  await input.press('Enter');
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toBeVisible();
  await input.fill('oui peut-être');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Je n’ai pas compris');
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
  await input.fill('je confirme');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Aucune action à confirmer');
  expect(downloads).toBe(0);
});

test('trained typo is understood and unsupported document is refused', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill('mes nottes');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
  await input.fill('télécharge mon diplôme');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Je n’ai pas compris');
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
});
