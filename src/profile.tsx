import { useEffect, useState } from 'react';
import { UserRound, Volume2 } from 'lucide-react';
import type { GreetingState } from './greeting';

const STORAGE = 'accessivoice-profile';
const DEFAULT_NAME = 'Utilisateur Démo';
const cleanName = (value: string) => value.replace(/\s+/g, ' ').trim();

function savedName() {
  try {
    const profile = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    const name = typeof profile?.name === 'string' ? cleanName(profile.name) : '';
    return name.length > 0 && name.length <= 60 ? name : DEFAULT_NAME;
  } catch { return DEFAULT_NAME; }
}

export function useProfile() {
  const [name, setName] = useState(savedName);
  function save(value: string) {
    const next = cleanName(value);
    if (!next || next.length > 60) throw new Error('Saisissez un nom de 1 à 60 caractères.');
    try { localStorage.setItem(STORAGE, JSON.stringify({ name: next })); }
    catch { throw new Error('Le navigateur ne peut pas enregistrer ce nom. Autorisez le stockage local, puis réessayez.'); }
    setName(next);
  }
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase('fr');
  return { name, initials, save };
}

export function GreetingNotice({ state }: { state: GreetingState }) {
  if (state !== 'blocked' && state !== 'unavailable') return null;
  return <p className="greeting-notice" role="status">{state === 'blocked' ? 'La salutation n’a pas pu être lue. Utilisez le bouton de salutation pour réessayer après une interaction.' : 'La lecture vocale est indisponible dans ce navigateur. Votre nom reste affiché à l’écran.'}</p>;
}

export function ProfileSettings({ profile, greet, greetingState }: { profile: ReturnType<typeof useProfile>; greet(): void; greetingState: GreetingState }) {
  const [draft, setDraft] = useState(profile.name);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setDraft(profile.name); }, [profile.name]);
  return <section className="content-panel profile-settings" aria-labelledby="profile-title"><div className="section-heading"><h2 id="profile-title">Mon profil</h2><UserRound size={24} aria-hidden="true" /></div><p>Choisissez le nom affiché dans votre espace et prononcé à l’ouverture : « Salut {profile.name} ! »</p><GreetingNotice state={greetingState} /><form className="profile-form" onSubmit={event => {
    event.preventDefault(); setNotice(''); setError('');
    try { profile.save(draft); setNotice('Votre nom a été enregistré. Il sera conservé à la prochaine ouverture.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Impossible de modifier le profil.'); }
  }}><label htmlFor="profile-name">Nom d’utilisateur</label><input id="profile-name" name="nickname" autoComplete="nickname" required maxLength={60} value={draft} onChange={event => { setDraft(event.target.value); setNotice(''); setError(''); }} aria-describedby="profile-description" /><p id="profile-description" className="field-help">Ce nom est conservé dans ce navigateur. Les noms des demandes se renseignent dans leurs formulaires.</p><div className="explore-actions"><button className="primary-button" type="submit">Enregistrer mon nom</button><button className="secondary-button" type="button" onClick={greet}><Volume2 size={18} />{greetingState === 'playing' ? 'Arrêter la salutation' : 'Écouter ma salutation'}</button></div></form>{notice && <p className="profile-notice" role="status">{notice}</p>}{error && <p className="notice" role="alert">{error}</p>}</section>;
}
