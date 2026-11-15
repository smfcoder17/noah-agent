# Noah Agent 0.3.0 : plan, lots et tests

Demande de Franck du 15 novembre 2026 (conversation). Ce fichier est écrit **avant** le code : chaque lot a son critère de fin, ses tests fonctionnels, non fonctionnels et de régression. Une case n'est cochée qu'avec sa preuve (commande, sortie, capture). Les leçons de Nod (n8n) viennent de `nod-comparaison.md`.

Avant la 0.3.0, la **0.2.1** (correctif) part avec : saisie mobile refaite, mascotte unique, cartes du retour, ↑/↓ dans l'historique, copier et reprendre ses messages, agent réveillé au premier message, « plus relié » qui mène toujours à l'accueil, pas d'alerte « nouvel appareil » sur l'appareil qu'on vient de relier, révocation de la session en service corrigée.

## Méthode

1. Ce plan, puis le code lot par lot, chacun sur sa branche, fusionné quand ses tests sont verts.
2. Relecture de chaque lot selon ce plan : **un agent GLM 5.3 Flash** (`tools/agents/consult.mjs --role code-review --model glm-5.3-flash:cloud`) et **un agent Opus**. Pas de Codex pour la relecture.
3. Tests par des agents indépendants : **DeepSeek 4.1 Flash** et **Sonnet**, qui suivent les scénarios ci-dessous dans l'app réelle (local, Docker).
4. Audit de sécurité offensif en local : **DeepSeek**, **Sonnet**, **Kimi K3**, chacun cherche à entrer, élever ses droits, sortir du conteneur, lire les secrets.
5. Tout en local (`docker compose -p noah`, app de bureau avec `NOAH_PROFIL=Test`). La CI ne sert qu'à publier.

## Lot A : abonnements comme fournisseurs (Claude Code, ChatGPT)

**But.** Dans Réglages > Modèles > Fournisseurs, « Claude Code (ton ordinateur) » et « ChatGPT (ton ordinateur) » se choisissent comme n'importe quel fournisseur. Les requêtes du cerveau partent vers l'app de bureau de la personne, qui les fait passer par **son** Claude Code (binaire officiel non modifié, `claude -p`) ou **son** forfait ChatGPT (connexion officielle « Sign in with ChatGPT », déjà faite en 0.2). La réponse revient au serveur, puis à tous les appareils.

**Fonctionnement.**
- Le serveur expose ces fournisseurs comme une API compatible OpenAI interne (`/v1/chat/completions` du relais) : le maillon `ordinateur:claude-code` ou `ordinateur:chatgpt` transmet la requête au bureau en ligne du propriétaire (canal déjà ouvert par `desktop.py`), qui répond en flux.
- Claude Code : le bureau lance `claude -p --output-format stream-json --verbose --model <m> --tools "" --system-prompt <instructions>` avec la conversation en entrée ; les outils du cerveau (format OpenAI) sont décrits dans la consigne et l'appel d'outil revient en JSON validé (`--json-schema` quand la CLI le permet, sinon analyse stricte avec une relance). Aucun jeton n'est lu ni stocké par Noah.
- Modèles : le bureau liste les modèles du compte (ChatGPT : liste du compte ; Claude Code : `sonnet`, `opus`, `haiku` et les noms complets acceptés par `--model`). Le serveur les affiche comme ceux des autres fournisseurs.
- Dépenses : chaque appel est noté dans `usage` avec le fournisseur, le modèle, les jetons rapportés par la CLI, et le coût « compris dans l'abonnement » (0 $ affiché comme tel, jamais confondu avec « prix inconnu »).
- Web et mobile : les deux fournisseurs apparaissent avec « (ton ordinateur seulement) ». Les choisir ouvre une boîte : « Continue sur ton ordinateur » ; le lien `noah-agent://abonnements/claude` (ou `chatgpt`) ouvre l'app de bureau, ou la ramène au premier plan si elle tourne, sur l'écran de connexion de l'abonnement. Sans app de bureau : lien de téléchargement.
- PC éteint : le fournisseur de secours de l'agent répond, et la conversation le dit d'une ligne (« ton ordinateur est éteint : réponse par <fournisseur> »).

**Risque à dire à Franck.** Anthropic interdit de faire passer des requêtes par les identifiants d'un abonnement pour le compte d'autrui ; lancer soi-même le binaire officiel, connecté par soi, est permis par le texte (`abonnements.md`). L'usage reste personnel : un agent partagé avec un autre profil n'utilise jamais l'abonnement du propriétaire.

**Tests fonctionnels.**
- A1 Bureau connecté à Claude Code, fournisseur choisi : un message reçoit une réponse produite par `claude -p` (faux `claude` en test, vrai `claude` à la main), visible sur le web et le téléphone.
- A2 Appel d'outil : le cerveau demande `terminal`, le bureau rend un `tool_calls` valide, Hermes exécute, la réponse finale arrive.
- A3 Liste des modèles du compte affichée ; le modèle choisi est celui passé à `--model`.
- A4 PC éteint en route : le secours répond, ligne explicative, aucune requête perdue.
- A5 Web : l'option porte « (ton ordinateur seulement) », la boîte propose d'ouvrir l'app ; le lien ramène l'app au premier plan sur la bonne page.
- A6 ChatGPT : mêmes étapes avec le forfait (faux OpenAI en test).
- A7 Activité : chaque tour porte « Claude Code · sonnet · abonnement », jetons, durée.
- A8 Agent partagé, message d'un invité : jamais par l'abonnement du propriétaire.

**Non fonctionnels.** Premier jeton en moins de 8 s hors temps du modèle ; aucun jeton ou secret de l'abonnement dans les journaux, la base ou le réseau du serveur ; une seule requête à la fois par PC (file), délai 10 min par tour ; arrêt propre (Stop) en moins de 5 s.

**Régression.** Tâches confiées à Claude Code (0.2) toujours vertes (`tests/desktop/claude_test.mjs`, `abonnements_test.py`, `abonnements_reel.mjs`) ; relais sans PC inchangé (`tests/relay`).

## Lot B : coffre (leçons de Nod)

**But.** L'agent ne redemande plus un identifiant déjà retenu, et la liste des sites dit la vérité.

- B1 `coffre.py` : sur une page de connexion, le **serveur** cherche les identifiants du site (origine exacte, puis même site enregistrable : `www.instagram.com` ↔ `instagram.com`) ; un seul : il remplit sans demander ; plusieurs : la carte demande lequel ; aucun : la carte demande l'identifiant.
- B2 Coffre **par personne**, partagé par ses agents (droit « utiliser mon coffre » par agent, allumé pour les agents du propriétaire, éteint pour un agent partagé). Migration des lignes par agent vers le propriétaire, sans perte.
- B3 Le modèle ne voit jamais un secret : nom, site, deux premiers caractères de l'identifiant. Remplissage et envoi par le serveur en une étape.
- B4 Cartes de paiement et clés d'authentificateur (TOTP) dans le coffre ; une carte ne part qu'après accord pour un paiement précis (boutique, montant) ; le code de sécurité est tapé par la personne. Code TOTP tapé par le serveur sans passer au modèle.
- B5 `sites.py` : registre vérifié. Un site est « connecté » seulement après un contrôle du serveur (page sur le site, pas de champ mot de passe visible) ; « Retirer » tient ; la devinette par cookies disparaît de la liste ; « identifiants retenus » et « sessions » séparés ; état « à reconnecter ».
- B6 Écran Coffre (Réglages > Coffre) : ajouter, voir (après preuve), modifier, supprimer un identifiant, une carte, une clé TOTP ; import CSV d'un gestionnaire de mots de passe.

**Tests fonctionnels.** B1 avec un identifiant Instagram retenu : aucune carte, connexion faite ; deux comptes : carte « lequel » ; B2 un identifiant retenu par l'agent A sert à l'agent B du même propriétaire, pas à un agent partagé ; B3 aucune valeur secrète dans le flux du modèle (sonde dans le test) ; B4 paiement refusé sans accord, accepté une fois, pas deux ; B5 un site lu seulement n'apparaît pas, « Retirer » tient après rechargement ; B6 import CSV de 3 lignes, une mauvaise refusée avec sa raison.

**Non fonctionnels.** Chiffrement au repos (clé hors base, `noah_noah-secrets`) ; aucune valeur dans les journaux ; accès à un secret exige la preuve (mot de passe ou code) côté interface.

**Régression.** `tests/tools/juge_test.py`, tests du coffre existants, connexions déjà enregistrées toujours valides après migration.

**État (branche `feat/030-coffre`).** Preuves : `tests/tools/coffre_030_test.py` (58 vérifications), `tests/tools/coffre_test.py` (100), `tests/tools/sites_test.py`, `frontend/src/components/Vault.test.tsx` (5 tests), vitest complet et build verts.
- [x] B1 serveur qui choisit (origine exacte, puis même site en https, même port, hors hébergements partagés) ; carte « Quel compte ? » ; identifiant refusé par le site écarté 10 min du choix d'office (sinon boucle).
- [x] B2 tables `coffre` (par personne) et `coffre_agents` (droit) ; migration `db._migrate_logins`, même id, même secret scellé.
- [x] B3 `list` : nom, site, deux premiers caractères ; sonde sur toutes les réponses à l'agent.
- [ ] B4 partiel : clé TOTP (code tapé par le serveur) et carte rangée sans code de sécurité. **Pas fait** : le paiement lié à un accord (boutique, montant, usage unique) ; il faut des champs de carte dans `launcher/camofox-noah` (`/noah/remplir`) et le lot C (accords). Les cartes ne sont jamais montrées au modèle.
- [x] B5 registre vérifié (`sites.verify`), états `connecte`, `a_reconnecter`, `non_verifie` ; plus de lecture des cookies.
- [x] B6 Réglages > Coffre : ajouter, voir après preuve (`_prove_if_needed`, 15 min), modifier, supprimer, import CSV (Chrome, Firefox, Bitwarden, 1Password), droit par agent.

**Doutes (tranchés par l'option la plus sûre, à relire par Franck).**
1. « Agent partagé » lu comme : un agent du propriétaire qui a au moins un partage (`agent_shares`). Son droit est éteint d'office ; un agent qui avait déjà des identifiants avant la migration garde le droit allumé, pour que ses connexions restent valides.
2. « Même site enregistrable » : sans liste publique des suffixes, on calcule le site comme `site_of` et on refuse le même-site sur une liste d'hébergements partagés (`SHARED_HOSTING` : github.io, vercel.app…), en http, ou sur un autre port. L'origine exacte reste toujours acceptée.
3. Seul le propriétaire de l'agent remplit son coffre : un admin partagé qui répond à la carte se connecte, mais rien n'est retenu, et la carte « Quel compte ? » ne lui montre pas les comptes du propriétaire. `GET /api/agents/{id}/coffre` passe de « admin » à « propriétaire ».
4. Les sites notés avant la 0.3.0 n'ont été que déclarés par l'agent : ils restent dans la liste, marqués « Non vérifié », au lieu d'être effacés ou crus.
5. Le modèle voit les deux premiers caractères de l'identifiant, sans le domaine de l'adresse (avant : un caractère et le domaine).
6. Pendant une routine, le plugin refuse toujours `save_login` avant le serveur : le choix d'office ne joue pas en routine (seul `list` puis `fill`, comme avant).
7. `tests/profiles/profiles_test.py` et `tests/exposition/sorties_test.py` échouent déjà sur `HEAD` (routes `connections/cles`, `desktop/progres`, `taches-confiees` non déclarées ; adresses OpenAI de `desktop/chatgpt.js`), hors du lot B : non corrigés ici. Les routes du coffre y sont déclarées, et le reste de `profiles_test` passe une fois ces cinq routes mises de côté.

## Lot C : juge et accords (leçons de Nod)

- C1 Le juge doit citer mot pour mot les paroles de la personne pour laisser passer ; le serveur vérifie la citation ; elle s'affiche dans l'Activité.
- C2 Seuls les gestes qui engagent (envoi, publication, paiement, suppression, écriture hors de l'agent) passent par le juge ; lecture, frappe, navigation, `sleep`, `cd` passent.
- C3 Accord lié à l'action exacte et ses arguments, à usage unique, avec un titre qui dit l'action ; états « fait », « annulé », « expiré », « a peut-être eu lieu ».
- C4 Une clé collée dans la conversation (formes `sk-`, `ghp_`, `xoxb-`…) est masquée avant le modèle et dans les titres.
- C5 Prix inconnu affiché « prix inconnu », jamais 0 $ ; point d'étape à 5 $ par tâche.

**Tests.** Corpus du juge (`tests/tools/juge_test.py`) étendu : 20 cas « dit / pas dit », 10 gestes de lecture qui ne demandent rien ; citation inventée refusée ; accord rejoué refusé ; clé masquée dans le titre de tâche.

## Lot D : interface (bureau et web)

- D1 **Barre du haut à droite** : icônes Activité, Tâches, Fichiers, Ordinateur, Session, Détails, avec infobulle. Elles ouvrent le **panneau de droite** ; plus de sous-menu sous l'agent dans la barre de gauche.
- D2 **Panneau de droite** : redimensionnable, bouton « plein écran » qui l'étend sur toute la page, fermeture par Échap. Ordinateur : dans le panneau, plus large par défaut.
- D3 **Fichiers** : arbre de dossiers dépliables (icônes de dossier), aperçu du fichier dans le panneau (texte, Markdown rendu, image, PDF, HTML en bac à sable), filtre.
- D4 **Barre de session** : tâches en arrière-plan (processus lancés, routines, tâches confiées) avec leur état, et les derniers fichiers ou résultats ; un clic ouvre l'aperçu dans le panneau.
- D5 **Barre de gauche** minimale : grand visage de l'agent (pas de carré), nom, statut, réglages à côté ; repliable en icônes seules ; état gardé.
- D6 Une seule mascotte vivante dans la conversation (fait en 0.2.1), cartes du retour (fait).

**Tests fonctionnels.** Chaque icône ouvre son panneau et l'infobulle dit son nom ; Échap ferme ; plein écran puis retour ; arbre : déplier, ouvrir un `.md`, une image, un PDF ; barre de session : une tâche lancée apparaît en moins de 3 s et disparaît à sa fin ; gauche repliée puis rouverte après rechargement.

**Non fonctionnels.** Ouverture d'un panneau en moins de 150 ms ; aucun décalage de mise en page (CLS < 0,05) ; clavier : tout se fait sans souris, focus visible ; contraste AA ; anglais et français complets (`i18n.test.ts`).

**Régression.** 141 tests vitest, `lot2-regressions.test.tsx`, conversation, appels, accords.

## Lot E : mobile

- E1 Même barre d'icônes en haut à droite (repliée dans un menu « … » si l'écran est étroit) ; panneaux en feuille plein écran avec retour.
- E2 Saisie à la ChatGPT (fait), en-tête compact (fait), clavier suivi (fait) ; espacements, tailles de cible ≥ 44 px, aucune ligne de texte coupée.
- E3 Notification « nouvel appareil » urgente (canal Android à importance haute, déjà en place) ; l'écran d'alerte n'apparaît pas sur l'appareil qu'on vient de relier (fait).

**Tests.** Parcours complet sur 375×812 et sur un vrai Android : envoyer, joindre, dicter, ouvrir chaque panneau, revenir ; captures avant/après.

## Lot F : sécurité

- F1 Non-indexation : `robots.txt` « Disallow: / » et `X-Robots-Tag: noindex, nofollow, noarchive` sur toutes les réponses (déjà en production, vérifié le 15 novembre) ; test qui l'exige sur chaque route publique.
- F2 Audit offensif local par trois agents (DeepSeek, Sonnet, Kimi K3) : authentification (force brute, fixation, CSRF, jetons), autorisation entre profils, injection (SQL, commandes, chemins), SSRF par l'agent ou les aperçus de liens, sortie du conteneur de l'agent vers l'hôte ou le lanceur (socket Docker), lecture des secrets, XSS dans les messages et les aperçus HTML, en-têtes.
- F3 Corrections de chaque faille trouvée, avec un test qui la rejoue.
- F4 Double vérification proposée dès la création du compte sur un serveur public (pas imposée).

**Critère de fin.** Aucun constat « critique » ou « élevé » ouvert ; chaque constat a son test.

## Tests de régression communs (avant chaque fusion)

`node scripts/verifier.mjs` (suite entière), vitest + build du frontend, tests du bureau (`tests/desktop/*_test.mjs`), comptes (`tests/install/comptes_test.py`), exposition (`tests/exposition/sorties_test.py`), juge (`tests/tools/juge_test.py`).

## Ordre

0.2.1 (correctif) → B (coffre) et D (interface) en parallèle → A (abonnements) → C (juge) → E (mobile) → F (sécurité) → relectures et tests par agents → note de version.
