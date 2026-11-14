# Réponses prévues : « Contenu de l'appli » (Play Console)

Chaque réponse cite ce qui l'appuie dans le dépôt. **Points rouges** : à régler avant l'envoi pour examen.

## État dans la console (13 novembre 2026)

Appli « Noah Agent » créée, nom de paquet `agent.noah.mobile` (définitif sur Play), français (France), appli, sans frais. Tableau de bord : 5 tâches sur 11.

- Enregistré : fiche Play Store par défaut (textes, icône, image de présentation, 5 captures, « ne pas signaler d'éléments IA »), catégorie Productivité, Annonces (non), Identifiant publicitaire (non), Applis gouvernementales (non), Fonctionnalités financières (aucune), Santé (aucune).
- Non rempli : Règles de confidentialité, Informations de connexion, Classification du contenu, Cible, Sécurité des données, coordonnées (e-mail).

## Points rouges, avant tout envoi

1. **Mise à jour hors Play.** `REQUEST_INSTALL_PACKAGES` et `NoahShellPlugin.installUpdate` téléchargent et installent l'APK des Releases GitHub. Les règles Google interdisent à une appli distribuée par Play de se mettre à jour par un autre canal, et cette permission est restreinte. La version Play doit retirer la permission et ce chemin (le PBI 0.1.6, lot 4, prévoit déjà « les mises à jour arrivent par la boutique »).
2. **Signalement du contenu IA.** Noah est un agent conversationnel : il entre dans la règle « Contenu généré par IA », qui exige un moyen de signaler un contenu offensant **sans quitter l'appli**. Rien de tel dans `frontend/src` aujourd'hui (seul `Proactive.tsx` emploie « signaler », pour autre chose). Un bouton « Signaler cette réponse » sous chaque message est à prévoir. Question ouverte pour Franck : vers qui va le signalement, puisque le modèle et le serveur sont ceux de la personne ?
3. **Accès pour l'examen.** L'appli ne marche qu'avec un serveur Noah, et la liaison passe par un code valable 10 minutes, confirmé sur un autre appareil. Un examinateur ne peut pas faire ça. Il faut un serveur de démonstration et un moyen de liaison réutilisable (voir « Accès à l'appli »).
4. **URL de la politique de confidentialité**, publique et hors PDF.

## Règles de confidentialité

URL : à créer. Texte prêt : `confidentialite.md`. Proposition : une page GitHub Pages du dépôt public `smfcoder17/noah-agent` (par exemple `https://smfcoder17.github.io/noah-agent/confidentialite`), ou au minimum le fichier rendu sur github.com.

## Accès à l'appli

Réponse : « Tout ou partie de la fonctionnalité est restreinte ».
Instructions (en anglais, comme Google le demande), à compléter par Franck :

```
Noah Agent is a companion app for a self-hosted server. It does nothing without a Noah server.
We provide a demo server for review:
1. Open the app and tap "Saisir l'adresse et le code" (Enter address and code).
2. Server address: <URL DU SERVEUR DE DÉMO>
3. Code: <CODE RÉUTILISABLE>
4. You are then signed in to a demo account with sample agents. Tap an agent to chat.
No password, payment or 2-step code is needed.
```

Blocage : le code court actuel expire en 10 minutes et la liaison doit être acceptée depuis un autre appareil (`SECURITY.md`, « Les appareils »). Il faut un mode d'examen côté serveur de démo, ou un compte de démo, avant de remplir ce formulaire. Non rempli dans la console.

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

Choix de fond, **à valider par Franck** : selon Google, « collecter » veut dire envoyer des données hors du téléphone, quel que soit le destinataire ; Google ne traite pas le cas d'un serveur auto-hébergé par l'utilisateur. Réponse prudente proposée : déclarer comme collectées les données que l'appli envoie au serveur de la personne.

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

Si la console pose la question : oui, l'appli permet de discuter avec des modèles d'IA (texte, voix, images). Engagement exigé : signalement dans l'appli (voir point rouge 2).

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
