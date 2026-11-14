// Écran de connexion de l'app : obtenir une session du serveur Noah (QR code ou code court), la confier à l'app,
// qui rouvre alors sa fenêtre sur l'interface du serveur.
const { Capacitor } = window;
// Pas de bundler ici : le pont natif expose les plugins dans Capacitor.Plugins.
const shell = Capacitor.Plugins.NoahShell;
const scanner = Capacitor.Plugins.CapacitorBarcodeScanner;
const $ = (id) => document.getElementById(id);

// Textes de l'écran, en français et en anglais. Le français reste celui d'origine.
const TEXTES = {
  fr: {
    titre: "Relier Noah",
    consigne: "Sur ton ordinateur, ouvre Noah puis Réglages → Appareils → « Relier un appareil ». Un QR code s'affiche.",
    scanner: "Scanner le QR code",
    saisir: "Saisir l'adresse et le code",
    adresse: "Adresse de ton serveur",
    exempleAdresse: "https://noah.exemple.com",
    code: "Code",
    exempleCode: "BCDF-GHJK",
    relier: "Relier",
    vieprivee: "Noah fonctionne sur ton propre serveur : tes conversations ne passent par aucun service de Noah.",
    politique: "Politique de confidentialité",
    attente: "Sur l'appareil où le code est affiché, accepte ce téléphone et saisis :",
    injoignable: "Impossible de joindre {server}. Vérifie ta connexion et l'adresse.",
    refus: "Le serveur a refusé ({status}).",
    refuseeOuExpiree: "Demande refusée ou expirée. Affiche un nouveau code et recommence.",
    expiree: "Demande expirée. Affiche un nouveau code et recommence.",
    viser: "Vise le QR code de Réglages → Appareils",
    pasNoah: "Ce QR code ne vient pas de Noah (Réglages → Appareils → « Relier un appareil »).",
    confirmer: "Relier ce téléphone au serveur {host} ?\n\nContinue seulement si c'est bien ton Noah.",
    scannerFerme: "Le scanner n'a pas pu s'ouvrir. Saisis l'adresse et le code à la place.",
    adresseHttps: "Indique une adresse en https:// (exemple : https://noah.exemple.com).",
    longueurCode: "Le code fait 8 caractères (exemple : BCDF-GHJK).",
  },
  en: {
    titre: "Link Noah",
    consigne: "On your computer, open Noah, then Settings → Devices → “Link a device.” A QR code appears.",
    scanner: "Scan the QR code",
    saisir: "Enter the address and code",
    adresse: "Your server address",
    exempleAdresse: "https://noah.exemple.com",
    code: "Code",
    exempleCode: "BCDF-GHJK",
    relier: "Link",
    vieprivee: "Noah runs on your own server: your conversations never go through any Noah service.",
    politique: "Privacy policy",
    attente: "On the device showing the code, approve this phone and enter:",
    injoignable: "Can't reach {server}. Check your connection and the address.",
    refus: "The server refused ({status}).",
    refuseeOuExpiree: "Request declined or expired. Show a new code and try again.",
    expiree: "Request expired. Show a new code and try again.",
    viser: "Point at the QR code in Settings → Devices",
    pasNoah: "This QR code isn't from Noah (Settings → Devices → “Link a device”).",
    confirmer: "Link this phone to the server {host}?\n\nOnly continue if this is really your Noah.",
    scannerFerme: "The scanner couldn't open. Enter the address and code instead.",
    adresseHttps: "Enter an https:// address (for example: https://noah.exemple.com).",
    longueurCode: "The code is 8 characters long (for example: BCDF-GHJK).",
  },
};

/** Langue du téléphone : le premier code fr ou en de navigator.languages ; anglais si aucun des deux. */
const LANGUE = (() => {
  for (const tag of navigator.languages || [navigator.language || ""]) {
    const code = String(tag).toLowerCase().split("-")[0];
    if (code === "fr" || code === "en") return code;
  }
  return "en";
})();

/** Texte de l'écran dans la langue choisie, {variables} remplacées. */
const t = (key, vars = {}) => TEXTES[LANGUE][key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));

document.documentElement.lang = LANGUE;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);

/** Ferme le clavier, qui cacherait la suite, et amène ce qu'il faut lire à l'écran une fois la page redimensionnée. */
function reveal(el) {
  document.activeElement?.blur?.();
  setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 350);
}

const say = (text) => {
  $("wait").style.display = "none";
  $("error").textContent = text || "";
  if (text) reveal($("error"));
};
/** Attente de l'accord : consigne calme et nombre bien lisible, pas une erreur. */
function showWaiting(verification) {
  $("error").textContent = "";
  $("wait").replaceChildren(t("attente"), Object.assign(document.createElement("b"), { textContent: verification }));
  $("wait").style.display = "block";
  reveal($("wait"));
}

function origin(raw) {
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    // http seulement pour une instance de développement (adresse privée) ; l'app publiée exige le HTTPS.
    const dev = u.protocol === "http:" && /^(10\.|192\.168\.|localhost$)/.test(u.hostname);
    return u.protocol === "https:" || dev ? u.origin : null;
  } catch {
    return null;
  }
}

/** Le lien du QR code : https://serveur/#appairage=<jeton> (jamais dans l'adresse elle-même : elle finirait dans les journaux). */
function parseLink(text) {
  try {
    const u = new URL(text.trim());
    const code = (u.hash.match(/appairage=([\w-]+)/) || [])[1];
    return code ? { server: u.origin, code } : null;
  } catch {
    return null;
  }
}

/**
 * POST JSON par le client HTTP natif, borné à 15 s par le transport lui-même (connexion et lecture) : un serveur qui
 * accepte la connexion sans répondre ne laisse pas de requête pendante. Rend { ok, status, json() } comme fetch.
 */
async function post(url, body, headers = {}) {
  const r = await Capacitor.Plugins.CapacitorHttp.request({
    url, method: "POST", headers: { "Content-Type": "application/json", ...headers }, data: body,
    connectTimeout: 15000, readTimeout: 15000, responseType: "json",
  });
  const data = typeof r.data === "string" ? JSON.parse(r.data || "{}") : r.data || {};
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => data };
}

// Change à chaque nouvelle demande : une attente plus ancienne s'arrête, et sa session arrivée trop tard est révoquée.
let attempt = 0;

async function revokeLate(server, token) {
  await shell.revokeLater({ server, token }); // file native chiffrée, rejouée jusqu'à réussir
}

async function claim(server, code) {
  const mine = ++attempt;
  say("");
  const info = await shell.info();
  let r;
  try {
    // CapacitorHttp : la requête part de l'app elle-même (pas de restriction CORS pour cet écran local).
    r = await post(`${server}/api/pairing/claim`, { code, appareil: info.device, type: "android" },
      { "X-Noah-Version": info.version });
  } catch {
    return say(t("injoignable", { server }));
  }
  const body = await r.json().catch(() => ({}));
  if (mine !== attempt) return body.token ? revokeLate(server, body.token) : undefined; // une autre demande a pris la main
  if (r.ok && body.attente) return waitForApproval(server, body.sondage, body.expire, body.verification, mine);
  if (!r.ok || !body.token) return say(body.detail || t("refus", { status: r.status }));
  await shell.connect({ server, token: body.token });
}

/**
 * Le serveur attend que l'utilisateur autorise ce téléphone dans Réglages → Appareils, sur l'appareil où le code est
 * affiché, en recopiant le nombre montré ici. On sonde jusqu'au refus ou à l'expiration (410) seulement.
 */
async function waitForApproval(server, sondage, expire, verification, mine) {
  showWaiting(verification);
  const until = Date.now() + (expire || 1200) * 1000;
  while (Date.now() < until && mine === attempt) {
    await new Promise((ok) => setTimeout(ok, 2000));
    let r;
    try {
      r = await post(`${server}/api/pairing/flow/poll`, { sondage });
    } catch {
      continue; // réseau coupé un instant : on réessaie
    }
    if (r.status === 410) return mine !== attempt ? undefined : say(t("refuseeOuExpiree"));
    if (!r.ok) continue; // mise à jour du serveur (503), ralentissement (429) ; 202 : en attente, sans jeton
    const body = await r.json().catch(() => ({}));
    if (body.token) {
      if (mine !== attempt) return revokeLate(server, body.token); // remplacée par une demande plus récente
      return shell.connect({ server, token: body.token });
    }
  }
  if (mine === attempt) say(t("expiree"));
}

$("scan").onclick = async () => {
  say("");
  try {
    const result = await scanner.scanBarcode({ hint: 0, scanInstructions: t("viser") });
    const link = parseLink(result.ScanResult || "");
    if (!link || !origin(link.server)) return say(t("pasNoah"));
    // Un QR peut mener n'importe où : la personne voit à quel serveur elle se relie avant que l'app ne le contacte.
    if (!window.confirm(t("confirmer", { host: new URL(link.server).host }))) return;
    await claim(link.server, link.code);
  } catch (e) {
    if (!String(e && e.message).match(/cancel/i)) say(t("scannerFerme"));
  }
};

$("showManual").onclick = () => {
  $("manual").style.display = "flex";
  $("showManual").style.display = "none";
  $("server").focus();
};

$("server").addEventListener("input", () => {
  const link = parseLink($("server").value);
  if (link) {
    $("server").value = link.server;
    $("code").value = link.code;
  }
});

$("manual").onsubmit = async (e) => {
  e.preventDefault();
  const server = origin($("server").value);
  if (!server) return say(t("adresseHttps"));
  if ($("code").value.trim().length < 8) return say(t("longueurCode"));
  $("go").disabled = true;
  await claim(server, $("code").value.trim());
  $("go").disabled = false;
};
