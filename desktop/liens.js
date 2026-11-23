// Liens qui ouvrent l'application de bureau depuis le web ou le téléphone : noah-agent://abonnements/claude et …/chatgpt.
// Le lien ne porte qu'un mot : il ouvre l'écran d'un abonnement, jamais une action. Tout le reste est ignoré.
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const SCHEME = "noah-agent";
const PAGES = new Set(["claude", "chatgpt", "grok"]);

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

/** D9 : l'adresse `file:` désigne-t-elle ce fichier ? Chemins comparés après fileURLToPath et path.normalize (espaces encodés, `.asar`,
 *  segments « . » et « .. ») ; sous Windows, sans tenir compte de la casse. Toute autre adresse, ou illisible : non. */
function sameFile(raw, file, platform = process.platform) {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  let got;
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "file:") return false;
    u.search = "";
    u.hash = "";
    got = fileURLToPath(u, { windows });
  } catch {
    return false;
  }
  const [a, b] = [p.normalize(got), p.normalize(String(file))];
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Une requête de la fenêtre doit-elle être coupée ? Oui si elle vise l'hôte du serveur de Noah sur un autre port : le cookie de
 * session ne distingue pas les ports (RFC 6265 §8.5), il ne doit partir que vers l'adresse exacte du serveur. WebSocket compris
 * (sa poignée de main emporte aussi le cookie) ; wss:443 vaut https:443. Tout le reste passe : les images, vidéos et pages
 * de fichiers (/api/agents/…/files/raw/, /api/apercu/, /api/media) sont des adresses du serveur lui-même, donc jamais coupées.
 * `origin` : l'origine du serveur connecté ; vide, rien n'est coupé.
 */
function requestBlocked(rawUrl, origin) {
  try {
    const u = new URL(rawUrl), home = origin ? new URL(origin) : null;
    const scheme = { "ws:": "http:", "wss:": "https:" }[u.protocol] || u.protocol;
    const port = u.port || (scheme === "https:" ? "443" : "80");
    const homePort = home && (home.port || (home.protocol === "https:" ? "443" : "80"));
    return !!home && /^(https?|wss?):$/.test(u.protocol) && u.hostname === home.hostname
      && !(scheme === home.protocol && port === homePort);
  } catch {
    return false;
  }
}

module.exports = { SCHEME, subscriptionOf, fromArgv, sameFile, requestBlocked };
