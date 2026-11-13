import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.main import app, sessions


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr('backend.main.DB', tmp_path / 'events.sqlite3')
    with TestClient(app) as connection:
        yield connection


def new_session(client):
    return client.post("/api/sessions").json()["session_id"]


def command(client, session, text):
    return client.post("/api/commands", json={"session_id": session, "text": text}).json()


def test_health_and_missing_session(client):
    assert client.get("/api/health").json()["demo"] is True
    assert client.post("/api/commands", json={"text": "mes notes", "session_id": "invented"}).status_code == 401


@pytest.mark.parametrize("text,intent", [("Je veux mes notes", "grades"), ("Ouvre mes documents", "documents"), ("Ouvre mes démarches", "forms"), ("Lis cette page", "read"), ("Télécharge mon attestation", "download"), ("Envoie le formulaire", "submit"), ("Je confirme", "confirm"), ("Non", "cancel")])
def test_core_intents(client, text, intent):
    assert command(client, new_session(client), text)["intent"] == intent


@pytest.mark.parametrize("text", ["ne télécharge pas mon attestation", "je ne veux pas envoyer ce formulaire", "sans télécharger", "achète une pizza", "supprime tous mes fichiers", "paie mon inscription", "", "x" * 501])
def test_unsafe_or_unsupported_commands(client, text):
    response = client.post("/api/commands", json={"session_id": new_session(client), "text": text})
    if not text or len(text) > 500:
        assert response.status_code == 422
    else:
        assert response.json()["intent"] == "unknown"


def test_confirmation_is_required_and_consumed(client):
    token = new_session(client)
    body = {"session_id": token, "action": "download", "confirmed": True}
    assert client.post("/api/actions", json=body).status_code == 409
    command(client, token, "Télécharge mon attestation")
    assert client.post("/api/actions", json={**body, "confirmed": False}).status_code == 409
    result = client.post("/api/actions", json=body)
    assert result.status_code == 200
    assert result.headers["content-type"] == "application/pdf"
    assert result.content.startswith(b"%PDF")
    assert client.post("/api/actions", json=body).status_code == 409


def test_cancel_and_expiration(client):
    token = new_session(client)
    body = {"session_id": token, "action": "download", "confirmed": True}
    command(client, token, "Télécharge mon attestation")
    command(client, token, "Annuler")
    assert client.post("/api/actions", json=body).status_code == 409
    command(client, token, "Télécharge mon attestation")
    sessions[token]["pending"]["at"] = time.monotonic() - 121
    assert client.post("/api/actions", json=body).status_code == 409


def test_sessions_are_isolated(client):
    alice, bob = new_session(client), new_session(client)
    command(client, alice, "Télécharge mon attestation")
    assert client.post("/api/actions", json={"session_id": bob, "action": "download", "confirmed": True}).status_code == 409


def test_submit_requires_valid_form_and_matching_action(client):
    token = new_session(client)
    command(client, token, "Envoie le formulaire")
    body = {"session_id": token, "action": "submit", "confirmed": True}
    assert client.post("/api/actions", json=body).status_code == 422
    assert client.post("/api/actions", json={**body, "action": "download"}).status_code == 409
    result = client.post("/api/actions", json={**body, "form": {"name": "Amine Démo", "student_id": "DEMO-123", "reason": "Dossier de stage"}})
    assert result.status_code == 200
    assert result.json()["reference"].startswith("DEMO-")
    assert client.post("/api/actions", json=body).status_code == 409


def test_confirmation_race_only_executes_once(client):
    token = new_session(client)
    command(client, token, "Télécharge mon attestation")
    body = {"session_id": token, "action": "download", "confirmed": True}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post("/api/actions", json=body).status_code, range(2)))
    assert sorted(results) == [200, 409]


def test_metrics_expose_no_transcripts(client):
    command(client, new_session(client), "Ouvre mes documents")
    metrics = client.get("/api/metrics").json()
    assert metrics["commands"] >= 1
    assert set(metrics) == {"commands", "mean_inference_ms", "unknown_commands", "model_version"}
