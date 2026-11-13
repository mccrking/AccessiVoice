export type NarrationState = 'idle' | 'speaking' | 'paused';

// Keep the utterance alive while listening. cancel() would discard the text
// and make a subsequent voice command to resume ineffective.
export function createNarration(callbacks: {
  state(value: NarrationState): void;
  completed(): void;
  failed(): void;
}) {
  let current: SpeechSynthesisUtterance | null = null;
  let state: NarrationState = 'idle';
  let deadline: number | undefined;
  let remaining = 0;
  let started = 0;

  function update(value: NarrationState) { state = value; callbacks.state(value); }
  function cancel() {
    current = null;
    window.clearTimeout(deadline);
    update('idle');
    window.speechSynthesis?.cancel();
  }
  function fail() { cancel(); callbacks.failed(); }
  function arm() {
    started = Date.now();
    deadline = window.setTimeout(fail, remaining);
  }

  return {
    get speaking() { return state === 'speaking'; },
    get paused() { return state === 'paused'; },
    cancel,
    speak(text: string, rate: number) {
      cancel();
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) { callbacks.failed(); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'fr-FR';
      utterance.rate = rate;
      const voice = window.speechSynthesis.getVoices().find(value => value.lang.startsWith('fr'));
      if (voice) utterance.voice = voice;
      current = utterance;
      utterance.onend = () => {
        if (current !== utterance) return;
        current = null;
        window.clearTimeout(deadline);
        update('idle');
        callbacks.completed();
      };
      utterance.onerror = () => { if (current === utterance) fail(); };
      remaining = Math.max(45000, text.length * 180);
      update('speaking');
      arm();
      try {
        // Some browsers retain their paused flag after cancelling an utterance.
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utterance);
      } catch { fail(); }
    },
    pause() {
      if (!current || state !== 'speaking') return false;
      window.clearTimeout(deadline);
      remaining = Math.max(1000, remaining - (Date.now() - started));
      update('paused');
      window.speechSynthesis.pause();
      return true;
    },
    resume() {
      if (!current || state !== 'paused') return false;
      update('speaking');
      arm();
      window.speechSynthesis.resume();
      return true;
    },
  };
}
