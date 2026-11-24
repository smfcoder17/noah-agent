// React 19 : les tests pilotent explicitement les effets avec act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Les tests lisent les textes en français, la langue source : le navigateur simulé (jsdom) se dit anglais.
try { localStorage.setItem("noah-langue", "fr"); } catch { /* environnement node */ }
// L'app charge l'anglais à la demande (chargerLangue) ; les tests l'ont d'avance. Après la langue : i18n la lit à son chargement.
const { enregistrerAnglais } = await import("./i18n");
const { en } = await import("./i18n/en");
enregistrerAnglais(en);
