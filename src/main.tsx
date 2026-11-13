import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Check, CheckCheck, CircleHelp, FileCheck2, FileText, GraduationCap, House, Keyboard, Menu, MessageCircle, Mic, MicOff, Send, Settings2, Volume2, VolumeX, X, History, FlaskConical, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import './styles.css';
import { requestError } from './api';
import { createSessionClient } from './session';
import { createNarration } from './narration';
import type { NarrationState } from './narration';
import { CorrectionCard, LearningSettings, usePersonalLearning } from './learning';
import type { CorrectableCommand } from './learning';
import { createSpeechSession } from './speech';
import type { SpeechSession, SpeechWindow } from './speech';
import { Documents, RequestForm, RequestTracker, useCampus, serviceTitle, services } from './campus';
import type { FormValues, Flow, RequestKind, CampusRequest } from './campus';
import { Lab } from './lab';
import { ProfileSettings, useProfile, GreetingNotice } from './profile';
import { createGreeting, greetingText } from './greeting';
import type { GreetingState } from './greeting';

type Page = 'home' | 'documents' | 'grades' | 'forms' | 'help' | 'settings' | 'tracking' | 'lab' | 'learning';
type Message = { id: number; role: 'assistant' | 'user'; text: string };
type Preferences = { voice: boolean; contrast: boolean; large: boolean; rate: number };
const navigation: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: 'home', label: 'Mon espace', icon: House },
  { page: 'documents', label: 'Mes documents', icon: FileText },
  { page: 'grades', label: 'Mes notes', icon: GraduationCap },
  { page: 'forms', label: 'Mes démarches', icon: FileCheck2 },
  { page: 'tracking', label: 'Mon suivi', icon: History },
  { page: 'learning', label: 'Apprentissage', icon: Sparkles },
  { page: 'lab', label: 'Laboratoire IA', icon: FlaskConical },
];
const initialMessage = 'Bonjour ! Que souhaitez-vous faire ?';
const welcomeGuide = 'Bienvenue dans AccessiVoice. Je peux vous aider à consulter vos notes, ouvrir vos documents ou remplir une demande. Après ce guide, le navigateur pourra vous demander d’autoriser le microphone. Dites par exemple « ouvre mes documents », « je veux mes notes » ou « aide ». Après chaque réponse, je vous redonne la parole. Les téléchargements et les envois demandent toujours une confirmation. Dites « arrête le guidage » ou appuyez sur Échap pour arrêter. Alt plus M permet de parler, et Alt plus H de réécouter ce guide.';
const defaults: Preferences = { voice: false, contrast: false, large: false, rate: 1 };
function savedPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem('accessivoice-preferences') || '{}');
    return { voice: typeof value.voice === 'boolean' ? value.voice : false, contrast: value.contrast === true, large: value.large === true, rate: [0.6, 0.8, 1, 1.2].includes(value.rate) ? value.rate : 1 };
  } catch { return defaults; }
}

function App() {
  const profile = useProfile();
  const [page, setPage] = useState<Page>('home');
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const personalLearning = usePersonalLearning();
  const campus = useCampus();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [lastCommand, setLastCommand] = useState<CorrectableCommand | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [prefs, setPrefs] = useState(savedPreferences);
  const [messages, setMessages] = useState<Message[]>([{ id: 0, role: 'assistant', text: initialMessage }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [listening, setListening] = useState(false);
  const [available, setAvailable] = useState(false);
  const [apiStatus, setApiStatus] = useState<'loading' | 'online' | 'offline'>('loading');
  const [pending, setPending] = useState<{ action: string; form?: FormValues; documentType?: RequestKind; requestReference?: string } | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({ name: '', student_id: '', reason: '' });
  const [submission, setSubmission] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [guided, setGuided] = useState(false);
  const [guideSpeaking, setGuideSpeaking] = useState(false);
  const [guideStatus, setGuideStatus] = useState('');
  const [activity, setActivity] = useState<{ title: string; detail: string }[]>([]);
  const [sessionClient] = useState(() => createSessionClient(() => {
    setPending(null); setLastCommand(null); setCorrectionOpen(false); setFlow(null);
  }));
  const recognition = useRef<SpeechSession | null>(null);
  const chatBottom = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const nextIndex = useRef(-1);
  const lastSpoken = useRef(initialMessage);
  const firstPage = useRef(true);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const assistantPanel = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const assistantLauncher = useRef<HTMLButtonElement>(null);
  const restoreAssistantFocus = useRef(true);
  const requestedFieldFocus = useRef<HTMLElement | null>(null);
  const welcomeButton = useRef<HTMLButtonElement>(null);
  const guidedRef = useRef(false);
  const [narrationState, setNarrationState] = useState<NarrationState>('idle');
  const [greetingState, setGreetingState] = useState<GreetingState>('idle');
  const greeting = useRef<ReturnType<typeof createGreeting> | null>(null);
  if (!greeting.current) greeting.current = createGreeting(setGreetingState);
  const playback = useRef<ReturnType<typeof createNarration> | null>(null);
  if (!playback.current) playback.current = createNarration({
    state: setNarrationState,
    completed: () => { setGuideSpeaking(false); queueListening(); },
    failed: () => {
      stopGuidance();
      setGuideStatus('La lecture du guide ou de la réponse a été interrompue. Alt + M permet de parler ; Alt + K permet d’écrire.');
    },
  });
  const resumeListening = useRef<number | undefined>(undefined);
  const voicePrefs = useRef(prefs);
  voicePrefs.current = prefs;
  const processVoiceCommand = useRef<(text: string) => void>(() => {});
  processVoiceCommand.current = text => { void processCommand(text); };

  function stopGuidance() {
    greeting.current?.cancel();
    guidedRef.current = false;
    setGuided(false); setGuideSpeaking(false);
    window.clearTimeout(resumeListening.current);
    recognition.current?.stop();
    playback.current?.cancel();
  }

  function playGreeting() {
    if (greetingState === 'playing') { greeting.current?.cancel(); return; }
    stopGuidance(); setGuideStatus('');
    greeting.current?.play(profile.name, voicePrefs.current.rate);
  }

  useEffect(() => {
    let attempted = false;
    const welcome = () => {
      if (document.hidden || attempted) return;
      attempted = true;
      greeting.current?.play(profile.name, voicePrefs.current.rate);
    };
    welcome();
    document.addEventListener('visibilitychange', welcome);
    return () => { document.removeEventListener('visibilitychange', welcome); greeting.current?.cancel(); };
  }, []);

  useEffect(() => {
    const text = `${greetingText(profile.name)} Que souhaitez-vous faire ?`;
    setMessages(items => items.map(item => item.id === 0 ? { ...item, text } : item));
    lastSpoken.current = text;
  }, [profile.name]);

  function queueListening() {
    window.clearTimeout(resumeListening.current);
    if (!guidedRef.current) return;
    resumeListening.current = window.setTimeout(() => {
      if (!guidedRef.current || busyRef.current || playback.current?.speaking || recognition.current?.active || document.hidden) return;
      setGuideStatus('À vous de parler. Échap arrête le guidage.');
      setMenuOpen(false); setAssistantOpen(true);
      startMicrophone();
    }, 400);
  }

  function startGuidance() {
    if (busyRef.current) return;
    stopGuidance();
    setMenuOpen(false); setAssistantOpen(true);
    guidedRef.current = true;
    setGuided(true); setGuideSpeaking(true);
    setGuideStatus('Le guide est en cours de lecture. Échap permet de l’arrêter.');
    speak(welcomeGuide, true);
  }

  useEffect(() => {
    // Announced by a screen reader without competing autoplay audio.
    if (!window.location.hash && document.activeElement === document.body) welcomeButton.current?.focus({ preventScroll: true });
    const onVisibility = () => { if (document.hidden) { stopGuidance(); setGuideStatus('Guidage arrêté. Alt + H permet de le relancer.'); } };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      guidedRef.current = false;
      window.clearTimeout(resumeListening.current);
      playback.current?.cancel();
    };
  }, []);

  function openAssistant(voice = false) {
    setMenuOpen(false);
    setAssistantOpen(true);
    window.requestAnimationFrame(() => chatInput.current?.focus());
    if (voice) toggleMicrophone();
  }
  function closeAssistant() {
    stopGuidance();
    setAssistantOpen(false);
  }

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const resize = () => { setCompact(media.matches); setMenuOpen(false); };
    media.addEventListener('change', resize);
    resize();
    return () => media.removeEventListener('change', resize);
  }, []);
  useEffect(() => {
    if (!compact || (!assistantOpen && !menuOpen)) return;
    const panel = assistantOpen ? assistantPanel.current : sidebar.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    restoreAssistantFocus.current = true;
    const frame = window.requestAnimationFrame(() => {
      if (assistantOpen) (pending ? confirmButton.current : chatInput.current)?.focus();
      else panel?.querySelector<HTMLButtonElement>('button')?.focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return;
      const elements = [...panel.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex="0"]')].filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', trapFocus);
      if (restoreAssistantFocus.current) window.requestAnimationFrame(() => {
        if (previous?.isConnected && previous !== document.body && !panel?.contains(previous) && !previous.closest('[inert]')) previous.focus();
        else (assistantOpen ? assistantLauncher.current : menuButton.current)?.focus();
      });
    };
  }, [compact, assistantOpen, menuOpen]);

  useEffect(() => {
    const win = window as SpeechWindow;
    setAvailable(Boolean(win.SpeechRecognition || win.webkitSpeechRecognition));
    fetch('/api/health').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(() => setApiStatus('online')).catch(() => setApiStatus('offline'));
    return () => { recognition.current?.stop(); playback.current?.cancel(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem('accessivoice-preferences', JSON.stringify(prefs)); } catch { /* Private browsing can disable persistence. */ }
    document.documentElement.dataset.contrast = String(prefs.contrast);
    document.documentElement.dataset.large = String(prefs.large);
  }, [prefs]);
  useEffect(() => { if (!compact || assistantOpen) { const log = chatBottom.current?.closest('.assistant-content'); if (log) log.scrollTop = log.scrollHeight; } }, [messages, busy, compact, assistantOpen]);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    pageHeading.current?.focus();
    nextIndex.current = -1;
  }, [page]);
  useEffect(() => {
    if (compact && (assistantOpen || menuOpen)) return;
    const target = requestedFieldFocus.current;
    if (!target) return;
    requestedFieldFocus.current = null;
    const frame = window.requestAnimationFrame(() => { if (target.isConnected) target.focus(); });
    return () => window.cancelAnimationFrame(frame);
  }, [compact, assistantOpen, menuOpen]);
  useEffect(() => { if (page === 'tracking') void campus.refresh(); }, [page]);
  useEffect(() => {
    if (!pending) return;
    if (compact) setAssistantOpen(true);
    const frame = window.requestAnimationFrame(() => confirmButton.current?.focus());
    const timeout = window.setTimeout(() => { setPending(null); setNotice('La confirmation a expiré. Relancez votre demande.'); }, 120000);
    return () => { window.clearTimeout(timeout); window.cancelAnimationFrame(frame); };
  }, [pending, compact]);

  function speak(text: string, force = false) {
    lastSpoken.current = text;
    if (!voicePrefs.current.voice && !force && !guidedRef.current) return;
    greeting.current?.cancel();
    if (!window.speechSynthesis) {
      stopGuidance();
      setGuideStatus('La lecture vocale est indisponible. Utilisez votre lecteur d’écran ; Alt + M lance le microphone et Alt + K permet d’écrire.');
      return;
    }
    window.clearTimeout(resumeListening.current);
    if (recognition.current?.active) recognition.current.stop();
    if (guidedRef.current && text !== welcomeGuide) setGuideStatus('Lecture de la réponse. L’écoute reprendra ensuite.');
    playback.current?.speak(text, voicePrefs.current.rate);
  }
  function respond(text: string, read = true, preserveReading = false) {
    setMessages(items => [...items, { id: Date.now() + Math.random(), role: 'assistant' as const, text }].slice(-60));
    if (preserveReading) return;
    lastSpoken.current = text;
    if (read || guidedRef.current) speak(text);
  }
  function pauseReading() {
    if (playback.current?.pause() || playback.current?.paused) {
      respond('Lecture mise en pause. Dites « reprends la lecture » pour continuer.', false, true);
      queueListening();
    } else respond('Aucune lecture en cours. Dites « lis cette page » pour commencer.');
  }
  function resumeReading() {
    recognition.current?.stop();
    window.clearTimeout(resumeListening.current);
    if (playback.current?.resume()) respond('Lecture reprise.', false, true);
    else respond('Aucune lecture en pause. Dites « lis cette page » pour commencer.');
  }
  function navigate(target: Page) {
    restoreAssistantFocus.current = false;
    setPage(target); setMenuOpen(false); setNotice(''); setPending(null); setCorrectionOpen(false); setFlow(null);
    if (compact) setAssistantOpen(false);
    window.requestAnimationFrame(() => pageHeading.current?.focus());
  }

  async function performConfirmation(current: NonNullable<typeof pending>) {
    const owner = current.action === 'submit' || current.requestReference ? await campus.ensureToken() : undefined;
    const response = await sessionClient.send('actions', { action: current.action, confirmed: true, form: current.form, owner_token: owner, request_reference: current.requestReference });
    setPending(null); setFlow(null);
    if (current.action === 'download') {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = current.documentType === 'releve' ? 'releve-demo.pdf' : current.documentType === 'stage' ? 'convention-demo.pdf' : 'attestation-demo.pdf'; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      respond(`${serviceTitle(current.documentType)} : le téléchargement du PDF fictif a été lancé.`);
      setActivity(items => [{ title: serviceTitle(current.documentType), detail: 'Document de démonstration téléchargé · À l’instant' }, ...items].slice(0, 4));
    } else {
      const result = await response.json();
      if (result.request) campus.remember(result.request);
      setSubmission(result.reference);
      respond(`Votre demande de démonstration est enregistrée sous la référence ${result.reference}. Aucune donnée n’a été envoyée à une université.`);
      setActivity(items => [{ title: 'Demande simulée enregistrée', detail: `${result.reference} · À l’instant` }, ...items].slice(0, 4));
    }
    chatInput.current?.focus();
  }

  async function prepareTrackedDownload(request: CampusRequest) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const token = await campus.ensureToken();
      await sessionClient.send('campus/prepare-download', { token, reference: request.reference });
      setPending({ action: 'download', documentType: request.form.request_type, requestReference: request.reference });
      respond(`Télécharger ${request.title}, référence ${request.reference} ? Dites « je confirme » ou « annuler ».`);
    } catch (cause) { respond(requestError(cause)); }
    finally { busyRef.current = false; setBusy(false); queueListening(); }
  }

  function startRequest(kind: RequestKind) {
    const phrase = kind === 'stage' ? 'Je veux une convention de stage' : kind === 'releve' ? 'Je veux un relevé de notes' : 'Je veux une attestation de scolarité';
    void processCommand(phrase);
  }

  async function processCommand(raw: string) {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    if (compact) setAssistantOpen(true);
    busyRef.current = true; setBusy(true); setNotice(''); setCorrectionOpen(false);
    setInput('');
    setMessages(items => [...items, { id: Date.now(), role: 'user' as const, text }].slice(-60));
    recognition.current?.stop();
    let actionAttempted = false;
    try {
      if (/^(?:arr[eê]te|stoppe|stop|quitte)(?: le)? guidage[.!?]*$/i.test(text)) {
        setLastCommand(null); stopGuidance();
        respond('Le guidage vocal est arrêté. Alt + H permet de le relancer.', false);
        speak('Le guidage vocal est arrêté.', true);
        setGuideStatus('Guidage arrêté. Alt + H permet de le relancer.');
        return;
      }
      // Explicit dictation only fills the currently selected field in our own demo form.
      if (page === 'forms' && !flow && /^(?:écris|ecris)\s+/i.test(text)) {
        setLastCommand(null);
        const fields: (keyof FormValues)[] = ['name', 'student_id', 'reason'];
        const field = fields[nextIndex.current];
        setPending(null);
        if (!field) respond('Sélectionnez d’abord un champ avec « champ suivant », puis dites « écris » suivi du texte.');
        else { setFormValues(v => ({ ...v, [field]: text.replace(/^(?:écris|ecris)\s+/i, '') })); respond('Le champ a été rempli. Vous pouvez le corriger au clavier ou passer au champ suivant.'); }
        return;
      }
      const complete = formValues.name.trim().length >= 2 && /^[A-Za-z0-9-]{3,30}$/.test(formValues.student_id) && formValues.reason.trim().length >= 3;
      const response = await sessionClient.send('commands', { text, page, learner_token: personalLearning.token, reset_dialogue: !flow, form_snapshot: page === 'forms' && complete ? formValues : undefined }, !flow);
      const result = await response.json();
      setApiStatus('online');
      if (result.intent === 'dialogue') {
        setPage('forms'); setSubmission(null); setFlow(result.flow); setFormValues(result.flow.draft); setLastCommand(null);
        setPending(result.ready ? { action: 'submit', form: result.flow.draft } : null);
        respond(result.flow.reply);
        return;
      }
      if (result.flow === null) setFlow(null);
      if (!['confirm', 'cancel'].includes(result.intent)) setLastCommand(result.command_id ? { id: result.command_id, text, intent: result.intent } : null);
      if (result.intent !== 'confirm') setPending(null);
      switch (result.intent) {
        case 'tracking': navigate('tracking'); respond('Voici votre suivi. Les demandes sont fictives et les étapes de traitement sont simulées.'); break;
        case 'lab': navigate('lab'); respond('Voici le laboratoire IA. Vous pouvez analyser une phrase sans exécuter d’action.'); break;
        case 'learning': navigate('learning'); respond('Voici votre apprentissage personnel. Vous pouvez l’activer avec votre accord, le mettre en pause ou l’effacer.'); break;
        case 'home': case 'documents': case 'grades': case 'forms': case 'help':
          navigate(result.intent as Page);
          respond({ home: 'Voici votre espace personnel.', documents: 'Voici vos documents. Votre attestation de scolarité est disponible en démonstration.', grades: 'Voici vos notes de démonstration. Votre moyenne est de 15,4 sur 20.', forms: 'Le formulaire est ouvert. Dites « champ suivant », puis « écris » suivi de votre texte pour remplir chaque champ.', help: 'Voici le guide et les commandes disponibles.' }[result.intent as 'home']);
          break;
        case 'read': {
          const content = document.getElementById('page-content')?.innerText || 'Aucun contenu disponible.';
          respond(content.slice(0, 4000), false); speak(content.slice(0, 4000), true); break;
        }
        case 'pause': pauseReading(); break;
        case 'resume': resumeReading(); break;
        case 'repeat': { const previous = lastSpoken.current; respond(previous, false); speak(previous, true); break; }
        case 'slower': setPrefs(p => ({ ...p, rate: Math.max(0.6, Number((p.rate - 0.2).toFixed(1))) })); respond('La vitesse de lecture a été réduite.', false); break;
        case 'next_field': {
          if (page !== 'forms') { respond('Ouvrez d’abord « Mes démarches » pour parcourir les champs.'); break; }
          const fields = formRef.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
          if (fields?.length) {
            nextIndex.current = (nextIndex.current + 1) % fields.length;
            const field = fields[nextIndex.current];
            if (compact) { restoreAssistantFocus.current = false; requestedFieldFocus.current = field; setAssistantOpen(false); }
            else window.requestAnimationFrame(() => field.focus());
            respond(`Champ ${field.getAttribute('aria-label')}. Dites « écris » suivi de votre texte.`);
          }
          break;
        }
        case 'download':
          setPage('documents'); setPending({ action: 'download', documentType: result.document_type }); respond(`Télécharger ${serviceTitle(result.document_type)} de démonstration au format PDF ? Dites « je confirme » ou « annuler ».`); break;
        case 'submit':
          if (page !== 'forms') { navigate('forms'); respond('Complétez d’abord les trois champs du formulaire, puis demandez son envoi.'); }
          else if (formRef.current?.reportValidity()) { setFlow(null); setPending({ action: 'submit', form: { ...formValues } }); respond(`Récapitulatif. ${serviceTitle(formValues.request_type)}. Nom : ${formValues.name}. Numéro étudiant : ${formValues.student_id}. Motif : ${formValues.reason}. Ces données fictives seront conservées dans votre suivi. Pour cet envoi simulé, dites « je confirme » ou « annuler ».`); }
          else respond('Certains champs sont incomplets ou incorrects. Veuillez vérifier le formulaire avant l’envoi.');
          break;
        case 'confirm':
          if (pending && result.pending_action === pending.action) { actionAttempted = true; await performConfirmation(pending); }
          else { setPending(null); respond('Aucune action à confirmer. Indiquez d’abord ce que vous souhaitez faire.'); }
          break;
        case 'cancel': setPending(null); setFlow(null); respond('L’action a été annulée.'); chatInput.current?.focus(); break;
        default: respond('Je n’ai pas compris votre demande avec assez de certitude. Essayez « ouvre mes documents », « lis cette page » ou « aide ».');
      }
    } catch (error) {
      setPending(null);
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) setApiStatus('offline');
      respond(requestError(error, actionAttempted), false);
    } finally { busyRef.current = false; setBusy(false); queueListening(); }
  }

  async function confirmAction() {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await performConfirmation(pending); }
    catch (error) {
      setPending(null);
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) setApiStatus('offline');
      respond(requestError(error, true));
    }
    finally { busyRef.current = false; setBusy(false); queueListening(); }
  }

  function toggleMicrophone() {
    if (busyRef.current) return;
    if (recognition.current?.active) { stopGuidance(); setGuideStatus('Microphone arrêté. Alt + H relance le guidage.'); return; }
    startMicrophone();
  }
  function startMicrophone() {
    if (busyRef.current) return;
    greeting.current?.cancel();
    const Constructor = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
    if (!Constructor) {
      const wasGuided = guidedRef.current;
      stopGuidance();
      const text = 'La reconnaissance vocale est indisponible dans ce navigateur. Utilisez le champ de commande écrite avec Alt + K.';
      setNotice(text); setGuideStatus(text);
      if (wasGuided) speak(text, true);
      chatInput.current?.focus(); return;
    }
    window.clearTimeout(resumeListening.current);
    playback.current?.pause();
    setGuideSpeaking(false);
    recognition.current = createSpeechSession(Constructor, {
      listening: setListening,
      notice: text => {
        if (text && !recognition.current?.active && guidedRef.current) {
          stopGuidance();
          setGuideStatus(text);
          speak(text, true);
        }
        setNotice(text);
      },
      result: text => processVoiceCommand.current(text),
    });
    recognition.current.start();
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); stopGuidance(); openAssistant(); }
      if (event.altKey && event.key.toLowerCase() === 'm') { event.preventDefault(); if (recognition.current?.active) toggleMicrophone(); else openAssistant(true); }
      if (event.altKey && event.key.toLowerCase() === 'h') { event.preventDefault(); startGuidance(); }
      if (event.key === 'Escape') {
        const wasGuided = guidedRef.current;
        stopGuidance(); if (wasGuided) setGuideStatus('Guidage arrêté. Alt + H relance le guide ; Alt + M permet de parler.'); setMenuOpen(false);
        if (pending) void processCommand('annuler');
        else if (correctionOpen) { setCorrectionOpen(false); chatInput.current?.focus(); }
        else setAssistantOpen(false);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  });

  const title = ({ home: 'Mon espace', documents: 'Mes documents', grades: 'Mes notes', forms: 'Mes démarches', help: 'Aide et commandes', settings: 'Accessibilité', tracking: 'Mon suivi', lab: 'Laboratoire IA', learning: 'Apprentissage personnel' })[page];
  return <div className="app-shell">
    <a className="skip-link" href="#page-content" inert={compact && (assistantOpen || menuOpen)}>Aller au contenu principal</a>
    <aside id="main-navigation" ref={sidebar} className="sidebar" hidden={compact && !menuOpen} inert={compact && assistantOpen} aria-label="Navigation principale">
      <div className="sidebar-heading"><a href="#accueil" className="brand" onClick={event => { event.preventDefault(); navigate('home'); }} aria-label="AccessiVoice, accueil"><span className="brand-mark"><AudioLines size={24} /></span>AccessiVoice</a>{compact && <button className="icon-button" aria-label="Fermer la navigation" onClick={() => setMenuOpen(false)}><X size={22} /></button>}</div>
      <nav aria-label="Services">{navigation.map(({ page: target, label, icon: Icon }) => <button key={target} className={`nav-item ${page === target ? 'active' : ''}`} aria-current={page === target ? 'page' : undefined} onClick={() => navigate(target)}><Icon size={21} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-item ${page === 'help' ? 'active' : ''}`} onClick={() => navigate('help')}><CircleHelp size={21} />Aide et commandes</button><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={21} />Accessibilité</button><button className="profile profile-button" aria-label={`Modifier mon profil, ${profile.name}`} onClick={() => navigate('settings')}><span className="avatar" aria-hidden="true">{profile.initials}</span><span>{profile.name}</span></button></div>
    </aside>
    {compact && menuOpen && <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
    <div className="workspace">
      <header className="topbar" inert={compact && (assistantOpen || menuOpen)}><div className="topbar-title">{compact && <button ref={menuButton} className="icon-button" aria-label="Ouvrir la navigation" aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen(true)}><Menu size={23} /></button>}<span>{title}</span></div><div className="topbar-actions"><span className="demo-badge" title="Les documents, les notes et les demandes sont fictifs.">Démonstration</span><button className="settings-shortcut icon-button" aria-label="Personnaliser l’affichage" onClick={() => navigate('settings')}><Settings2 size={21} /><span>Réglages</span></button></div></header>
      <div className="workspace-body">
        <main id="page-content" className="main-content" tabIndex={-1} inert={compact && (assistantOpen || menuOpen)}>
          <div className="page-title"><h1 ref={pageHeading} tabIndex={-1}>{page === 'home' ? `Bonjour, ${profile.name}` : title}</h1>{page === 'home' && <p>Que souhaitez-vous faire aujourd’hui ?</p>}</div>
          {page === 'home' && <>
            <section className="welcome-help startup-help" aria-labelledby="welcome-help-title"><div><h2 id="welcome-help-title">Un guide pour commencer</h2><p id="startup-instructions">Entrée lance le guide vocal, puis l’écoute. Autorisez le microphone si le navigateur le demande. Alt + M permet de parler ; Échap arrête le guidage.</p><div className="welcome-actions"><button ref={welcomeButton} className="primary-button" aria-describedby="startup-instructions" aria-keyshortcuts="Alt+H" disabled={busy} onClick={startGuidance}><Volume2 size={20} />Démarrer le guidage vocal</button><button className="secondary-button" onClick={() => { stopGuidance(); openAssistant(); }}><Keyboard size={20} />Écrire</button><button className="secondary-button" onClick={playGreeting} disabled={busy || greetingState === 'unavailable'}><Volume2 size={20} />{greetingState === 'playing' ? 'Arrêter la salutation' : 'Écouter la salutation'}</button></div><GreetingNotice state={greetingState} /></div></section>
            <section className="service-grid" aria-label="Vos services">{[
              { page: 'documents' as Page, icon: FileText, label: 'Mes documents', detail: 'Retrouver une attestation', color: 'green' },
              { page: 'grades' as Page, icon: GraduationCap, label: 'Mes notes', detail: 'Consulter mes résultats', color: 'peach' },
              { page: 'forms' as Page, icon: FileCheck2, label: 'Mes démarches', detail: 'Faire une demande', color: 'lavender' },
            ].map(({ page: target, icon: Icon, label, detail, color }) => <button className="service-card" key={target} onClick={() => navigate(target)}><span className={`service-icon ${color}`}><Icon size={25} /></span><span className="service-copy"><strong>{label}</strong><span>{detail}</span></span><ArrowRight size={19} aria-hidden="true" /></button>)}</section>
            <section className="content-panel explore-panel" aria-labelledby="explore-title"><h2 id="explore-title">Un parcours, de la demande au document</h2><p>Choisissez une démarche, laissez-vous guider et retrouvez chaque étape dans votre suivi.</p><div className="explore-actions"><button className="primary-button" disabled={busy} onClick={() => void processCommand('Je veux faire une demande')}>Préparer une demande guidée<ArrowRight size={18} /></button><button className="secondary-button" onClick={() => navigate('tracking')}><History size={18} />Voir mon suivi</button></div><details className="help-details"><summary>Découvrir l’intelligence de l’assistant</summary><p>Le laboratoire explique les décisions du modèle. L’apprentissage personnel permet de lui enseigner vos propres formulations.</p><div className="explore-actions"><button className="text-button" onClick={() => navigate('lab')}>Explorer le laboratoire IA</button><button className="text-button" onClick={() => navigate('learning')}>Découvrir l’apprentissage</button></div></details></section>
            {activity.length > 0 && <section className="content-panel recent-activity" aria-labelledby="activity-title"><h2 id="activity-title">Activité récente</h2>{activity.slice(0, 3).map((item, index) => <div className="activity-item" key={index}><CheckCheck size={21} /><div><strong>{item.title}</strong><p>{item.detail}</p></div></div>)}</section>}
          </>}
          {page === 'documents' && <Documents busy={busy} command={text => void processCommand(text)} request={startRequest} />}
          {page === 'grades' && <section className="content-panel"><div className="section-heading"><h2>Semestre 1</h2><span className="status-tag"><Check size={15} />Validé</span></div><div className="grade-summary"><span>Moyenne générale</span><strong>15,4 <small>/ 20</small></strong></div><table><caption className="sr-only">Notes fictives du semestre 1, modules de même coefficient</caption><thead><tr><th scope="col">Module</th><th scope="col">Note / 20</th></tr></thead><tbody>{[['Machine Learning', '16'], ['Développement et déploiement d’applications intelligentes', '15'], ['Traitement du langage naturel', '15,5'], ['Bases de données avancées', '14'], ['Ingénierie logicielle', '16,5']].map(([module, grade]) => <tr key={module}><th scope="row">{module}</th><td>{grade}</td></tr>)}</tbody></table></section>}
          {page === 'forms' && <RequestForm values={formValues} setValues={value => { setPending(null); setFlow(null); setFormValues(value); }} busy={busy} formRef={formRef} focusField={index => { nextIndex.current = index; }} submission={submission} submit={() => void processCommand('Envoie le formulaire')} guided={() => void processCommand('Commencer le formulaire guidé')} flow={flow} />}
          {page === 'tracking' && <RequestTracker campus={campus} busy={busy} download={request => void prepareTrackedDownload(request)} start={() => navigate('forms')} />}
          {page === 'lab' && <Lab learnerToken={personalLearning.token} />}
          {page === 'learning' && <div className="campus-stack"><section className="content-panel"><span className="eyebrow">UN ASSISTANT QUI S’ADAPTE À VOS MOTS</span><h2>De la correction à l’apprentissage</h2><p>Essayez « mon carnet du campus », corrigez la demande vers les notes et autorisez son enregistrement. La phrase est mémorisée immédiatement ; un modèle personnel est ensuite entraîné et vérifié.</p><ol className="pipeline"><li>Votre correction</li><li>Mémoire personnelle</li><li>Réentraînement</li><li>Tests avant activation</li></ol><button className="secondary-button" onClick={() => navigate('lab')}>Comparer dans le laboratoire<ArrowRight size={18} /></button></section><LearningSettings learning={personalLearning} /></div>}
          {page === 'help' && <section className="content-panel"><h2>Que puis-je demander ?</h2><p className="panel-description">Choisissez un exemple ou dites-le à l’assistant.</p><div className="help-commands">{['Ouvre mes documents', 'Je veux mes notes', 'Ouvre mes démarches', 'Je veux faire une demande', 'Ouvre mon suivi', 'Ouvre le laboratoire', 'Lis cette page', 'Répète', 'Pause', 'Reprends la lecture', 'Plus lentement'].map(command => <button key={command} disabled={busy} onClick={() => void processCommand(command)}><MessageCircle size={18} /><span>{command}</span><ArrowRight size={17} /></button>)}</div><details className="help-details"><summary>Raccourcis clavier</summary><p>Entrée lance le guide au démarrage. Alt + H permet de réécouter le guide, Alt + M de parler, Alt + K d’écrire et Échap d’arrêter le guidage. Tab permet de naviguer.</p></details></section>}
          {page === 'settings' && <><ProfileSettings profile={profile} greet={playGreeting} greetingState={greetingState} /><section className="content-panel"><h2>Lecture et affichage</h2><div className="settings-list">{([{ key: 'voice', icon: Volume2, label: 'Lire les réponses à voix haute' }, { key: 'contrast', icon: Settings2, label: 'Contraste renforcé' }, { key: 'large', icon: BookOpen, label: 'Texte agrandi' }] as const).map(({ key, icon: Icon, label }) => <div className="setting-row" key={key}><Icon size={22} /><strong id={`${key}-label`}>{label}</strong><button role="switch" aria-checked={prefs[key]} aria-labelledby={`${key}-label`} className={`switch ${prefs[key] ? 'on' : ''}`} onClick={() => { if (key === 'voice' && prefs.voice) playback.current?.cancel(); setPrefs(values => ({ ...values, [key]: !values[key] })); }}><span /></button></div>)}<div className="setting-row"><AudioLines size={22} /><label htmlFor="voice-speed">Vitesse de lecture</label><select id="voice-speed" value={prefs.rate} onChange={event => setPrefs(values => ({ ...values, rate: Number(event.target.value) }))}><option value={0.6}>Très lente</option><option value={0.8}>Lente</option><option value={1}>Normale</option><option value={1.2}>Rapide</option></select></div></div><button className="text-button" onClick={() => { playback.current?.cancel(); setPrefs(defaults); }}>Rétablir les réglages par défaut</button></section><LearningSettings learning={personalLearning} /></>}
        </main>
        {compact && assistantOpen && <div className="assistant-backdrop" onClick={closeAssistant} aria-hidden="true" />}
        <aside ref={assistantPanel} id="assistant-panel" className="assistant-panel" hidden={compact && !assistantOpen} role={compact ? 'dialog' : undefined} aria-modal={compact ? true : undefined} aria-labelledby="assistant-title">
          <div className="assistant-heading"><span className="assistant-avatar" aria-hidden="true"><AudioLines size={24} /></span><div><h2 id="assistant-title">Assistant</h2><span className={`assistant-status ${apiStatus === 'offline' ? 'offline' : ''}`}><span />{apiStatus === 'online' ? 'Disponible' : apiStatus === 'offline' ? 'Connexion indisponible' : 'Connexion…'}</span></div><button className="icon-button" aria-label={prefs.voice ? 'Désactiver la lecture automatique' : 'Activer la lecture automatique'} aria-pressed={prefs.voice} onClick={() => { if (prefs.voice) playback.current?.cancel(); setPrefs(values => ({ ...values, voice: !values.voice })); }}>{prefs.voice ? <Volume2 size={21} /> : <VolumeX size={21} />}</button>{compact && <button className="icon-button" aria-label="Fermer l’assistant" onClick={closeAssistant}><X size={23} /></button>}</div>
          <div className="assistant-content">
          {(guided || guideStatus) && <section className="voice-guidance" aria-label="Guidage vocal"><strong>{guided ? guideSpeaking ? 'Guide de démarrage' : 'Guidage vocal actif' : 'Guidage vocal arrêté'}</strong><p aria-live="polite">{guideStatus}</p>{guided ? <button className="text-button" onClick={() => { stopGuidance(); setGuideStatus('Guidage arrêté. Alt + H permet de le relancer.'); }} aria-keyshortcuts="Escape"><MicOff size={18} />Arrêter le guidage vocal</button> : <button className="text-button" disabled={busy} onClick={startGuidance}>Réécouter le guide</button>}</section>}
          {flow && <section className="dialogue-card" aria-label="Démarche guidée"><strong>{flow.step === 'type' ? 'Choisir une démarche' : flow.step === 'review' ? 'Votre récapitulatif est prêt' : 'Remplissage accompagné'}</strong>{flow.step === 'type' ? <div className="dialogue-choices">{services.map(service => <button className="secondary-button" key={service.id} disabled={busy} onClick={() => void processCommand(service.title)}>{service.title}</button>)}</div> : <p>{flow.step === 'review' ? 'Vous pouvez corriger un champ avant de confirmer.' : 'Répondez par écrit ou au microphone. « Annuler » quitte ce parcours.'}</p>}</section>}
          <div className="chat-messages" tabIndex={0} role="log" aria-label="Conversation avec l’assistant" aria-live="polite" aria-relevant="additions">{messages.map(message => <div key={message.id} className={`chat-message ${message.role}`}><span className="sr-only">{message.role === 'assistant' ? 'Assistant : ' : 'Vous : '}</span><p>{message.text}</p></div>)}{busy && <div className="thinking">Un instant…</div>}<div ref={chatBottom} /></div>
          {narrationState !== 'idle' && <div className="reading-controls" role="group" aria-label="Contrôle de la lecture"><span aria-live="polite">{narrationState === 'paused' ? 'Lecture en pause' : 'Lecture en cours'}</span><button className="text-button" disabled={busy} onClick={narrationState === 'paused' ? resumeReading : pauseReading}>{narrationState === 'paused' ? 'Reprendre la lecture' : 'Mettre en pause la lecture'}</button></div>}
          {messages.length === 1 && !guided && <div className="suggestions">{['Lis cette page', 'Ouvre mes documents'].map(text => <button key={text} disabled={busy} onClick={() => void processCommand(text)}>{text}<ArrowRight size={16} /></button>)}</div>}
          {pending && <section className="confirmation" aria-label="Confirmation de l’action"><h3>{pending.action === 'download' ? `Télécharger ${serviceTitle(pending.documentType)} ?` : 'Envoyer cette demande ?'}</h3><p>{pending.action === 'download' ? 'Document fictif · PDF' : 'Démonstration : aucun envoi réel.'}</p>{pending.form && <dl><dt>Démarche</dt><dd>{serviceTitle(pending.form.request_type)}</dd><dt>Nom</dt><dd>{pending.form.name}</dd><dt>Numéro étudiant</dt><dd>{pending.form.student_id}</dd><dt>Motif</dt><dd>{pending.form.reason}</dd></dl>}<div className="confirmation-actions"><button ref={confirmButton} className="primary-button" disabled={busy} onClick={() => void confirmAction()}><Check size={18} />Je confirme</button><button className="secondary-button" disabled={busy} onClick={() => void processCommand('annuler')}>Annuler</button></div></section>}
          {personalLearning.status?.enabled && lastCommand && !pending && !correctionOpen && <div className="learning-feedback"><button className="text-button" disabled={busy} onClick={() => setCorrectionOpen(true)}>Corriger ma demande</button></div>}
          {correctionOpen && personalLearning.status?.enabled && lastCommand && !pending && <CorrectionCard key={lastCommand.id} command={lastCommand} onClose={() => { setCorrectionOpen(false); chatInput.current?.focus(); }} onSave={async intent => { await personalLearning.save(lastCommand, intent, sessionClient.send); setCorrectionOpen(false); setLastCommand(null); respond('Votre formulation est retenue. Réessayez votre demande.'); chatInput.current?.focus(); }} />}
          {notice && !guided && <div className="notice" role="status">{notice}</div>}
          </div>
          <div className="assistant-controls"><button className={`microphone-button ${listening ? 'listening' : ''}`} disabled={busy} onClick={toggleMicrophone} aria-pressed={listening}>{listening ? <MicOff size={22} /> : <Mic size={22} />}<span>{listening ? 'Arrêter le microphone' : 'Parler'}</span></button><form className="chat-form" onSubmit={event => { event.preventDefault(); void processCommand(input); }}><label className="sr-only" htmlFor="chat-input">Votre demande à l’assistant</label><input id="chat-input" ref={chatInput} autoComplete="off" maxLength={500} value={input} onChange={event => setInput(event.target.value)} placeholder="Écrivez votre demande…" /><button aria-label="Envoyer la demande" type="submit" disabled={busy || !input.trim()}><Send size={20} /></button></form>{!available && <p className="microphone-note">Microphone indisponible. Vous pouvez écrire.</p>}</div>
        </aside>
      </div>
    </div>
    {compact && !assistantOpen && !menuOpen && <button ref={assistantLauncher} className="mobile-assistant-launcher" aria-label="Ouvrir l’assistant" aria-controls="assistant-panel" aria-expanded={assistantOpen} onClick={() => openAssistant()}><MessageCircle size={23} />Assistant<Mic size={21} /></button>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
