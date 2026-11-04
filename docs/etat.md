# État de Noah Agent (grille version 2)

Fichier généré par `tools/eval/score.mjs`, à ne pas modifier à la main. Un critère ne compte que si sa preuve atteint le niveau exigé. Méthode : [evaluation.md](evaluation.md).

**Promesse : 0 parcours tenus sur 10.**

| Parcours | Exigé | Atteint | Tenu |
|---|---|---|---|
| J1. VPS Hostinger neuf : première réponse de l'agent en 10 min, sans taper une commande | 3 | 0 | non |
| J2. App de bureau installée, reliée au compte du VPS, puis conversation | 3 | 0 | non |
| J3. APK installé, QR scanné en 4G, puis conversation | 3 | 0 | non |
| J4. Version majeure publiée : installée seule à une heure calme, sans perte ; panne provoquée : retour arrière | 3 | 0 | non |
| J5. Appeler un agent depuis le téléphone, lui parler, lui couper la parole, raccrocher | 3 | 0 | non |
| J6. Appeler un agent, créer un deuxième agent, l'appeler à son tour | 3 | 2 | non |
| J7. À la voix : « demande à tel agent de faire telle tâche », et il la fait | 3 | 2 | non |
| J8. Tâche lancée à l'écrit sur l'ordinateur ; à la fin, l'agent fait sonner le téléphone éteint et donne son compte rendu | 3 | 2 | non |
| J9. Deux profils sur le VPS : chacun ses agents, aucune fuite ; un agent partagé avec des droits, puis révoqué | 3 | 2 | non |
| J10. Connecter un outil au choix en moins de 60 s, puis s'en servir à la voix | 3 | 2 | non |

| Objectif | Prouvé | Sans bloquants | Déclaré | Seuil | Bloquants manquants |
|---|---|---|---|---|---|
| G0 Images publiées | 0 | 0 | 0 | 9 | G0.1, G0.5 |
| G1 Installation en un clic | 0 | 0 | 3.3 | 8 | G1.2, G1.3, G1.4, G1.5 |
| G2 Appairage | 0 | 1.7 | 4.2 | 9 | G2.1, G2.2, G2.3, G2.4 |
| G3 App de bureau | 0 | 0 | 1.1 | 8 | G3.1, G3.3 |
| G4 App Android | 0 | 0 | 1.8 | 8 | G4.3, G4.4, G4.5 |
| G5 PWA | 0 | 0 | 2.9 | 8 | G5.1 |
| G6 Mises à jour | 9.1 | 9.1 | 10 | 9 | — |
| G7 Sécurité et vie privée | 0 | 3 | 5 | 9 | G7.1, G7.3 |
| G8 Coûts et 24 h/24 | 0 | 1.7 | 6.7 | 8 | G8.1 |
| G9 Formation | 0 | 0 | 0 | 8 | — |
| G10 Conversation vocale | 0 | 0 | 3.3 | 8 | G10.1, G10.5, G10.6, G10.8 |
| G11 Appels et coordination | 0 | 5.8 | 5.8 | 8 | G11.1, G11.2 |
| G12 Profils et partage | 0 | 5 | 7.5 | 9 | G12.3, G12.5 |
| G13 Outils au choix | 5 | 5 | 10 | 8 | — |
| G14 Rapidité et légèreté | 0 | 0 | 0 | 8 | G14.2 |
| G15 Expérience face aux références | 0 | 0 | 0 | 8 | — |
| G16 Open source | 0 | 0 | 0 | 9 | G16.1, G16.2 |

**Objectifs au seuil : 1 sur 17.**

## Niveaux de preuve

- **0** : déclaré ou écrit, jamais exécuté
- **1** : test automatique avec simulations
- **2** : vrais conteneurs ou vrai navigateur, en local
- **3** : conditions réelles : VPS neuf, téléphone, 4G
- **4** : personne réelle, à l'aveugle

## Critères ajoutés (G10 à G15)

Les critères G0 à G9 sont décrits dans [grille-validation.md](grille-validation.md).

### G10. Conversation vocale (seuil 8)

- G10.1 [B] (exige 3, atteint 0) : Fin de parole → premier son : médiane ≤ 1,2 s, p95 ≤ 2 s, en 4G sur VPS
- G10.2 (exige 2, atteint 1) : Une pause en pleine phrase ne déclenche pas de réponse : moins de 5 coupures pour 100 tours
- G10.3 (exige 2, atteint 1) : Couper la parole : l'agent se tait en 200 ms au plus ; moins de 5 arrêts à tort pour 100 tours, « mm-hm » compris
- G10.4 (exige 2, atteint 0) : Transcription française : moins de 10 % d'erreurs de mots, sur de vraies voix et avec du bruit
- G10.5 [B] (exige 2, atteint 0) : Réussite des tâches vocales avec outils : au moins 71 %, sur 30 scénarios jugés par 3 fournisseurs
- G10.6 [B] (exige 2, atteint 0) : Jamais plus de 3 s de silence pendant que l'agent travaille, et aucun résultat inventé
- G10.7 (exige 2, atteint 0) : Coût : 0,05 $ la minute au plus, compteur par appel visible
- G10.8 [B] (exige 2, atteint 1) : Le fournisseur de voix se change sans toucher au code ; une voie entièrement open source existe

### G11. Appels et coordination (seuil 8)

- G11.1 [B] (exige 3, atteint 0) : Bouton Appeler : en ligne en 2 s au plus, avec l'agent choisi
- G11.2 [B] (exige 3, atteint 0) : Écran d'appel Android natif : écran éteint, sonnerie en 5 s au plus ; refuser laisse un compte rendu écrit
- G11.3 (exige 3, atteint 0) : L'appel survit au passage du Wi-Fi à la 4G et à l'écran verrouillé
- G11.4 [B] (exige 2, atteint 2) : Outil « demander à un autre agent » avec suivi de la tâche, boucles refusées
- G11.5 [B] (exige 2, atteint 2) : Outil « appeler l'utilisateur » : un agent ou la demande d'un autre fait sonner le téléphone
- G11.6 (exige 2, atteint 2) : Chaque appel est écrit dans la conversation de l'agent, avec les actions faites
- G11.7 [B] (exige 2, atteint 2) : Une action irréversible demandée à la voix attend une confirmation explicite

### G12. Profils et partage (seuil 9)

- G12.1 (exige 2, atteint 2) : Le propriétaire crée et supprime des profils ; chacun a ses appareils, ses agents et son budget
- G12.2 [B] (exige 1, atteint 2) : Isolation testée sur toutes les routes : un profil reçoit 403 ou 404 sur les données d'un autre
- G12.3 [B] (exige 2, atteint 1) : Les conteneurs, fichiers, secrets et comptes d'un agent sont invisibles des autres profils
- G12.4 (exige 2, atteint 2) : Partage d'un agent : lecture, usage, admin ; la révocation coupe tout en 5 s
- G12.5 [B] (exige 2, atteint 0) : Sur un agent partagé, la mémoire et les comptes connectés de chacun restent séparés, sauf choix explicite

### G13. Outils au choix (seuil 8)

- G13.1 (exige 2, atteint 1) : Ajouter un serveur MCP par adresse, avec OAuth, depuis l'interface, en 60 s au plus
- G13.2 (exige 2, atteint 2) : Droits par agent et par outil : lire, agir, demander confirmation
- G13.3 (exige 2, atteint 1) : Un outil connecté marche à la voix, à l'écrit et dans une routine
- G13.4 (exige 2, atteint 2) : La panne d'un outil est dite clairement et n'arrête pas l'agent

### G14. Rapidité et légèreté (seuil 8)

- G14.1 (exige 3, atteint 0) : Chat : première réaction à 800 ms au plus en médiane sur VPS ; gain jugé au-delà du bruit mesuré
- G14.2 [B] (exige 3, atteint 0) : Sur KVM 2 à 8 Go, 2 agents actifs : mémoire libre d'au moins 2 Go
- G14.3 (exige 2, atteint 0) : Un navigateur ne tourne que si l'agent s'en sert, et s'éteint au repos
- G14.4 (exige 1, atteint 0) : Chaque dépendance et service est justifié ; un service en plus doit gagner sa place au banc
- G14.5 (exige 3, atteint 0) : Application : ouverture en 1 s, liste de 1 000 messages fluide, sur un Android moyen
- G14.6 (exige 2, atteint 0) : Première installation : 4 Go à télécharger au plus, et le navigateur seulement à son premier usage

### G15. Expérience face aux références (seuil 8)

- G15.1 (exige 1, atteint 0) : Grille de 20 comportements relevés sur Grok Bot, Dots, Duet et Muse, chacun avec sa source
- G15.2 (exige 2, atteint 0) : Comparaisons à l'aveugle de captures : préféré à au moins une référence par 3 juges sur 4 parcours
- G15.3 (exige 4, atteint 0) : Verdict humain à l'aveugle : au moins aussi agréable que la référence choisie pour l'appel

### G16. Open source (seuil 9)

- G16.1 [B] (exige 3, atteint 0) : Sources publiques de tout ce qui est distribué : serveur, lanceur, bureau, Android
- G16.2 [B] (exige 1, atteint 0) : Licence choisie par la personne et compatible avec chaque dépendance, inventaire à l'appui
- G16.3 (exige 2, atteint 0) : Images et APK se reconstruisent depuis les sources sur une machine propre
