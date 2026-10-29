# Apollo

Des agents personnels auto-hébergés, construits sur [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Apollo ajoute une interface simple au-dessus d'Hermes : un compte local, le choix du modèle en quelques clics,
plusieurs agents isolés, et un chat qui montre ce que fait l'agent sans afficher ses prompts ni ses commandes.

## Démarrer

Prérequis : Docker (Docker Desktop sous Windows et macOS).

```sh
sh install.sh
```

Puis ouvre http://localhost:8080 :

1. crée le compte administrateur (il reste sur ta machine) ;
2. choisis un fournisseur (OpenRouter, Anthropic, OpenAI, Gemini ou Ollama), colle ta clé et le modèle ;
3. ton premier agent, « Assistant », démarre en une trentaine de secondes ;
4. crée d'autres agents avec « + Nouveau » : un nom et un rôle suffisent.

### Avec Ollama

Ollama doit tourner sur la machine hôte. Les agents le joignent via `host.docker.internal:11434`.
Les modèles `:cloud` d'Ollama fonctionnent aussi. Choisis un modèle qui gère les outils (*tools*).

### Depuis ton téléphone

1. Dans `.env`, mets `APOLLO_BIND=0.0.0.0`, puis relance `docker compose up -d`.
2. Sur le téléphone, connecté au même Wi-Fi, ouvre `http://<adresse-IP-du-PC>:8080`.
3. Pour l'installer comme une app (« Ajouter à l'écran d'accueil »), le navigateur exige HTTPS :
   passe par Tailscale (`tailscale serve 8080`) ou un nom de domaine avec Caddy.

## Ce qui tourne

| Service | Rôle |
|---|---|
| `apollo-server` | API, comptes, traduction des événements d'Hermes, interface web. Seul port exposé. |
| `apollo-launcher` | Seul service qui parle à Docker. Crée un conteneur par agent à partir d'une image fixe, sans privilège ni montage de l'hôte. |
| `apollo-agent-*` | Un conteneur Hermes par agent, avec son volume (mémoire, fichiers). Jamais exposé. |

Les données sont dans les volumes Docker `apollo_apollo-data` (compte, clé chiffrée, historique)
et `apollo-agent-*` (un par agent). `sh scripts/reset.sh` efface tout.

## Interface

`frontend/` : Vite + React + TypeScript + Tailwind, avec [assistant-ui](https://www.assistant-ui.com)
pour le chat (runtime « external store » branché sur nos événements SSE) et des composants
dans l'esprit de shadcn/ui. L'image Docker du serveur la compile et la sert ; rien à installer
pour l'utilisateur.

Pour la développer avec rechargement à chaud (le serveur Apollo doit tourner dans Docker) :

```sh
cd frontend && npm install && npm run dev
```

puis ouvre http://localhost:5173 (l'API et l'écran noVNC sont relayés vers le port 8080).

## Relais de modèle et budget

Les agents n'ont jamais la clé du fournisseur. Ils appellent `apollo-server` (`/relay/v1`, compatible OpenAI)
avec un jeton propre à chacun ; le serveur ajoute la clé, transmet la requête et enregistre les jetons
et le coût de chaque appel (coût exact avec OpenRouter, estimé avec les prix publics sinon).
Un budget mensuel optionnel bloque les appels une fois atteint. La dépense du mois s'affiche en bas
de la colonne de gauche.

## Navigateur et écran de l'agent

Chaque agent a son navigateur [Camoufox](https://camoufox.com) (Firefox anti-détection), dans un conteneur
`apollo-browser-*` basé sur [camofox-browser](https://github.com/jo-inc/camofox-browser), que Hermes pilote
nativement (`CAMOFOX_URL`). Le profil (cookies, sessions connectées) est gardé dans un volume.

Le bouton « Ordinateur » ouvre l'écran du navigateur en direct (noVNC, relayé par le serveur derrière ta
connexion). « Prendre le contrôle » passe en mode interactif : tu te connectes toi-même à un site ou tu
résous un CAPTCHA, puis tu dis à l'agent de continuer. L'agent a pour consigne de ne jamais demander de mot
de passe dans la conversation.

## Fichiers

- Joindre : bouton « + », glisser-déposer ou coller dans la zone de message. Les fichiers arrivent dans
  `/opt/data/workspace/uploads/` et le message les cite à l'agent.
- L'onglet « Fichiers » liste l'espace de travail de l'agent (livrables, applications, captures, envois)
  avec téléchargement et aperçu. Les applications web générées s'ouvrent dans un bac à sable sans accès
  à la session Apollo.

## Cache de prompt

Le début du prompt de chaque agent (identité, capacités) est un texte fixe ; le rôle propre vient à la fin.
Les fournisseurs mettent ce préfixe en cache. Pour Claude, Kimi et Qwen, qui demandent des marqueurs
explicites, le relais est déclaré à Hermes comme route avec `prompt_caching`. La part lue depuis le cache
s'affiche dans l'onglet « Détails ».

## Images

Quand un agent veut montrer une capture, il l'enregistre dans `/opt/data/workspace/captures/` et écrit
`MEDIA:/chemin.png`. L'interface l'affiche dans la conversation. Le lanceur ne sert que des images,
et seulement depuis les dossiers de travail de l'agent.

## Limites connues

- Le lanceur a accès au socket Docker. Il n'expose qu'un petit vocabulaire, mais reste
  le composant le plus sensible.
- Un seul compte administrateur pour l'instant.

## Feuille de route

1. ~~Un agent derrière une interface simple.~~
2. ~~Plusieurs agents, un conteneur chacun, historique, version mobile.~~
3. ~~Relais de modèle (clé hors des agents, budgets), choix du modèle par catalogue, images.~~
   ~~Navigateur Camoufox, vue en direct et prise de contrôle, fichiers.~~
   ~~Nouvelle interface (assistant-ui + shadcn).~~ Modèle par agent.
4. Veille programmatique (collecte sans LLM, triage par petit modèle), Gmail et Agenda.
5. Apps mobile et desktop, appairage par QR code, installation en une commande sur VPS.

L'architecture complète est décrite dans [docs/architecture.html](docs/architecture.html).
