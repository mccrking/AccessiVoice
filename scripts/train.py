"""Run from the repository root: python -m scripts.train"""
from backend.nlp import ARTIFACT, train_model

if __name__ == "__main__":
    train_model()
    print(f"Modèle entraîné : {ARTIFACT}")
