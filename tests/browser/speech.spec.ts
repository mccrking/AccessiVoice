import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const instances: any[] = [];
    class FakeRecognition {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onresult: ((event: any) => void) | null = null;
      aborted = false;
      constructor() { instances.push(this); }
      start() { this.onstart?.(); }
      abort() { this.aborted = true; this.onerror?.({ error: 'aborted' }); this.onend?.(); }
      stop() { this.onend?.(); }
    }
    Object.assign(window, { SpeechRecognition: FakeRecognition, speechInstances: instances });
  });
  await page.goto('/');
});

test('silence retries, interim words do not execute and a final command executes once', async ({ page }) => {
  let commands = 0;
  page.on('request', request => { if (request.url().endsWith('/api/commands')) commands++; });
  await page.locator('.microphone-button').click();
  await expect(page.getByRole('button', { name: 'Arrêter le microphone' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => {
    const current = (window as any).speechInstances.at(-1);
    current.onerror({ error: 'no-speech' }); current.onend();
  });
  await expect.poll(() => page.evaluate(() => (window as any).speechInstances.length)).toBe(2);
  await expect(page.getByRole('button', { name: 'Arrêter le microphone' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).speechInstances.at(-1).onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'mes' } }] });
  });
  expect(commands).toBe(0);
  await page.evaluate(() => {
    const current = (window as any).speechInstances.at(-1);
    const result = { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Je veux mes notes' } }] };
    current.onresult(result); current.onresult(result);
  });
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
  expect(commands).toBe(1);
  await expect(page.locator('.microphone-button')).toHaveAttribute('aria-pressed', 'false');
});

for (const [error, message] of [
  ['network', 'Le service de reconnaissance vocale est injoignable'],
  ['not-allowed', 'Accès au microphone refusé'],
  ['audio-capture', 'Microphone inaccessible'],
  ['service-not-allowed', 'Le service vocal est bloqué'],
]) {
  test(`${error} explains the failure without restarting the microphone`, async ({ page }) => {
    await page.clock.install();
    await page.locator('.microphone-button').click();
    await page.evaluate(error => {
      const current = (window as any).speechInstances.at(-1);
      current.onerror({ error }); current.onend();
    }, error);
    await expect(page.getByRole('status')).toContainText(message);
    await expect(page.locator('.microphone-button')).toHaveAttribute('aria-pressed', 'false');
    await page.clock.fastForward(31000);
    expect(await page.evaluate(() => (window as any).speechInstances.length)).toBe(1);
    await expect(page.getByRole('status')).toContainText(message);
  });
}

test('manual stop cancels a queued retry and ignores late results', async ({ page }) => {
  await page.clock.install();
  await page.locator('.microphone-button').click();
  await page.evaluate(() => (window as any).speechInstances[0].onend());
  await page.getByRole('button', { name: 'Arrêter le microphone' }).click();
  await page.clock.fastForward(31000);
  await page.evaluate(() => (window as any).speechInstances[0].onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'Je veux mes notes' } }] }));
  expect(await page.evaluate(() => (window as any).speechInstances.length)).toBe(1);
  await expect(page.getByRole('heading', { name: 'Bonjour, Utilisateur Démo', exact: true })).toBeVisible();
  await expect(page.locator('.notice')).toHaveCount(0);
});

test('listening expires and cannot repeatedly restart on silence', async ({ page }) => {
  await page.clock.install();
  await page.locator('.microphone-button').click();
  await page.clock.fastForward(30001);
  await expect(page.getByRole('status')).toContainText('après 30 secondes');
  await expect(page.locator('.microphone-button')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.microphone-button').click();
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => {
      const current = (window as any).speechInstances.at(-1);
      current.onerror({ error: 'no-speech' }); current.onend();
    });
    await page.clock.fastForward(300);
  }
  await expect(page.getByRole('status')).toContainText('Aucune parole reconnue');
  expect(await page.evaluate(() => (window as any).speechInstances.length)).toBe(4);
  await page.clock.fastForward(31000);
  expect(await page.evaluate(() => (window as any).speechInstances.length)).toBe(4);
});
