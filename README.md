# Apollo

Un agent personnel auto-hébergé, construit sur [Hermes Agent](https://github.com/NousResearch/hermes-agent).
Apollo ajoute une interface simple au-dessus d'Hermes : un compte local, le choix du modèle en quelques clics, et un chat qui montre ce que fait l'agent sans afficher ses prompts ni ses commandes.

## Démarrer

Prérequis : Docker.

```sh
./install.sh
```

Puis ouvre http://localhost:8080 :

1. crée le compte administrateur (il reste sur ta machine) ;
2. choisis un fournisseur (OpenRouter, Anthropic, OpenAI, Gemini ou Ollama) et colle ta clé ;
3. parle à ton agent.

## Ce qui tourne

| Service | Rôle |
|---|---|
| `apollo-server` | API, comptes, traduction des événements d'Hermes, interface web. Seul port exposé, en local. |
| `apollo-hermes` | La gateway Hermes Agent, avec son API activée. Jamais exposée hors du réseau Docker. |
| `apollo-docker-proxy` | Accès Docker restreint : le serveur peut seulement redémarrer des conteneurs. |

Les données (compte, clés, mémoire de l'agent) sont dans les volumes Docker `apollo_apollo-data` et `apollo_hermes-data`.

## Feuille de route

1. Un agent derrière une interface simple (ce dépôt aujourd'hui).
2. Plusieurs agents, un conteneur chacun, navigateur visible et prise de contrôle.
3. Veille programmatique (collecte sans LLM, triage par petit modèle), Gmail et Agenda.
4. Apps mobile et desktop, appairage par QR code, installation en une commande sur VPS.

L'architecture complète est décrite dans [docs/architecture.html](docs/architecture.html).
