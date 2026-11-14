// React 19 : les tests pilotent explicitement les effets avec act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Les tests lisent les textes en français, la langue source : le navigateur simulé (jsdom) se dit anglais.
try { localStorage.setItem("noah-langue", "fr"); } catch { /* environnement node */ }
