import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ArrowRight, FileCheck2, FileText, Clock3, CheckCheck, Trash2 } from 'lucide-react';
import { ApiError, post, requestError } from './api';

export type RequestKind = 'attestation' | 'releve' | 'stage';
export type FormValues = { name: string; student_id: string; reason: string; request_type?: RequestKind };
export type Flow = { step: 'type' | 'name' | 'student_id' | 'reason' | 'review'; draft: FormValues; reply?: string };
export const services: { id: RequestKind; title: string; detail: string; delay: string; command: string }[] = [
  { id: 'attestation', title: 'Attestation de scolarité', detail: 'Justifier votre inscription pour un dossier administratif.', delay: '1 à 2 jours ouvrés', command: 'Télécharge mon attestation' },
  { id: 'releve', title: 'Relevé de notes', detail: 'Retrouver les résultats fictifs de votre semestre.', delay: '2 à 3 jours ouvrés', command: 'Télécharge mon relevé de notes' },
  { id: 'stage', title: 'Convention de stage', detail: 'Préparer un exemple pour votre dossier de stage.', delay: '3 à 5 jours ouvrés', command: 'Télécharge ma convention de stage' },
];
export const serviceTitle = (kind?: RequestKind) => services.find(item => item.id === (kind || 'attestation'))!.title;
export type CampusRequest = { reference: string; title: string; form: FormValues; status: 'submitted' | 'processing' | 'ready'; status_label: string; created_at: string; timeline: { status: string; label: string; at: string }[] };
const STORAGE = 'accessivoice-campus-token';

function stored() {
  try { const value = localStorage.getItem(STORAGE); return value && /^[A-Za-z0-9_-]{32,100}$/.test(value) ? value : null; }
  catch { return null; }
}

export function useCampus() {
  const token = useRef<string | null>(stored());
  const creating = useRef<Promise<string> | null>(null);
  const [requests, setRequests] = useState<CampusRequest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function ensureToken() {
    if (token.current) return token.current;
    if (!creating.current) creating.current = (async () => {
      try { localStorage.setItem(`${STORAGE}-test`, '1'); localStorage.removeItem(`${STORAGE}-test`); }
      catch { throw new Error('Autorisez le stockage local pour conserver et gérer votre suivi de démonstration.'); }
      const result = await (await post('campus/profiles', {})).json();
      try { localStorage.setItem(STORAGE, result.token); }
      catch {
        await post('campus/forget', { token: result.token, confirmed: true });
        throw new Error('Le suivi ne peut pas être conservé par ce navigateur.');
      }
      token.current = result.token;
      return result.token as string;
    })().finally(() => { creating.current = null; });
    return creating.current;
  }
  async function refresh() {
    setBusy(true); setError('');
    try {
      if (!token.current) { setRequests([]); return; }
      const data = await (await post('campus/requests', { token: token.current })).json();
      setRequests(data.requests);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) {
        token.current = null; localStorage.removeItem(STORAGE); setRequests([]);
        setError('Le suivi précédent n’est plus disponible. Votre prochaine demande créera un nouveau suivi.');
      } else setError(requestError(cause));
    } finally { setBusy(false); }
  }
  async function advance(reference: string) {
    setBusy(true); setError('');
    try {
      const result = await (await post('campus/advance', { token: await ensureToken(), reference, simulate: true })).json();
      setRequests(items => items.map(item => item.reference === reference ? result : item));
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  async function forget() {
    setBusy(true); setError('');
    try {
      if (token.current) {
        try { await post('campus/forget', { token: token.current, confirmed: true }); }
        catch (cause) { if (!(cause instanceof ApiError && cause.status === 404)) throw cause; }
      }
      localStorage.removeItem(STORAGE); token.current = null; setRequests([]);
    } catch (cause) { setError(requestError(cause)); }
    finally { setBusy(false); }
  }
  function remember(request: CampusRequest) { setRequests(items => [request, ...items.filter(item => item.reference !== request.reference)]); }
  return { requests, error, busy, ensureToken, refresh, advance, forget, remember };
}

export function Documents({ busy, command, request }: { busy: boolean; command(text: string): void; request(kind: RequestKind): void }) {
  return <div className="campus-stack"><section className="welcome-help"><div><h2>Vos documents, en quelques mots</h2><p>Téléchargez un exemple fictif ou préparez une demande personnalisée, puis retrouvez son avancement dans Mon suivi.</p></div></section>{services.map((service, index) => <section className="content-panel" key={service.id}><div className="document-row"><span className={`service-icon ${['green', 'peach', 'lavender'][index]}`}><FileText size={26} /></span><div><h2>{service.title}</h2><p>{service.detail}</p></div><button className="primary-button" disabled={busy} onClick={() => command(service.command)}>{index === 0 ? 'Télécharger' : `Télécharger ${service.id === 'releve' ? 'le relevé' : 'la convention'}`}</button></div><div className="document-footer"><span>Exemple PDF · Sans valeur administrative</span><button className="text-button" disabled={busy} onClick={() => request(service.id)}>Préparer ma demande<ArrowRight size={16} /></button></div></section>)}</div>;
}

export function RequestForm({ values, setValues, busy, formRef, focusField, submission, submit, guided, flow }: {
  values: FormValues; setValues(value: FormValues): void; busy: boolean;
  formRef: RefObject<HTMLFormElement | null>; focusField(index: number): void;
  submission: string | null; submit(): void; guided(): void; flow: Flow | null;
}) {
  const selected = services.find(item => item.id === (values.request_type || 'attestation'))!;
  return <section className="content-panel"><div className="section-heading"><div><h2>Préparer une démarche</h2><p className="panel-description">Trois services, un formulaire accessible et un suivi conservé.</p></div><FileCheck2 size={26} aria-hidden="true" /></div>
    {submission && <div className="success-message" role="status"><CheckCheck size={23} /><div><strong>Demande simulée enregistrée</strong><p>Référence : {submission}. Aucune transmission externe. Retrouvez-la dans Mon suivi.</p></div></div>}
    <div className="guided-start"><div><strong>Un accompagnement étape par étape</strong><p>L’assistant demande les informations manquantes et permet de les corriger avant confirmation.</p></div><button className="secondary-button" disabled={busy} onClick={guided}>Commencer le formulaire guidé</button></div>
    {flow && <p className="flow-progress">Parcours guidé : {({ type: 'choix de la démarche', name: '1/3 · nom complet', student_id: '2/3 · numéro étudiant', reason: '3/3 · motif', review: 'vérification finale' })[flow.step]}</p>}
    <form ref={formRef} className="request-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label htmlFor="request-type">Type de démarche</label><select id="request-type" value={values.request_type || 'attestation'} onChange={event => setValues({ ...values, request_type: event.target.value as RequestKind })}>{services.map(service => <option key={service.id} value={service.id}>{service.title}</option>)}</select>
      <p className="field-help">Délai fictif : {selected.delay}. Aucune demande ne part vers une université.</p>
      <label htmlFor="student-name">Nom complet</label><input id="student-name" aria-label="Nom complet" required minLength={2} maxLength={100} value={values.name} placeholder="Ex. : Amine Démo" onFocus={() => focusField(0)} onChange={event => setValues({ ...values, name: event.target.value })} />
      <label htmlFor="student-id">Numéro étudiant</label><input id="student-id" aria-label="Numéro étudiant" required pattern="[A-Za-z0-9-]{3,30}" title="3 à 30 lettres, chiffres ou tirets" maxLength={30} value={values.student_id} placeholder="Ex. : ETU-001" onFocus={() => focusField(1)} onChange={event => setValues({ ...values, student_id: event.target.value })} />
      <label htmlFor="reason">Motif de la demande</label><textarea id="reason" aria-label="Motif de la demande" required minLength={3} maxLength={500} rows={4} value={values.reason} placeholder="Ex. : Dossier de stage" onFocus={() => focusField(2)} onChange={event => setValues({ ...values, reason: event.target.value })} />
      <p className="field-help">Après confirmation, ces informations fictives seront enregistrées dans votre suivi de démonstration. Vous pourrez effacer ce suivi.</p>
      <button className="primary-button" type="submit" disabled={busy}>Vérifier ma demande<ArrowRight size={19} /></button>
    </form><details className="help-details"><summary>Commandes de remplissage</summary><p>Mode simple : « champ suivant », puis « écris » suivi du texte. Mode guidé : répondez à la question, dites « champ précédent », « répète la question » ou « corrige le nom en Amine Démo ». « Annuler » quitte le parcours.</p></details>
  </section>;
}

export function RequestTracker({ campus, download, start, busy }: { campus: ReturnType<typeof useCampus>; download(request: CampusRequest): void; start(): void; busy: boolean }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const shown = campus.requests.filter(item => (filter === 'all' || item.status === filter) && `${item.reference} ${item.title}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr')));
  const counts = { submitted: 0, processing: 0, ready: 0 };
  campus.requests.forEach(item => counts[item.status]++);
  return <div className="campus-stack"><section className="content-panel"><div className="section-heading"><div><h2>Du dépôt au document prêt</h2><p className="panel-description">Un circuit administratif simulé, avec un historique conservé après rechargement.</p></div><button className="secondary-button" disabled={busy || campus.busy} onClick={() => void campus.refresh()}>Actualiser</button></div><div className="summary-grid">{([['submitted', 'Déposées'], ['processing', 'En traitement'], ['ready', 'Documents prêts']] as const).map(([status, label]) => <div key={status}><strong>{counts[status]}</strong><span>{label}</span></div>)}</div><div className="tracker-filters"><div><label htmlFor="request-search">Rechercher une demande</label><input id="request-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Référence ou démarche" /></div><div><label htmlFor="request-status">Statut</label><select id="request-status" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Tous les statuts</option><option value="submitted">Déposée</option><option value="processing">En traitement</option><option value="ready">Document prêt</option></select></div></div></section>
    {campus.error && <p className="notice" role="alert">{campus.error}</p>}
    {campus.busy && <p role="status">Chargement du suivi…</p>}
    {!campus.busy && shown.length === 0 && <section className="content-panel empty-state"><Clock3 size={32} /><h2>{campus.requests.length ? 'Aucune demande pour ces filtres' : 'Votre suivi commence ici'}</h2><p>Préparez une démarche et confirmez-la pour retrouver son historique.</p><button className="primary-button" disabled={busy} onClick={start}>Nouvelle démarche</button></section>}
    {shown.map(request => <article className="content-panel request-card" key={request.reference} aria-label={`${request.title} ${request.reference}`}><div className="section-heading"><div><span className="request-reference">{request.reference}</span><h2>{request.title}</h2></div><span className={`request-status ${request.status}`}>{request.status_label}</span></div><p>{request.form.name} · {request.form.student_id}</p><ol className="request-timeline" aria-label="Historique de la demande">{request.timeline.map(event => <li key={event.status}><CheckCheck size={17} aria-hidden="true" /><span>{event.label}<time dateTime={event.at}>{new Date(event.at).toLocaleString('fr-FR')}</time></span></li>)}</ol><details className="help-details"><summary>Voir les informations de la demande</summary><p>Motif : {request.form.reason}</p><p>Demande fictive. Les changements de statut sont déclenchés manuellement pour la démonstration.</p></details><div className="request-actions">{request.status === 'ready' ? <button className="primary-button" disabled={busy || campus.busy} onClick={() => download(request)}>Obtenir le document</button> : <button className="secondary-button" disabled={busy || campus.busy} onClick={() => void campus.advance(request.reference)}>Simuler l’étape suivante</button>}<span>{request.status === 'ready' ? 'PDF fictif après confirmation' : 'Simulation locale · Aucun traitement universitaire réel'}</span></div></article>)}
    {campus.requests.length > 0 && <section className="content-panel"><h2>Gérer mes données de démonstration</h2><p>Effacer le suivi supprime toutes vos demandes et leurs informations enregistrées. L’apprentissage personnel se gère séparément.</p>{confirmDelete ? <div className="request-actions"><button className="secondary-button" disabled={campus.busy || busy} onClick={() => { void campus.forget().then(() => setConfirmDelete(false)); }}>Confirmer l’effacement du suivi</button><button className="text-button" onClick={() => setConfirmDelete(false)}>Conserver mon suivi</button></div> : <button className="text-button" disabled={campus.busy || busy} onClick={() => setConfirmDelete(true)}><Trash2 size={17} />Effacer mon suivi</button>}</section>}
  </div>;
}
