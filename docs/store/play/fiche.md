# Fiche Play Store : Noah Agent

Langue par défaut : français (France). Appli, gratuite. Catégorie proposée : Productivité.
Identifiant d'application : `agent.noah.mobile` (`mobile/android/app/build.gradle`).

Longueurs comptées : titre 10/30, description courte 80/80, description longue 2 231/4 000.

## Nom de l'appli (30 caractères au plus)

```
Noah Agent
```

Le nom du dépôt et du manifeste web (`frontend/public/manifest.webmanifest`). Pas d'emoji, pas de « gratuit », « n°1 » ni « nouveau » (règles de métadonnées de Google).

## Description courte (80 caractères au plus)

```
Parle à tes agents IA depuis ton téléphone. Ils tournent sur ton propre serveur.
```

## Description longue (4 000 caractères au plus)

```
Noah Agent relie ton téléphone à ton serveur Noah : des agents IA qui font tes tâches de tous les jours, installés sur ton propre serveur (un VPS, par exemple). Tes conversations restent chez toi, et le modèle d'IA, c'est toi qui le choisis.

Important : cette application ne fonctionne qu'avec un serveur Noah déjà installé. Elle ne crée pas de compte et n'héberge rien. Le guide d'installation du serveur est public sur GitHub (smfcoder17/noah-agent).

CE QUE TES AGENTS FONT
• Neuf modèles d'agent prêts à l'emploi : assistant personnel, veille, recherche, créateur de contenu, achats et démarches, finances du foyer, voyages et sorties, coach d'apprentissage, bricoleur d'apps.
• Chaque agent a sa propre machine, sa mémoire, ses fichiers et son navigateur.
• Tâches à heure fixe, surveillance d'une source, objectifs gardés en tête.
• Sous chaque réponse, un reçu compare ce que l'agent affirme à ce que ses outils ont vraiment fait.

LE MODÈLE QUE TU VEUX
Ollama (local ou Cloud), OpenRouter, Anthropic, OpenAI, Gemini, Mistral, DeepSeek, Mammouth, ou tout service compatible OpenAI. Tu saisis ta clé sur ton serveur, pas dans l'application, et un plafond arrête la dépense.

SUR TON TÉLÉPHONE
• Relier l'appli : sur ton ordinateur, Réglages > Appareils > « Relier un appareil », puis « Scanner le QR code » dans l'appli. Tu confirmes avec un nombre à 3 chiffres : tu ne tapes jamais ton mot de passe dans l'application.
• Notifications : fin de tâche, veille en panne, crédit qui baisse.
• Un agent peut t'appeler quand il a besoin de toi, si tu l'autorises dans les réglages.
• Dictée et mode vocal, bulle flottante pour dicter depuis une autre appli si tu l'actives.
• « Joindre ma position » à un message, seulement quand tu le touches.

TES DONNÉES
• Pas de compte chez nous, aucune télémétrie : l'application ne parle qu'à ton serveur, en HTTPS.
• Tes messages partent seulement chez le fournisseur de modèle que tu as choisi sur ton serveur.
• Avant une action sensible, une carte te demande ton accord.

À SAVOIR
Noah est un projet jeune, sous licence PolyForm Noncommercial : gratuit pour un usage personnel. L'installation du serveur demande un peu d'aisance technique, ou un agent de code pour la faire à ta place.
```

## Coordonnées

- Site web : `https://github.com/smfcoder17/noah-agent` (dépôt public cité dans le README).
- Adresse e-mail de contact : **à fournir par Franck** (obligatoire dans la console, rien dans le dépôt).
- Règles de confidentialité : **URL publique à créer** (voir `confidentialite.md`).

## Images

| Élément | Fichier | Format | Source |
|---|---|---|---|
| Icône | `icone-512.png` | 512 × 512, PNG 32 bits avec alpha, 55 Ko | `frontend/public/assets/icon-512.png`, telle quelle |
| Image de présentation | `presentation-1024x500.png` | 1024 × 500, PNG 24 bits sans alpha | icône du dépôt + titre, fond pêche |
| Captures téléphone | `capture-1` à `capture-5` | 1080 × 1920 (9:16), PNG 24 bits sans alpha | `docs/images/telephone.png`, `presets.png`, `agent-vide.png`, `modeles.png`, et l'écran « Relier Noah » de `mobile/www/index.html` rendu à 1080 × 1920 |

Légende en haut de chaque capture : 340 px sur 1 920, soit 17,7 % (Google demande moins de 20 %).

Réserves sur les captures :
- Seules `capture-1` (téléphone) et `capture-5` (écran de liaison de l'appli) viennent d'un affichage de téléphone. `capture-2`, `-3` et `-4` sont des captures de l'interface web sur ordinateur ; l'appli Android affiche la même interface, mais en mise en page téléphone. À remplacer par de vraies captures du téléphone dès qu'un appareil est relié.
- `capture-1` est agrandie depuis 400 × 860 : un peu douce. Une capture native en 1080 × 2340 serait plus nette.

Fabrication : redimensionnement et composition par un script Pillow, à partir des fichiers du dépôt. Aucune image générée par IA.
