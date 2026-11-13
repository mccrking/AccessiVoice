"""Opt-in personal feedback, immediate aliases and automatically validated retraining.

No model trains on its own predictions. Profiles never modify the shared base model.
This in-process scheduler is intended for the single-process local prototype.
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import RLock, Timer

import joblib
import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

from backend.nlp import CORPUS, ROOT, VERSION, data_hash, decide, make_model, normalized, rule_decision

LEARNABLE = {'home', 'documents', 'grades', 'forms', 'read', 'next_field', 'repeat', 'pause', 'resume', 'slower', 'help', 'unknown'}
SENSITIVE = {'download', 'submit', 'confirm', 'cancel'}


class FeedbackError(ValueError):
    pass


class PersonalModel:
    def __init__(self, model, config, base, anchors):
        self.model, self.config, self.base = model, config, base
        self.anchors = anchors
        self.anchor_features = model['features'].transform(anchors)

    def predict(self, text):
        return self.predict_with_source(text)[:2]

    def predict_with_source(self, text):
        # Learning cannot create, reinterpret or weaken sensitive actions.
        original = self.base.predict(text)
        if rule_decision(text) is not None or original[0] in SENSITIVE:
            return (*original, 'base')
        # A personal correction should generalize near that formulation, not
        # reinterpret unrelated commands. Confident base decisions stay stable.
        if original[0] != 'unknown' and original[1] >= 0.80:
            return (*original, 'base')
        features = self.model['features'].transform([text])
        if float(cosine_similarity(features, self.anchor_features).max()) < 0.65:
            return (*original, 'base')
        prediction = decide(text, self.model.classes_, self.model.predict_proba([text])[0], self.config['threshold'], self.config['margin'])
        return (*original, 'base') if prediction[0] in SENSITIVE else (*prediction, 'personal_model')


class LearningService:
    def __init__(self, base, directory: Path, debounce=5.0):
        self.base, self.directory, self.debounce = base, directory, debounce
        self.base_hash = hashlib.sha256((data_hash() + VERSION + joblib.hash(base.model) + json.dumps(base.config, sort_keys=True)).encode()).hexdigest()
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / 'learning.sqlite3'
        self.lock = RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='accessivoice-learning')
        self.timers, self.models = {}, {}
        self.closed = False
        records = json.loads(CORPUS.read_text(encoding='utf-8'))['records']
        self.training = [r for r in records if r['split'] == 'train']
        self.suites = {'development': [r for r in records if r['split'] == 'dev']}
        old = json.loads((ROOT / 'data/intents.json').read_text(encoding='utf-8'))
        self.suites['legacy'] = [{'text': t, 'intent': r['intent']} for r in old for t in r['test']]
        challenge = json.loads((ROOT / 'data/challenge.json').read_text(encoding='utf-8'))
        self.suites['regression_challenge'] = [{'text': t, 'intent': r['intent']} for r in challenge['cases'] for t in r['texts']]
        self.suites['core_commands'] = [{'text': t, 'intent': r['intent']} for r in old for t in r['train']]
        self.reserved = {normalized(r['text']) for key, rows in self.suites.items() if key != 'core_commands' for r in rows}
        self.canonical = {normalized(r['text']): r['intent'] for r in self.training}
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS learners (
                    id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, revision INTEGER DEFAULT 0,
                    attempted INTEGER DEFAULT 0, model_revision INTEGER DEFAULT 0,
                    state TEXT DEFAULT 'idle', detail TEXT DEFAULT '', validation TEXT DEFAULT '{}',
                    base_fingerprint TEXT DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS corrections (
                    learner TEXT REFERENCES learners(id) ON DELETE CASCADE,
                    key TEXT NOT NULL, text TEXT NOT NULL, intent TEXT NOT NULL,
                    PRIMARY KEY (learner, key)
                );
            ''')
            if 'base_fingerprint' not in {r['name'] for r in db.execute('PRAGMA table_info(learners)')}:
                db.execute("ALTER TABLE learners ADD COLUMN base_fingerprint TEXT DEFAULT ''")
            for row in db.execute('SELECT * FROM learners WHERE revision>0').fetchall():
                if row['base_fingerprint'] != self.base_hash or (row['model_revision'] > 0 and self._current(row['id'], row) is self.base):
                    # A base-model update invalidates derived artifacts, not consented corrections.
                    self._artifact(row['id']).unlink(missing_ok=True)
                    db.execute("UPDATE learners SET model_revision=0,attempted=0,state=?,detail=?,validation='{}',base_fingerprint=? WHERE id=?", ('queued' if row['enabled'] else 'paused', 'Le modèle de base a changé. Les corrections seront réapprises.', self.base_hash, row['id']))
            pending = db.execute('SELECT id FROM learners WHERE enabled=1 AND (revision>attempted OR state IN (\'queued\',\'training\'))').fetchall()
        for row in pending:
            self._schedule(row['id'])

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA secure_delete=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def identifier(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def _row(self, db, key):
        row = db.execute('SELECT * FROM learners WHERE id=?', (key,)).fetchone()
        if row is None:
            raise FeedbackError('Profil d’apprentissage introuvable. Activez-le à nouveau.')
        return row

    def create(self):
        token = secrets.token_urlsafe(36)
        with self.lock, self.db() as db:
            if db.execute('SELECT COUNT(*) FROM learners').fetchone()[0] >= 100:
                raise FeedbackError('La limite des profils de démonstration est atteinte.')
            db.execute('INSERT INTO learners(id,enabled,base_fingerprint) VALUES (?,1,?)', (self.identifier(token), self.base_hash))
        return token

    def status(self, token):
        key = self.identifier(token)
        with self.lock, self.db() as db:
            row = self._row(db, key)
            count = db.execute('SELECT COUNT(*) FROM corrections WHERE learner=?', (key,)).fetchone()[0]
            return {'enabled': bool(row['enabled']), 'corrections': count, 'revision': row['revision'], 'model_revision': row['model_revision'], 'state': row['state'], 'detail': row['detail'], 'validation': json.loads(row['validation'])}

    def set_enabled(self, token, enabled):
        key = self.identifier(token)
        with self.lock, self.db() as db:
            row = self._row(db, key)
            pending = enabled and row['revision'] > row['attempted']
            state = ('queued' if pending else 'ready' if row['model_revision'] else 'idle') if enabled else 'paused'
            detail = 'Réentraînement automatique prévu.' if pending else 'Apprentissage personnel activé.' if enabled else 'Apprentissage en pause. Vos formulations restent conservées.'
            db.execute('UPDATE learners SET enabled=?, state=?,detail=? WHERE id=?', (int(enabled), state, detail, key))
            if not enabled:
                timer = self.timers.pop(key, None)
                if timer:
                    timer.cancel()
        if pending:
            self._schedule(key)
        return self.status(token)

    def forget(self, token):
        key = self.identifier(token)
        with self.lock, self.db() as db:
            self._row(db, key)
            db.execute('DELETE FROM learners WHERE id=?', (key,))
            timer = self.timers.pop(key, None)
            if timer:
                timer.cancel()
            self.models.pop(key, None)
            self._artifact(key).unlink(missing_ok=True)
        # A worker must re-check profile and revision before writing any artifact.

    def add(self, token, text, intent):
        key, clean = self.identifier(token), normalized(text)
        if intent not in LEARNABLE:
            raise FeedbackError('L’apprentissage concerne la navigation et la lecture, pas les actions sensibles.')
        if len(clean) < 3 or len(text) > 160 or len(text.split()) > 25:
            raise FeedbackError('Choisissez une commande courte, entre 3 et 160 caractères.')
        if re.search(r'@|https?://|www\.|\d{6,}|(?:\d[\s.()+-]*){7,}|\b(mot de passe|identifiant|carte bancaire)\b', text, re.I):
            raise FeedbackError('Cette phrase semble contenir des informations personnelles. Utilisez une commande sans ces informations.')
        if rule_decision(text) is not None:
            raise FeedbackError('Cette phrase relève des règles de contrôle et ne peut pas être réinterprétée par apprentissage.')
        if clean in self.reserved:
            raise FeedbackError('Cette commande appartient aux tests réservés et reste exclue de l’apprentissage.')
        if clean in self.canonical and self.canonical[clean] != intent:
            raise FeedbackError('Cette correction contredit une commande de référence. Choisissez une formulation personnelle distincte.')
        with self.lock, self.db() as db:
            row = self._row(db, key)
            if not row['enabled']:
                raise FeedbackError('Activez d’abord l’apprentissage personnel.')
            previous = db.execute('SELECT intent FROM corrections WHERE learner=? AND key=?', (key, clean)).fetchone()
            if previous and previous['intent'] == intent:
                return False
            count = db.execute('SELECT COUNT(*) FROM corrections WHERE learner=?', (key,)).fetchone()[0]
            if not previous and count >= 200:
                raise FeedbackError('La limite de 200 corrections est atteinte. Vous pouvez effacer les apprentissages dans les réglages.')
            db.execute('INSERT INTO corrections(learner,key,text,intent) VALUES (?,?,?,?) ON CONFLICT(learner,key) DO UPDATE SET text=excluded.text,intent=excluded.intent', (key, clean, text, intent))
            db.execute("UPDATE learners SET revision=revision+1,state='queued',detail='Formulation retenue. Réentraînement automatique prévu.' WHERE id=?", (key,))
        self._schedule(key)
        return True

    def _artifact(self, key):
        return self.directory / f'personal-{key}.joblib'

    def _current(self, key, row):
        if key in self.models:
            return self.models[key]
        path = self._artifact(key)
        if path.exists():
            try:
                payload = joblib.load(path)
                if payload.get('schema') == 1 and payload['base_hash'] == self.base_hash and payload['base_version'] == VERSION and payload['revision'] == row['model_revision']:
                    self.models[key] = PersonalModel(payload['model'], payload['config'], self.base, payload['anchors'])
                    return self.models[key]
            except (OSError, ValueError, KeyError, EOFError):
                pass
        return self.base

    def predict(self, text, token):
        key = self.identifier(token)
        with self.lock, self.db() as db:
            row = self._row(db, key)
            if not row['enabled'] or rule_decision(text) is not None:
                return (*self.base.predict(text), 'base')
            alias = db.execute('SELECT intent FROM corrections WHERE learner=? AND key=?', (key, normalized(text))).fetchone()
            if alias:
                # 1 is a user-supplied mapping, never a calibrated model score.
                return alias['intent'], 1.0, 'personal_memory'
            model = self._current(key, row)
        return model.predict_with_source(text) if model is not self.base else (*model.predict(text), 'base')

    def _schedule(self, key):
        with self.lock:
            if self.closed:
                return
            timer = self.timers.pop(key, None)
            if timer:
                timer.cancel()
            timer = Timer(self.debounce, self._enqueue, args=(key,))
            timer.daemon = True
            self.timers[key] = timer
            timer.start()

    def _enqueue(self, key):
        with self.lock:
            self.timers.pop(key, None)
            if not self.closed:
                self.pool.submit(self._train, key)

    def _fit(self, corrections):
        texts = [r['text'] for r in self.training] + [r['text'] for r in corrections]
        labels = [r['intent'] for r in self.training] + [r['intent'] for r in corrections]
        weights = np.array([1.0] * len(self.training) + [20.0] * len(corrections))
        model = make_model(self.base.config['c']).fit(texts, labels, classifier__sample_weight=weights)
        return PersonalModel(model, self.base.config, self.base, [r['text'] for r in corrections])

    def _validate(self, candidate, champion):
        result, passed = {}, True
        for name, rows in self.suites.items():
            before = [champion.predict(r['text'])[0] for r in rows]
            after = [candidate.predict(r['text'])[0] for r in rows]
            good_before = sum(p == r['intent'] for p, r in zip(before, rows))
            good_after = sum(p == r['intent'] for p, r in zip(after, rows))
            rejected_before = sum(p == 'unknown' and r['intent'] == 'unknown' for p, r in zip(before, rows))
            rejected_after = sum(p == 'unknown' and r['intent'] == 'unknown' for p, r in zip(after, rows))
            unsafe = sum(p in {'submit', 'download', 'confirm'} and r['intent'] == 'unknown' for p, r in zip(after, rows))
            okay = good_after >= good_before and rejected_after >= rejected_before and unsafe == 0
            result[name] = {'total': len(rows), 'before_correct': good_before, 'after_correct': good_after, 'false_sensitive': unsafe, 'passed': okay}
            passed = passed and okay
        return passed, result

    def _train(self, key):
        revision = None
        try:
            with self.lock, self.db() as db:
                row = db.execute('SELECT * FROM learners WHERE id=?', (key,)).fetchone()
                if self.closed or not row or not row['enabled'] or row['revision'] <= row['attempted']:
                    return
                revision = row['revision']
                corrections = [dict(r) for r in db.execute('SELECT text,intent FROM corrections WHERE learner=?', (key,))]
                champion = self._current(key, row)
                db.execute("UPDATE learners SET state='training',detail='Entraînement et tests en cours.' WHERE id=?", (key,))
            candidate = self._fit(corrections)
            passed, validation = self._validate(candidate, champion)
            # Training recall is not independent validation; keep its meaning explicit.
            validation['corrections_training_recall'] = {'correct': sum(candidate.predict(r['text'])[0] == r['intent'] for r in corrections), 'total': len(corrections)}
            with self.lock, self.db() as db:
                row = db.execute('SELECT * FROM learners WHERE id=?', (key,)).fetchone()
                if self.closed or not row or not row['enabled'] or row['revision'] != revision:
                    return
                if passed:
                    path = self._artifact(key)
                    temporary = path.with_suffix('.tmp')
                    try:
                        joblib.dump({'schema': 1, 'model': candidate.model, 'config': candidate.config, 'anchors': candidate.anchors, 'revision': revision, 'base_hash': self.base_hash, 'base_version': VERSION}, temporary)
                        os.replace(temporary, path)
                    finally:
                        temporary.unlink(missing_ok=True)
                    self.models[key] = candidate
                    db.execute("UPDATE learners SET state='ready',attempted=?,model_revision=?,detail=?,validation=? WHERE id=?", (revision, revision, 'Modèle personnel actualisé après les tests.', json.dumps(validation), key))
                else:
                    db.execute("UPDATE learners SET state='rejected',attempted=?,detail=?,validation=? WHERE id=?", (revision, 'Les tests ont conservé le modèle précédent. Vos formulations exactes restent retenues.', json.dumps(validation), key))
        except Exception:
            with self.lock, self.db() as db:
                # Never revive a deleted profile or overwrite a newer queued revision.
                db.execute("UPDATE learners SET state='failed',detail='Le réentraînement a échoué. Le modèle précédent reste disponible.' WHERE id=? AND revision=?", (key, revision))

    def close(self):
        with self.lock:
            self.closed = True
            for timer in self.timers.values():
                timer.cancel()
            self.timers.clear()
        self.pool.shutdown(wait=True, cancel_futures=True)
