import time
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient

from backend.learning import FeedbackError, LearningService
from backend.main import app, sessions
from backend.nlp import IntentClassifier


@pytest.fixture(scope='module')
def base():
    return IntentClassifier()


@pytest.fixture
def service(base, tmp_path):
    learning = LearningService(base, tmp_path / 'learning', debounce=3600)
    yield learning
    learning.close()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('backend.main.DB', tmp_path / 'events.sqlite3')
    with TestClient(app) as connection:
        import backend.main as main
        main.learning.debounce = 3600
        yield connection


def test_memory_is_immediate_personal_and_deduplicated(service):
    alice, bob = service.create(), service.create()
    assert service.add(alice, 'mon carnet du campus', 'grades') is True
    assert service.predict('Mon carnet du campus !', alice) == ('grades', 1.0, 'personal_memory')
    assert service.predict('mon carnet du campus', bob)[2] == 'base'
    assert service.add(alice, 'mon carnet du campus', 'grades') is False
    assert service.status(alice)['corrections'] == 1
    assert service.status(alice)['revision'] == 1


@pytest.mark.parametrize('text,intent', [
    ("n'envoie pas le formulaire", 'grades'), ('oui je confirme', 'documents'),
    ('ma formule magique', 'confirm'), ('ma formule magique', 'download'),
    ('mon carnet campus', 'submit'), ('mon dossier 0612345678', 'documents'),
    ('ouvre test@example.com', 'documents'), ('je veux mes notes', 'documents'),
    ('ramène moi à l’accueil', 'home'), ('x', 'home'),
])
def test_invalid_or_unsafe_learning_is_refused(service, text, intent):
    token = service.create()
    with pytest.raises(FeedbackError):
        service.add(token, text, intent)
    assert service.status(token)['corrections'] == 0


def test_pause_disables_personalization_and_resume_restores_it(service):
    token = service.create()
    service.add(token, 'mon carnet campus', 'grades')
    service.set_enabled(token, False)
    assert service.predict('mon carnet campus', token)[2] == 'base'
    with pytest.raises(FeedbackError):
        service.add(token, 'mon autre carnet', 'grades')
    service.set_enabled(token, True)
    assert service.status(token)['state'] == 'queued'
    assert service.predict('mon carnet campus', token)[2] == 'personal_memory'


def test_profile_and_alias_survive_service_restart(base, tmp_path):
    path = tmp_path / 'restart'
    first = LearningService(base, path, debounce=3600)
    token = first.create()
    first.add(token, 'mon carnet campus', 'grades')
    first.close()
    second = LearningService(base, path, debounce=3600)
    try:
        assert second.status(token)['corrections'] == 1
        assert second.predict('mon carnet campus', token)[2] == 'personal_memory'
    finally:
        second.close()


def test_real_automatic_retraining_and_artifact_reload(base, tmp_path):
    path = tmp_path / 'automatic'
    learning = LearningService(base, path, debounce=0.02)
    try:
        token = learning.create()
        learning.add(token, 'mon carnet du campus', 'grades')
        deadline = time.monotonic() + 30
        while learning.status(token)['state'] in {'queued', 'training'} and time.monotonic() < deadline:
            time.sleep(0.05)
        status = learning.status(token)
        assert status['state'] == 'ready', status
        assert status['model_revision'] == 1
        assert status['validation']['legacy']['after_correct'] == 39
        assert all(row['passed'] for name, row in status['validation'].items() if name != 'corrections_training_recall')
        assert learning.predict('mon carnet du campus', token)[0] == 'grades'
    finally:
        learning.close()
    reloaded = LearningService(base, path, debounce=3600)
    try:
        # Exercise the trained artifact, not the exact phrase memory.
        prediction = reloaded.predict('je voudrais mon carnet du campus', token)
        assert prediction[0] == 'grades'
        assert prediction[2] == 'personal_model'
    finally:
        reloaded.close()


def test_failed_quality_gate_keeps_previous_model_and_memory(service, monkeypatch):
    token = service.create()
    service.add(token, 'mon carnet campus', 'grades')
    monkeypatch.setattr(service, '_fit', lambda _: service.base)
    monkeypatch.setattr(service, '_validate', lambda *_: (False, {'test': {'passed': False}}))
    service._train(service.identifier(token))
    assert service.status(token)['state'] == 'rejected'
    assert service.status(token)['model_revision'] == 0
    assert not service._artifact(service.identifier(token)).exists()
    assert service.predict('mon carnet campus', token)[2] == 'personal_memory'


@pytest.mark.parametrize('operation', ['forget', 'pause'])
def test_inflight_training_cannot_resurrect_deleted_or_paused_profile(service, monkeypatch, operation):
    token = service.create()
    service.add(token, 'mon carnet campus', 'grades')
    entered, release = Event(), Event()
    def fit(_):
        entered.set()
        assert release.wait(5)
        return service.base
    monkeypatch.setattr(service, '_fit', fit)
    monkeypatch.setattr(service, '_validate', lambda *_: (True, {}))
    thread = Thread(target=service._train, args=(service.identifier(token),))
    thread.start()
    assert entered.wait(5)
    if operation == 'forget':
        service.forget(token)
    else:
        service.set_enabled(token, False)
    release.set()
    thread.join(5)
    assert not thread.is_alive()
    assert not service._artifact(service.identifier(token)).exists()
    if operation == 'forget':
        with pytest.raises(FeedbackError):
            service.status(token)
    else:
        assert service.status(token)['state'] == 'paused'


def test_regression_validator_rejects_broken_candidate(service):
    class Broken:
        def predict(self, _):
            return 'grades', 1.0
    passed, report = service._validate(Broken(), service.base)
    assert passed is False
    assert report['legacy']['passed'] is False


def test_api_requires_consent_proof_and_profile_ownership(client):
    assert client.post('/api/learning/create', json={'consent': False}).status_code == 422
    token = client.post('/api/learning/create', json={'consent': True}).json()['token']
    other = client.post('/api/learning/create', json={'consent': True}).json()['token']
    session = client.post('/api/sessions').json()['session_id']
    no_optin = client.post('/api/commands', json={'session_id': session, 'text': 'mon carnet campus'}).json()
    assert no_optin['command_id'] is None
    result = client.post('/api/commands', json={'session_id': session, 'text': 'mon carnet campus', 'learner_token': token}).json()
    feedback = {'session_id': session, 'token': token, 'command_id': result['command_id'], 'expected_intent': 'grades', 'consent': True}
    assert client.post('/api/learning/feedback', json={**feedback, 'token': other}).status_code == 404
    assert client.post('/api/learning/feedback', json={**feedback, 'consent': False}).status_code == 422
    response = client.post('/api/learning/feedback', json=feedback)
    assert response.status_code == 200
    assert response.json()['corrections'] == 1
    repeated = client.post('/api/commands', json={'session_id': session, 'text': 'mon carnet campus', 'learner_token': token}).json()
    assert repeated['intent'] == 'grades'
    assert repeated['prediction_source'] == 'personal_memory'
    assert client.post('/api/learning/forget', json={'token': token}).status_code == 200
    assert not sessions[session]['history']
    assert client.post('/api/learning/status', json={'token': token}).status_code == 404


def test_expired_feedback_proof_cannot_train(client):
    token = client.post('/api/learning/create', json={'consent': True}).json()['token']
    session = client.post('/api/sessions').json()['session_id']
    command = client.post('/api/commands', json={'session_id': session, 'text': 'mon carnet campus', 'learner_token': token}).json()
    sessions[session]['history'][command['command_id']]['at'] = time.monotonic() - 601
    response = client.post('/api/learning/feedback', json={'session_id': session, 'token': token, 'command_id': command['command_id'], 'expected_intent': 'grades', 'consent': True})
    assert response.status_code == 404


def test_outdated_personal_artifact_is_invalidated_and_requeued(base, tmp_path):
    import joblib
    path = tmp_path / 'obsolete'
    service = LearningService(base, path, debounce=3600)
    token = service.create()
    service.add(token, 'mon carnet campus', 'grades')
    key = service.identifier(token)
    joblib.dump({'schema': 1, 'base_hash': 'outdated'}, service._artifact(key))
    with service.db() as db:
        db.execute("UPDATE learners SET model_revision=1,attempted=1,state='ready' WHERE id=?", (key,))
    service.close()
    restored = LearningService(base, path, debounce=3600)
    try:
        status = restored.status(token)
        assert status['state'] == 'queued'
        assert status['model_revision'] == 0
        assert status['corrections'] == 1
        assert not restored._artifact(key).exists()
    finally:
        restored.close()
