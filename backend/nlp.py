"""Reproducible French intent model with development-only selection and safe abstention."""
import hashlib
import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FeatureUnion, Pipeline
from backend.languages import multilingual_decision, blocked_multilingual

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data/intents.json'
CORPUS = ROOT / 'data/corpus.json'
ARTIFACT = ROOT / 'backend/runtime/intent_model.joblib'
VERSION = '0.2.0'


def normalized(text):
    text = unicodedata.normalize('NFKD', text.lower())
    return ' '.join(''.join(c if c.isalnum() else ' ' for c in text if not unicodedata.combining(c)).split())


def dataset():
    return json.loads(DATA.read_text(encoding='utf-8'))


def data_hash():
    return hashlib.sha256(CORPUS.read_bytes()).hexdigest()


def make_model(c=12):
    return Pipeline([
        ('features', FeatureUnion([
            ('words', TfidfVectorizer(preprocessor=normalized, ngram_range=(1, 2), sublinear_tf=True)),
            ('characters', TfidfVectorizer(preprocessor=normalized, analyzer='char_wb', ngram_range=(3, 5), sublinear_tf=True)),
        ])),
        ('classifier', LogisticRegression(C=c, class_weight='balanced', max_iter=2000, random_state=42)),
    ])


CONFIRMATIONS = {'oui', 'oui je confirme', 'je confirme', 'confirmer', 'confirme', 'valider cette action'}
CANCELLATIONS = {'non', 'annuler', 'annule', 'non annule', 'je refuse', 'annule cette action', 'annule l action', 'laisse tomber'}
DOWNLOAD = r'\b(telecharg\w*|telecharj\w*|recuper\w*|sauvegard\w*|enregistr\w*|obtenir)\b'
OPERATIONS = r'\b(ouvr\w*|affich\w*|consult\w*|retour\w*|accueil|notes|documents|demarch\w*|lis|lire|lectur\w*|envoi\w*|soumet\w*|valid\w*|telecharg\w*|annul\w*|confirm\w*)\b'


def rule_decision(text):
    """Conservative capability boundary, not a general French language parser."""
    clean = normalized(text)
    multilingual = multilingual_decision(text)
    if multilingual is not None:
        return multilingual
    if blocked_multilingual(text):
        return 'unknown', 0.0
    if clean in CONFIRMATIONS:
        return 'confirm', 1.0
    if clean in CANCELLATIONS:
        return 'cancel', 1.0
    if not clean or re.search(r'\b(pas|jamais|aucun\w*|sans|ne|ni|refus\w*|evit\w*)\b', clean) or re.search(r'\bn (envoi\w*|envoy\w*|autoris\w*|ouvr\w*|telecharg\w*)\b', clean):
        return 'unknown', 0.0
    if re.search(r'\b(supprim\w*|effac\w*|achet\w*|pay\w*|paie\w*|modifi\w*|install\w*|desinstall\w*|imprim\w*|bancair\w*|banque|medic\w*|sante|sang|facebook|youtube|mail|email|courriel|sms|employeur|entreprise|contact\w*|prive\w*|mot de passe|telephone|reunion)\b', clean):
        return 'unknown', 0.0
    if re.search(r'\b(peut etre|eventuellement|probablement|si|demain|plus tard|attends|avant d|quand|ignore|contourne|system|administrateur|code|confirme|confirmer)\b', clean):
        return 'unknown', 0.0
    if re.search(r'\b(hier|professeur|mon ami|la phrase|le mot|signifie|qu est ce|je pensais|je me demande|j aime|c est quoi)\b', clean):
        return 'unknown', 0.0
    clauses = re.split(r'\b(?:et|puis|ensuite|ou)\b|;', text.lower())
    if sum(bool(re.search(OPERATIONS, normalized(part))) for part in clauses) > 1:
        return 'unknown', 0.0
    if re.search(DOWNLOAD, clean):
        if re.search(r'\b(notes|releve|bulletin|diplome|photo\w*|video\w*|livre|identite)\b', clean):
            return 'unknown', 0.0
        if not re.search(r'\b(attest\w*|atest\w*|certif\w*|document\w*|pdf|scolar\w*)\b', clean):
            return 'unknown', 0.0
    return None


def decide(text, classes, probabilities, threshold, margin):
    rule = rule_decision(text)
    if rule is not None:
        return rule
    order = np.argsort(probabilities)
    score = float(probabilities[order[-1]])
    if score < threshold or score - float(probabilities[order[-2]]) < margin:
        return 'unknown', round(score, 4)
    intent = str(classes[order[-1]])
    # Discussing how an action works is not a request to start that action.
    if intent in {'download', 'submit'} and re.search(r'\b(comment|pourquoi|savoir|signifie|explique\w*)\b', normalized(text)):
        return 'unknown', round(score, 4)
    return intent, round(score, 4)


def train_model():
    """Select only on development data, then save atomically. Never read test data."""
    from sklearn.metrics import accuracy_score, f1_score
    records = json.loads(CORPUS.read_text(encoding='utf-8'))['records']
    train = [row for row in records if row['split'] == 'train']
    dev = [row for row in records if row['split'] == 'dev']
    texts, labels = [r['text'] for r in train], [r['intent'] for r in train]
    expected = [row['intent'] for row in dev]
    trials, best, selected = [], None, None
    for c in [2, 6, 12, 24]:
        model = make_model(c).fit(texts, labels)
        probabilities = model.predict_proba([row['text'] for row in dev])
        for threshold in [0.32, 0.45, 0.58, 0.70]:
            for margin in [0.10, 0.18, 0.26]:
                predictions = [decide(row['text'], model.classes_, scores, threshold, margin)[0] for row, scores in zip(dev, probabilities)]
                false_sensitive = sum(r['intent'] == 'unknown' and p in {'submit', 'download', 'confirm'} for r, p in zip(dev, predictions))
                unknown_correct = sum(r['intent'] == 'unknown' and p == 'unknown' for r, p in zip(dev, predictions))
                accuracy = accuracy_score(expected, predictions)
                f1 = f1_score(expected, predictions, average='macro', zero_division=0)
                trial = {'c': c, 'threshold': threshold, 'margin': margin, 'accuracy': accuracy, 'macro_f1': f1, 'false_sensitive': false_sensitive, 'unknown_correct': unknown_correct}
                trials.append(trial)
                ranking = (-false_sensitive, f1, accuracy, unknown_correct, -c, threshold, margin)
                if best is None or ranking > best:
                    best = ranking
                    selected = {'model': model, 'config': {'c': c, 'threshold': threshold, 'margin': margin}, 'validation': trial}
    selected.update({'data_hash': data_hash(), 'version': VERSION, 'created_utc': datetime.now(timezone.utc).isoformat(), 'training_examples': len(train), 'development_examples': len(dev)})
    ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
    temporary = ARTIFACT.with_name(f'intent_model.{os.getpid()}.tmp')
    try:
        joblib.dump(selected, temporary)
        os.replace(temporary, ARTIFACT)
    finally:
        temporary.unlink(missing_ok=True)
    report = ROOT / 'reports/model_selection.json'
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps({'version': VERSION, 'data_sha256': data_hash(), 'selection_policy': 'Development only. Minimize false sensitive predictions, maximize macro-F1, accuracy, unknown rejection; ties prefer lower C and stricter thresholds. No final-test tuning.', 'selected': selected['validation'], 'trials': trials, 'training_examples': len(train), 'development_examples': len(dev)}, indent=2), encoding='utf-8')
    return selected['model']


class IntentClassifier:
    def __init__(self):
        saved = joblib.load(ARTIFACT) if ARTIFACT.exists() else None
        if not saved or saved.get('data_hash') != data_hash() or saved.get('version') != VERSION:
            train_model()
            saved = joblib.load(ARTIFACT)
        self.model = saved['model']
        self.config = saved['config']

    def predict(self, text):
        rule = rule_decision(text)
        if rule is not None:
            return rule
        return decide(text, self.model.classes_, self.model.predict_proba([text])[0], self.config['threshold'], self.config['margin'])
