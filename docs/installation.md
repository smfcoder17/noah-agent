# Installer Noah Agent

Trois façons d'installer, puis les mêmes réglages. Il faut Docker, et de la place : environ 5 Go sur le disque, plus 4 Go la première fois qu'un agent navigue.

| Tu veux | Fais | Temps |
|---|---|---|
| L'essayer sur ton ordinateur | [Sur ton ordinateur](#sur-ton-ordinateur) | 10 min, surtout le téléchargement |
| Un agent 24 h/24, joignable partout | [Sur un VPS](#sur-un-vps) | 10 min |
| Le relier à ton téléphone | [Ton téléphone](#ton-téléphone) | 2 min |

> **À savoir aujourd'hui.** L'installation sur VPS télécharge des images publiées par le dépôt GitHub. Tant que ce dépôt et sa première version ne sont pas publiés, seule l'installation sur ton ordinateur marche. Elle compile tout depuis le code.

## Sur ton ordinateur

Installe [Docker Desktop](https://docs.docker.com/get-docker/) et démarre-le, puis, à la racine du dépôt :

```bash
sh install.sh
```

Ouvre http://localhost:8080, crée ton compte et choisis ton modèle. Noah reste sur ta machine : il n'est pas ouvert au réseau.

## Sur un VPS

Un VPS Ubuntu ou Debian, 4 Go de mémoire au moins, ports 80 et 443 libres. Aucun nom de domaine n'est nécessaire.

- **Hostinger :** VPS > Docker Manager > Compose > « Compose from URL », colle `https://github.com/smfcoder17/noah-agent/releases/latest/download/docker-compose.yml`, puis Deploy.
- **Ailleurs,** en root :

```bash
curl -fsSL https://raw.githubusercontent.com/smfcoder17/noah-agent/main/get.sh | sh
```

**Un Traefik tient déjà les ports 80 et 443 ?** `get.sh` le voit et place Noah derrière lui : tes autres sites ne bougent pas. Sans domaine, Noah répond sur `<ip-en-tirets>.sslip.io`.

Le lien de création du compte s'affiche à la fin, ou dans les journaux du service `server`. Il porte un code à usage unique : personne d'autre ne peut créer le compte. Noah répond en HTTPS sur `<ip-en-tirets>.sslip.io`, ou sur ton domaine avec `NOAH_DOMAIN=noah.exemple.com` devant la commande.

## Choisir le modèle

Réglages > Cerveau, un seul choix pour tous tes agents.

| Fournisseur | Il te faut | Pour qui |
|---|---|---|
| **Ollama local** | Ollama lancé sur la machine. Adresse facultative, sans clé | Tes modèles locaux, et les modèles `:cloud` de ton compte Ollama |
| **Ollama Cloud** | Une clé Ollama | Les modèles cloud sans rien installer, le plus simple sur un VPS |
| **Compatible OpenAI** | Une adresse en `/v1`, clé facultative | LM Studio, vLLM, LiteLLM ou tout autre serveur compatible |
| OpenRouter, Anthropic, OpenAI, Gemini | Une clé | Leurs modèles |

Choisis un modèle qui sait utiliser des outils. Une clé ne suit jamais un autre fournisseur ni une autre adresse : si tu changes l'adresse, retape la clé.

## La voix

Le modèle ne suffit pas pour parler : il faut aussi transcrire et synthétiser. Réglages > Voix propose deux chemins :

- **Une clé OpenRouter,** le plus simple : tout marche tout de suite. Elle ne sert qu'à la voix et aux images si ton cerveau est ailleurs.
- **Ton propre serveur de voix,** compatible OpenAI (par exemple [Speaches](https://speaches.ai/)) : son adresse, sa clé facultative, ses modèles. Aucune donnée vocale ne part alors chez un tiers.

La réponse rapide à l'oral suit le fournisseur du cerveau.

## Ton téléphone

- **Android :** installe l'APK, puis scanne le QR code de Réglages > Appareils.
- **iPhone ou autre :** ouvre l'adresse HTTPS de ton VPS, puis « Ajouter à l'écran d'accueil ».
- **Bureau :** `cd desktop && npm install && npm start`.

Accepte les notifications : c'est par elles qu'un agent te rappelle. Sur Android, l'écran d'appel natif n'existe pas encore : un rappel arrive comme une notification, puis ouvre l'écran de Noah. Tu ne l'entends sonner que si le téléphone n'est pas en silencieux.

## Tes agents

- **Créer un agent :** « Créer un agent », un nom et un rôle. Il répond en moins d'une minute.
- **Lui parler :** le bouton de voix à côté du champ, sans rien appuyer ensuite. Parle pour l'interrompre.
- **Faire travailler un agent pour un autre :** « Demande à Rita de… ». Ajoute « et rappelle-moi quand c'est fini » pour qu'il te rappelle.
- **Brancher un outil :** Détails > Connexions > Ajouter un outil, l'adresse d'un serveur MCP, un test, puis Enregistrer. Choisis son droit : lire, agir, ou demander confirmation (par défaut). L'agent l'a en moins d'une minute.
- **Ajouter une personne :** Réglages > Profils. Chacun a ses agents, ses appareils et son plafond de dépenses.
- **Partager un agent :** Détails > Partager, avec le droit lecture, usage ou admin. Attention : un agent partagé garde une seule mémoire, un seul navigateur et un seul dossier, et ses comptes connectés servent à tous ceux avec qui tu le partages.

## En cas de souci

| Ce que tu vois | Quoi faire |
|---|---|
| Un agent « Hors ligne » | Le bouton Redémarrer en haut de sa conversation. Il repart avec ses données |
| « Docker ne répond pas » | Démarre Docker Desktop, puis `sh install.sh` |
| Un outil « En panne » | Vérifie son serveur. L'agent continue sans lui |
| Un outil sur ton réseau privé est refusé | Ajoute le réseau dans « Serveur sur ton réseau privé », sous l'ajout d'un outil |
| La voix ne répond pas | Réglages > Voix : une clé OpenRouter ou un serveur de voix est nécessaire |
| Pas de notification sur le téléphone | Autorise les notifications de Noah dans les réglages du téléphone |

## Sauvegarder et mettre à jour

```bash
sh scripts/backup.sh
```

Noah se met à jour seul pendant ton créneau calme. La sauvegarde contient la clé de chiffrement de tes secrets : range-la en lieu sûr. Détails dans le [README](../README.md).

## Les limites à connaître

- **Plusieurs profils :** l'isolation tient entre agents distincts. Un agent partagé garde une seule machine : donne-le seulement à quelqu'un en qui tu as confiance.
- **Outils OAuth :** ils tournent dans la machine de l'agent. « Demander confirmation » arrête le modèle, pas un agent déjà détourné. Les outils ajoutés sans authentification ou avec un jeton passent par Noah, qui garde le contrôle.
- **Coûts :** Ollama et les serveurs compatibles OpenAI comptent 0 $. Le plafond ne les arrête pas.

## Ce qui n'est pas encore vérifié

Ce guide n'a pas été suivi sur un VPS neuf ni sur un vrai téléphone. L'état exact, parcours par parcours, est dans [etat.md](etat.md).
