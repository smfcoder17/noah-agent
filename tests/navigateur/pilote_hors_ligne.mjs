// Tourne DANS le conteneur du navigateur (docker exec), sans réseau : attend le service, ouvre une page servie sur
// l'interface locale, relit ce que le vrai Firefox en a rendu. Écrit un seul JSON sur la sortie standard.
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";

const JETON = process.argv[2];
const CLE = process.argv[3];
const API = "http://127.0.0.1:9377";
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${CLE}` };
const out = { sante: null, attente_sante_s: null, onglet: null, page_lue: false, capture_octets: 0, processus: [], route_sortante: null, sortie_bloquee: null, erreurs: [] };

// La preuve que le conteneur est bien coupé du monde : aucune route par défaut, et un appel sortant échoue.
const routes = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
out.route_sortante = routes.some((l) => l.split(/\s+/)[1] === "00000000");
try {
  await fetch("https://github.com", { signal: AbortSignal.timeout(8000) });
  out.sortie_bloquee = false;
} catch {
  out.sortie_bloquee = true;
}

const site = createServer((_, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>${JETON}</title><h1>${JETON}</h1><p>Rendu par Firefox sans réseau.</p>`);
});
await new Promise((r) => site.listen(9999, "127.0.0.1", r));

const t0 = Date.now();
for (let i = 0; i < 90 && !out.sante; i++) {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) out.sante = await r.json();
  } catch {
    await new Promise((res) => setTimeout(res, 2000));
  }
}
out.attente_sante_s = Math.round((Date.now() - t0) / 1000);

async function ouvre() {
  const r = await fetch(`${API}/tabs`, {
    method: "POST", headers, body: JSON.stringify({ userId: "noah", sessionKey: "noah", url: "http://127.0.0.1:9999/" }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`POST /tabs ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j.tabId;
}

if (out.sante) {
  try {
    const debut = Date.now();
    out.onglet = await ouvre();
    out.attente_onglet_s = Math.round((Date.now() - debut) / 1000);
    const snap = await fetch(`${API}/tabs/${out.onglet}/snapshot?userId=noah`, { headers, signal: AbortSignal.timeout(60000) });
    const texte = await snap.text();
    out.page_lue = snap.ok && texte.includes(JETON);
    if (!out.page_lue) out.erreurs.push(`snapshot ${snap.status} ${texte.slice(0, 300)}`);
    const shot = await fetch(`${API}/tabs/${out.onglet}/screenshot?userId=noah`, { headers, signal: AbortSignal.timeout(60000) });
    const png = Buffer.from(await shot.arrayBuffer());
    if (shot.ok && png.subarray(1, 4).toString() === "PNG") out.capture_octets = png.length;
  } catch (e) {
    out.erreurs.push(String(e.message || e));
  }
}

// Le processus du navigateur, lu dans /proc : ni le service ni le message d'un journal ne remplacent ça.
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const exe = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0];
    if (/camoufox/.test(exe)) out.processus.push(exe);
  } catch { /* processus terminé entre-temps */ }
}
out.processus = [...new Set(out.processus)];
try {
  out.extension = readFileSync("/root/.cache/camoufox/addons/UBO/manifest.json", "utf8").replace(/\s+/g, " ").match(/"version":\s*"[^"]+"/)?.[0] || "";
} catch {
  out.extension = "";
}
site.close();
console.log(JSON.stringify(out));
process.exit(0);
