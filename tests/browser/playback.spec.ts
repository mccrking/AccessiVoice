import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const audio = { utterances: [] as any[], microphones: [] as any[], active: null as any, paused: false };
    class Utterance { constructor(public text: string) {} }
    class Recognition {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onresult: ((event: any) => void) | null = null;
      constructor() { audio.microphones.push(this); }
      start() { this.onstart?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [],
      speak: (utterance: any) => { audio.active = utterance; audio.utterances.push(utterance); },
      pause: () => { audio.paused = true; },
      resume: () => { audio.paused = false; },
      cancel: () => { const old = audio.active; audio.active = null; old?.onerror?.({ error: 'canceled' }); },
    } });
    Object.assign(window, { SpeechRecognition: Recognition, SpeechSynthesisUtterance: Utterance, playbackTest: audio });
  });
  await page.goto('/');
});

async function command(page: Page, text: string) {
  const input = page.getByLabel('Votre demande à l’assistant');
  await input.fill(text);
  await input.press('Enter');
}

async function say(page: Page, text: string) {
  await page.getByRole('button', { name: 'Parler', exact: true }).click();
  await page.evaluate(text => (window as any).playbackTest.microphones.at(-1).onresult({
    resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }],
  }), text);
}

test('microphone preserves the reading and spoken resume continues the same utterance', async ({ page }) => {
  await command(page, 'Lis cette page');
  await expect(page.getByRole('button', { name: 'Mettre en pause la lecture' })).toBeVisible();
  await say(page, 'Pause');
  await expect(page.getByRole('log')).toContainText('Lecture mise en pause');
  expect(await page.evaluate(() => {
    const audio = (window as any).playbackTest;
    return audio.paused && audio.active === audio.utterances[1];
  })).toBe(true);
  await say(page, 'Reprends la lecture');
  await expect(page.getByRole('log')).toContainText('Lecture reprise');
  expect(await page.evaluate(() => {
    const audio = (window as any).playbackTest;
    return !audio.paused && audio.active === audio.utterances[1] && audio.utterances.length === 2;
  })).toBe(true);
});

test('paused reading survives a long wait and remains resumable at the keyboard', async ({ page }) => {
  await command(page, 'Lis cette page');
  await expect(page.getByRole('button', { name: 'Mettre en pause la lecture' })).toBeVisible();
  await page.clock.install();
  await page.getByRole('button', { name: 'Mettre en pause la lecture' }).click();
  await page.clock.fastForward(180000);
  await expect(page.getByText('Lecture en pause', { exact: true })).toBeVisible();
  const resume = page.getByRole('button', { name: 'Reprendre la lecture', exact: true });
  await resume.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Lecture en cours', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).playbackTest.utterances.length)).toBe(2);
});

test('Escape cancels paused reading and late audio events cannot restore it', async ({ page }) => {
  await command(page, 'Lis cette page');
  await page.getByRole('button', { name: 'Mettre en pause la lecture' }).click();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).playbackTest.utterances[1].onend());
  await expect(page.getByRole('group', { name: 'Contrôle de la lecture' })).toHaveCount(0);
  await command(page, 'Reprends la lecture');
  await expect(page.getByRole('log')).toContainText('Aucune lecture en pause');
  expect(await page.evaluate(() => (window as any).playbackTest.active)).toBeNull();
});

test('reading controls remain accessible on a small screen with enlarged text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole('button', { name: 'Personnaliser l’affichage' }).click();
  await page.getByRole('switch', { name: 'Texte agrandi' }).click();
  await page.getByRole('switch', { name: 'Contraste renforcé' }).click();
  await page.getByRole('button', { name: 'Ouvrir l’assistant', exact: true }).click();
  await command(page, 'Lis cette page');
  await expect(page.getByRole('button', { name: 'Mettre en pause la lecture' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Parler', exact: true })).toBeInViewport();
  const bounds = await page.getByLabel('Votre demande à l’assistant').boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(568);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(audit.violations.map(item => item.id)).toEqual([]);
  await page.screenshot({ path: 'reports/preview-reading-mobile.png' });
});
