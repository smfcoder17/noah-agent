# Politique de confidentialité de l'application Noah Agent (Android)

Dernière mise à jour : à dater le jour de la mise en ligne.

Éditeur : SmfCoder, développeur de Noah Agent. Contact : **adresse e-mail à compléter**.

## En bref

L'application Noah Agent n'envoie rien à son développeur. Elle ne parle qu'au serveur Noah que **tu** as installé et que tu administres (ton VPS, par exemple). Elle ne contient ni publicité, ni outil de mesure d'audience, ni télémétrie.

## Ce que fait l'application

L'application relie ton téléphone à ton propre serveur Noah, puis affiche son interface : tes agents IA, leurs conversations, leurs fichiers et leurs notifications. Sans serveur Noah, elle ne sert à rien.

## Les données qui passent par l'application

Toutes ces données vont **de ton téléphone vers ton serveur**, en HTTPS. Le développeur de Noah n'y a aucun accès.

| Donnée | Quand | Où elle va |
|---|---|---|
| Adresse de ton serveur et jeton de l'appareil | À la liaison (QR code ou code court), puis à chaque connexion | Gardés sur le téléphone ; le jeton est présenté à ton serveur |
| Tes messages, fichiers et photos joints | Quand tu les envoies | Ton serveur |
| Ta voix (micro) | Seulement quand tu dictes, utilises le mode vocal, la bulle flottante ou un appel d'agent | Ton serveur |
| Ta position | Seulement quand tu touches « Joindre ma position » ; jamais en arrière-plan | Ton serveur, dans le message |
| Notifications | Quand ton serveur en envoie | Reçues de ton serveur, directement ou par le service de notification que tu as choisi (UnifiedPush) ; leur contenu est chiffré |

Le mot de passe de ton compte Noah n'est jamais saisi dans l'application : tu autorises le téléphone depuis un appareil déjà connecté, avec un nombre à 3 chiffres.

## Ce que fait ton serveur de ces données

Ton serveur, et non l'application, décide de ce qui en sort. Il envoie tes messages au fournisseur de modèle d'IA que tu as choisi (par exemple OpenAI, Anthropic, Mistral, OpenRouter, Ollama), avec ta propre clé, et les sites que visitent tes agents voient l'adresse de ton serveur. La liste de ces flux est affichée dans Réglages > Serveur > Confidentialité, et décrite dans le fichier SECURITY.md du dépôt public github.com/smfcoder17/noah-agent. Ces fournisseurs appliquent leurs propres règles de confidentialité.

## Permissions demandées

- **Internet** : joindre ton serveur.
- **Appareil photo** : scanner le QR code de liaison, seulement à ta demande.
- **Notifications** : t'avertir (tâche finie, accord à donner, appel d'un agent).
- **Micro** : dictée, mode vocal, appel d'un agent, bulle flottante, seulement quand tu les utilises.
- **Position** : seulement au toucher de « Joindre ma position ».
- **Affichage par-dessus les autres applis** : la bulle flottante, seulement si tu l'actives.
- **Service au premier plan, démarrage du téléphone, écran d'appel en plein écran** : pour qu'un agent puisse t'appeler sans service tiers, si tu l'actives dans Réglages > Téléphone.

## Conservation et suppression

L'application garde sur le téléphone l'adresse de ton serveur, le jeton de l'appareil et tes réglages d'affichage. Désinstaller l'application les efface. Pour couper l'accès d'un téléphone, retire-le dans Réglages > Appareils de ton serveur. Tes conversations et ton compte sont sur ton serveur : tu les supprimes toi-même (Réglages > Personnes, ou en supprimant le serveur). Le développeur ne détient aucune donnée à supprimer.

## Sécurité

Les échanges avec ton serveur passent en HTTPS. Les limites de sécurité de Noah sont décrites honnêtement dans SECURITY.md : par exemple, les conversations ne sont pas chiffrées sur le disque du serveur.

## Enfants

L'application s'adresse aux adultes (18 ans et plus) et ne vise pas les enfants.

## Changements

Toute modification de cette politique sera publiée à la même adresse, avec sa date.
