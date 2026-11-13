"""Persistent, token-isolated campus demonstrations. No real university connected."""
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import secrets
import sqlite3

from pydantic import BaseModel, Field, ConfigDict
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from typing import Literal

RequestKind = Literal['attestation', 'releve', 'stage']
SERVICES = {
    'attestation': {'title': 'Attestation de scolarité', 'description': 'Justifier votre inscription pour un dossier administratif.', 'delay': '1 à 2 jours ouvrés (exemple)', 'filename': 'attestation-demo.pdf'},
    'releve': {'title': 'Relevé de notes', 'description': 'Obtenir le récapitulatif de vos résultats du semestre.', 'delay': '2 à 3 jours ouvrés (exemple)', 'filename': 'releve-demo.pdf'},
    'stage': {'title': 'Convention de stage', 'description': 'Préparer un document fictif pour votre dossier de stage.', 'delay': '3 à 5 jours ouvrés (exemple)', 'filename': 'convention-demo.pdf'},
}
STATUS_LABELS = {'submitted': 'Déposée', 'processing': 'En traitement', 'ready': 'Document prêt'}


class CampusForm(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=2, max_length=100)
    student_id: str = Field(pattern=r'^[A-Za-z0-9-]{3,30}$')
    reason: str = Field(min_length=3, max_length=500)
    request_type: RequestKind = 'attestation'


def now():
    return datetime.now(timezone.utc).isoformat()


class CampusError(ValueError):
    pass


class CampusStore:
    def __init__(self, path: Path):
        self.path = path
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS campus_profiles (id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS campus_requests (
                    reference TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES campus_profiles(id) ON DELETE CASCADE,
                    form TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, timeline TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS campus_request_owner ON campus_requests(owner);
            ''')

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
        return sha256(token.encode()).hexdigest()

    def profile(self, db, token):
        key = self.identifier(token)
        if not db.execute('SELECT 1 FROM campus_profiles WHERE id=?', (key,)).fetchone():
            raise CampusError('Profil de démonstration introuvable. Créez un nouveau suivi.')
        return key

    def create_profile(self):
        token = secrets.token_urlsafe(36)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM campus_profiles').fetchone()[0] >= 500:
                raise CampusError('La limite des profils de démonstration est atteinte.')
            db.execute('INSERT INTO campus_profiles(id) VALUES (?)', (self.identifier(token),))
        return token

    @staticmethod
    def present(row):
        form = json.loads(row['form'])
        return {'reference': row['reference'], 'form': form, 'title': SERVICES[form['request_type']]['title'], 'status': row['status'], 'status_label': STATUS_LABELS[row['status']], 'created_at': row['created_at'], 'timeline': json.loads(row['timeline'])}

    def add(self, token, form):
        timestamp, reference = now(), 'DEMO-' + secrets.token_hex(6).upper()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            owner = self.profile(db, token)
            if db.execute('SELECT COUNT(*) FROM campus_requests WHERE owner=?', (owner,)).fetchone()[0] >= 100:
                raise CampusError('La limite de 100 demandes est atteinte. Effacez le suivi de démonstration pour recommencer.')
            timeline = [{'status': 'submitted', 'label': STATUS_LABELS['submitted'], 'at': timestamp}]
            db.execute('INSERT INTO campus_requests VALUES (?,?,?,?,?,?)', (reference, owner, json.dumps(form, ensure_ascii=False), 'submitted', timestamp, json.dumps(timeline)))
            return self.present(db.execute('SELECT * FROM campus_requests WHERE reference=?', (reference,)).fetchone())

    def list(self, token):
        with self.db() as db:
            owner = self.profile(db, token)
            return [self.present(row) for row in db.execute('SELECT * FROM campus_requests WHERE owner=? ORDER BY created_at DESC, reference', (owner,))]

    def get(self, token, reference):
        with self.db() as db:
            owner = self.profile(db, token)
            row = db.execute('SELECT * FROM campus_requests WHERE owner=? AND reference=?', (owner, reference)).fetchone()
            if not row:
                raise CampusError('Demande introuvable dans votre suivi.')
            return self.present(row)

    def advance(self, token, reference):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            owner = self.profile(db, token)
            row = db.execute('SELECT * FROM campus_requests WHERE owner=? AND reference=?', (owner, reference)).fetchone()
            if not row:
                raise CampusError('Demande introuvable dans votre suivi.')
            next_status = {'submitted': 'processing', 'processing': 'ready'}.get(row['status'])
            if next_status:
                timeline = json.loads(row['timeline']) + [{'status': next_status, 'label': STATUS_LABELS[next_status], 'at': now()}]
                db.execute('UPDATE campus_requests SET status=?,timeline=? WHERE reference=?', (next_status, json.dumps(timeline), reference))
            return self.present(db.execute('SELECT * FROM campus_requests WHERE reference=?', (reference,)).fetchone())

    def forget(self, token):
        with self.db() as db:
            owner = self.profile(db, token)
            db.execute('DELETE FROM campus_profiles WHERE id=?', (owner,))


def document_pdf(kind='attestation', form=None, reference=None):
    from textwrap import wrap
    form = form or {'name': 'Utilisateur Démo', 'student_id': 'ETU-2026-001', 'reason': 'Exemple pédagogique'}
    output = BytesIO()
    pdf = canvas.Canvas(output, pagesize=A4)
    title = SERVICES[kind]['title']
    pdf.setTitle(title + ' — Démonstration AccessiVoice')
    pdf.setFont('Helvetica-Bold', 22)
    pdf.drawString(50, 780, 'AccessiVoice | Campus démo')
    pdf.setFont('Helvetica-Bold', 17)
    pdf.drawString(50, 725, title.upper())
    pdf.setFont('Helvetica', 11)
    lines = ['DOCUMENT FICTIF — SANS VALEUR ADMINISTRATIVE', '', f"Étudiant : {form['name']}", f"Numéro : {form['student_id']}", 'Formation : Master Intelligence Artificielle', 'Année universitaire : 2026–2027']
    if reference:
        lines += [f'Référence : {reference}']
    lines += ['', 'Motif : ' + form['reason'], '']
    if kind == 'releve':
        lines += ['Résultats fictifs du semestre 1 :', 'Machine Learning : 16 / 20', 'Développement et déploiement : 15 / 20', 'Traitement du langage naturel : 15,5 / 20', 'Bases de données : 14 / 20', 'Ingénierie logicielle : 16,5 / 20', 'Moyenne : 15,4 / 20']
    elif kind == 'stage':
        lines += ['Convention pédagogique de démonstration.', 'Organisme, dates, missions et signatures : à compléter.', 'Ce document ne constitue pas une convention signée.']
    else:
        lines += ['Le profil fictif est inscrit dans le campus de démonstration.', 'Aucune inscription réelle n’est certifiée.']
    lines += ['', 'Généré localement. Aucun document ni dossier universitaire réel.']
    y = 685
    for line in lines:
        for part in wrap(line, 85) or ['']:
            if y < 65:
                pdf.showPage()
                pdf.setFont('Helvetica', 11)
                y = 780
            pdf.drawString(50, y, part)
            y -= 19
    pdf.save()
    return output.getvalue()
