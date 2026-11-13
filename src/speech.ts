type SpeechResult = { readonly isFinal: boolean; readonly [index: number]: { transcript: string } };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort?(): void;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
export type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
export type SpeechSession = { start(): void; stop(): void; readonly active: boolean };

const errors: Record<string, string> = {
  'not-allowed': 'Accès au microphone refusé. Autorisez le microphone dans les réglages du site et de votre appareil, puis réessayez.',
  'service-not-allowed': 'Le service vocal est bloqué par ce navigateur. Ouvrez cette page dans un navigateur autorisant la reconnaissance vocale, puis autorisez le microphone.',
  'audio-capture': 'Microphone inaccessible. Vérifiez qu’il est branché, sélectionné et disponible dans les réglages audio de votre appareil.',
  network: 'Le service de reconnaissance vocale est injoignable. Vérifiez votre connexion Internet. Si le problème persiste, essayez cette page dans un autre navigateur.',
  'language-not-supported': 'La reconnaissance du français n’est pas disponible dans ce navigateur. Essayez un autre navigateur ou écrivez votre demande.',
  aborted: 'L’écoute a été interrompue par le navigateur. Appuyez sur Parler pour réessayer.',
};

// One user gesture starts one command, with bounded retries for silence only.
// Permission, capture and network failures require a new explicit gesture.
export function createSpeechSession(
  Constructor: new () => Recognition,
  callbacks: { listening(value: boolean): void; notice(text: string): void; result(text: string): void },
): SpeechSession {
  let active = false;
  let instance: Recognition | null = null;
  let attempts = 0;
  let retry: number | undefined;
  let deadline: number | undefined;

  function stop() {
    active = false;
    window.clearTimeout(retry);
    window.clearTimeout(deadline);
    const previous = instance;
    instance = null;
    callbacks.listening(false);
    callbacks.notice('');
    try { if (previous?.abort) previous.abort(); else previous?.stop(); } catch { /* Already ended. */ }
  }
  function fail(message: string) { stop(); callbacks.notice(message); }
  function attempt() {
    if (!active) return;
    attempts++;
    try {
      const current = new Constructor();
      instance = current;
      current.lang = 'fr-FR';
      current.continuous = true;
      current.interimResults = true;
      const isCurrent = () => active && instance === current;
      current.onstart = () => { if (isCurrent()) callbacks.notice('Je vous écoute… Parlez, puis faites une pause.'); };
      current.onresult = event => {
        if (!isCurrent()) return;
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (!result.isFinal) continue;
          const text = result[0]?.transcript.trim();
          if (text) { stop(); callbacks.result(text); return; }
        }
      };
      current.onerror = event => {
        if (!isCurrent()) return;
        if (event.error === 'no-speech') { callbacks.notice('Je vous écoute encore… Vous pouvez parler.'); return; }
        fail(errors[event.error] || `La reconnaissance vocale a échoué (${event.error}). Réessayez ou écrivez votre demande.`);
      };
      current.onend = () => {
        if (!isCurrent()) return;
        instance = null;
        if (attempts >= 3) { fail('Aucune parole reconnue. Vérifiez le microphone, puis appuyez sur Parler pour réessayer.'); return; }
        retry = window.setTimeout(attempt, 250);
      };
      current.start();
    } catch {
      fail('L’écoute n’a pas pu démarrer. Vérifiez l’autorisation du microphone, puis réessayez.');
    }
  }
  return {
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      attempts = 0;
      callbacks.listening(true);
      callbacks.notice('Démarrage du microphone…');
      deadline = window.setTimeout(() => fail('L’écoute s’est arrêtée après 30 secondes. Appuyez sur Parler pour réessayer.'), 30000);
      attempt();
    },
    stop,
  };
}
