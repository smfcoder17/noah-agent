# Contribuer à Noah Agent

Un bug, une idée, une consigne fausse dans un guide ? [Ouvre un ticket](https://github.com/smfcoder17/noah-agent/issues/new/choose). Une faille de sécurité passe par [SECURITY.md](SECURITY.md).

Ouvre aussi un ticket avant un gros changement. Le code est disponible sous [PolyForm Noncommercial 1.0.0](LICENSE), et les conditions de reprise d'une contribution ne sont pas encore écrites : on en parle d'abord.

## Lancer le projet

Il te faut [Docker Desktop](https://docs.docker.com/get-docker/). À la racine du dépôt :

```sh
sh install.sh                                    # compile tout, puis http://localhost:8080
cd frontend && npm install && npm run dev        # interface à chaud sur http://localhost:5173, serveur dans Docker
```

Les applications se construisent à part :

```sh
# Windows : l'installateur arrive dans desktop/dist/
cd desktop && npm install && npm run dist
```

```sh
# Android (Node 22, JDK 21, SDK Android) : l'APK de débogage arrive dans app/build/outputs/apk/debug/
cd mobile && npm ci && npx cap sync android
cd android && ./gradlew assembleDebug
```

## Avant de proposer un changement

```sh
node scripts/verifier.mjs          # tout ce que la CI vérifierait, en local
node scripts/verifier.mjs voice    # seulement les étapes qui contiennent ce mot
```

- **Dis ce que tu as prouvé.** `docs/etat.md` classe les preuves du simple écrit à la personne réelle. Ce fichier est généré par `tools/eval/score.mjs` : ne le modifie pas à la main.
- **Une promesse suit sa preuve.** Le README n'annonce que ce que le code tient, et il dit ce qui reste à vérifier.
- **Écris pour la personne qui lit.** L'interface et la documentation sont en français clair, sans jargon.

## Où est quoi

| Dossier | Rôle |
|---|---|
| `server/` | API, comptes, relais de modèle, juge, coffre |
| `launcher/` | Le seul service qui parle à Docker |
| `frontend/` | L'interface |
| `desktop/`, `mobile/` | Les applications Windows et Android |
| `deploy/`, `get.sh` | Ce qui part sur un VPS |
| `tests/`, `tools/eval/` | Les tests et la grille de preuve |
