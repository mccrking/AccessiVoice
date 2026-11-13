"""Read-only teaching views. Inspecting a phrase never executes a campus action."""
from collections import Counter
import json
import time
from backend.nlp import CORPUS, ROOT, VERSION, normalized, rule_decision, data_hash
from backend.dialogue import service_command


def overview(classifier):
    records = json.loads(CORPUS.read_text(encoding='utf-8'))['records']
    counts = {split: Counter(row['intent'] for row in records if row['split'] == split) for split in ('train', 'dev')}
    path = ROOT / 'reports/training_comparison.json'
    benchmark = None
    if path.exists():
        report = json.loads(path.read_text(encoding='utf-8'))
        if report.get('training_data_sha256') == data_hash() and report.get('version') == VERSION:
            benchmark = {'created_at': report['created_utc'], 'examples': report['after']['examples'], 'accuracy': report['after']['accuracy'], 'macro_f1': report['after']['macro_f1'], 'false_sensitive': report['after']['false_sensitive_predictions'], 'model_only_accuracy': report['model_only_ablation']['accuracy'], 'errors': report['after']['errors'], 'limitations': report['limitations']}
    return {'model_version': VERSION, 'fingerprint': data_hash(), 'config': classifier.config, 'training_examples': sum(counts['train'].values()), 'development_examples': sum(counts['dev'].values()), 'distribution': [{'intent': key, 'train': counts['train'][key], 'dev': counts['dev'][key]} for key in sorted(counts['train'])], 'benchmark': benchmark}


def inspect(classifier, text):
    started = time.perf_counter()
    probabilities = classifier.model.predict_proba([text])[0]
    order = probabilities.argsort()[::-1][:3]
    intent, score = classifier.predict(text)
    service = service_command(text)
    return {'normalized': normalized(text), 'base': {'intent': intent, 'score': score, 'source': 'policy_rules' if rule_decision(text) is not None else 'statistical_model'}, 'service': service, 'candidates': [{'intent': str(classifier.model.classes_[index]), 'score': round(float(probabilities[index]), 4)} for index in order], 'duration_ms': round((time.perf_counter() - started) * 1000, 2), 'executed': False}
