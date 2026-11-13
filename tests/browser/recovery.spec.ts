import { test, expect } from '@playwright/test';

test('an expired session renews once and the command succeeds without reloading', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill('Je veux mes notes');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
  const ids: string[] = [];
  await page.route('**/api/commands', async route => {
    ids.push(route.request().postDataJSON().session_id);
    if (ids.length === 1) await route.fulfill({ status: 401, json: { detail: 'Session expirée.' } });
    else await route.continue();
  });
  await input.fill('Ouvre mes documents');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mes documents', exact: true })).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test('an expired confirmation is discarded and never replayed in a new session', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill('Télécharge mon attestation');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Je confirme', exact: true })).toBeVisible();
  let actions = 0;
  await page.route('**/api/actions', async route => {
    actions++;
    await route.fulfill({ status: 401, json: { detail: 'Session expirée.' } });
  });
  await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('aucune confirmation précédente ne sera réutilisée');
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
  await input.fill('je confirme');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('Aucune action à confirmer');
  expect(actions).toBe(1);
});

for (const confirmation of ['button', 'command']) {
test(`a lost action response does not cause a second submission (${confirmation})`, async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Mes démarches' }).click();
  await page.getByLabel('Nom complet', { exact: true }).fill('Amine Démo');
  await page.getByLabel('Numéro étudiant', { exact: true }).fill('ETU-001');
  await page.getByLabel('Motif de la demande', { exact: true }).fill('Dossier de stage');
  await page.getByRole('button', { name: 'Vérifier ma demande' }).click();
  await expect(page.getByRole('button', { name: 'Je confirme', exact: true })).toBeEnabled();
  let actions = 0;
  await page.route('**/api/actions', async route => {
    actions++;
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    await route.abort('failed');
  });
  if (confirmation === 'button') await page.getByRole('button', { name: 'Je confirme', exact: true }).click();
  else {
    await page.getByLabel('Votre demande à l’assistant').fill('je confirme');
    await page.getByLabel('Votre demande à l’assistant').press('Enter');
  }
  await expect(page.getByRole('log')).toContainText('Son résultat est incertain');
  await expect(page.getByText('Connexion indisponible', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toHaveCount(0);
  await page.getByLabel('Votre demande à l’assistant').fill('je confirme');
  await page.getByLabel('Votre demande à l’assistant').press('Enter');
  await expect(page.getByRole('log')).toContainText('Aucune action à confirmer');
  await expect(page.getByText('Disponible', { exact: true })).toBeVisible();
  expect(actions).toBe(1);
});
}

test('repeated session failures stop after one retry', async ({ page }) => {
  await page.goto('/');
  let commands = 0;
  await page.route('**/api/commands', async route => {
    commands++;
    await route.fulfill({ status: 401, json: { detail: 'Session expirée.' } });
  });
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill('Je veux mes notes');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('La session a expiré');
  await expect(page.getByRole('button', { name: 'Parler', exact: true })).toBeEnabled();
  expect(commands).toBe(2);
});
