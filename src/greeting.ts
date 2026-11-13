export type GreetingState = 'idle' | 'playing' | 'done' | 'blocked' | 'unavailable';
export const greetingText = (name: string) => `Salut ${name} !`;

// A brief greeting never starts speech recognition. Failed autoplay is retried
// only by an explicit button; delayed events cannot restart a cancelled greeting.
export function createGreeting(changed: (state: GreetingState) => void) {
  let current: SpeechSynthesisUtterance | null = null;
  let deadline: number | undefined;
  function cancel() {
    window.clearTimeout(deadline);
    const previous = current;
    current = null;
    if (previous) window.speechSynthesis?.cancel();
    changed('idle');
  }
  function play(name: string, rate = 1) {
    cancel();
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) { changed('unavailable'); return; }
    try {
      const utterance = new SpeechSynthesisUtterance(greetingText(name));
      utterance.lang = 'fr-FR';
      utterance.rate = rate;
      const voice = window.speechSynthesis.getVoices().find(item => item.lang.startsWith('fr'));
      if (voice) utterance.voice = voice;
      current = utterance;
      const blocked = () => {
        if (current !== utterance) return;
        cancel(); changed('blocked');
      };
      utterance.onstart = () => {
        if (current !== utterance) return;
        window.clearTimeout(deadline);
        deadline = window.setTimeout(blocked, 15000);
      };
      utterance.onend = () => {
        if (current !== utterance) return;
        current = null; window.clearTimeout(deadline); changed('done');
      };
      utterance.onerror = blocked;
      changed('playing');
      deadline = window.setTimeout(blocked, 4000);
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utterance);
    } catch { cancel(); changed('blocked'); }
  }
  return { play, cancel };
}
