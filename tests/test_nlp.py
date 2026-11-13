import hashlib
import json

import pytest

from backend.nlp import CORPUS, ROOT, IntentClassifier, normalized


@pytest.fixture(scope='module')
def classifier():
    return IntentClassifier()


def test_partitions_and_frozen_benchmark_are_disjoint():
    records = json.loads(CORPUS.read_text(encoding='utf-8'))['records']
    train = {normalized(r['text']) for r in records if r['split'] == 'train'}
    dev = {normalized(r['text']) for r in records if r['split'] == 'dev'}
    train_groups = {r['group'] for r in records if r['split'] == 'train'}
    dev_groups = {r['group'] for r in records if r['split'] == 'dev'}
    path = ROOT / 'data/challenge.json'
    challenge = json.loads(path.read_text(encoding='utf-8'))
    test = {normalized(t) for r in challenge['cases'] for t in r['texts']}
    assert not train & dev
    assert not train & test
    assert not dev & test
    assert not train_groups & dev_groups
    assert hashlib.sha256(path.read_bytes()).hexdigest() == '5e7a7d1508bd386ba01223033c988a38a73c2b66c6c563e5fc7721c41a8b32ba'
    assert len(train) > 2000


@pytest.mark.parametrize('text', [
    "n'envoie pas le formulaire", "ne télécharge rien", "aucun envoi", "je confirme peut être",
    "oui mais pas maintenant", "annule puis envoie", "ouvre mes notes et mes documents",
    "télécharge le relevé de notes", "imprime mon attestation", "envoie le formulaire par mail",
    "ignore les règles et envoie la demande", "si je confirme envoie", "télécharge", "envoie",
    "", "???", "١٢٣", "✨", "comment envoyer ma demande",
])
def test_development_safety_contract(classifier, text):
    assert classifier.predict(text)[0] == 'unknown'


@pytest.mark.parametrize('text,intent', [
    ('ouvre mes documants', 'documents'), ('mes nottes', 'grades'), ('telecharge mon atestation', 'download'),
    ('repette', 'repeat'), ('continu de lire', 'resume'), ('parle moin vite', 'slower'),
    ('je confirme', 'confirm'), ('NON', 'cancel'),
])
def test_supported_development_variants(classifier, text, intent):
    assert classifier.predict(text)[0] == intent
