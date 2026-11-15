// Liens qui ouvrent l'application de bureau depuis le web ou le téléphone : noah-agent://abonnements/claude et …/chatgpt.
// Le lien ne porte qu'un mot : il ouvre l'écran d'un abonnement, jamais une action. Tout le reste est ignoré.
const SCHEME = "noah-agent";
const PAGES = new Set(["claude", "chatgpt"]);

/** L'abonnement visé par un lien, ou null. Accepte aussi la forme sans « // » que certains systèmes rendent. */
function subscriptionOf(raw) {
  const m = /^noah-agent:\/{0,2}abonnements\/([a-z]+)\/?(?:[?#].*)?$/i.exec(String(raw || "").trim());
  const page = m?.[1].toLowerCase();
  return page && PAGES.has(page) ? page : null;
}

/** Sous Windows et Linux, le lien arrive dans la ligne de commande de la seconde instance (ou de la première). */
function fromArgv(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const page = subscriptionOf(arg);
    if (page) return page;
  }
  return null;
}

module.exports = { SCHEME, subscriptionOf, fromArgv };
