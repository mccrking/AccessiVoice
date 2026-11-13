import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const voice = { instances: [] as any[], utterances: [] as any[] };
    class Utterance { constructor(public text: string) {} }
    class Recognition {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      onresult: ((event: any) => void) | null = null;
      constructor() { voice.instances.push(this); }
      start() { this.onstart?.(); }
      abort() { this.onerror?.({ error: 'aborted' }); this.onend?.(); }
      stop() { this.onend?.(); }
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], cancel: () => {}, pause: () => {}, resume: () => {},
      speak: (utterance: any) => voice.utterances.push(utterance),
    } });
    Object.assign(window, { SpeechRecognition: Recognition, SpeechSynthesisUtterance: Utterance, voiceTest: voice });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Démarrer le guidage vocal' })).toBeFocused();
});

async function speechCount(page: Page) { return page.evaluate(() => (window as any).voiceTest.utterances.length); }
async function micCount(page: Page) { return page.evaluate(() => (window as any).voiceTest.instances.length); }
async function finishSpeech(page: Page) {
  const previous = await micCount(page);
  await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).onend());
  await expect.poll(() => micCount(page)).toBe(previous + 1);
}
async function say(page: Page, text: string) {
  const previous = await speechCount(page);
  await page.evaluate(text => (window as any).voiceTest.instances.at(-1).onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }), text);
  await expect.poll(() => speechCount(page)).toBeGreaterThan(previous);
}

test('entry is announced, Enter reads instructions, then listening alternates with replies', async ({ page }) => {
  const start = page.getByRole('button', { name: 'Démarrer le guidage vocal' });
  await expect(start).toBeFocused();
  await expect(start).toHaveAccessibleDescription(/Entrée lance le guide vocal/);
  expect(await speechCount(page)).toBe(1);
  expect(await page.evaluate(() => (window as any).voiceTest.utterances[0].text)).toBe('Salut Utilisateur Démo !');
  expect(await micCount(page)).toBe(0);
  await page.keyboard.press('Enter');
  const intro = await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).text);
  expect(intro).toContain('autoriser le microphone');
  expect(intro).toContain('ouvre mes documents');
  expect(intro).toContain('Échap');
  expect(await micCount(page)).toBe(0);
  await finishSpeech(page);
  await say(page, 'Je veux mes notes');
  await expect(page.getByRole('heading', { name: 'Mes notes', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).text)).toContain('15,4');
  expect(await micCount(page)).toBe(1);
  await finishSpeech(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Arrêter le guidage vocal' })).toHaveCount(0);
  await page.clock.install();
  await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).onend());
  await page.clock.fastForward(31000);
  expect(await micCount(page)).toBe(2);
});

test('form can be dictated across pages and its values are read before explicit confirmation', async ({ page }) => {
  let actions = 0;
  page.on('request', request => { if (request.url().endsWith('/api/actions')) actions++; });
  await page.keyboard.press('Alt+h');
  for (const text of ['Ouvre mes démarches', 'champ suivant', 'écris Amine Démo', 'champ suivant', 'écris ETU-001', 'champ suivant', 'écris Dossier de stage', 'Envoie le formulaire']) {
    await finishSpeech(page);
    await say(page, text);
  }
  const recap = await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).text);
  expect(recap).toContain('Amine Démo');
  expect(recap).toContain('ETU-001');
  expect(recap).toContain('Dossier de stage');
  expect(recap).toContain('je confirme');
  expect(actions).toBe(0);
  await finishSpeech(page);
  await say(page, 'je confirme');
  expect(actions).toBe(1);
  await expect(page.getByRole('status')).toContainText('DEMO-');
  await page.keyboard.press('Escape');
});

test('microphone denial is explained aloud and ends the guided loop', async ({ page }) => {
  await page.keyboard.press('Alt+h');
  await finishSpeech(page);
  await page.evaluate(() => (window as any).voiceTest.instances.at(-1).onerror({ error: 'not-allowed' }));
  await expect(page.getByRole('status')).toContainText('Accès au microphone refusé');
  expect(await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).text)).toContain('Autorisez le microphone');
  await page.clock.install();
  await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).onend());
  await page.clock.fastForward(31000);
  expect(await micCount(page)).toBe(1);
  await expect(page.getByRole('button', { name: 'Arrêter le guidage vocal' })).toHaveCount(0);
});

test('blocked narration gives a keyboard fallback and Alt M can start and stop directly', async ({ page }) => {
  await page.keyboard.press('Alt+h');
  await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).onerror({ error: 'not-allowed' }));
  await expect(page.getByText('La lecture du guide ou de la réponse a été interrompue.', { exact: false })).toBeVisible();
  expect(await micCount(page)).toBe(0);
  await page.keyboard.press('Alt+m');
  await expect(page.getByRole('button', { name: 'Arrêter le microphone' })).toBeVisible();
  await page.keyboard.press('Alt+m');
  await expect(page.locator('.microphone-button')).toHaveAttribute('aria-pressed', 'false');
});

test('mobile guidance keeps stop controls accessible and hiding the page stops listening', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.getByRole('button', { name: 'Ouvrir la navigation' })).toBeVisible();
  await page.keyboard.press('Alt+h');
  await finishSpeech(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arrêter le guidage vocal' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Arrêter le microphone' })).toBeInViewport();
  const inputBounds = await page.getByLabel('Votre demande à l’assistant').boundingBox();
  expect(inputBounds!.y + inputBounds!.height).toBeLessThanOrEqual(568);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations.map(item => item.id)).toEqual([]);
  await page.screenshot({ path: 'reports/preview-guidance-mobile.png' });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: 'Arrêter le guidage vocal' })).toHaveCount(0);
  await expect(page.locator('.microphone-button')).toHaveAttribute('aria-pressed', 'false');
});

test('a spoken stop command ends guidance without another listening turn', async ({ page }) => {
  await page.keyboard.press('Alt+h');
  await finishSpeech(page);
  await say(page, 'arrête le guidage');
  await expect(page.getByRole('button', { name: 'Arrêter le guidage vocal' })).toHaveCount(0);
  await page.clock.install();
  await page.evaluate(() => (window as any).voiceTest.utterances.at(-1).onend());
  await page.clock.fastForward(31000);
  expect(await micCount(page)).toBe(1);
  await expect(page.getByRole('log')).toContainText('Le guidage vocal est arrêté');
});

test('contextual voice dialogue stays usable on a small screen through correction and submission', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.keyboard.press('Alt+h');
  await finishSpeech(page);
  await say(page, 'Je veux faire une demande');
  const input = page.getByLabel('Votre demande à l’assistant');
  const bounds = await input.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(568);
  for (const text of ['Convention de stage', 'Amine Démo', 'ETU-001', 'Dossier de stage', 'corrige le numéro étudiant en ETU-002']) {
    await finishSpeech(page);
    await say(page, text);
  }
  await expect(page.getByRole('region', { name: 'Confirmation de l’action' })).toContainText('ETU-002');
  await expect(page.getByRole('button', { name: 'Je confirme', exact: true })).toBeInViewport();
  const finalBounds = await input.boundingBox();
  expect(finalBounds!.y + finalBounds!.height).toBeLessThanOrEqual(568);
  await page.screenshot({ path: 'reports/preview-dialogue-mobile.png' });
  await finishSpeech(page);
  await say(page, 'je confirme');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).toContainText('DEMO-');
  await page.evaluate(async () => {
    const token = localStorage.getItem('accessivoice-campus-token');
    await fetch('/api/campus/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, confirmed: true }) });
  });
});
