import sqlite3
import pytest
from fastapi.testclient import TestClient
from backend.main import app
from backend.campus import CampusStore, CampusError


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('backend.main.DB', tmp_path / 'events.sqlite3')
    with TestClient(app) as connection:
        yield connection


def session(client):
    return client.post('/api/sessions').json()['session_id']


def profile(client):
    return client.post('/api/campus/profiles').json()['token']


def command(client, sid, text, **extra):
    response = client.post('/api/commands', json={'session_id': sid, 'text': text, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def complete(client, sid, token, kind='stage'):
    form = {'name': 'Amine Démo', 'student_id': 'ETU-001', 'reason': 'Dossier de stage', 'request_type': kind}
    command(client, sid, 'Envoie le formulaire', form_snapshot=form)
    response = client.post('/api/actions', json={'session_id': sid, 'action': 'submit', 'confirmed': True, 'form': form, 'owner_token': token})
    assert response.status_code == 200, response.text
    return response.json()['request']


def test_request_lifecycle_is_isolated_and_download_requires_confirmation(client):
    sid, alice, bob = session(client), profile(client), profile(client)
    request = complete(client, sid, alice)
    reference = request['reference']
    assert request['status'] == 'submitted'
    assert client.post('/api/campus/requests', json={'token': bob}).json()['requests'] == []
    assert client.post('/api/campus/advance', json={'token': bob, 'reference': reference, 'simulate': True}).status_code == 404
    body = {'token': alice, 'reference': reference, 'session_id': sid}
    assert client.post('/api/campus/prepare-download', json=body).status_code == 409
    assert client.post('/api/campus/advance', json={'token': alice, 'reference': reference}).status_code == 422
    for status in ['processing', 'ready', 'ready']:
        result = client.post('/api/campus/advance', json={'token': alice, 'reference': reference, 'simulate': True}).json()
        assert result['status'] == status
    assert len(result['timeline']) == 3
    assert client.post('/api/campus/prepare-download', json=body).status_code == 200
    action = {'session_id': sid, 'action': 'download', 'confirmed': True, 'request_reference': reference}
    assert client.post('/api/actions', json={**action, 'owner_token': bob}).status_code == 409
    pdf = client.post('/api/actions', json={**action, 'owner_token': alice})
    assert pdf.status_code == 200
    assert pdf.content.startswith(b'%PDF')
    assert 'convention-demo.pdf' in pdf.headers['content-disposition']
    assert client.post('/api/actions', json={**action, 'owner_token': alice}).status_code == 409


def test_confirmed_form_is_bound_to_server_preview(client):
    sid, token = session(client), profile(client)
    form = {'name': 'Amine Démo', 'student_id': 'ETU-001', 'reason': 'Inscription', 'request_type': 'releve'}
    command(client, sid, 'Envoie le formulaire', form_snapshot=form)
    action = {'session_id': sid, 'action': 'submit', 'confirmed': True, 'owner_token': token}
    assert client.post('/api/actions', json={**action, 'form': {**form, 'request_type': 'stage'}}).status_code == 409
    assert client.post('/api/actions', json={**action, 'form': form}).status_code == 200
    assert len(client.post('/api/campus/requests', json={'token': token}).json()['requests']) == 1
    assert client.post('/api/actions', json={**action, 'form': form}).status_code == 409


def test_dialogue_collects_valid_fields_corrects_and_cancels(client):
    sid = session(client)
    other = session(client)
    assert command(client, sid, 'Je veux faire une demande')['flow']['step'] == 'type'
    assert command(client, sid, 'Convention de stage')['flow']['step'] == 'name'
    assert command(client, other, 'Je veux mes notes')['intent'] == 'grades'
    assert command(client, sid, 'Amine Démo')['flow']['step'] == 'student_id'
    assert command(client, sid, '!!')['flow']['step'] == 'student_id'
    assert command(client, sid, 'ETU 001')['flow']['draft']['student_id'] == 'ETU001'
    result = command(client, sid, 'Dossier de stage')
    assert result['ready'] is True
    assert result['pending_action'] == 'submit'
    changed = command(client, sid, 'corrige le nom en Salma Démo')
    assert changed['flow']['draft']['name'] == 'Salma Démo'
    assert changed['flow']['draft']['reason'] == 'Dossier de stage'
    assert command(client, sid, 'champ précédent')['flow']['step'] == 'reason'
    assert command(client, sid, 'annuler')['intent'] == 'cancel'
    assert command(client, sid, 'je confirme')['pending_action'] is None


def test_guided_submission_keeps_field_values_out_of_learning_history(client):
    sid, token = session(client), profile(client)
    learner = client.post('/api/learning/create', json={'consent': True}).json()['token']
    for text in ['Je veux une attestation de scolarité', 'Amine Démo', 'ETU-001', 'Dossier de stage']:
        result = command(client, sid, text, learner_token=learner)
        assert result['command_id'] is None
    form = result['flow']['draft']
    response = client.post('/api/actions', json={'session_id': sid, 'action': 'submit', 'confirmed': True, 'owner_token': token, 'form': form})
    assert response.status_code == 200
    assert client.post('/api/learning/status', json={'token': learner}).json()['corrections'] == 0
    import backend.main as main
    assert main.sessions[sid]['history'] == {}
    assert main.sessions[sid]['dialogue'] is None


@pytest.mark.parametrize('text', ['ne télécharge pas mon relevé de notes', 'télécharge mon relevé de notes et envoie le formulaire', 'télécharge mon diplôme'])
def test_new_document_commands_preserve_safety_boundary(client, text):
    result = command(client, session(client), text)
    assert result['intent'] == 'unknown'
    assert result['pending_action'] is None


@pytest.mark.parametrize('text,kind', [('Télécharge mon relevé de notes', 'releve'), ('Télécharge ma convention de stage', 'stage')])
def test_new_examples_have_distinct_documents(client, text, kind):
    sid = session(client)
    result = command(client, sid, text)
    assert result['document_type'] == kind
    pdf = client.post('/api/actions', json={'session_id': sid, 'action': 'download', 'confirmed': True})
    assert pdf.status_code == 200 and pdf.content.startswith(b'%PDF')


def test_store_survives_restart_and_erasure_cascades(tmp_path):
    path = tmp_path / 'campus.sqlite3'
    store = CampusStore(path)
    token, other = store.create_profile(), store.create_profile()
    form = {'name': 'Amine Démo', 'student_id': 'ETU-001', 'reason': 'Inscription', 'request_type': 'attestation'}
    store.add(token, form)
    store.add(other, form)
    restarted = CampusStore(path)
    assert len(restarted.list(token)) == 1
    restarted.forget(token)
    with pytest.raises(CampusError):
        restarted.list(token)
    assert len(restarted.list(other)) == 1
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM campus_requests').fetchone()[0] == 1


def test_laboratory_never_creates_pending_actions(client):
    sid = session(client)
    response = client.post('/api/lab/inspect', json={'text': 'Télécharge mon relevé de notes'}).json()
    assert response['executed'] is False
    assert response['service']['intent'] == 'download'
    assert len(response['candidates']) == 3
    import backend.main as main
    assert main.sessions[sid]['pending'] is None
    overview = client.get('/api/lab/overview').json()
    assert overview['training_examples'] > 2000
    assert overview['benchmark'] is None


def test_laboratory_compares_base_with_consented_personal_memory(client):
    sid = session(client)
    learner = client.post('/api/learning/create', json={'consent': True}).json()['token']
    phrase = 'mon carnet du campus'
    result = command(client, sid, phrase, learner_token=learner)
    feedback = client.post('/api/learning/feedback', json={'token': learner, 'session_id': sid, 'command_id': result['command_id'], 'expected_intent': 'grades', 'consent': True})
    assert feedback.status_code == 200
    comparison = client.post('/api/lab/inspect', json={'text': phrase, 'learner_token': learner}).json()
    assert comparison['personal']['intent'] == 'grades'
    assert comparison['personal']['source'] == 'personal_memory'
    assert comparison['executed'] is False
    paused = client.post('/api/learning/toggle', json={'token': learner, 'enabled': False})
    assert paused.status_code == 200
    comparison = client.post('/api/lab/inspect', json={'text': phrase, 'learner_token': learner}).json()
    assert comparison['personal']['source'] == 'base'
