// Écran de connexion de l'app : obtenir une session du serveur Noah (QR code ou code court), la confier à l'app,
// qui rouvre alors sa fenêtre sur l'interface du serveur.
const { Capacitor } = window;
// Pas de bundler ici : le pont natif expose les plugins dans Capacitor.Plugins.
const shell = Capacitor.Plugins.NoahShell;
const scanner = Capacitor.Plugins.CapacitorBarcodeScanner;
const $ = (id) => document.getElementById(id);

const say = (text) => {
  $("wait").style.display = "none";
  $("error").textContent = text || "";
};
/** Attente de l'accord : consigne calme et nombre bien lisible, pas une erreur. */
function showWaiting(verification) {
  $("error").textContent = "";
  $("wait").replaceChildren("Sur l'appareil où le code est affiché, accepte ce téléphone et saisis :", Object.assign(document.createElement("b"), { textContent: verification }));
  $("wait").style.display = "block";
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

async function claim(server, code) {
  say("");
  const info = await shell.info();
  let r;
  try {
    // CapacitorHttp : la requête part de l'app elle-même (pas de restriction CORS pour cet écran local).
    r = await fetch(`${server}/api/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Noah-Version": info.version },
      body: JSON.stringify({ code, appareil: info.device, type: "android" }),
    });
  } catch {
    return say(`Impossible de joindre ${server}. Vérifie ta connexion et l'adresse.`);
  }
  const body = await r.json().catch(() => ({}));
  if (r.ok && body.attente) return waitForApproval(server, body.sondage, body.expire, body.verification);
  if (!r.ok || !body.token) return say(body.detail || `Le serveur a refusé (${r.status}).`);
  await shell.connect({ server, token: body.token });
}

/**
 * Le serveur attend que l'utilisateur autorise ce téléphone dans Réglages → Appareils, sur l'appareil où le code est
 * affiché, en recopiant le nombre montré ici. On sonde jusqu'au refus ou à l'expiration (410) seulement.
 */
async function waitForApproval(server, sondage, expire, verification) {
  showWaiting(verification);
  const until = Date.now() + (expire || 1200) * 1000;
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 2000));
    let r;
    try {
      r = await fetch(`${server}/api/pairing/flow/poll`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sondage }),
      });
    } catch {
      continue; // réseau coupé un instant : on réessaie
    }
    if (r.status === 410) return say("Demande refusée ou expirée. Affiche un nouveau code et recommence.");
    if (!r.ok) continue; // mise à jour du serveur (503), ralentissement (429) ; 202 : en attente, sans jeton
    const body = await r.json().catch(() => ({}));
    if (body.token) return shell.connect({ server, token: body.token });
  }
  say("Demande expirée. Affiche un nouveau code et recommence.");
}

$("scan").onclick = async () => {
  say("");
  try {
    const result = await scanner.scanBarcode({ hint: 0, scanInstructions: "Vise le QR code de Réglages → Appareils" });
    const link = parseLink(result.ScanResult || "");
    if (!link || !origin(link.server)) return say("Ce QR code ne vient pas de Noah (Réglages → Appareils → « Relier un appareil »).");
    await claim(link.server, link.code);
  } catch (e) {
    if (!String(e && e.message).match(/cancel/i)) say("Le scanner n'a pas pu s'ouvrir. Saisis l'adresse et le code à la place.");
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
  if (!server) return say("Indique une adresse en https:// (exemple : https://noah.exemple.com).");
  if ($("code").value.trim().length < 8) return say("Le code fait 8 caractères (exemple : BCDF-GHJK).");
  $("go").disabled = true;
  await claim(server, $("code").value.trim());
  $("go").disabled = false;
};
