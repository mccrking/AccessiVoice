from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Literal
import secrets
import os
import sqlite3
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.nlp import IntentClassifier, VERSION
from backend.learning import LearningService, FeedbackError
from backend.languages import multilingual_decision
from backend.campus import CampusStore, CampusForm, CampusError, SERVICES, document_pdf
from backend.dialogue import handle_dialogue, service_command

classifier: IntentClassifier | None = None
learning: LearningService | None = None
campus: CampusStore | None = None
sessions: dict = {}
lock = Lock()
DB = Path(os.environ.get('ACCESSIVOICE_RUNTIME_DIR', Path(__file__).parent / 'runtime')) / 'events.sqlite3'
SESSION_TTL = 3600
PENDING_TTL = 120
MAX_SESSIONS = 1000


@asynccontextmanager
async def lifespan(app: FastAPI):
    global classifier, learning, campus
    classifier = IntentClassifier()
    DB.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB) as db:
        db.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, intent TEXT, confidence REAL, duration_ms REAL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)")
    learning = LearningService(classifier, DB.parent / 'personal_learning')
    campus = CampusStore(DB)
    try:
        yield
    finally:
        learning.close()
        sessions.clear()


app = FastAPI(title="AccessiVoice API", version='0.4.0', lifespan=lifespan)


class Command(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    session_id: str
    page: str = "home"
    language: Literal['fr', 'en', 'ary'] = 'fr'
    learner_token: str | None = Field(default=None, min_length=32, max_length=100)
    form_snapshot: CampusForm | None = None
    reset_dialogue: bool = False


class LearningConsent(BaseModel):
    consent: Literal[True]


class LearningToken(BaseModel):
    token: str = Field(min_length=32, max_length=100)


class LearningToggle(LearningToken):
    enabled: bool


class Correction(LearningToken):
    session_id: str
    command_id: str
    expected_intent: str = Field(max_length=30)
    consent: Literal[True]


FormData = CampusForm


class Action(BaseModel):
    session_id: str
    action: str
    confirmed: bool = False
    form: FormData | None = None
    owner_token: str | None = Field(default=None, min_length=32, max_length=100)
    request_reference: str | None = Field(default=None, pattern=r'^DEMO-[A-F0-9]{12}$')


class CampusToken(BaseModel):
    token: str = Field(min_length=32, max_length=100)


class CampusRequest(CampusToken):
    reference: str = Field(pattern=r'^DEMO-[A-F0-9]{12}$')


class AdvanceRequest(CampusRequest):
    simulate: Literal[True]


class DownloadRequest(CampusRequest):
    session_id: str


class ForgetCampus(CampusToken):
    confirmed: Literal[True]


def session_for(session_id):
    session = sessions.get(session_id)
    if not session or time.monotonic() - session["created"] > SESSION_TTL:
        sessions.pop(session_id, None)
        raise HTTPException(401, "Session expirée. Relancez votre demande pour recommencer.")
    return session


@app.get("/api/health")
def health():
    return {"status": "ok", "model_version": VERSION, "app_version": '0.4.0', "demo": True, "learning_available": True, 'campus_available': True}


@app.post("/api/sessions")
def create_session():
    with lock:
        now = time.monotonic()
        for key in [key for key, value in sessions.items() if now - value["created"] > SESSION_TTL]:
            del sessions[key]
        if len(sessions) >= MAX_SESSIONS:
            raise HTTPException(503, "Trop de sessions actives. Réessayez plus tard.")
        token = secrets.token_urlsafe(32)
        sessions[token] = {"created": now, "pending": None, "history": {}, 'dialogue': None}
    return {"session_id": token}


@app.post("/api/commands")
def command(body: Command):
    started = time.perf_counter()
    with lock:
        session = session_for(body.session_id)
        if body.reset_dialogue:
            session['dialogue'] = None
        service = service_command(body.text) if body.language == 'fr' else None
        dialogue = handle_dialogue(body.text, session.get('dialogue')) if body.language == 'fr' and not service else None
        if dialogue:
            session['dialogue'] = {key: dialogue['flow'][key] for key in ('step', 'draft')}
            session['pending'] = {'action': 'submit', 'at': time.monotonic(), 'form': dialogue['flow']['draft']} if dialogue['ready'] else None
            return {**dialogue, 'confidence': None, 'duration_ms': round((time.perf_counter() - started) * 1000, 2), 'pending_action': 'submit' if dialogue['ready'] else None, 'model_version': VERSION, 'command_id': None, 'prediction_source': 'dialogue_rules', 'language': body.language}
        try:
            if service:
                intent, confidence, source = service['intent'], 1.0, 'service_rules'
            elif body.learner_token:
                intent, confidence, source = learning.predict(body.text.strip(), body.learner_token)
            else:
                intent, confidence = classifier.predict(body.text.strip())
                source = 'base'
            if body.language != 'fr':
                known = multilingual_decision(body.text, body.language)
                if known:
                    intent, confidence = known
                    source = 'multilingual_rules'
                elif source != 'personal_memory':
                    # No French statistical guess for unsupported foreign requests.
                    intent, confidence, source = 'unknown', 0.0, 'multilingual_rules'
        except FeedbackError as error:
            raise HTTPException(400, str(error)) from error
        command_id = None
        if not service and body.learner_token and learning.status(body.learner_token)['enabled']:
            command_id = secrets.token_urlsafe(18)
            history = session['history']
            history[command_id] = {'text': body.text.strip(), 'profile': learning.identifier(body.learner_token), 'at': time.monotonic()}
            for key in list(history):
                if len(history) > 10 or time.monotonic() - history[key]['at'] > 600:
                    del history[key]
        if intent == "cancel":
            session["pending"] = None
            session['dialogue'] = None
        elif intent in {"download", "submit"}:
            session["pending"] = {"action": intent, "at": time.monotonic()}
            if intent == 'download':
                session['pending']['document_type'] = service.get('document_type', 'attestation') if service else 'attestation'
            elif body.form_snapshot:
                session['pending']['form'] = body.form_snapshot.model_dump()
        elif intent != "confirm":
            session["pending"] = None
        if intent in {'home', 'documents', 'grades', 'forms', 'help', 'tracking', 'lab', 'learning'}:
            session['dialogue'] = None
        pending = session["pending"]
        if pending and time.monotonic() - pending["at"] > PENDING_TTL:
            session["pending"] = None
        pending_action = session["pending"]["action"] if session["pending"] else None
    duration = round((time.perf_counter() - started) * 1000, 2)
    # Deliberately no transcript, audio, session identifier or form values in logs.
    with sqlite3.connect(DB) as db:
        db.execute("INSERT INTO events(intent, confidence, duration_ms) VALUES (?, ?, ?)", (intent, confidence, duration))
        db.execute("DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) - 10000 FROM events)")
    return {"intent": intent, "confidence": confidence, "duration_ms": duration, "pending_action": pending_action, "model_version": VERSION, "command_id": command_id, "prediction_source": source, "language": body.language, 'document_type': service.get('document_type', 'attestation') if service else 'attestation', 'flow': session.get('dialogue')}


@app.post('/api/learning/create')
def learning_create(body: LearningConsent):
    try:
        token = learning.create()
        return {'token': token, **learning.status(token)}
    except FeedbackError as error:
        raise HTTPException(400, str(error)) from error


@app.post('/api/learning/status')
def learning_status(body: LearningToken):
    try:
        return learning.status(body.token)
    except FeedbackError as error:
        raise HTTPException(404, str(error)) from error


@app.post('/api/learning/toggle')
def learning_toggle(body: LearningToggle):
    try:
        return learning.set_enabled(body.token, body.enabled)
    except FeedbackError as error:
        raise HTTPException(404, str(error)) from error


@app.post('/api/learning/forget')
def learning_forget(body: LearningToken):
    try:
        with lock:
            learning.forget(body.token)
            profile = learning.identifier(body.token)
            for session in sessions.values():
                session['history'] = {key: value for key, value in session['history'].items() if value['profile'] != profile}
        return {'forgotten': True}
    except FeedbackError as error:
        raise HTTPException(404, str(error)) from error


@app.post('/api/learning/feedback')
def learning_feedback(body: Correction):
    with lock:
        session = session_for(body.session_id)
        record = session['history'].get(body.command_id)
        if not record or record['profile'] != learning.identifier(body.token) or time.monotonic() - record['at'] > 600:
            raise HTTPException(404, 'Cette commande n’est plus disponible pour une correction. Réessayez-la avec l’apprentissage activé.')
        try:
            changed = learning.add(body.token, record['text'], body.expected_intent)
        except FeedbackError as error:
            raise HTTPException(400, str(error)) from error
        session['pending'] = None
    return {'saved': True, 'changed': changed, **learning.status(body.token)}


@app.post("/api/actions")
def action(body: Action):
    with lock:
        session = session_for(body.session_id)
        pending = session["pending"]
        if not body.confirmed or not pending or pending["action"] != body.action or time.monotonic() - pending["at"] > PENDING_TTL:
            raise HTTPException(409, "Une confirmation explicite et une action en attente sont nécessaires.")
        if body.action == "submit" and body.form is None:
            raise HTTPException(422, "Veuillez compléter le formulaire.")
        if body.action == 'submit' and pending.get('form') and body.form.model_dump() != pending['form']:
            raise HTTPException(409, 'Le formulaire a changé. Vérifiez un nouveau récapitulatif avant de confirmer.')
        saved = None
        request_document = None
        try:
            if body.action == 'submit' and body.owner_token:
                saved = campus.add(body.owner_token, body.form.model_dump())
            if pending.get('request_reference'):
                if not body.owner_token or body.request_reference != pending['request_reference'] or campus.identifier(body.owner_token) != pending['owner']:
                    raise HTTPException(409, 'La confirmation ne correspond pas à ce document.')
                request_document = campus.get(body.owner_token, body.request_reference)
                if request_document['status'] != 'ready':
                    raise HTTPException(409, 'Le document est encore en préparation.')
        except CampusError as error:
            raise HTTPException(404, str(error)) from error
        session["pending"] = None  # Consume once; a replay cannot submit twice.
        session['dialogue'] = None
    if body.action == "download":
        kind = request_document['form']['request_type'] if request_document else pending.get('document_type', 'attestation')
        content = document_pdf(kind, request_document['form'] if request_document else None, body.request_reference)
        filename = SERVICES[kind]['filename']
        return Response(content, media_type='application/pdf', headers={'Content-Disposition': f'attachment; filename="{filename}"'})
    if saved:
        return {'status': 'submitted', 'reference': saved['reference'], 'request': saved, 'message': 'Demande fictive conservée dans votre suivi. Aucune transmission à une université.'}
    return {"status": "submitted", "reference": "DEMO-" + secrets.token_hex(3).upper(), "message": "Demande simulée. Aucune transmission à une université."}


@app.get("/api/metrics")
def metrics():
    with sqlite3.connect(DB) as db:
        total, average, unknown = db.execute("SELECT COUNT(*), COALESCE(AVG(duration_ms),0), COALESCE(SUM(intent='unknown'),0) FROM events").fetchone()
    return {"commands": total, "mean_inference_ms": round(average, 2), "unknown_commands": unknown, "model_version": VERSION}


@app.get('/api/campus/services')
def campus_services():
    return {'services': [{'id': key, **value} for key, value in SERVICES.items()]}


@app.post('/api/campus/profiles')
def campus_profile():
    try:
        return {'token': campus.create_profile()}
    except CampusError as error:
        raise HTTPException(400, str(error)) from error


@app.post('/api/campus/requests')
def campus_requests(body: CampusToken):
    try:
        return {'requests': campus.list(body.token)}
    except CampusError as error:
        raise HTTPException(404, str(error)) from error


@app.post('/api/campus/advance')
def campus_advance(body: AdvanceRequest):
    try:
        return campus.advance(body.token, body.reference)
    except CampusError as error:
        raise HTTPException(404, str(error)) from error


@app.post('/api/campus/prepare-download')
def campus_prepare_download(body: DownloadRequest):
    with lock:
        session = session_for(body.session_id)
        try:
            request = campus.get(body.token, body.reference)
        except CampusError as error:
            raise HTTPException(404, str(error)) from error
        if request['status'] != 'ready':
            raise HTTPException(409, 'Le document est encore en préparation.')
        session['pending'] = {'action': 'download', 'at': time.monotonic(), 'request_reference': body.reference, 'owner': campus.identifier(body.token)}
        session['dialogue'] = None
        return {'action': 'download', 'request_reference': body.reference, 'document_type': request['form']['request_type']}


@app.post('/api/campus/forget')
def campus_forget(body: ForgetCampus):
    try:
        with lock:
            campus.forget(body.token)
            for session in sessions.values():
                if session.get('pending') and session['pending'].get('owner') == campus.identifier(body.token):
                    session['pending'] = None
        return {'forgotten': True}
    except CampusError as error:
        raise HTTPException(404, str(error)) from error


@app.get('/api/lab/overview')
def lab_overview():
    from backend.lab import overview
    return overview(classifier)


class LabText(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    learner_token: str | None = Field(default=None, min_length=32, max_length=100)


@app.post('/api/lab/inspect')
def lab_inspect(body: LabText):
    from backend.lab import inspect
    result = inspect(classifier, body.text)
    if body.learner_token:
        try:
            intent, score, source = learning.predict(body.text, body.learner_token)
            result['personal'] = {'intent': intent, 'score': score, 'source': source}
        except FeedbackError as error:
            raise HTTPException(404, str(error)) from error
    return result


# A production build can be served by the same process, without a Node runtime.
DIST = Path(__file__).parent.parent / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
