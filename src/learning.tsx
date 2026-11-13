import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, RefreshCw, Trash2, X } from 'lucide-react';
import { ApiError, post } from './api';

const STORAGE = 'accessivoice-learning-token';
export type LearningStatus = { enabled: boolean; corrections: number; revision: number; model_revision: number; state: string; detail: string };
export type CorrectableCommand = { id: string; text: string; intent: string };
const choices = [
  ['home', 'Ouvrir mon espace'], ['documents', 'Consulter mes documents'], ['grades', 'Consulter mes notes'],
  ['forms', 'Ouvrir mes démarches'], ['read', 'Lire la page'], ['next_field', 'Passer au champ suivant'],
  ['repeat', 'Répéter la réponse'], ['pause', 'Mettre la lecture en pause'], ['resume', 'Reprendre la lecture'],
  ['slower', 'Ralentir la lecture'], ['help', 'Afficher l’aide'], ['unknown', 'Ne réaliser aucune action'],
];

function storedToken() {
  try { const value = localStorage.getItem(STORAGE); return value && /^[A-Za-z0-9_-]{32,100}$/.test(value) ? value : null; }
  catch { return null; }
}

export function usePersonalLearning() {
  const [token, setToken] = useState(storedToken);
  const tokenRef = useRef(token);
  const mutation = useRef(0);
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    if (!token) return;
    const generation = mutation.current;
    try {
      const response = await post('learning/status', { token });
      const result = await response.json();
      if (tokenRef.current === token && generation === mutation.current) setStatus(result);
    } catch (cause) {
      if (tokenRef.current !== token || generation !== mutation.current) return;
      if (tokenRef.current === token && generation === mutation.current && cause instanceof ApiError && cause.status === 404) {
        localStorage.removeItem(STORAGE); tokenRef.current = null; setToken(null); setStatus(null);
        setError('Le profil précédent n’est plus disponible. Vous pouvez activer un nouvel apprentissage.');
        return;
      }
      throw cause;
    }
  }, [token]);
  useEffect(() => { if (token) void refresh().catch(() => setError('Le profil d’apprentissage est indisponible. Vous pouvez l’effacer ou réessayer.')); }, [refresh, token]);
  useEffect(() => {
    if (!token || !status || !['queued', 'training'].includes(status.state)) return;
    const timer = window.setInterval(() => { void refresh().catch(() => setError('Le suivi de l’apprentissage est momentanément indisponible.')); }, 2000);
    return () => window.clearInterval(timer);
  }, [token, status?.state, refresh]);

  async function toggle(enabled: boolean) {
    mutation.current++;
    setBusy(true); setError('');
    try {
      if (token) { const result = await (await post('learning/toggle', { token, enabled })).json(); mutation.current++; setStatus(result); }
      else if (enabled) {
        try { localStorage.setItem(`${STORAGE}-test`, '1'); localStorage.removeItem(`${STORAGE}-test`); }
        catch { throw new Error('Le stockage local doit être autorisé pour conserver et gérer votre profil personnel.'); }
        const result = await (await post('learning/create', { consent: true })).json();
        try { localStorage.setItem(STORAGE, result.token); }
        catch { await post('learning/forget', { token: result.token }); throw new Error('Le navigateur ne peut pas conserver le profil. Aucun apprentissage n’a été activé.'); }
        tokenRef.current = result.token; mutation.current++; setToken(result.token); setStatus(result);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Impossible de modifier l’apprentissage.'); }
    finally { setBusy(false); }
  }

  async function forget() {
    if (!token) return;
    mutation.current++; setBusy(true); setError('');
    try {
      try { await post('learning/forget', { token }); }
      catch (cause) { if (!(cause instanceof ApiError && cause.status === 404)) throw cause; }
      localStorage.removeItem(STORAGE);
      tokenRef.current = null; mutation.current++; setToken(null); setStatus(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Impossible d’effacer les apprentissages.'); }
    finally { setBusy(false); }
  }

  async function save(command: CorrectableCommand, expected: string, send: (path: string, body: Record<string, unknown>) => Promise<Response>) {
    if (!token || !status?.enabled) throw new Error('Activez d’abord l’apprentissage personnel.');
    mutation.current++;
    const response = await send('learning/feedback', { token, command_id: command.id, expected_intent: expected, consent: true });
    const result = await response.json(); mutation.current++;
    if (tokenRef.current === token) setStatus(result);
  }
  return { token: status?.enabled ? token : null, hasProfile: Boolean(token), status, busy, error, toggle, forget, save };
}

type Learning = ReturnType<typeof usePersonalLearning>;

export function LearningSettings({ learning }: { learning: Learning }) {
  const [consent, setConsent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const id = useId();
  const updating = ['queued', 'training'].includes(learning.status?.state || '');
  return <section className="content-panel learning-settings" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Apprendre avec vous</h2>
    <p className="panel-description">Corrigez une demande pour que l’assistant reconnaisse vos expressions.</p>
    <div className="learning-state" role="status"><span className={`learning-dot ${learning.status?.enabled ? 'enabled' : ''}`} /><div><strong>{learning.status?.enabled ? 'Apprentissage activé' : learning.hasProfile ? 'Apprentissage en pause' : 'Apprentissage désactivé'}</strong>{learning.status && <p>{learning.status.corrections} expression(s) retenue(s)</p>}{updating && <p>Mise à jour en cours…</p>}{learning.status?.state === 'ready' && <p>Vos expressions sont à jour.</p>}{learning.status?.state === 'rejected' && <p>Vos expressions restent mémorisées.</p>}{learning.status?.state === 'failed' && <p>La mise à jour n’a pas abouti. Vos expressions sont conservées.</p>}</div>{updating && <RefreshCw size={18} aria-label="Mise à jour en cours" />}</div>
    {!learning.status?.enabled && <label className="consent-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>J’accepte que mes corrections soient enregistrées pour personnaliser l’assistant.</span></label>}
    <div className="learning-buttons"><button className="primary-button" disabled={learning.busy || (!learning.status?.enabled && !consent)} onClick={() => { void learning.toggle(!learning.status?.enabled); setConsent(false); }}>{learning.status?.enabled ? 'Mettre en pause' : 'Activer l’apprentissage'}</button>{learning.hasProfile && !confirmDelete && <button className="secondary-button" disabled={learning.busy} onClick={() => setConfirmDelete(true)}><Trash2 size={17} />Effacer mes apprentissages</button>}</div>
    {confirmDelete && <div className="delete-learning"><p>Effacer définitivement vos expressions enregistrées ?</p><button className="secondary-button" disabled={learning.busy} onClick={() => { void learning.forget().then(() => setConfirmDelete(false)); }}>Oui, effacer mes apprentissages</button><button className="text-button" disabled={learning.busy} onClick={() => setConfirmDelete(false)}>Annuler</button></div>}
    {learning.error && <p className="learning-error" role="alert">{learning.error}</p>}
    <details className="help-details"><summary>Vos données et votre confidentialité</summary><p>Seules les expressions que vous corrigez et autorisez sont enregistrées. Utilisez des phrases sans informations personnelles.</p><p>Vous pouvez mettre l’apprentissage en pause ou l’effacer à tout moment. Les envois et les téléchargements demandent toujours votre confirmation.</p><p>L’application ne conserve pas votre audio. La reconnaissance vocale peut utiliser un service de votre navigateur.</p></details>
  </section>;
}

export function CorrectionCard({ command, onSave, onClose }: { command: CorrectableCommand; onSave: (intent: string) => Promise<void>; onClose: () => void }) {
  const [expected, setExpected] = useState(choices.some(([key]) => key === command.intent) && command.intent !== 'unknown' ? command.intent : '');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const selection = useRef<HTMLSelectElement>(null);
  useEffect(() => { selection.current?.focus(); }, []);
  return <section className="correction-card" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><h3 id={`${id}-title`}>Corriger ma demande</h3><button className="icon-button" aria-label="Fermer la correction" onClick={onClose}><X size={21} /></button></div>
    <p className="correction-phrase">« {command.text} »</p>
    <form onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void onSave(expected).catch(cause => setError(cause instanceof Error ? cause.message : 'La correction n’a pas pu être enregistrée.')).finally(() => setBusy(false)); }}>
      <label htmlFor={`${id}-intent`}>La bonne action</label><select ref={selection} id={`${id}-intent`} required value={expected} onChange={event => setExpected(event.target.value)}><option value="">Choisir une action</option>{choices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <label className="consent-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>J’autorise l’enregistrement de cette expression, sans informations personnelles.</span></label>
      <button className="primary-button" type="submit" disabled={busy || !consent || !expected}><Check size={18} />Retenir cette expression</button>
      {error && <p className="learning-error" role="alert">{error}</p>}
    </form>
  </section>;
}
