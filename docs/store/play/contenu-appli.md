# Réponses prévues : « Contenu de l'appli » (Play Console)

Chaque réponse cite ce qui l'appuie dans le dépôt. **Points rouges** : à régler avant l'envoi pour examen.

## État dans la console (14 novembre 2026)

Appli « Noah Agent » créée, nom de paquet `agent.noah.mobile` (définitif sur Play), français (France), appli, sans frais. Tableau de bord : 6 tâches sur 11.

- Enregistré : fiche Play Store par défaut (textes, icône, image de présentation, 5 captures, « ne pas signaler d'éléments IA »), catégorie Productivité, Annonces (non), Identifiant publicitaire (non), Applis gouvernementales (non), Fonctionnalités financières (aucune), Santé (aucune), **Règles de confidentialité** (`https://noah-agent.smfcoder.com/confidentialite/`, console : « Modification enregistrée »).
- Brouillon : **Sécurité des données**, « Non » à la collecte ou au partage (console : « Modification enregistrée »). Aperçu : « Aucune collecte de données déclarée », « Aucune donnée partagée avec des tiers ». Le bouton final « Enregistrer » reste grisé tant que « Cible et contenu » n'est pas rempli. Avec « Non », la console ne pose pas les questions chiffrement et suppression.
- Bloqué :
  - **Informations de connexion** : la console n'enregistre pas sans cocher « Les informations de connexion fournies dans cette déclaration donnent un accès complet à toutes les fonctionnalités… ». Avec des identifiants à compléter, cette attestation serait fausse : rien d'enregistré. Texte prêt plus bas.
  - **Cible et contenu** : la console exige d'abord « Informations de connexion ».
  - **Classification du contenu** : la page indique « En remplissant ce questionnaire, vous acceptez les Conditions d'utilisation de l'IARC ». Laissé à Franck.
  - **Coordonnées** (Paramètres de la fiche) : l'e-mail est obligatoire, « Enregistrer » reste grisé sans lui ; le site `https://noah-agent.smfcoder.com/` n'a donc pas été enregistré.
- Pas de déclaration « Applis d'IA générative » dans Contenu de l'application. L'IA n'apparaît que dans les outils de la fiche (traductions, images) et, sans doute, dans le questionnaire IARC.

Ordre pour Franck : e-mail de contact et site → serveur de démo → Informations de connexion → Cible (18 ans et plus) → Sécurité des données (« Enregistrer ») → Classification du contenu.

## Points rouges, avant tout envoi

1. **Mise à jour hors Play.** `REQUEST_INSTALL_PACKAGES` et `NoahShellPlugin.installUpdate` téléchargent et installent l'APK des Releases GitHub. Les règles Google interdisent à une appli distribuée par Play de se mettre à jour par un autre canal, et cette permission est restreinte. La version Play doit retirer la permission et ce chemin (le PBI 0.1.6, lot 4, prévoit déjà « les mises à jour arrivent par la boutique »).
2. **Signalement du contenu IA.** Noah est un agent conversationnel : il entre dans la règle « Contenu généré par IA », qui exige un moyen de signaler un contenu offensant **sans quitter l'appli**. Rien de tel dans `frontend/src` aujourd'hui (seul `Proactive.tsx` emploie « signaler », pour autre chose). Un bouton « Signaler cette réponse » sous chaque message est à prévoir. Question ouverte pour Franck : vers qui va le signalement, puisque le modèle et le serveur sont ceux de la personne ?
3. **Accès pour l'examen.** L'appli ne marche qu'avec un serveur Noah, et la liaison passe par un code valable 10 minutes, confirmé sur un autre appareil. Un examinateur ne peut pas faire ça. Il faut un serveur de démonstration et un moyen de liaison réutilisable (voir « Accès à l'appli »).
4. **URL de la politique de confidentialité**, publique et hors PDF.

## Règles de confidentialité

URL enregistrée : `https://noah-agent.smfcoder.com/confidentialite/` (en ligne, fait foi ; `confidentialite.md` est l'ancien brouillon). La page en ligne donne le contact `contact@smfcoder.com`, alors que l'e-mail de la fiche n'est pas confirmé : à aligner.

## Accès à l'appli

Console (page « Informations de connexion ») : « Une partie de votre appli est-elle limitée ? » → Oui, puis « Ajouter des détails ». Champs : Nom (60 car.), identifiant et mot de passe (facultatifs), « Toute autre information requise » (500 car.), et une case d'attestation obligatoire pour enregistrer.
Texte prêt (385/500), essayé puis abandonné sans enregistrer, faute de pouvoir cocher l'attestation honnêtement :

- Nom : `Demo server (self-hosted Noah)`
- Toute autre information :

```
Companion app for a self-hosted Noah server: it does nothing until it is linked to one. Demo server for review:
1. Open the app and tap "Saisir l'adresse et le code" (Enter address and code).
2. Server address and link code: [Franck : URL du serveur de démo et code]
3. You land in a demo account with sample agents. Tap an agent to chat.
No password, payment or 2-step code is needed.
```

Blocage : le code court actuel expire en 10 minutes et la liaison doit être acceptée depuis un autre appareil (`SECURITY.md`, « Les appareils »). Google demande « des identifiants de connexion réutilisables qui n'expirent pas ». Il faut un mode d'examen côté serveur de démo avant d'enregistrer ; la phrase 3 et la dernière ligne ne sont vraies qu'avec ce mode.

## Annonces

Non, l'appli ne contient pas d'annonces. Appui : `mobile/package.json` n'a aucun SDK publicitaire ; `SECURITY.md` : « Noah n'envoie rien à ses développeurs ».

## Classification du contenu (questionnaire IARC)

- Catégorie : « Toutes les autres applis » (ni jeu, ni réseau social).
- Violence, sexe, langage grossier, drogues, jeux d'argent : non (l'appli n'en propose pas elle-même).
- Contenu généré par les utilisateurs ou interactions entre utilisateurs : les utilisateurs d'un même serveur peuvent partager un agent (`docs/installation.md`, « Partager un agent »), mais uniquement entre personnes ajoutées par le propriétaire du serveur : pas d'échange avec des inconnus. Réponse proposée : non pour le partage public ; à confirmer par Franck.
- Contenu généré par IA : oui, si la question est posée.
- Partage de la position : l'appli peut joindre la position à un message, seulement à la demande. Si la question « partage la position avec d'autres utilisateurs » apparaît : non.
- Achats numériques : non.

Le questionnaire se termine par un envoi qui produit la classification : laissé à Franck si l'envoi est définitif.

## Public cible

18 ans et plus. Raison : agent IA généraliste qui agit en ligne (navigation, publications, achats avec accord), contenu produit par des modèles choisis par l'utilisateur. Pas d'attrait pour les enfants dans la fiche.

## Appli d'actualités

Non.

## Applis de santé, finances, gouvernement

Non (le modèle d'agent « Finances du foyer » est un usage, pas une appli financière agréée). À confirmer si la console le demande.

## Sécurité des données

**Décision de Franck (13-14 novembre) : aucune donnée collectée ni partagée par l'éditeur.** Brouillon enregistré ainsi (« Non »).

Risque, sources à l'appui :
- Aide Google (answer/10787469, « Collecte des données ») : « Le terme "Collecte" désigne la transmission des données de l'application depuis l'appareil d'un utilisateur ». La console le répète : données « transmises depuis l'appareil de l'utilisateur, soit à vous ou à un tiers ».
- Exceptions listées : traitement sur l'appareil, chiffrement de bout en bout. Le HTTPS vers le serveur ne compte pas comme bout en bout au sens de Google, puisque le serveur lit les données.
- Le cas le plus proche, la FAQ Google Drive ou Dropbox : pas de collecte si l'utilisateur envoie lui-même ses données vers son propre stockage, sous les règles de ce stockage, et si l'appli n'y accède jamais. Noah, lui, affiche ce qui revient du serveur ; l'analogie tient en partie seulement.
- Google peut prendre « des mesures » en cas d'incohérence entre l'appli et la déclaration (même page). L'appli déclare micro, position et caméra : un examinateur peut voir ces envois.

Si Franck change d'avis, l'ancienne proposition prudente reste ci-dessous.

Ancienne proposition : déclarer comme collectées les données que l'appli envoie au serveur de la personne.

- Collecte ou partage de données : oui (vers le serveur de l'utilisateur).
- Chiffrement en transit : oui. Appui : `mobile/www/app.js` refuse toute adresse non HTTPS sauf adresses privées de développement ; `capacitor.config.json` : `allowMixedContent: false`.
- Moyen de demander la suppression : oui. L'utilisateur supprime lui-même ses données sur son serveur (Réglages > Personnes) ; le développeur ne détient rien. URL de suppression : la page de confidentialité, section « Conservation et suppression ».
- Comptes : l'appli ne crée pas de compte chez le développeur ; le compte est sur le serveur de l'utilisateur.

Types de données déclarés (tous : collectés, non partagés, pour le fonctionnement de l'appli, traitement non éphémère, fournis par l'utilisateur) :

| Type Google | Pourquoi | Facultatif ? | Appui |
|---|---|---|---|
| Messages > Autres messages intégrés à l'appli | La conversation avec les agents | Non | README |
| Photos et vidéos ; Fichiers et documents | Pièces jointes | Oui | `frontend/src/lib/api.ts` (`uploadFile`) |
| Audio > Enregistrements vocaux | Dictée, mode vocal, appel | Oui | `RECORD_AUDIO`, `CallSession`, `NoahBubble` |
| Position > Position exacte et approximative | « Joindre ma position » | Oui | `ACCESS_FINE_LOCATION`, `SECURITY.md` |
| Identifiants de l'appareil ou autres | Jeton de l'appareil relié | Non | `Pairing.java` |

Non collectés : nom, e-mail, contacts, données financières, santé, historique de navigation du téléphone, diagnostics, identifiant publicitaire.

Doute : le lecteur de QR code (`@capacitor/barcode-scanner`) s'appuie sans doute sur ML Kit ; vérifier dans le manifeste fusionné et la doc de la bibliothèque s'il envoie des diagnostics à Google.

## Applis d'IA générative

Pas de déclaration dédiée dans Contenu de l'application (vérifié le 14 novembre). Si le questionnaire IARC pose la question : oui, l'appli affiche des réponses d'IA générées par le modèle que la personne a choisi sur son serveur. Signalement : bouton « Signaler » en cours d'ajout, envoi à l'éditeur par e-mail seulement si la personne le choisit (politique en ligne, « Signaler une réponse d'IA »).

## Autorisations et API sensibles (déclarations)

Ces déclarations apparaissent après le téléversement d'un AAB. Rien n'est téléversé : elles ne sont pas visibles maintenant.

| Élément | Déclaration à préparer |
|---|---|
| Service au premier plan `specialUse` (`CallWatch`, `NoahBubble`) | Description : garder l'attente des appels d'un agent depuis le serveur de la personne, sans service de notification tiers ; bulle de dictée. Vidéo à tourner : activer l'appel dans Réglages > Téléphone, puis recevoir un appel. |
| Service au premier plan `microphone` (`CallSession`, `NoahBubble`) | Appel en cours avec un agent, dictée par la bulle. Vidéo : lancer un appel ou la bulle. |
| `USE_FULL_SCREEN_INTENT` | Écran d'appel d'un agent (`CallActivity`). Google n'accorde cette permission d'office qu'aux applis d'appel ou d'alarme ; sinon, demande à l'utilisateur et repli propre. À déclarer « appel ». |
| `REQUEST_INSTALL_PACKAGES` | À retirer de la version Play (point rouge 1). |
| `SYSTEM_ALERT_WINDOW` | Bulle flottante, activée par la personne. Pas de déclaration Play dédiée connue ; à justifier si l'examen le demande. |
| `ACCESS_FINE_LOCATION` | Premier plan seulement : pas de déclaration de position en arrière-plan. |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Usage restreint par Google ; justification : sonner un appel écran éteint. À vérifier, peut être refusé. |
