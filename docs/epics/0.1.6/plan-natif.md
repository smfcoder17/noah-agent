# Rendre les apps plus rapides et plus natives

Question de Franck (9 novembre 2026) : peut-on faire les apps mobile et bureau en Rust, ou plus natives qu'Electron, pour qu'elles soient plus rapides et fluides ? Quel effort ?

## Réponse courte

La lenteur vient surtout de l'app elle-même, pas d'Electron ni de Capacitor. Changer de cadre sans corriger l'app ne la rendrait pas plus fluide : Tauri (Rust) affiche la même vue web que l'app de bureau d'aujourd'hui. Ce qui manque vraiment sur le téléphone (zoom au pincement, lecteur PDF, « Ouvrir avec ») s'ajoute en écrans Android natifs, sans tout réécrire.

## Ce que le code montre

Mesures dans le dépôt le 9 novembre 2026 :

- Le front fait 17 485 lignes et 56 écrans React. Son paquet principal pèse 1,24 Mo, à analyser à chaque démarrage.
- L'app relit la liste des agents et des discussions toutes les 4 s, la conversation toutes les 3 s et l'écran de l'ordinateur toutes les 3 s. On compte 25 minuteries de ce genre, et chaque relève compare des listes entières.
- Aucun écran n'est mémorisé : un changement d'état en haut peut redessiner toute l'app, conversation comprise.
- Changer d'onglet détruit puis recrée tout son contenu (`SidePanel.tsx`, `key={tab}`), d'où l'écran de l'ordinateur qui se reconnecte.
- Le téléphone charge l'app depuis le VPS à chaque ouverture. Les écrans secondaires sont déjà chargés à la demande (`lazy` dans `App.tsx`) et un service worker garde les fichiers en cache (`frontend/public/sw.js`).
- Ce sont des causes probables, pas une preuve : l'absence de mémorisation ne prouve pas que tout se redessine. Seule la mesure de l'étape 1 le dira (revue Codex).

## Les voies comparées

| Voie | Gain de fluidité | Réutilise l'existant | Effort estimé |
|---|---|---|---|
| **Corriger l'app** (flux d'événements, mémorisation, onglets gardés, paquet découpé) | le plus gros, sur toutes les plateformes | tout | 1 à 2 semaines |
| **Écrans Android natifs** (image, PDF, Ouvrir avec, partage) | les gestes natifs demandés | tout | 1 à 2 semaines |
| App dans l'APK au lieu du VPS | démarrage plus rapide | tout | 1 semaine |
| Tauri 2 sur le bureau (Rust) | installateur 12 Mo au lieu de 200, moins de mémoire ; fluidité à mesurer (WebView2 est aussi du Chromium) | interface oui, 1 800 lignes Node à porter en Rust | 3 à 5 semaines |
| Tauri 2 sur le téléphone | aucun (même vue web) | élevée | 4 à 6 semaines |
| React Native (Expo) | vrai natif | logique oui, écrans à refaire | 8 à 12 semaines |
| Kotlin natif, Flutter, ou interface en Rust (Dioxus, Slint) | natif | rien de l'interface | 12 à 16 semaines et plus, iPhone en double |

Les efforts sont des estimations pour un développeur aidé d'agents, pas des mesures. Sources : rapport de recherche du 9 novembre (Tauri, Expo, Flutter, Dioxus, Slint, comparatifs Tauri contre Electron).

## Plan proposé

1. **Mesurer avant de toucher au cadre.** Profiler sur le téléphone de Franck et sur l'ordinateur : démarrage, changement d'onglet, défilement. Ces chiffres sont la base.
2. **Corriger l'app (0.1.6, lot 2).** Un seul flux d'événements du serveur à la place des relèves, onglets gardés montés, mémorisation de la liste des messages et de la barre latérale, paquet découpé par écran. Mesurer à nouveau.
3. **Écrans Android natifs (0.1.6, lot 2).** Visionneuse d'image avec zoom, lecteur PDF (Jetpack PDF), « Ouvrir avec » et partage, appelés depuis l'app.
4. **Décider sur les chiffres.** Si l'app reste lente sur le téléphone après 2 et 3 : passer à React Native écran par écran (en commençant par la discussion), en gardant le code Java des appels et du push. Pas de Rust sur le téléphone : aucune bibliothèque mûre n'y donne des écrans Android natifs.
5. **Bureau.** Garder Electron, qui reçoit les mêmes corrections. Tauri seulement si la taille de l'installateur ou la mémoire deviennent une priorité ; il ne règle pas la lenteur.

## À trancher par Franck

- Mettre l'app dans l'APK pour un démarrage plus rapide, ou la garder servie par le VPS pour des mises à jour immédiates.
- Accepter de décider React Native ou non après la mesure de l'étape 2, plutôt qu'avant.
