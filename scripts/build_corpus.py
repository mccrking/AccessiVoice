"""Deterministic augmentation confined to training groups; no holdout templates."""
import json
import random
import unicodedata

from backend.nlp import ROOT, normalized


def build():
    source = json.loads((ROOT / 'data/training_seeds.json').read_text(encoding='utf-8'))
    original = json.loads((ROOT / 'data/intents.json').read_text(encoding='utf-8'))
    protected = {normalized(text) for row in original for text in row['test']}
    challenge = json.loads((ROOT / 'data/challenge.json').read_text(encoding='utf-8'))
    challenge_keys = {normalized(text) for row in challenge['cases'] for text in row['texts']}
    # Historical fixtures may coincide with exact confirmations; keep them evaluation-only.
    reserved = protected | challenge_keys
    dev_keys = {normalized(text) for row in source.values() for text in row['dev']}
    records, seen = [], set()
    for label, row in source.items():
        old = next((item['train'] for item in original if item['intent'] == label), [])
        for index, text in enumerate(old + row['train']):
            # Keep the entire family out if its source is reserved for evaluation.
            if normalized(text) in reserved | dev_keys:
                continue
            group = f'{label}-seed-{index:03d}'
            variants = [text]
            if label != 'unknown':
                variants += [f's’il te plaît {text}', f'{text} merci', f'bonjour {text} s il te plait', f'{text} svp']
                # One reproducible keyboard-like deletion per seed, not an ASR simulation.
                plain = ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c))
                candidates = [i for i, c in enumerate(plain) if c.isalpha() and i > 1 and i < len(plain) - 2]
                if candidates:
                    rng = random.Random(group)
                    position = rng.choice(candidates)
                    variants.append(plain[:position] + plain[position + 1:])
            for variant in variants:
                key = normalized(variant)
                if key and key not in seen and key not in reserved and key not in dev_keys:
                    records.append({'text': variant, 'intent': label, 'split': 'train', 'group': group, 'source': 'synthetic_curated_or_augmented'})
                    seen.add(key)
        for index, text in enumerate(row['dev']):
            key = normalized(text)
            if key in reserved:
                raise ValueError(f'Development text overlaps evaluation: {text}')
            if key in seen:
                raise ValueError(f'Duplicate across partitions: {text}')
            records.append({'text': text, 'intent': label, 'split': 'dev', 'group': f'{label}-dev-{index:03d}', 'source': 'synthetic_curated'})
            seen.add(key)
    target = ROOT / 'data/corpus.json'
    target.write_text(json.dumps({'seed': 42, 'description': 'Synthetic French text. All augmentations of one seed stay in train. Dev selects parameters; legacy and challenge tests are evaluation-only. Exact normalized overlaps excluded; semantic independence is not guaranteed.', 'records': records}, ensure_ascii=False, indent=2), encoding='utf-8')
    print({split: sum(row['split'] == split for row in records) for split in ['train', 'dev']})


if __name__ == '__main__':
    build()
