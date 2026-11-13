import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function send(page: Page, text: string) {
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill(text);
  await input.press('Enter');
  await expect(page.locator('.thinking')).toHaveCount(0);
}

async function eraseProfile(page: Page) {
  await page.evaluate(async () => {
    const token = localStorage.getItem('accessivoice-campus-token');
    if (token) await fetch('/api/campus/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, confirmed: true }) });
    localStorage.removeItem('accessivoice-campus-token');
  });
}

test.afterEach(async ({ page }) => { await eraseProfile(page); });

test('guided dialogue collects, corrects, persists and tracks a complete request', async ({ page }) => {
  await page.goto('/');
  await send(page, 'Je veux faire une demande');
  await expect(page.getByRole('region', { name: 'Démarche guidée' })).toBeVisible();
  await page.getByRole('button', { name: 'Convention de stage', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Quel est votre nom complet');
  await send(page, 'Amine Démo');
  await expect(page.getByRole('log')).toContainText('Quel est votre numéro étudiant');
  await send(page, 'ETU-001');
  await expect(page.getByRole('log')).toContainText('Quel est le motif');
  await send(page, 'Dossier de stage');
  const confirmation = page.getByRole('region', { name: 'Confirmation de l’action' });
  await expect(confirmation).toContainText('Convention de stage');
  await send(page, 'corrige le nom en Salma Démo');
  await expect(confirmation).toContainText('Salma Démo');
  await expect(page.getByLabel('Nom complet', { exact: true })).toHaveValue('Salma Démo');
  await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('DEMO-');
  await page.getByRole('navigation').getByRole('button', { name: 'Mon suivi', exact: true }).click();
  const card = page.getByRole('article').filter({ hasText: 'Salma Démo' });
  await expect(card).toContainText('Déposée');
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: 'Mon suivi', exact: true }).click();
  await expect(card).toContainText('Salma Démo');
  await card.getByRole('button', { name: 'Simuler l’étape suivante' }).click();
  await expect(card.locator('.request-status')).toHaveText('En traitement');
  await card.getByRole('button', { name: 'Simuler l’étape suivante' }).click();
  await expect(card.locator('.request-status')).toHaveText('Document prêt');
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations.map(item => item.id)).toEqual([]);
  await page.screenshot({ path: 'reports/preview-tracking.png', fullPage: true });
  await card.getByRole('button', { name: 'Obtenir le document' }).click();
  await expect(confirmation).toContainText('Convention de stage');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('convention-demo.pdf');
  await page.getByRole('button', { name: 'Effacer mon suivi', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmer l’effacement du suivi' }).click();
  await expect(page.getByText('Votre suivi commence ici', { exact: true })).toBeVisible();
});

test('document catalogue generates distinct PDFs with explicit confirmations', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Mes documents', exact: true }).click();
  for (const [button, filename] of [['Télécharger le relevé', 'releve-demo.pdf'], ['Télécharger la convention', 'convention-demo.pdf']]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
    expect((await download).suggestedFilename()).toBe(filename);
  }
});

test('laboratory explains the model without starting an action', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Laboratoire IA', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entraînement reproductible', exact: true })).toBeVisible();
  await page.getByLabel('Phrase à analyser').fill('télécharge mon relevé de notes');
  await page.getByRole('button', { name: 'Analyser sans exécuter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Aucune action n’a été exécutée');
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
  await page.getByText('Répartition des données et paramètres', { exact: true }).click();
  await expect(page.getByRole('table', { name: 'Corpus actuel par intention' })).toContainText('unknown');
  await expect(page.getByText('Rapport indisponible', { exact: false })).toHaveCount(0);
});

test('navigation safely leaves a draft and no early confirmation submits it', async ({ page }) => {
  await page.goto('/');
  await send(page, 'Je veux une attestation de scolarité');
  await expect(page.getByRole('log')).toContainText('Quel est votre nom complet');
  await send(page, 'je confirme');
  await expect(page.getByRole('log')).toContainText('Aucune action à confirmer');
  await send(page, 'Ouvre mes notes');
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Démarche guidée' })).toHaveCount(0);
  await send(page, 'annuler');
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
});

for (const width of [320, 1440]) {
  test(`new pages remain accessible and within viewport at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 1000 });
    await page.goto('/');
    for (const label of ['Mon suivi', 'Laboratoire IA', 'Apprentissage']) {
      if (width === 320) await page.getByRole('button', { name: 'Ouvrir la navigation' }).click();
      await page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
      if (label === 'Laboratoire IA') await expect(page.getByRole('heading', { name: 'Entraînement reproductible', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })) ).toEqual([]);
      if (label === 'Laboratoire IA') await page.screenshot({ path: `reports/preview-lab-${width}.png`, fullPage: true });
    }
  });
}
