# Epic 0.1.6 : une app qui ne fait plus attendre ni demander pour rien

Issue parente : [#32](https://github.com/smfcoder17/noah-agent/issues/32). PBI : [pbi.md](pbi.md), validé par Franck le 2026-11-09. Maquettes : [mobile](maquette-mobile.html), [ordinateur et web](maquette-ordinateur.html). Fluidité : [plan-natif.md](plan-natif.md).

## Promesse

Je confie une tâche à Noah depuis mon téléphone ou mon ordinateur ; il la fait seul dans la limite que je lui ai donnée, me montre son travail sous une forme que je comprends d'un coup d'œil, et ne me dérange que pour ce qui le mérite.

## Histoires (sous-tickets)

| Lot | Ticket | Histoire |
|---|---|---|
| 1 | #33 | Écran de l'ordinateur fiable, onglets gardés |
| 1 | #34 | Juge : un seul tableau d'autonomie |
| 1 | #35 | Bureau : plus aucune fenêtre Windows |
| 1 | #36 | Accords synchronisés sur tous les appareils |
| 1 | #37 | Notifications et appels sans rien héberger |
| 1 | #38 | Version de l'app et version du serveur |
| 1 | #39 | Sans VPS : l'ordinateur comme cerveau |
| 1 bis | #40 | Banc de l'autonomie |
| 1 bis | #41 | Compétences apprises visibles |
| 2 | #42 | Navigation mobile façon Muse et clavier |
| 2 | #43 | Design ordinateur et web |
| 2 | #44 | Éléments ouvrables dans la discussion |
| 2 | #45 | Cerveau et fournisseurs avec logos |
| 2 | #46 | Fluidité mesurée |
| 3 | #47 | Navigateur de l'agent : mesure et choix |
| 4 | #48 | Paquets Play Store et Microsoft Store |

## Invariants (chacun a son test nommé, ajouté au fil des tickets)

1. Le juge ne demande que dans les cases « demande » du tableau d'autonomie. Test : `tests/tools/juge_test.py`, section tableau.
2. Un tour qui a lu des consignes ne peut pas envoyer ou publier sans accord. Test : `tests/tools/juge_test.py`, section durci.
3. Un accord de bureau ne peut être affiché ni donné par la page du serveur ; il vaut une fois, pour l'action exacte. Test : `tests/desktop/accord_test.mjs` (à écrire).
4. Une demande d'accord répondue, expirée ou annulée n'est plus affichée sur aucun appareil. Test : `tests/exposition/accords_sync_test.py` (#36 ; exécution Docker à confirmer).
5. Rien n'est hébergé pour les notifications ; le contenu ne passe jamais par un tiers. Test : à écrire (#37).
6. Une compétence apprise par l'agent est visible dans l'app. Test : à écrire (#41).
7. Le banc de l'autonomie passe ses 8 scénarios obligatoires à chaque passage. Test : à écrire (#40).

## Décisions

- 2026-11-09 : une seule version 0.1.6 livrée par lots ; ordre : lot 1 et banc, interface, navigateur, boutiques.
- 2026-11-09 : notifications sans rien héberger (ni relais ni Firebase) : UnifiedPush, sinon veille discrète de l'app.
- 2026-11-09 : Microsoft Store avec un compte individuel gratuit ; Play Store préparé, compte et 25 $ par Franck.
- 2026-11-09 : navigateur choisi par la mesure du lot 3 ; à égalité, Camoufox reste.
- 2026-11-09 : pas de changement de cadre (Rust, Tauri, React Native) avant la mesure de la fluidité.

## Journal

- 2026-11-09 : PBI, maquettes et plan de fluidité écrits, revus par Codex (10 points corrigés ; avis Ollama impossible, clé vide), validés par Franck. Issue #32 et 16 sous-tickets créés.
