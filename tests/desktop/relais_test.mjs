// Relais de sortie réseau de l'app de bureau (desktop/relais.js) : tous les refus d'adresse (IPv4, IPv6, noms, ports, résolution
// vers une adresse privée), la connexion à l'adresse vérifiée sans seconde résolution, le plafond de connexions, la contre-pression,
// la reconnexion à délai croissant, et un journal qui ne dit jamais le contenu.
//   node tests/desktop/relais_test.mjs
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
const relais = require(join(desktop, "relais.js"));
const { verifierDestination, adresseInterdite, FENETRE, DELAIS, FERME_REMPLACE } = relais;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`ÉCHEC ${name}\n       ${String(e.stack || e).split("\n").join("\n       ")}`);
  }
};
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok)); };
const until = async (fn, what, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((ok) => setTimeout(ok, 5)); }
  assert.fail(`attendu : ${what}`);
};

// --- 1. Adresses --------------------------------------------------------------------------------------------------------------
const PRIVEES_V4 = ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.1.254", "127.0.0.1", "127.255.0.9",
  "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.100.100.100", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250",
  "255.255.255.255", "240.0.0.1", "192.0.0.5", "198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1"];
const PUBLIQUES_V4 = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "11.0.0.1", "126.255.255.255", "128.0.0.1"];
const PRIVEES_V6 = ["::1", "::", "fe80::1", "fe80::abcd:1234", "febf::1", "fc00::1", "fd00::1", "fdff:ffff::1", "ff02::1", "ff00::", "::ffff:10.0.0.1", "::ffff:127.0.0.1",
  "::ffff:7f00:1", "::ffff:c0a8:0101", "::ffff:169.254.169.254", "::ffff:100.64.0.1", "::127.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "2002:c0a8:101::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  "2001:db8::1", "fec0::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:ffff:0a00:0001"];
const PUBLIQUES_V6 = ["2606:4700:4700::1111", "2a00:1450:4007:80f::200e", "::ffff:8.8.8.8", "::ffff:808:808", "2001:4860:4860::8888", "2620:fe::fe"];

await check("IPv4 : privées, boucle locale, lien local, CGNAT, multicast, non spécifiée, réservées refusées", () => {
  for (const ip of PRIVEES_V4) assert.ok(adresseInterdite(ip), ip);
});
await check("IPv4 : les voisines publiques des plages interdites passent", () => {
  for (const ip of PUBLIQUES_V4) assert.equal(adresseInterdite(ip), "", ip);
});
await check("IPv6 : boucle locale, non spécifiée, ULA, lien local, multicast, IPv4 cachée (mappée, NAT64, 6to4) refusés", () => {
  for (const ip of PRIVEES_V6) assert.ok(adresseInterdite(ip), ip);
});
await check("IPv6 : adresses publiques et IPv4 publique mappée passent", () => {
  for (const ip of PUBLIQUES_V6) assert.equal(adresseInterdite(ip), "", ip);
});
await check("une adresse mal formée est refusée, jamais devinée", () => {
  for (const ip of ["", "abc", "1.2.3", "1.2.3.4.5", "256.1.1.1", ":::", "1::2::3", "fe80::1%eth0", "12345::1", "::g"]) assert.ok(adresseInterdite(ip), ip);
});

const jamais = () => assert.fail("pas de résolution DNS pour une adresse ou un nom refusé d'avance");
await check("vérification : chaque adresse privée écrite telle quelle, avec ou sans crochets, est refusée sans résoudre", async () => {
  for (const ip of [...PRIVEES_V4, ...PRIVEES_V6.filter((x) => !x.includes("%"))]) {
    for (const hote of [ip, `[${ip}]`]) {
      const v = await verifierDestination(hote, 443, jamais);
      assert.equal(v.ok, false, hote);
      assert.equal(v.genre, "refus", hote);
    }
  }
});
await check("vérification : les écritures détournées de 127.0.0.1 (127.1, 2130706433, 0x7f.0.0.1, 0177.0.0.1) sont refusées", async () => {
  for (const h of ["127.1", "2130706433", "0x7f.0.0.1", "0x7f000001", "0177.0.0.1", "017700000001", "1.2.3", "10.1", "3232235777", "192.168.1"]) {
    const v = await verifierDestination(h, 80, jamais);
    assert.equal(v.ok, false, h);
  }
});
await check("vérification : localhost, .local, .localhost, noms internes et noms sans point refusés sans résoudre", async () => {
  for (const h of ["localhost", "LOCALHOST", "localhost.", "app.localhost", "imprimante.local", "Imprimante.LOCAL.", "nas", "serveur", "pc.lan", "x.home.arpa", "mon-pc.tailnet.ts.net", "db.internal", "wpad.localdomain"]) {
    const v = await verifierDestination(h, 443, jamais);
    assert.equal(v.ok, false, h);
    assert.equal(v.raison, "nom interne", h);
  }
});
await check("vérification : noms vides, trop longs, avec espace, @, barre, pourcentage ou retour à la ligne refusés", async () => {
  for (const h of ["", "  ", "a b.com", "exemple.com@evil.net", "exemple.com/x", "exemple.com\nx", "exemple.com\\x", "exemple.com?x", "exemple.com#x", "fe80::1%eth0", "a".repeat(260) + ".com", null, undefined]) {
    const v = await verifierDestination(h, 443, jamais);
    assert.equal(v.ok, false, String(h));
  }
});
await check("vérification : seuls les ports 80 et 443 passent", async () => {
  for (const port of [0, 1, 21, 22, 23, 25, 53, 110, 143, 445, 587, 993, 3306, 3389, 5432, 6379, 8080, 8443, 9000, 65535, 442, 444, -1, 65536, 80.5, "443", null, undefined, NaN]) {
    const v = await verifierDestination("exemple.com", port, jamais);
    assert.equal(v.ok, false, String(port));
    assert.equal(v.raison, "port refusé", String(port));
  }
  for (const port of [80, 443]) assert.equal((await verifierDestination("93.184.216.34", port, jamais)).ok, true);
});
await check("vérification : un nom qui se résout vers une adresse privée est refusé, même mêlé à une publique", async () => {
  const cas = [["10.0.0.5"], ["192.168.1.20"], ["127.0.0.1"], ["169.254.169.254"], ["100.64.1.1"], ["::1"], ["fd00::5"], ["fe80::1"], ["::ffff:10.0.0.5"],
    ["93.184.216.34", "192.168.1.5"], ["192.168.1.5", "93.184.216.34"], ["2606:4700::1111", "fd00::1"], ["0.0.0.0"], ["224.0.0.1"]];
  for (const liste of cas) {
    const v = await verifierDestination("exemple.com", 443, async () => liste);
    assert.equal(v.ok, false, liste.join(","));
    assert.equal(v.genre, "refus");
    assert.match(v.raison, /privée/);
  }
});
await check("vérification : une résolution qui échoue ou ne donne rien est une erreur, pas un refus", async () => {
  for (const resolve of [async () => { throw new Error("ENOTFOUND"); }, async () => [], async () => null]) {
    const v = await verifierDestination("exemple.com", 443, resolve);
    assert.deepEqual([v.ok, v.genre], [false, "erreur"]);
  }
});
await check("vérification : un nom public rend les adresses vérifiées, résolu une seule fois", async () => {
  let n = 0;
  const v = await verifierDestination("Exemple.COM.", 443, async (h) => { n++; assert.equal(h, "exemple.com"); return ["93.184.216.34", "2606:2800:220:1::1"]; });
  assert.deepEqual(v, { ok: true, adresses: ["93.184.216.34", "2606:2800:220:1::1"] });
  assert.equal(n, 1);
  assert.deepEqual(await verifierDestination("[2606:4700:4700::1111]", 80, jamais), { ok: true, adresses: ["2606:4700:4700::1111"] });
});

// --- 2. Le relais, avec un faux WebSocket, de vraies prises et des minuteries à la main -------------------------------------
class FauxWS {
  static instances = [];
  constructor(url, options) {
    Object.assign(this, { url, options, readyState: 0, sent: [], bufferedAmount: 0, closed: false });
    FauxWS.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; }
  ouvrir() { this.readyState = 1; this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
  fermer(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  ordres() { return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d)); }
  paquets() { return this.sent.filter((d) => typeof d !== "string").map((b) => ({ id: Buffer.from(b).readUInt32BE(0), data: Buffer.from(b).subarray(4) })); }
}
const paquetServeur = (id, data) => { const b = Buffer.alloc(4 + data.length); b.writeUInt32BE(id, 0); Buffer.from(data).copy(b, 4); return b; };

function minuteries() {
  const liste = [];
  let n = 0;
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, id: ++n, unref() {} }; liste.push(t); return t; },
    clearTimer: (t) => { const i = liste.indexOf(t); if (i >= 0) liste.splice(i, 1); },
    en_attente: () => liste.map((t) => t.ms),
    tirer(ms) { const i = liste.findIndex((t) => t.ms === ms); assert.ok(i >= 0, `aucune minuterie de ${ms} ms parmi ${liste.map((t) => t.ms)}`); const [t] = liste.splice(i, 1); t.fn(); },
  };
}

/** Un faux site : accepte les connexions, garde ce qu'il reçoit, répond à la demande. */
async function fauxSite() {
  const recus = [];
  const prises = [];
  const server = net.createServer((s) => { prises.push(s); s.on("data", (d) => recus.push(d)); s.on("error", () => {}); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { port: server.address().port, recus, prises, server, close: () => { for (const s of prises) s.destroy(); server.close(); } };
}

function monter({ site, resolve, max, lien, permettreClair = false, prevenir = null, delais } = {}) {
  FauxWS.instances.length = 0;
  const journal = [], tours = minuteries(), connexions = [], resolutions = [];
  const r = relais.create({
    lien: lien ?? (async () => ({ origin: "https://noah.exemple.com", token: "JETON-DE-L-APPAREIL" })),
    journal: (l) => journal.push(l),
    resolve: resolve ?? (async (h) => { resolutions.push(h); return ["93.184.216.34"]; }),
    connect: async (adresse, port) => {
      connexions.push([adresse, port]);
      return new Promise((ok, ko) => { const s = net.connect({ host: "127.0.0.1", port: site.port }); s.once("connect", () => ok(s)); s.once("error", ko); });
    },
    WebSocketImpl: FauxWS, setTimer: tours.setTimer, clearTimer: tours.clearTimer, nom: () => "PC-DE-FRANCK", permettreClair, prevenir,
    ...(max ? { max } : {}), ...(delais ? { delais } : {}),
  });
  return { r, journal, tours, connexions, resolutions, ws: () => FauxWS.instances.at(-1) };
}
const ouvert = async (m) => { m.r.start(); await settle(); m.ws().ouvrir(); await settle(); return m.ws(); };
const open = (ws, id, hote = "exemple.com", port = 443) => ws.message(JSON.stringify({ t: "open", id, hote, port }));

await check("connexion : adresse wss du serveur, jeton de l'appareil dans l'en-tête, nom de l'ordinateur annoncé", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  assert.equal(ws.url, "wss://noah.exemple.com/api/sortie/relais");
  assert.deepEqual(ws.options, { headers: { Authorization: "Bearer JETON-DE-L-APPAREIL" } });
  assert.deepEqual(ws.ordres(), [{ t: "bonjour", nom: "PC-DE-FRANCK" }]);
  assert.equal(m.r.status().etat, "actif");
  assert.deepEqual(m.journal, ["relais : ouvert"]);
  site.close();
});
await check("connexion : jamais de jeton en clair vers un serveur public (http), sauf banc d'essai", async () => {
  const site = await fauxSite();
  const lien = async () => ({ origin: "http://noah.exemple.com", token: "T" });
  const m = monter({ site, lien });
  m.r.start(); await settle();
  assert.equal(FauxWS.instances.length, 0, "aucune connexion ouverte");
  assert.ok(m.tours.en_attente().includes(DELAIS[0]), "il réessaiera");
  const essai = monter({ site, lien, permettreClair: true });
  essai.r.start(); await settle();
  assert.equal(essai.ws().url, "ws://noah.exemple.com/api/sortie/relais");
  site.close();
});
await check("une destination publique : vérifiée, résolue une fois, jointe à l'adresse vérifiée, puis les octets passent dans les deux sens", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  open(ws, 7);
  await until(() => ws.ordres().some((o) => o.t === "ok" && o.id === 7), "ok");
  assert.deepEqual(m.resolutions, ["exemple.com"], "une seule résolution");
  assert.deepEqual(m.connexions, [["93.184.216.34", 443]], "la prise vise l'adresse vérifiée");
  ws.message(paquetServeur(7, "GET / HTTP/1.1\r\n\r\n"));
  await until(() => Buffer.concat(site.recus).toString() === "GET / HTTP/1.1\r\n\r\n", "octets au site");
  site.prises[0].write("HTTP/1.1 200 OK\r\n\r\n");
  await until(() => ws.paquets().length === 1, "octets vers le serveur");
  assert.deepEqual([ws.paquets()[0].id, ws.paquets()[0].data.toString()], [7, "HTTP/1.1 200 OK\r\n\r\n"]);
  assert.deepEqual(m.journal, ["relais : ouvert"], "une connexion permise ne laisse rien dans le journal, et jamais son contenu");
  site.close();
});
await check("fermeture : celle du serveur coupe la prise, celle du site est annoncée au serveur", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  open(ws, 1); open(ws, 2);
  await until(() => ws.ordres().filter((o) => o.t === "ok").length === 2, "deux connexions");
  ws.message(JSON.stringify({ t: "close", id: 1 }));
  await until(() => site.prises[0].destroyed || site.prises[0].readableEnded, "prise 1 coupée");
  site.prises[1].end();
  await until(() => ws.ordres().some((o) => o.t === "close" && o.id === 2), "fermeture annoncée");
  assert.equal(m.r.status().connexions, 0);
  site.close();
});
await check("chaque destination interdite demandée par le serveur reçoit un refus, n'ouvre aucune prise, et le journal dit hôte et raison", async () => {
  const site = await fauxSite();
  const m = monter({ site, resolve: async (h) => (h === "piege.exemple.com" ? ["192.168.1.9"] : ["93.184.216.34"]) });
  const ws = await ouvert(m);
  const demandes = [["192.168.1.9", 443], ["10.0.0.1", 80], ["127.0.0.1", 443], ["[::1]", 443], ["fd00::1", 443], ["169.254.169.254", 80], ["100.64.0.5", 443], ["localhost", 443],
    ["imprimante.local", 80], ["exemple.com", 22], ["exemple.com", 8080], ["piege.exemple.com", 443], ["127.1", 80], ["", 443]];
  demandes.forEach(([h, p], i) => open(ws, 100 + i, h, p));
  await until(() => ws.ordres().filter((o) => o.t === "refus").length === demandes.length, "un refus par demande");
  assert.deepEqual(m.connexions, [], "aucune prise ouverte");
  assert.equal(m.r.status().connexions, 0);
  const lignes = m.journal.filter((l) => l.startsWith("relais : refus"));
  assert.equal(lignes.length, demandes.length);
  assert.ok(lignes.some((l) => l.includes("192.168.1.9:443") && l.includes("adresse privée")), lignes.join("\n"));
  assert.ok(lignes.some((l) => l.includes("exemple.com:22") && l.includes("port refusé")));
  assert.ok(lignes.some((l) => l.includes("piege.exemple.com:443") && l.includes("résolu vers une adresse privée")));
  site.close();
});
await check("plafond : au-delà de N connexions simultanées (même en cours d'ouverture), refus ; une place libérée se reprend", async () => {
  const site = await fauxSite();
  let lacher;
  const lent = new Promise((ok) => { lacher = ok; });
  const m = monter({ site, max: 3, resolve: async (h) => { if (h === "lent.exemple.com") await lent; return ["93.184.216.34"]; } });
  const ws = await ouvert(m);
  open(ws, 1, "lent.exemple.com"); open(ws, 2); open(ws, 3); open(ws, 4); open(ws, 5);
  await until(() => ws.ordres().filter((o) => o.t === "refus").length === 2, "deux refus");
  assert.deepEqual(ws.ordres().filter((o) => o.t === "refus").map((o) => [o.id, o.raison]), [[4, "trop de connexions"], [5, "trop de connexions"]]);
  lacher();
  await until(() => ws.ordres().filter((o) => o.t === "ok").length === 3, "trois ouvertes");
  ws.message(JSON.stringify({ t: "close", id: 2 }));
  await until(() => m.r.status().connexions === 2, "une place libre");
  open(ws, 6);
  await until(() => ws.ordres().some((o) => o.t === "ok" && o.id === 6), "la sixième passe");
  site.close();
});
await check("contre-pression : l'app arrête de lire la prise à la fin de la fenêtre et reprend quand le serveur redonne du crédit", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  open(ws, 9);
  await until(() => ws.ordres().some((o) => o.t === "ok"), "ok");
  const gros = Buffer.alloc(64 * 1024, 97);
  const envoyes = () => ws.paquets().reduce((n, p) => n + p.data.length, 0);
  let ecrits = 0;
  const pousser = () => { while (ecrits < FENETRE * 6 && site.prises[0].write(gros)) ecrits += gros.length; ecrits += gros.length; };
  pousser();
  await until(() => envoyes() >= FENETRE, "la fenêtre est envoyée");
  await settle(40);
  assert.equal(envoyes(), FENETRE, "pas un octet de plus sans crédit");
  ws.message(JSON.stringify({ t: "credit", id: 9, n: 128 * 1024 }));
  await until(() => envoyes() >= FENETRE + 128 * 1024, "le crédit relance l'envoi");
  await settle(40);
  assert.ok(envoyes() <= FENETRE + 128 * 1024 + 64 * 1024, `ne dépasse pas le crédit donné : ${envoyes()}`);
  site.close();
});
await check("contre-pression : le crédit est redonné au serveur une fois les octets écrits sur la prise", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  open(ws, 3);
  await until(() => ws.ordres().some((o) => o.t === "ok"), "ok");
  for (let i = 0; i < 4; i++) ws.message(paquetServeur(3, Buffer.alloc(32 * 1024, 98)));
  await until(() => ws.ordres().some((o) => o.t === "credit" && o.id === 3), "crédit rendu");
  const rendu = ws.ordres().filter((o) => o.t === "credit").reduce((n, o) => n + o.n, 0);
  assert.ok(rendu >= 64 * 1024 && rendu <= 128 * 1024, `crédit rendu : ${rendu}`);
  await until(() => Buffer.concat(site.recus).length === 128 * 1024, "tout est arrivé au site");
  site.close();
});
await check("des paquets pour une connexion inconnue, trop courts ou du texte invalide sont ignorés sans casser le relais", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  ws.message(paquetServeur(99, "x")); ws.message(Buffer.from([1, 2])); ws.message("pas du json"); ws.message("null"); ws.message(JSON.stringify({ t: "inconnu" }));
  ws.message(JSON.stringify({ t: "open", id: "x", hote: "exemple.com", port: 443 })); ws.message(JSON.stringify({ t: "ping" }));
  await settle();
  assert.deepEqual(ws.ordres().filter((o) => o.t !== "bonjour"), [{ t: "pong" }]);
  assert.equal(m.r.status().etat, "actif");
  site.close();
});

await check("reconnexion : coupure → nouvel essai après 2 s, puis 4, 8, 16, 32, 60 s ; « bonjour » du serveur remet le délai à zéro", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  let ws = await ouvert(m);
  ws.message(JSON.stringify({ t: "bonjour" }));
  ws.fermer(1006);
  assert.equal(m.r.status().etat, "connexion");
  assert.deepEqual(m.tours.en_attente().filter((ms) => DELAIS.includes(ms)), [DELAIS[0]]);
  const vus = [];
  for (let i = 0; i < 8; i++) {
    const attendu = DELAIS[Math.min(i, DELAIS.length - 1)];
    const avant = FauxWS.instances.length;
    m.tours.tirer(attendu);
    await settle();
    assert.equal(FauxWS.instances.length, avant + 1, `essai ${i + 1} après ${attendu} ms`);
    vus.push(attendu);
    m.ws().fermer(1006); // le serveur ne répond pas : la connexion échoue sans jamais s'ouvrir
  }
  assert.deepEqual(vus, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  m.tours.tirer(60000); await settle();
  ws = m.ws(); ws.ouvrir(); await settle();
  ws.message(JSON.stringify({ t: "bonjour" }));
  ws.fermer(1006);
  assert.ok(m.tours.en_attente().includes(DELAIS[0]), "le délai repart de 2 s");
  assert.ok(m.journal.filter((l) => l === "relais : fermé").length === 2, m.journal.join("|"));
  site.close();
});
await check("reconnexion : une coupure libère toutes les prises ; les connexions ne survivent pas à leur relais", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  open(ws, 1); open(ws, 2);
  await until(() => ws.ordres().filter((o) => o.t === "ok").length === 2, "deux connexions");
  ws.fermer(1006);
  await until(() => site.prises.every((p) => p.destroyed), "prises détruites");
  assert.equal(m.r.status().connexions, 0);
  site.close();
});
await check("reconnexion : pas encore relié (lien vide) ou erreur du lien → on réessaie, sans rien ouvrir", async () => {
  const site = await fauxSite();
  let reponse = null;
  const m = monter({ site, lien: async () => { if (reponse === "erreur") throw new Error("keychain"); return reponse; } });
  m.r.start(); await settle();
  assert.equal(FauxWS.instances.length, 0);
  reponse = "erreur";
  m.tours.tirer(DELAIS[0]); await settle();
  assert.equal(FauxWS.instances.length, 0);
  reponse = { origin: "https://noah.exemple.com", token: "T" };
  m.tours.tirer(DELAIS[1]); await settle();
  assert.equal(FauxWS.instances.length, 1);
  site.close();
});
await check("reconnexion : une ligne qui se tait 70 s est coupée et rouverte ; chaque message du serveur repousse l'échéance", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  assert.ok(m.tours.en_attente().includes(70000));
  ws.message(JSON.stringify({ t: "ping" }));
  assert.equal(m.tours.en_attente().filter((ms) => ms === 70000).length, 1, "une seule échéance, repoussée");
  m.tours.tirer(70000); await settle();
  assert.ok(ws.closed, "la ligne morte est fermée");
  assert.equal(m.r.status().etat, "connexion");
  m.tours.tirer(DELAIS[0]); await settle();
  assert.equal(FauxWS.instances.length, 2);
  site.close();
});
await check("« remplacé » (un autre ordinateur a pris le relais) : pas de reconnexion, état dédié", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const etats = [];
  m.r.onChange((e) => etats.push(e));
  const ws = await ouvert(m);
  ws.fermer(FERME_REMPLACE);
  await settle();
  assert.equal(m.r.status().etat, "remplace");
  assert.equal(m.r.status().voulu, false);
  assert.deepEqual(m.tours.en_attente().filter((ms) => DELAIS.includes(ms)), []);
  assert.deepEqual(etats, ["connexion", "actif", "remplace"]);
  site.close();
});
await check("arrêt : plus aucune reconnexion, la ligne se ferme, et le serveur est prévenu si on le demande", async () => {
  const site = await fauxSite();
  const prevenus = [];
  const m = monter({ site, prevenir: async (origin, token) => { prevenus.push([origin, token]); } });
  const ws = await ouvert(m);
  open(ws, 1);
  await until(() => ws.ordres().some((o) => o.t === "ok"), "ok");
  await m.r.stop({ serveur: true });
  assert.ok(ws.closed);
  assert.equal(m.r.status().etat, "arret");
  assert.deepEqual(prevenus, [["https://noah.exemple.com", "JETON-DE-L-APPAREIL"]]);
  await until(() => site.prises[0].destroyed, "prise libérée");
  ws.fermer(1000); // l'événement de fermeture arrive après : sans effet
  await settle();
  assert.deepEqual(m.tours.en_attente().filter((ms) => DELAIS.includes(ms)), []);
  assert.equal(FauxWS.instances.length, 1);
  m.r.start(); await settle();
  assert.equal(FauxWS.instances.length, 2, "rallumé : une nouvelle ligne");
  await m.r.stop();
  assert.equal(prevenus.length, 1, "un arrêt simple (fermeture de l'app) ne prévient pas le serveur");
  site.close();
});
await check("journal : ouverture, fermeture et refus seulement, jamais d'octets ni de jeton", async () => {
  const site = await fauxSite();
  const m = monter({ site });
  const ws = await ouvert(m);
  open(ws, 1);
  await until(() => ws.ordres().some((o) => o.t === "ok"), "ok");
  ws.message(paquetServeur(1, "SECRET-DU-CONTENU Authorization: cookie=abc"));
  open(ws, 2, "10.0.0.8", 443);
  await until(() => m.journal.some((l) => l.includes("refus")), "refus");
  ws.fermer(1006);
  const tout = m.journal.join("\n");
  assert.doesNotMatch(tout, /SECRET|cookie|JETON/);
  assert.deepEqual(m.journal.map((l) => l.split(" ").slice(0, 4).join(" ").replace(" (adresse", "")), ["relais : ouvert", "relais : refus 10.0.0.8:443", "relais : fermé"]);
  site.close();
});

if (failures) {
  console.log(`${failures} échec(s)`);
  process.exit(1);
}
console.log("Relais de sortie réseau (bureau) : tout est en ordre.");
process.exit(0);
