# Navigateur de l'agent : naviguer sans être pris pour un robot

Demande de Franck (13 novembre) : Chromium s'il est meilleur, avec ce qui fait la force de Camoufox contre la détection, ou une autre solution au même résultat. L'agent tourne surtout sur un VPS. Il veut aussi un agent plus malin sur les sites, avec un navigateur isolé pour lire les profils et faire ses recherches.

## Ce qui fait détecter un agent, du plus lourd au plus léger

1. **L'adresse IP.** Un VPS sort par une adresse de centre de données, connue comme telle. Aucun navigateur ne corrige ça.
2. **Le comportement.** Trente profils lus en rafale puis un post : c'est ce qui a valu le code 226 sur X. Aucun navigateur ne corrige ça non plus.
3. **Les traces du pilotage.** Le protocole qui commande le navigateur laisse des marques dans la page (`navigator.webdriver`, effets de `Runtime.enable` en CDP).
4. **L'empreinte.** Écran, polices, WebGL, fuseau, langue : elle doit ressembler à une vraie machine et rester cohérente.

Camoufox est fort sur 3 et 4 : ses corrections sont dans le code du navigateur et non injectées en JavaScript, son pilotage est isolé de la page, ses empreintes sont tirées de vraies machines. Il ne fait rien pour 1 et 2, et les blocages de Franck venaient de 2.

## Proposition

### A. Deux navigateurs, deux rôles

- **Lecture** : profil jetable, sans aucun compte connecté, pour la recherche et la lecture de pages publiques. Rapide (Chromium). Ce qu'il fait ne touche jamais le compte de la personne.
- **Compte** : profil gardé, avec les sessions de la personne, réservé aux gestes (publier, répondre). Peu de gestes, lents. Le plus discret des moteurs.

L'agent choisit par règle du lanceur, pas par bonne volonté : une page ouverte « pour lire » part dans Lecture.

Limite : X montre peu sans compte. Pour lire X, trois voies à comparer : l'API de lecture (payante), un compte secondaire réservé à la lecture, ou la lecture lente dans le navigateur Compte.

### B. Le moteur : choisir sur mesure, sans fabriquer le nôtre

Tenir nos propres corrections de Chromium demande de les refaire à chaque version de Chrome : hors de portée. On prend un moteur déjà entretenu. Candidats au banc :

- Camoufox (actuel) ;
- Chrome réel, avec écran, piloté sans les traces connues (Patchright ou équivalent) ;
- un Chromium corrigé entretenu par d'autres, s'il en existe un sérieux au moment de l'essai.

Hypothèse de départ : Chromium pour Lecture, Camoufox pour Compte. Le banc tranche.

### C. Le rythme tenu par le lanceur

Un budget par site et par heure (profils vus, recherches, gestes), des délais irréguliers, appliqués dans l'outil du navigateur. Le prompt ne suffit pas : c'est lui qui a laissé passer la rafale.

### D. Des fiches par site

Une fiche courte par site courant (X, LinkedIn, Google, Instagram) : chemin le plus court, ce qui se lit sans compte, ce qui déclenche un refus, quand passer par l'API.

### E. Sortir par la maison (option)

Le plus fort levier sur un VPS : faire sortir le navigateur Compte par l'ordinateur de la personne (l'application de bureau comme relais) ou par un relais résidentiel qu'elle fournit. À rapprocher de l'extension Chrome de `agir-sur-ordinateur.md` : agir dans son vrai navigateur reste le moins détectable.

## Ordre

1. **Banc anti-robot sur un VPS** (1 jour) : pages de test d'empreinte, Cloudflare, recherche Google, X et LinkedIn sans compte, Amazon ; pour chaque moteur : passe ou bloque, et temps. Étend `tools/eval/navigateur.mjs`.
2. **Deux navigateurs et rythme du lanceur** (2 à 3 jours).
3. **Bascule du moteur** selon le banc.
4. **Fiches par site**, puis **sortie par la maison**.

## Ce que ça ne garantit pas

Les conditions de X interdisent l'automatisation hors de son API. Ce plan réduit le risque pour le compte, il ne l'annule pas. La voie sans risque pour publier reste l'API.

## À décider par Franck

- Lire X : API payante, compte secondaire, ou lecture lente ?
- Le banc tourne sur son VPS ou sur un VPS d'essai ?
- La sortie par la maison entre-t-elle dans la 0.3.0 ?
