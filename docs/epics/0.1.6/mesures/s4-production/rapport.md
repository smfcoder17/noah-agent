# S4 — défaut du build de production, 2026-11-10

## 1. Dossier et reproduction

Travail effectué dans `D:\Data\Multimedia\SmfCoder\YouTube\apollo`, branche
`feat/32-noah-016` (vérifiés par `Get-Location` et `git branch --show-current`).
Aucun worktree utilisé et aucun commit créé. Les modifications déjà présentes
dans `desktop.css` et `lot2-regressions.test.tsx` ont été conservées et corrigées.

`npx.cmd vite build`, depuis `frontend`, réussit avec Vite 6.4.5.
`npx.cmd vite preview --host 127.0.0.1 --port 4173 --strictPort` sert `dist`.
La vraie App s'ouvre, y compris Réglages, avec les réponses d'API simulées.
Ce n'est pas la page de banc `/tests/lot2.html`.
Sans API ni simulation, l'authentification de l'App ne permet pas ce parcours.
Docker est inaccessible à cette session : `docker ps` répond
`permission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine`.
L'image Docker de Franck n'a donc pas été reconstruite ni modifiée.

Preuves avant correction :

- [Capture du défaut reproduit](avant/ordinateur.png).
- [Styles calculés et règles CSS chargées depuis dist](avant/diagnostic.json) :
  `index-CtgP1mN4.css`, cadre `x=-292, y=-400, width=1048, height=800`,
  donc partie visible jusqu'à `right=756, bottom=400`.
- [Mesures du test de mise en page en échec](avant-test/mesures.json).
  `vue-reglages.mjs` termine avec le code 1 : `AssertionError: -292 !== 232`.

## 2. Cause exacte

Tailwind 4 centre le dialogue commun avec les propriétés CSS individuelles
`translate: var(--tw-translate-x) var(--tw-translate-y)` et des valeurs `-50%`.
S4 réinitialisait `translate:none` **et** `transform:none` dans la même règle.
L'optimiseur CSS de `@tailwindcss/vite` utilise Lightning CSS et fusionne ces
réinitialisations en ne conservant que `transform:none`.
La réinitialisation de `translate` disparaît du CSS livré ; les utilitaires
Tailwind continuent donc d'appliquer `translate: -50% -50%`.
Le placement avant translation reste correct : `inset: 0px 0px 0px 232px`.
Ce sont ensuite `1048 / 2 = 524px` et `800 / 2 = 400px` qui sont soustraits,
d'où `232 - 524 = -292` et `0 - 400 = -400`.

Preuve : `avant/diagnostic.json` contient à la fois le style calculé
`translate: -50% -50%` et la règle `.desktop-settings[role="dialog"]`
livrée sans `translate:none`. La règle n'est pas purgée et les dimensions
initiales sont correctes : la disparition de cette déclaration explique le défaut.

Reproduction minimale avec le même optimiseur, exécutée depuis `frontend` :

```js
import { optimize } from '@tailwindcss/node';
for (const css of ['.dialog{translate:none;transform:none}', '.dialog{translate:none}']) {
  console.log(css + ' => ' + optimize(css, { minify: true }).code);
}
```

Sortie exacte :

```text
.dialog{translate:none;transform:none} => .dialog{transform:none}
.dialog{translate:none} => .dialog{translate:none}
```

`npm.cmd ls @tailwindcss/vite @tailwindcss/node lightningcss vite --depth=3`
confirme `@tailwindcss/vite@4.3.3`, `@tailwindcss/node@4.3.3`,
`lightningcss@1.32.0` et `vite@6.4.5`.

## 3. Correction et vérification en production

Retrait du seul `transform:none` de la règle S4. `translate:none` reste la
réinitialisation nécessaire et survit maintenant à l'optimisation.
Le test JSDOM précise sa portée (règles sources, pas rectangles calculés).
`vue-reglages.mjs` peut désormais utiliser `NOAH_FIXTURES=1` sans Docker :
il charge la vraie App, bloque le service worker pour mesurer les fichiers
servis, conserve les styles calculés et l'adresse de la feuille CSS dans les mesures.
Les réponses simulées nécessaires à l'App et au modèle de décision sont fournies.

Reconstruction : `npx.cmd vite build`, code 0, 3225 modules, 16,16 s.
Nouveau CSS : `index-CKAZ1CGc.css`.

Commande PowerShell du test, depuis la racine, avec preview encore actif :

```powershell
$env:NOAH_PLAYWRIGHT='D:/Data/Projects/Programming/Tools/brolls-web/node_modules/playwright-core'
$env:NOAH_FIXTURES='1'
$env:BASE='http://127.0.0.1:4173'
node tools/eval/vue-reglages.mjs docs/epics/0.1.6/mesures/s4-production/apres-test
```

Résultat : code 0. Le parcours Réglages → Modèles et budget → Cerveau →
Fournisseurs passe dans les deux tailles.

| Mesure | Ordinateur 1280 × 800 | Téléphone 390 × 844 |
|---|---|---|
| Cadre (x, y, largeur, hauteur) | (232, 0, 1048, 800) | (0, 0, 390, 844) |
| Translation calculée | none | 0px |
| Défilement du cadre à l'ouverture | 0 | 0 |
| Défilement de la liste | 0 | 0 |
| Liste des rubriques | largeur 280, première à y=70 | masquée |
| Dialogue modal / focus dedans | true / true | true / true |

Preuves : [mesures complètes](apres-test/mesures.json),
[règles CSS compilées et styles calculés](apres/diagnostic.json),
[capture ordinateur](apres-test/ordinateur-1-reglages.png),
[capture téléphone](apres-test/telephone-1-reglages.png).
Les captures 2, 3 et 4 dans `apres-test` montrent également le parcours complet.
Les captures finales ont été examinées visuellement.

## 4. TypeScript et Vitest

Depuis `frontend` :

- `npx.cmd tsc -b` : code 0, aucune erreur, aucune sortie.
- `npx.cmd vitest run` : code 0 ; **15 fichiers, 33 tests réussis**,
  dont les 13 tests de `lot2-regressions.test.tsx` ; durée 12,18 s.

Portée : le CSS de production et le parcours de la vraie App sont vérifiés dans
Chrome sur ordinateur et téléphone émulé. L'API est simulée ; aucune validation
d'une nouvelle image Docker ni du serveur Python n'est revendiquée ici.
