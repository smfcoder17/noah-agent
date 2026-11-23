// Relais de sortie réseau : « Mes agents sortent par cet ordinateur ».
// Le navigateur d'un agent, sur le serveur, ouvre ses connexions vers Internet ; le serveur les fait passer par cette app, qui les
// ouvre depuis la connexion de la maison. L'app ouvre elle-même, vers le serveur, une seule connexion sortante chiffrée (wss, jeton de
// l'appareil relié, jamais le mot de passe) ; rien à ouvrir sur la box, rien à installer.
//
// Protocole (un message texte JSON par ordre, un message binaire par paquet : 4 octets d'identifiant de connexion, puis les octets) :
//   serveur -> app   {t:"open", id, hote, port}   ouvrir une connexion       {t:"close", id}   la fermer
//                    {t:"credit", id, n}          n octets de plus à envoyer  {t:"ping"}
//   app -> serveur   {t:"ok", id}  {t:"refus", id, raison}  {t:"erreur", id, raison}  {t:"close", id}  {t:"credit", id, n}  {t:"pong"}
//                    {t:"bonjour", nom}           dit le nom de cet ordinateur dès l'ouverture
// Contre-pression : chaque sens a une fenêtre de FENETRE octets par connexion ; le receveur redonne du crédit une fois les octets
// écrits sur sa prise, l'émetteur s'arrête à zéro. Une connexion lente ne gonfle donc jamais la mémoire de l'autre.
//
// Sécurité (non négociable, tests/desktop/relais_test.mjs) : le serveur n'est pas cru. Toute destination est vérifiée ici :
// ports 80 et 443 seulement ; aucun nom interne ; aucune adresse privée, de boucle locale, de lien local, CGNAT, multicast,
// non spécifiée, IPv6 ULA ou de lien local, avant comme après la résolution DNS ; l'app se connecte à l'adresse vérifiée, sans
// seconde résolution. Un plafond limite les connexions simultanées. Rien du contenu n'est journalisé : seulement l'ouverture et
// la fermeture du relais, et les refus (hôte, raison).
const dns = require("node:dns");
const net = require("node:net");
const os = require("node:os");

const PORTS = new Set([80, 443]);
const MAX_CONNEXIONS = 64;
const FENETRE = 256 * 1024; // octets qu'on peut envoyer sans accusé, par connexion et par sens
const CREDIT_PAR = 64 * 1024; // on redonne du crédit par paquets d'au moins cette taille
const DELAIS = [2000, 4000, 8000, 16000, 32000, 60000]; // reconnexion : délai croissant, puis toutes les minutes
const SILENCE = 70000; // le serveur dit ping toutes les 20 s : plus rien depuis 70 s, la ligne est morte
const DELAI_CONNEXION = 15000;
const DELAI_RESOLUTION = 10000;
const TAMPON_WS = 4 * 1024 * 1024; // au-delà, on arrête de lire les prises en attendant que le réseau suive
const FERME_REMPLACE = 4000; // un autre ordinateur a pris le relais

// --- Destinations ---------------------------------------------------------------------------------------------------------

const INTERDITES = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) INTERDITES.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 96], // non spécifiée, boucle locale, ancienne forme « compatible IPv4 »
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64 : une adresse IPv4 cachée dedans
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], // rejet, Teredo, documentation, 6to4
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], // ULA, lien local, ancien site local, multicast
]) INTERDITES.addSubnet(a, p, "ipv6");

/** Les 8 groupes d'une adresse IPv6 (nombres), ou null. Accepte « :: » et une fin en IPv4 pointé. */
function groupes(ip) {
  let texte = ip;
  const fin = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(texte);
  if (fin) {
    const o = fin[2].split(".").map(Number);
    texte = `${fin[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [tete, queue, trop] = texte.split("::");
  if (trop !== undefined) return null;
  const a = tete ? tete.split(":") : [];
  const b = queue ? queue.split(":") : [];
  const manque = 8 - a.length - b.length;
  if (queue === undefined ? manque !== 0 : manque < 1) return null;
  const all = [...a, ...Array(queue === undefined ? 0 : manque).fill("0"), ...b].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

/** La raison pour laquelle cette adresse (déjà numérique) est refusée, ou une chaîne vide. */
function adresseInterdite(ip) {
  const v = net.isIP(ip);
  if (!v) return "adresse invalide";
  if (v === 6) {
    const g = groupes(ip);
    if (!g) return "adresse invalide";
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) { // IPv4 vue en IPv6 : on juge l'IPv4
      return adresseInterdite(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    return INTERDITES.check(g.map((x) => x.toString(16)).join(":"), "ipv6") ? "adresse privée" : ""; // i18n-ignore : raison technique, journal seulement
  }
  return INTERDITES.check(ip, "ipv4") ? "adresse privée" : ""; // i18n-ignore : raison technique, journal seulement
}

const SUFFIXES_INTERNES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".ts.net", ".intranet", ".corp", ".private"];
const NUMERIQUE = /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/i; // 127.1, 0x7f.1, 2130706433 : des écritures de 127.0.0.1 que getaddrinfo accepte

function resoudre(hote) {
  return Promise.race([
    dns.promises.lookup(hote, { all: true, verbatim: true }).then((l) => l.map((x) => x.address)),
    new Promise((_ok, ko) => setTimeout(() => ko(new Error("délai")), DELAI_RESOLUTION).unref()),
  ]);
}

/**
 * Vérifie une destination demandée par le serveur. Rend {ok:true, adresses} (toutes vérifiées : l'app se connecte à l'une d'elles,
 * sans résoudre une seconde fois), ou {ok:false, genre:"refus"|"erreur", raison}.
 * Une résolution qui donne ne serait-ce qu'une adresse interdite refuse tout : un nom qui panache public et privé est un piège.
 */
async function verifierDestination(hote, port, resolve = resoudre) {
  const refus = (raison) => ({ ok: false, genre: "refus", raison });
  if (!Number.isInteger(port) || !PORTS.has(port)) return refus("port refusé"); // i18n-ignore : raison technique, journal seulement
  let h = String(hote ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.$/, "");
  if (!h || h.length > 253 || /[\s\u0000-\u001f\u007f/\\@?#%]/.test(h)) return refus("adresse invalide");
  if (net.isIP(h)) {
    const raison = adresseInterdite(h);
    return raison ? refus(raison) : { ok: true, adresses: [h] };
  }
  if (NUMERIQUE.test(h) || /^[0-9a-f:.]*:[0-9a-f:.]*$/i.test(h)) return refus("adresse invalide");
  if (h === "localhost" || SUFFIXES_INTERNES.some((s) => h.endsWith(s)) || !h.includes(".")) return refus("nom interne");
  let adresses;
  try {
    adresses = await resolve(h);
  } catch {
    return { ok: false, genre: "erreur", raison: "résolution impossible" }; // i18n-ignore : raison technique, journal seulement
  }
  if (!Array.isArray(adresses) || !adresses.length) return { ok: false, genre: "erreur", raison: "résolution impossible" }; // i18n-ignore : raison technique, journal seulement
  for (const a of adresses) {
    if (adresseInterdite(String(a))) return refus("résolu vers une adresse privée"); // i18n-ignore : raison technique, journal seulement
  }
  return { ok: true, adresses: adresses.map(String) };
}

/** Prise vers une adresse numérique déjà vérifiée : `host` est une IP, aucune résolution n'a lieu. */
function connecter(adresse, port) {
  return new Promise((ok, ko) => {
    const s = net.connect({ host: adresse, port, noDelay: true });
    const fin = setTimeout(() => s.destroy(new Error("délai")), DELAI_CONNEXION);
    s.once("connect", () => {
      clearTimeout(fin);
      s.removeAllListeners("error");
      // Ceinture et bretelles : l'adresse réellement jointe est celle qu'on a vérifiée.
      if (adresseInterdite(s.remoteAddress || "")) {
        s.destroy();
        return ko(new Error("adresse privée")); // i18n-ignore : raison technique, journal seulement
      }
      ok(s);
    });
    s.once("error", (e) => {
      clearTimeout(fin);
      ko(e);
    });
  });
}

// --- Le relais ------------------------------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {() => Promise<{origin: string, token: string} | null>} o.lien   serveur relié et jeton de l'appareil (null : pas encore relié)
 * @param {(ligne: string) => void} [o.journal]   journal : ouverture, fermeture, refus
 * @param {(texte: string) => Promise<string[]>} [o.resolve]   résolution DNS (remplaçable en test)
 * @param {(adresse: string, port: number) => Promise<import("node:net").Socket>} [o.connect]   prise sortante (remplaçable en test)
 * @param {typeof WebSocket} [o.WebSocketImpl]
 * @param {(origin: string, token: string) => Promise<void>} [o.prevenir]   dit au serveur que le relais est coupé pour de bon
 */
function create({
  lien, journal = () => {}, resolve = resoudre, connect = connecter, WebSocketImpl = globalThis.WebSocket, delais = DELAIS,
  max = MAX_CONNEXIONS, setTimer = setTimeout, clearTimer = clearTimeout, nom = () => os.hostname(), permettreClair = false,
  prevenir = null,
}) {
  let voulu = false;
  let etat = "arret"; // arret | connexion | actif | remplace
  let ws = null;
  let generation = 0; // chaque connexion a la sienne : les événements d'une ancienne sont ignorés
  let tentative = 0;
  let minuteur = null;
  let silence = null;
  let soulage = null;
  const conns = new Map(); // id -> {socket, credit, recu, ferme}
  const ecouteurs = [];

  const changer = (e) => {
    if (e === etat) return;
    etat = e;
    for (const f of ecouteurs) f(e);
  };
  const envoyer = (g, donnees) => {
    if (g !== generation || !ws || ws.readyState !== 1) return false;
    try {
      ws.send(donnees);
      return true;
    } catch {
      return false;
    }
  };
  const ordre = (g, o) => envoyer(g, JSON.stringify(o));
  const paquet = (id, buf) => {
    const p = Buffer.allocUnsafe(4 + buf.length);
    p.writeUInt32BE(id, 0);
    buf.copy(p, 4);
    return p;
  };

  function liberer(id, g, prevenirServeur) {
    const c = conns.get(id);
    if (!c) return;
    conns.delete(id);
    c.ferme = true;
    if (c.socket && !c.socket.destroyed) c.socket.destroy();
    if (prevenirServeur) ordre(g, { t: "close", id });
  }

  function surveillerTampon(g) {
    if (soulage || g !== generation) return;
    soulage = setTimer(() => {
      soulage = null;
      if (g !== generation || !ws) return;
      if (ws.bufferedAmount > TAMPON_WS / 2) return surveillerTampon(g);
      for (const c of conns.values()) if (c.socket && c.credit > 0 && c.arrete) { c.arrete = false; c.socket.resume(); }
    }, 50);
    soulage.unref?.();
  }

  async function ouvrir(g, id, hote, port) {
    if (conns.has(id) || !Number.isInteger(id)) return;
    if (conns.size >= max) {
      journal(`relais : refus ${hote}:${port} (trop de connexions)`); // i18n-ignore : journal
      return ordre(g, { t: "refus", id, raison: "trop de connexions" }); // i18n-ignore : raison technique, journal seulement
    }
    const c = { socket: null, credit: FENETRE, recu: 0, ferme: false, arrete: false };
    conns.set(id, c); // la place est prise avant la résolution : le plafond tient aussi pour les connexions en cours d'ouverture
    const v = await verifierDestination(hote, port, resolve);
    if (c.ferme || g !== generation) return;
    if (!v.ok) {
      conns.delete(id);
      journal(`relais : refus ${String(hote).slice(0, 120)}:${port} (${v.raison})`); // i18n-ignore : journal
      return ordre(g, { t: v.genre, id, raison: v.raison });
    }
    let socket = null;
    for (const a of v.adresses) {
      try {
        socket = await connect(a, port);
        break;
      } catch { /* l'adresse suivante */ }
    }
    if (c.ferme || g !== generation) return socket?.destroy();
    if (!socket) {
      conns.delete(id);
      return ordre(g, { t: "erreur", id, raison: "connexion impossible" });
    }
    c.socket = socket;
    socket.on("data", (buf) => {
      if (c.ferme) return;
      envoyer(g, paquet(id, buf));
      c.credit -= buf.length;
      if (c.credit <= 0 || ws?.bufferedAmount > TAMPON_WS) {
        c.arrete = true;
        socket.pause();
        if (c.credit > 0) surveillerTampon(g);
      }
    });
    socket.on("end", () => {
      if (!c.ferme) liberer(id, g, true);
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (!c.ferme) liberer(id, g, true);
    });
    ordre(g, { t: "ok", id });
  }

  function recevoirDonnees(g, buf) {
    if (buf.length < 4) return;
    const id = buf.readUInt32BE(0);
    const c = conns.get(id);
    if (!c || !c.socket || c.ferme) return;
    const taille = buf.length - 4;
    if (!taille) return;
    c.socket.write(buf.subarray(4), () => { // le crédit se redonne une fois les octets partis, pas avant : c'est la contre-pression
      c.recu += taille;
      if (c.recu >= CREDIT_PAR && !c.ferme) {
        ordre(g, { t: "credit", id, n: c.recu });
        c.recu = 0;
      }
    });
  }

  function recevoir(g, message) {
    if (g !== generation) return;
    reveiller(g);
    const donnee = message.data;
    if (typeof donnee === "string") {
      let o;
      try {
        o = JSON.parse(donnee);
      } catch {
        return;
      }
      if (!o || typeof o !== "object") return;
      if (o.t === "open") ouvrir(g, o.id, o.hote, o.port).catch(() => liberer(o.id, g, true));
      else if (o.t === "credit") {
        const c = conns.get(o.id);
        if (c && Number.isFinite(o.n) && o.n > 0) {
          c.credit = Math.min(c.credit + o.n, FENETRE);
          if (c.arrete && c.credit > 0 && c.socket) { c.arrete = false; c.socket.resume(); }
        }
      } else if (o.t === "close") {
        const c = conns.get(o.id);
        if (c?.socket) {
          c.ferme = true;
          conns.delete(o.id);
          c.socket.end(); // les octets déjà reçus partent d'abord
          setTimer(() => c.socket.destroy(), 5000)?.unref?.();
        } else liberer(o.id, g, false);
      } else if (o.t === "ping") ordre(g, { t: "pong" });
      else if (o.t === "bonjour") tentative = 0;
      return;
    }
    const buf = donnee instanceof ArrayBuffer ? Buffer.from(donnee) : ArrayBuffer.isView(donnee) ? Buffer.from(donnee.buffer, donnee.byteOffset, donnee.byteLength) : null;
    if (buf) recevoirDonnees(g, buf);
  }

  function reveiller(g) {
    clearTimer(silence);
    silence = setTimer(() => {
      if (g !== generation) return;
      journal("relais : plus de nouvelles du serveur"); // i18n-ignore : journal
      couper(g, true); // pas d'attente de la poignée de main de fermeture d'une ligne morte
    }, SILENCE);
    silence.unref?.();
  }

  /** Ferme la ligne en cours (le serveur n'y répond pas toujours) et libère toutes les connexions. */
  function couper(g, replanifier) {
    if (g !== generation) return;
    generation++;
    clearTimer(silence);
    clearTimer(soulage);
    silence = soulage = null;
    const ancien = ws;
    ws = null;
    for (const id of [...conns.keys()]) liberer(id, g, false);
    try { ancien?.close(); } catch { /* déjà fermée */ }
    if (voulu && replanifier) planifier();
  }

  function planifier() {
    clearTimer(minuteur);
    const ms = delais[Math.min(tentative, delais.length - 1)];
    tentative++;
    changer("connexion");
    minuteur = setTimer(() => { minuteur = null; cycle(); }, ms);
    minuteur.unref?.();
  }

  async function cycle() {
    if (!voulu || ws) return;
    changer("connexion");
    let l = null;
    try { l = await lien(); } catch { /* pas encore relié */ }
    if (!voulu || ws) return;
    if (!l?.origin || !l.token) return planifier();
    let url;
    try {
      const u = new URL(l.origin);
      const sur = u.protocol === "https:" || (permettreClair && u.protocol === "http:");
      if (!sur) return planifier(); // jamais de jeton en clair vers un serveur public
      url = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/api/sortie/relais`;
    } catch {
      return planifier();
    }
    const g = ++generation;
    let ouverte = false;
    try {
      ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${l.token}` } });
    } catch {
      ws = null;
      return planifier();
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (g !== generation) return;
      ouverte = true;
      journal("relais : ouvert"); // i18n-ignore : journal
      changer("actif");
      reveiller(g);
      ordre(g, { t: "bonjour", nom: String(nom()).slice(0, 80) });
    };
    ws.onmessage = (m) => recevoir(g, m);
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (g !== generation) return;
      if (ouverte) journal("relais : fermé"); // i18n-ignore : journal
      if (e?.code === FERME_REMPLACE) { // un autre ordinateur a pris le relais : celui-ci s'éteint, il ne se bat pas pour la place
        voulu = false;
        couper(g, false);
        return changer("remplace");
      }
      couper(g, true);
    };
  }

  return {
    /** Allume le relais : il se connecte, et se reconnecte seul après une coupure. */
    start() {
      if (voulu) return;
      voulu = true;
      tentative = 0;
      cycle();
    },
    /** Éteint le relais. `serveur` : le dit aussi au serveur, qui cesse alors de compter sur cet ordinateur. */
    async stop({ serveur = false } = {}) {
      const etait = voulu;
      voulu = false;
      clearTimer(minuteur);
      minuteur = null;
      let l = null;
      if (serveur && prevenir) l = await Promise.resolve(lien()).catch(() => null);
      couper(generation, false);
      changer("arret");
      if (etait) journal("relais : arrêté"); // i18n-ignore : journal
      if (l?.origin && l.token) await prevenir(l.origin, l.token).catch(() => {});
    },
    status: () => ({ voulu, etat, connexions: conns.size }),
    onChange: (f) => ecouteurs.push(f),
  };
}

module.exports = { create, verifierDestination, adresseInterdite, PORTS, MAX_CONNEXIONS, FENETRE, DELAIS, FERME_REMPLACE };
