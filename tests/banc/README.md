# Socle du banc de l'autonomie (#40)

Ce dossier contient les faux et l'horloge, **aucun scénario**. Python 3.12,
bibliothèque standard seulement pour les faux et leurs tests. Pas de clé Google,
GitHub ou de modèle. Les faux n'effectuent aucun appel sortant.

## Vérifier sans Internet ni Docker

Depuis la racine :

```sh
python -m unittest discover -s tests/banc -p '*_test.py' -v
```

Les tests ouvrent seulement des sockets sur `127.0.0.1` et utilisent des dossiers
temporaires. Ils vérifient les effets dans les faux, le manifeste, les erreurs
du vrai `_google_get`, les vraies lectures Gmail/Agenda et leur renouvellement,
ainsi que la logique de session extraite de `_open`, `_request`, `list_tools`.
Pour ces trois fonctions MCP, transport et constantes sont des doublures :
cela ne valide ni les en-têtes httpx réels, ni ses codes HTTP, son résolveur
ou ses délais. Le test échoue explicitement si une fonction extraite manque.

## Faux Google

```sh
python tests/banc/faux_google.py --port 8081
```

Base : `http://127.0.0.1:8081`. Les routes d'API demandent
`Authorization: Bearer noah-banc-google-access`.

- `GET /gmail/v1/users/me/messages` : `q`, `labelIds`, `maxResults`, `pageToken`.
  Recherche couverte : mots, `from:`, `to:`, `subject:`, `in:`, `label:`,
  `is:unread`, `is:read`, `newer_than:`, exclusion par `-` ; les autres
  opérateurs produisent une erreur explicite.
- `GET /gmail/v1/users/me/messages/{id}` : `format` full/metadata/minimal/raw,
  `metadataHeaders` répété.
- `POST /gmail/v1/users/me/messages/{id}/modify` : `addLabelIds`, `removeLabelIds`.
- `GET` et `POST /gmail/v1/users/me/drafts` ; `POST .../drafts/send` ;
  `POST .../messages/send`. Le contenu d'un envoi est le champ `raw` RFC 2822
  encodé en base64url ; un brouillon porte `message.raw`.
- `GET` et `POST /calendar/v3/calendars/{calendarId}/events` ;
  `PATCH .../events/{eventId}`. Fenêtres `timeMin`/`timeMax`, `orderBy=startTime`,
  pagination, calendriers séparés. Pas d'expansion des récurrences dans ce socle.
- `POST /token` : formulaire OAuth2 `grant_type=refresh_token` et
  `refresh_token=noah-banc-google-refresh` ; renvoie un jeton factice préfixé.
- `POST /revoke` : formulaire `token` (jeton d'accès ou de renouvellement),
  réponse 200 vide d'effet ; cet endpoint prouve le routage de la révocation,
  sans simuler la propagation de l'invalidation des jetons chez Google.
  Contrat : [révocation OAuth2 Google](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

Écart documenté : `pageToken` est un décalage entier dans le faux, un jeton
opaque chez Google. Les scénarios devront réutiliser `nextPageToken` tel quel.

Contrôle du banc, sans authentification et uniquement sur ce faux :

```json
{"courriel":{"id":"m1","snippet":"À traiter","payload":{"headers":[{"name":"From","value":"alice@example.test"},{"name":"Subject","value":"Urgent"}]}}}
```

```json
{"evenement":{"id":"e1","summary":"Revue","start":{"dateTime":"2026-11-10T10:00:00+01:00"},"end":{"dateTime":"2026-11-10T11:00:00+01:00"}},"calendrier":"primary"}
```

Envoyer ces objets à `POST /__injecter`. Un courriel peut aussi fournir `raw`.
Un identifiant déjà présent remplace la ressource : utile pour rejouer une arrivée.
Injecter une panne : `{"erreur":{"code":429,"chemin":"/gmail/","fois":1}}`
(codes 401, 403, 429). `GET /__etat` donne `messages`, `brouillons`, `envois`,
`evenements` par calendrier et `journal` (méthode, chemin avec sa requête, statut).
Chaque instance possède son propre état, perdu à son arrêt.

Pour les lectures de Noah, définir **dans le conteneur de l'agent**
`NOAH_BANC=1` et `NOAH_GOOGLE_BASE=http://faux-google:8081`.
Sans `NOAH_BANC=1`, la base est ignorée. Les identifiants de test doivent tous
commencer par `noah-banc-` : cette sentinelle interdit leur envoi hors du faux,
y compris au renouvellement, à la révocation et avant le `--check` Hermes.
En banc, le relevé d'état évite ce `--check` qui ne sait pas rediriger sa base ;
les redirections et proxys HTTP sont désactivés.
Cette redirection porte sur `agent_admin.py` ; le script Google livré dans
l'image Hermes n'est pas modifié par cette partie. Son chemin d'écriture sera à
vérifier au branchement des scénarios.

## Faux GitHub

```sh
python tests/banc/faux_github.py --port 8082
```

Adresse MCP : `http://127.0.0.1:8082/mcp` (depuis la machine hôte).
`initialize` émet `Mcp-Session-Id`, à renvoyer pour `notifications/initialized`,
`tools/list`, `tools/call`, `ping`. Une session perdue donne HTTP 404, ce qui
déclenche la réinitialisation dans le client Noah. Une notification reçoit 202.
Ce sous-ensemble n'accepte que `protocolVersion=2025-06-18` à l'initialisation ;
une version absente ou incompatible donne -32602, sans créer de session.

Outils : `list_pull_requests`, `pull_request_read` (dont `get` et `get_diff`),
`add_issue_comment`, `list_notifications`, `get_notification_details`.
Le résultat est un bloc MCP `content` de type `text`, contenant le JSON de la
ressource, ou directement le diff. Les erreurs d'outil portent `isError:true`.

Injection par `POST /__injecter` :

```json
{"owner":"equipe","repo":"projet","pr":{"number":40,"title":"Correction","body":"Description"},"diff":"diff --git a/x b/x\n+correction"}
```

Champs facultatifs : `files`, `reviews`, `review_comments`, `status`.
`GET /__etat` contient les PR, les commentaires, les notifications et le journal
des appels MCP avec nom d'outil et arguments. Réinjecter une même PR actualise
sa notification. Le manifeste `manifestes/github.json` est figé au 2026-11-09 :
contrat des arguments des cinq outils reconstruit depuis les sources officielles
citées dedans, descriptions abrégées. Ce n'est **pas** une capture authentifiée
du `tools/list` distant. Les tests comparent la réponse HTTP du faux à ce fichier
indépendant ; ils ne régénèrent jamais le manifeste.

## Images locales et temps commun (C5)

Il faut un moteur Docker de test, les images locales serveur/lanceur habituelles,
et l'accès aux paquets Debian lors de la construction. Aucune image n'est poussée.
Le Dockerfile ajoute `libfaketime` au serveur et à l'image Hermes déjà épinglée.
Le paquet est épinglé par base Debian : `0.9.10-2.1` pour bookworm,
`0.9.10+2024-06-05+gba9ed5b2-0.6` pour trixie
([Debian bookworm](https://packages.debian.org/bookworm/libfaketime),
[Debian trixie](https://packages.debian.org/trixie/libfaketime)). Pour une autre
base, la construction refuse de continuer sans `--build-arg LIBFAKETIME_VERSION=…`
explicite. La disponibilité de ces paquets dans les images reste à vérifier.

Sous Linux, définir la commande commune (sous Windows, remplacer `/dev/null` par
`NUL`). Elle évite de charger le fichier `.env` du dépôt :

```sh
export LAUNCHER_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"
export NOAH_SECRET_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"
banc() { docker compose --env-file /dev/null -f docker-compose.yml -f tests/real/compose.essai.yml -f tests/banc/compose.banc.yml "$@"; }
banc --profile images build server hermes-image
banc up -d
```

Le projet, le réseau et les conteneurs serveur/lanceur ont des noms propres au
banc. Les noms dynamiques `noah-agent-*` viennent encore du lanceur existant :
employer un moteur de test sans agents de production. La pile reprend le faux
modèle et la base d'essai de `compose.essai.yml`.

L'agent n'est pas un service Compose fixe : `lanceur_banc.py`, monté seulement
dans cette pile, ajoute le même volume nommé `noah-banc-horloge`, en lecture
seule, aux créations Docker marquées `noah.agent`. Le serveur lit aussi ce volume.
Les images définissent `LD_PRELOAD`, `FAKETIME_TIMESTAMP_FILE`,
`FAKETIME_NO_CACHE=1`, `FAKETIME_DONT_FAKE_MONOTONIC=1` : le temps mural avance,
les délais réseau et le temps monotone restent réels. Aucun changement à
`watch.py`, aucun endpoint `/api/banc/avancer`, aucune horloge dans le serveur.

**Limite à arbitrer avec Franck avant les scénarios :** conserver le monotone réel
préserve aussi tous les `asyncio.sleep`, pas seulement les délais réseau MCP.
Ce réglage ne prouve donc pas encore le critère « les délais suivent le temps
simulé ». Accélérer le monotone toucherait en revanche aux délais réseau MCP.
La séparation de ces deux usages reste à valider dans les conteneurs ; ne pas
annoncer C5 entièrement validé sur la seule base des tests unitaires du fichier.

Le pilote, lui, tourne **sans** libfaketime et écrit atomiquement un décalage
relatif. Ainsi, un agent démarré plus tard rejoint la même heure que le serveur.
`horloge-init` crée le fichier seulement s'il n'existe pas, sans le remettre à zéro
au redémarrage. Une seule commande pilote l'horloge à un instant donné :

```sh
banc run --rm horloge-init python /banc/horloge.py /banc-horloge/temps.rc --avancer 3600
banc run --rm horloge-init python /banc/horloge.py /banc-horloge/temps.rc --fixer 2026-11-09T09:00:00Z
# Ou laisser passer une heure simulée par minute réelle :
banc --profile horloge up -d horloge
```

Un verrou `temps.rc.pid` refuse tout second pilote, y compris une avance manuelle
pendant que `horloge` tourne. Il est retiré à la sortie normale ou à Ctrl+C.
Après un arrêt brutal, vérifier que le pilote est arrêté avant de retirer ce
verrou ; son PID est indicatif et n'est pas comparable entre conteneurs.
Le dossier entier est monté : remplacer le fichier ne laisse pas les conteneurs
sur l'ancien inode. Pour observer C5 une fois les images construites :

```sh
docker exec noah-banc-server python /banc/temps_conteneurs.py
docker cp tests/banc/temps_conteneurs.py noah-agent-ID:/tmp/temps_conteneurs.py
docker exec noah-agent-ID /opt/hermes/.venv/bin/python /tmp/temps_conteneurs.py
```

Comparer les heures avant/après une avance ; `delai_reel` doit rester proche de
0,2 seconde dans les deux conteneurs. Cette sonde n'a pas tourné sous Windows
dans la session d'écriture : accès au moteur Docker refusé.

## Avant les scénarios

Le faux GitHub est servi sur un réseau distinct dans Compose. Le client MCP de
production refuse expressément le réseau interne de Noah (`mcp.resolve`). Son
branchement depuis Noah reste à trancher avec Franck : soit un adaptateur de
test limité à une adresse fixe, soit un serveur sur un réseau privé externe
explicitement accepté. Ce socle ne contourne pas cette protection.

Restent à faire : valider les images et la sonde C5 sur Linux ; brancher les vrais
outils de l'agent aux faux ; confronter le manifeste à une capture officielle ;
écrire le pilote des 18 scénarios (9 obligatoires selon C8), leurs listes d'actions
permises et leurs preuves après coup (fichiers, faux, notifications, messages,
routines) ; plafonner le budget puis lancer trois passages avec un vrai modèle.
La relecture GLM 5.3 Flash a eu lieu ; ses corrections sont consignées ci-dessous.

## Preuves des corrections après relecture

Lectures préalables effectuées : PBI et architecture 0.1.6 (A12, A13, #40,
C4, C5, C8), `agent_admin.py` entier, `watch.py`, `faux_modele.py`,
`parcours_agents.py`, `compose.essai.yml`, client et session MCP demandés,
puis tous les fichiers du socle concernés. Branche : `feat/32-noah-016`.

| Point | Correction et preuve automatisée |
|---|---|
| 1 | Révocation HTTP gardée ; état Hermes gardé avant délégation. `test_toutes_les_fonctions_google_refusent_un_faux_jeton_avant_reseau` calcule les appelants sur le fichier entier, exige une invocation pour chaque voie et espionne HTTP, sockets et sous-processus. Jeton frais/périmé, drapeau absent/inexact et banc sans base. `test_revocation_va_uniquement_au_faux_et_retirer_local_ne_contacte_personne` prouve aussi l'effet local et la trace du faux. |
| 2 | Image explicite pour `faux` ; elle est également présente dans `tests/real/compose.essai.yml`. Fusion Compose à relancer par l'orchestrateur. |
| 3 | Validation du volume avant l'import Docker ; `test_lanceur_refuse_volume_absent_des_le_demarrage` couvre variable absente, vide et blanche. |
| 4 | Verrou atomique de présence ; `test_un_seul_pilote_y_compris_avance_manuelle_et_liberation` refuse un deuxième `--vitesse` et une avance manuelle, puis vérifie la libération. |
| 5 | Réponse 500 et type d'erreur journalisé ; `test_bug_interne_repond_500_journalise_et_serveur_reste_disponible`. |
| 8 | En-tête et nom du test bornés à la logique de session, assertion sur les trois fonctions extraites. Aucun changement à `server/noah/mcp.py`. |
| 9 | `test_vraies_lectures_gmail_agenda_et_renouvellement` relit l'expiration sur disque et la borne entre 58 et 60 minutes après le renouvellement. |
| 10 | Écart de pagination documenté dans l'en-tête du faux et ici. |
| 11 | Versions exactes du paquet dans `Dockerfile.temps`, sources Debian ci-dessus ; construction non exécutée ici. |
| 12 | Version supportée explicite, rejet sans session ; `test_initialize_refuse_versions_absentes_ou_incompatibles_sans_session` et initialisation valide dans les autres tests. |
| 13 | `_google_validate` dédiée, appelée directement pour un jeton frais ; couverte par les tests de garde frais/périmé. |

Points 6 et 7 laissés hors correction à la demande de Franck : manifeste et rendu
déjà présents, sonde conservée avec son invocation manuelle documentée.

Vérification locale sans réseau externe : Python 3.14.2 Windows (interpréteur
installé, l'alias Windows `python` est inaccessible), commande
`python -m unittest discover -s tests/banc -p '*_test.py' -v` : **26 tests, OK**.
Les 20 tests antérieurs sous Docker sont une preuve fournie par l'orchestrateur,
pas une exécution de cette correction. À relancer sous Python 3.12 dans Docker,
avec fusion Compose, construction des images et sondes C5 ; Docker est
inaccessible dans ce bac à sable. Aucun scénario, commit ou envoi d'image.
