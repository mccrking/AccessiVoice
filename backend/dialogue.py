"""Explicit French form dialogue, separate from the statistical classifier."""
import re
from backend.nlp import normalized, CONFIRMATIONS, CANCELLATIONS
from backend.campus import SERVICES

FIELDS = [('name', 'nom complet'), ('student_id', 'numéro étudiant'), ('reason', 'motif de la demande')]
PROMPTS = {'name': 'Quel est votre nom complet ? Utilisez un nom fictif.', 'student_id': 'Quel est votre numéro étudiant ? Par exemple ETU-001.', 'reason': 'Quel est le motif de votre demande ? Par exemple dossier de stage.'}
KINDS = {
    'attestation': {'attestation', 'une attestation', 'attestation de scolarite', 'une attestation de scolarite'},
    'releve': {'releve', 'un releve', 'releve de notes', 'un releve de notes'},
    'stage': {'stage', 'une convention', 'convention de stage', 'une convention de stage'},
}


def kind_for(text):
    clean = normalized(text)
    return next((key for key, values in KINDS.items() if clean in values), None)


def service_command(text):
    """Full utterances only: no keyword fallback for negations or compounds."""
    clean = normalized(text)
    if clean in {'mon suivi', 'mes demandes', 'suivi des demandes', 'ouvre mon suivi', 'ou en est ma demande', 'montre mes demandes'}:
        return {'intent': 'tracking'}
    if clean in {'ouvre le laboratoire', 'laboratoire ia', 'explique le modele', 'montre le laboratoire', 'ouvre le labo'}:
        return {'intent': 'lab'}
    if clean in {'ouvre l apprentissage', 'mes apprentissages', 'apprentissage personnel'}:
        return {'intent': 'learning'}
    match = re.fullmatch(r'(?:telecharge|telecharger|recupere) (?:mon |ma |le |la |une? )?(attestation(?: de scolarite)?|releve de notes|convention de stage)', clean)
    if match:
        return {'intent': 'download', 'document_type': kind_for(match[1])}
    return None


def valid_value(field, value):
    if field == 'name':
        return 2 <= len(value) <= 100
    if field == 'student_id':
        return bool(re.fullmatch(r'[A-Za-z0-9-]{3,30}', value))
    return 3 <= len(value) <= 500


def view(state, reply=None):
    if state['step'] == 'type':
        message = 'Quelle démarche souhaitez-vous préparer : une attestation de scolarité, un relevé de notes ou une convention de stage ?'
    elif state['step'] == 'review':
        draft = state['draft']
        message = f"Récapitulatif. {SERVICES[draft['request_type']]['title']}. Nom : {draft['name']}. Numéro étudiant : {draft['student_id']}. Motif : {draft['reason']}. Cette demande fictive sera conservée dans votre suivi local. Dites « je confirme », « annuler » ou « corrige le nom en … »."
    else:
        message = PROMPTS[state['step']]
    return {'intent': 'dialogue', 'flow': {**state, 'reply': reply or message}, 'ready': state['step'] == 'review'}


def handle_dialogue(text, state):
    clean = normalized(text)
    generic = {'je veux faire une demande', 'je veux faire une demarche', 'commence une demande', 'nouvelle demande', 'aide moi a remplir le formulaire', 'remplissage guide', 'commencer le formulaire guide'}
    match = re.fullmatch(r'(?:je veux |je souhaite |demande |prepare |prepare une demande de |je voudrais )(?:demander )?(.+)', clean)
    chosen = kind_for(match[1]) if match else None
    if clean in generic or chosen:
        state = {'step': 'name' if chosen else 'type', 'draft': {'name': '', 'student_id': '', 'reason': '', 'request_type': chosen or 'attestation'}}
        return view(state)
    if not state:
        return None
    # These controls keep their normal server semantics, including exact confirmation.
    if clean in CONFIRMATIONS | CANCELLATIONS:
        return None
    if clean in {'repete la question', 'repete', 'relis ma demande', 'recapitulatif', 'verifie ma demande'}:
        return view(state)
    if clean in {'champ precedent', 'reviens au champ precedent'}:
        steps = ['name', 'student_id', 'reason', 'review']
        if state['step'] in steps:
            state = {**state, 'step': steps[max(0, steps.index(state['step']) - 1)]}
        return view(state)
    edit = re.fullmatch(r'(?:corrige|modifie|change) (?:le |mon |la )?(nom(?: complet)?|num[eé]ro(?: [eé]tudiant)?|motif)(?: en| par| avec)?\s+(.+)', text.strip(), re.I)
    if edit:
        field = 'name' if normalized(edit[1]).startswith('nom') else 'student_id' if normalized(edit[1]).startswith('numero') else 'reason'
        value = edit[2].strip()
        if field == 'student_id':
            value = re.sub(r'\s+', '', value).upper()
        if not valid_value(field, value):
            return view(state, 'Cette valeur est incorrecte. ' + PROMPTS[field])
        state = {**state, 'draft': {**state['draft'], field: value}}
        return view(state)
    if state['step'] == 'type':
        chosen = kind_for(text)
        return view({'step': 'name', 'draft': {**state['draft'], 'request_type': chosen}}) if chosen else view(state)
    if state['step'] == 'review':
        return None
    # Recognizable navigation/reading requests must not become form values.
    if re.match(r'^(?:ouvre|lis|telecharge|envoie|montre|retourne|pause|reprends|arrete|stoppe|aide)\b', clean) or clean in {'je veux mes notes', 'mes documents', 'mes demarches', 'accueil'}:
        return None
    field = state['step']
    value = re.sub(r'^(?:écris|ecris)\s+', '', text.strip(), flags=re.I)
    if field == 'student_id':
        value = re.sub(r'\s+', '', value).upper()
    if not valid_value(field, value):
        return view(state, 'La réponse est incomplète ou incorrecte. ' + PROMPTS[field])
    next_step = {'name': 'student_id', 'student_id': 'reason', 'reason': 'review'}[field]
    return view({'step': next_step, 'draft': {**state['draft'], field: value}})
