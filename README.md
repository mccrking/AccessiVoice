# AccessiVoice

AccessiVoice est un portail de démonstration qui facilite les démarches universitaires grâce à un assistant utilisable à la voix, au texte ou au clavier.

## Fonctionnalités

- Consulter des notes et préparer trois types de démarches.
- Remplir un formulaire avec un dialogue guidé, corriger les réponses et confirmer les actions.
- Suivre les demandes et retrouver les documents générés par l’application.
- Adapter l’affichage : taille du texte, contraste et navigation au clavier.
- Modifier le nom du profil et écouter une salutation personnalisée.
- Apprendre des expressions personnelles avec l’accord de l’utilisateur.
- Explorer les décisions du modèle dans le laboratoire IA.

Les données et les démarches sont fictives. Aucun service universitaire externe n’est connecté.

## Technologies

React et TypeScript pour l’interface, FastAPI pour l’API, SQLite pour le suivi et scikit-learn pour la reconnaissance des intentions. Le modèle utilise TF-IDF et une régression logistique.

## Installation

Prérequis : **Python 3.12**, **Node.js 24** et npm.

Dans PowerShell, depuis le dossier du projet :

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
npm ci
```

## Lancer le projet

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Presentation
```

Ouvrir **http://127.0.0.1:8000** et garder le terminal ouvert. Utiliser **Ctrl+C** pour arrêter.

Au premier démarrage, le modèle est entraîné automatiquement à partir du corpus fourni. Cela peut prendre un peu de temps.

Pour travailler sur l’interface avec le rechargement automatique :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

L’interface est alors accessible sur **http://127.0.0.1:5173**. La documentation de l’API est disponible sur **http://127.0.0.1:8000/docs**.

## Essayer

1. Écrire « Je veux mes notes » dans l’assistant.
2. Écrire « Je veux faire une demande » et suivre les questions.
3. Relire les informations, les corriger si nécessaire, puis confirmer.
4. Ouvrir **Mon suivi** pour retrouver la demande et simuler son avancement.
5. Ouvrir **Accessibilité** pour personnaliser le profil, la voix et l’affichage.

La voix dépend du navigateur, du microphone et des voix installées. Le texte et le clavier restent disponibles. La reconnaissance vocale du navigateur peut utiliser un service en ligne ; saisir uniquement des données fictives.

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
npx playwright install chromium
npm run test:e2e
```

Les tests du navigateur simulent les événements vocaux. Le microphone et le son doivent aussi être essayés manuellement.

## Organisation

- `src/` : interface et assistant.
- `backend/` : API, dialogue, suivi et apprentissage.
- `data/` : corpus synthétique pour le modèle.
- `scripts/` : entraînement et outils de développement.
- `tests/` : tests Python et navigateur.

Les préférences du profil sont conservées dans le navigateur. Les demandes et les apprentissages sont enregistrés localement dans `backend/runtime/`, un dossier ignoré par Git.
