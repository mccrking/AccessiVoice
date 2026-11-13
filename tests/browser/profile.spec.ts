import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function installVoice(page: Page, options: { name?: string; blocked?: boolean; silent?: boolean; denyStorage?: boolean } = {}) {
  await page.addInitScript(options => {
    if (options.name) localStorage.setItem('accessivoice-profile', JSON.stringify({ name: options.name }));
    if (options.denyStorage) {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'accessivoice-profile') throw new DOMException('Storage denied', 'SecurityError');
        original.call(this, key, value);
      };
    }
    const audio = { calls: [] as any[], microphones: 0, active: null as any, blocked: Boolean(options.blocked), silent: Boolean(options.silent) };
    class Utterance { constructor(public text: string) {} }
    class Recognition { constructor() { audio.microphones++; } }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ lang: 'fr-FR', name: 'Test français' }],
      cancel: () => { const previous = audio.active; audio.active = null; previous?.onerror?.({ error: 'canceled' }); },
      resume: () => {},
      speak: (utterance: any) => {
        audio.calls.push(utterance); audio.active = utterance;
        if (audio.blocked) { audio.blocked = false; utterance.onerror?.({ error: 'not-allowed' }); }
        else if (!audio.silent) { utterance.onstart?.(); utterance.onend?.(); audio.active = null; }
      },
    } });
    Object.assign(window, { SpeechSynthesisUtterance: Utterance, SpeechRecognition: Recognition, greetingTest: audio });
  }, options);
}

test('opening the interface greets the saved user once without starting the microphone', async ({ page }) => {
  await installVoice(page, { name: 'Salma Démo' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bonjour, Salma Démo', exact: true })).toBeVisible();
  const result = await page.evaluate(() => {
    const audio = (window as any).greetingTest;
    return { text: audio.calls[0].text, lang: audio.calls[0].lang, count: audio.calls.length, microphones: audio.microphones };
  });
  expect(result).toEqual({ text: 'Salut Salma Démo !', lang: 'fr-FR', count: 1, microphones: 0 });
  await expect(page.getByRole('button', { name: 'Démarrer le guidage vocal' })).toBeFocused();
  await page.getByRole('button', { name: 'Voir mon suivi', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Mon espace', exact: true }).click();
  expect(await page.evaluate(() => (window as any).greetingTest.calls.length)).toBe(1);
});

test('saving a profile updates the name, initials and greeting across reloads', async ({ page }) => {
  await installVoice(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Modifier mon profil, Utilisateur Démo', exact: true }).click();
  await page.getByLabel('Nom d’utilisateur', { exact: true }).fill('  Salma   Bennani  ');
  await page.getByRole('button', { name: 'Enregistrer mon nom', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Mon profil', exact: true }).getByRole('status')).toContainText('Votre nom a été enregistré');
  await expect(page.locator('.profile-button .avatar')).toHaveText('SB');
  await page.getByRole('button', { name: 'Écouter ma salutation' }).click();
  expect(await page.evaluate(() => (window as any).greetingTest.calls.at(-1).text)).toBe('Salut Salma Bennani !');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Bonjour, Salma Bennani', exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Salut Salma Bennani !');
  expect(await page.evaluate(() => (window as any).greetingTest.calls[0].text)).toBe('Salut Salma Bennani !');
});

test('blocked autoplay has an explicit retry and never retries or opens the microphone by itself', async ({ page }) => {
  await installVoice(page, { blocked: true });
  await page.goto('/');
  await expect(page.getByText('La salutation n’a pas pu être lue.', { exact: false })).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(20000);
  expect(await page.evaluate(() => (window as any).greetingTest.calls.length)).toBe(1);
  await page.getByRole('button', { name: 'Écouter la salutation', exact: true }).click();
  expect(await page.evaluate(() => (window as any).greetingTest.calls.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).greetingTest.microphones)).toBe(0);
  await expect(page.getByText('La salutation n’a pas pu être lue.', { exact: false })).toHaveCount(0);
});

test('a browser that sends no audio event exposes the retry after the bounded wait', async ({ page }) => {
  await installVoice(page, { silent: true });
  await page.clock.install();
  await page.goto('/');
  await page.clock.fastForward(4001);
  await expect(page.getByText('La salutation n’a pas pu être lue.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as any).greetingTest.calls.length)).toBe(1);
});

test('Escape cancels the greeting and late events cannot start a guided session', async ({ page }) => {
  await installVoice(page, { silent: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Démarrer le guidage vocal' })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const utterance = (window as any).greetingTest.calls[0];
    utterance.onstart(); utterance.onend(); utterance.onerror({ error: 'not-allowed' });
  });
  await page.clock.install();
  await page.clock.fastForward(20000);
  expect(await page.evaluate(() => (window as any).greetingTest.active)).toBeNull();
  expect(await page.evaluate(() => (window as any).greetingTest.microphones)).toBe(0);
  await expect(page.getByText('La salutation n’a pas pu être lue.', { exact: false })).toHaveCount(0);
});

test('profile changes report unavailable storage instead of claiming persistence', async ({ page }) => {
  await installVoice(page, { denyStorage: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
  await page.getByLabel('Nom d’utilisateur', { exact: true }).fill('Kenza');
  await page.getByRole('button', { name: 'Enregistrer mon nom', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Autorisez le stockage local');
  await page.getByRole('navigation').getByRole('button', { name: 'Mon espace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bonjour, Utilisateur Démo', exact: true })).toBeVisible();
});

test('the automatic greeting has a visible stop control and can be replayed explicitly', async ({ page }) => {
  await installVoice(page, { silent: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Arrêter la salutation', exact: true }).click();
  expect(await page.evaluate(() => (window as any).greetingTest.active)).toBeNull();
  await page.evaluate(() => { (window as any).greetingTest.silent = false; });
  await page.getByRole('button', { name: 'Écouter la salutation', exact: true }).click();
  expect(await page.evaluate(() => (window as any).greetingTest.calls.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).greetingTest.microphones)).toBe(0);
});

test('the profile editor and long names fit a small screen and pass the automatic audit', async ({ page }) => {
  await installVoice(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
  await page.getByLabel('Nom d’utilisateur', { exact: true }).fill('S'.repeat(60));
  await page.getByRole('button', { name: 'Enregistrer mon nom', exact: true }).click();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations.map(item => item.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Ouvrir la navigation' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Mon espace', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Bonjour, ${'S'.repeat(60)}`, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
