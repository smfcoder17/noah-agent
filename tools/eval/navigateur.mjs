// Banc du navigateur de l'agent (lot 5 de la 0.2.0) : 10 tâches, N passages, temps, mémoire, réussite.
// Il pilote le navigateur comme Hermes : par l'API REST de Camofox, ou par CDP pour un Chrome candidat.
// Il ne touche à aucun conteneur de Noah : on lui donne un navigateur à part (voir docs plus bas).
//
//     node tools/eval/navigateur.mjs camofox http://127.0.0.1:19401 <clé> <conteneur> [passages=3] [sortie.json]
//     node tools/eval/navigateur.mjs cdp     http://127.0.0.1:19222 -      <conteneur> [passages=3] [sortie.json]
//
// <conteneur> : son nom Docker, pour la mémoire (docker stats, relevée après chaque tâche ; on garde le pic).
// CDP demande Playwright (variable NOAH_PLAYWRIGHT : dossier du paquet playwright).
// Les sites sont publics et ne demandent aucun compte ; la page de connexion est un site d'essai qui publie ses identifiants.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";

const [kind, endpoint, key, container, runsArg = "3", out] = process.argv.slice(2);
if (!["camofox", "cdp"].includes(kind) || !endpoint || !container) {
  console.error("usage : node tools/eval/navigateur.mjs camofox|cdp <adresse> <clé|-> <conteneur> [passages] [sortie.json]");
  process.exit(2);
}
const RUNS = Number(runsArg);
const TASK_MS = 90_000;
const USER = "banc";

// --- Pilotes ---------------------------------------------------------------------------------------------------------
// Même petite interface pour les deux : ouvrir un onglet, aller à une adresse, lire la page (ce que lit l'agent),
// évaluer du JavaScript, taper, cliquer, fermer.

function camofox() {
  const H = { "content-type": "application/json", authorization: `Bearer ${key}` };
  const call = async (method, path, body) => {
    const r = await fetch(endpoint + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TASK_MS) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} : ${r.status} ${JSON.stringify(data).slice(0, 160)}`);
    return data;
  };
  return {
    async start() { await call("POST", "/start"); },
    async open(url) { return (await call("POST", "/tabs", { userId: USER, sessionKey: USER, url })).tabId; },
    async go(tab, url) { await call("POST", `/tabs/${tab}/navigate`, { userId: USER, url }); },
    async read(tab) { const s = await call("GET", `/tabs/${tab}/snapshot?userId=${USER}`); return JSON.stringify(s).length; },
    async js(tab, expression) { return (await call("POST", `/tabs/${tab}/evaluate`, { userId: USER, expression })).result; },
    async type(tab, selector, text) { await call("POST", `/tabs/${tab}/type`, { userId: USER, selector, text }); },
    async click(tab, selector) { await call("POST", `/tabs/${tab}/click`, { userId: USER, selector }); },
    async close(tab) { await call("DELETE", `/tabs/${tab}?userId=${USER}`).catch(() => {}); },
    async end() {},
  };
}

async function cdp() {
  const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] || await browser.newContext();
  const pages = new Map();
  let n = 0;
  const page = (tab) => pages.get(tab);
  return {
    async start() {},
    async open(url) { const p = await context.newPage(); await p.goto(url, { waitUntil: "load", timeout: TASK_MS }); pages.set(++n, p); return n; },
    async go(tab, url) { await page(tab).goto(url, { waitUntil: "load", timeout: TASK_MS }); },
    async read(tab) { return (await page(tab).locator("body").ariaSnapshot({ timeout: TASK_MS })).length; },
    async js(tab, expression) { return page(tab).evaluate(expression); },
    async type(tab, selector, text) { await page(tab).fill(selector, text); },
    async click(tab, selector) { await page(tab).click(selector); },
    async close(tab) { await page(tab)?.close().catch(() => {}); pages.delete(tab); },
    async end() { await browser.close().catch(() => {}); },
  };
}

// --- Tâches ----------------------------------------------------------------------------------------------------------
// Chacune rend true si le résultat attendu est là. Les attentes de page se font dans la page, bornées.
const waitFor = (cond, ms = 15000) => `(async () => { const end = Date.now() + ${ms}; while (Date.now() < end) { try { if (${cond}) return true; } catch (e) {} await new Promise(r => setTimeout(r, 250)); } return false; })()`;
const VIDEO_H264 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const VIDEO_VP9 = "https://test-videos.co.uk/vids/bigbuckbunny/webm/vp9/360/Big_Buck_Bunny_360_10s_1MB.webm";
const play = (src) => `(async () => {
  const v = document.createElement('video'); v.muted = true; v.src = ${JSON.stringify(src)}; document.body.appendChild(v);
  try { await v.play(); } catch (e) { return false; }
  const end = Date.now() + 15000; while (Date.now() < end && v.currentTime < 2) await new Promise(r => setTimeout(r, 250));
  return v.currentTime >= 2 && !v.error;
})()`;

const TASKS = [
  ["page simple", async (d) => { const t = await d.open("https://example.com"); try { return /Example Domain/.test(await d.js(t, "document.title")); } finally { await d.close(t); } }],
  ["article et lecture", async (d) => { const t = await d.open("https://fr.wikipedia.org/wiki/Lyon"); try { return (await d.read(t)) > 2000 && /Lyon/.test(await d.js(t, "document.title")); } finally { await d.close(t); } }],
  ["défilement long", async (d) => { const t = await d.open("https://fr.wikipedia.org/wiki/France"); try { return await d.js(t, `(async () => { for (let i = 0; i < 20; i++) { scrollBy(0, innerHeight); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))); } return scrollY > 5000; })()`); } finally { await d.close(t); } }],
  ["recherche", async (d) => { const t = await d.open("https://html.duckduckgo.com/html/?q=noah+agent"); try { return await d.js(t, waitFor("document.querySelectorAll('.result, .result__a').length > 3")); } finally { await d.close(t); } }],
  ["page lourde", async (d) => { const t = await d.open("https://github.com/microsoft/vscode"); try { return (await d.read(t)) > 2000 && await d.js(t, waitFor("document.querySelector('article, [data-testid], #readme')")); } finally { await d.close(t); } }],
  ["formulaire", async (d) => {
    const t = await d.open("https://httpbin.org/forms/post");
    try {
      await d.type(t, "input[name=custname]", "Banc Noah");
      await d.click(t, "button");
      return await d.js(t, waitFor("document.body.innerText.includes('Banc Noah')"));
    } finally { await d.close(t); }
  }],
  ["page de connexion", async (d) => {
    const t = await d.open("https://the-internet.herokuapp.com/login");
    try {
      await d.type(t, "#username", "tomsmith");
      await d.type(t, "#password", "SuperSecretPassword!"); // identifiants d'essai publiés par le site lui-même
      await d.click(t, "button[type=submit]");
      return await d.js(t, waitFor("location.pathname === '/secure'"));
    } finally { await d.close(t); }
  }],
  ["vidéo H.264", async (d) => { const t = await d.open("https://example.com"); try { return await d.js(t, play(VIDEO_H264)); } finally { await d.close(t); } }],
  ["vidéo VP9", async (d) => { const t = await d.open("https://example.com"); try { return await d.js(t, play(VIDEO_VP9)); } finally { await d.close(t); } }],
  ["trois onglets", async (d) => {
    const urls = ["https://fr.wikipedia.org/wiki/Paris", "https://fr.wikipedia.org/wiki/Marseille", "https://fr.wikipedia.org/wiki/Bordeaux"];
    const tabs = [];
    try {
      for (const u of urls) tabs.push(await d.open(u)); // l'un après l'autre, comme l'agent
      const titles = await Promise.all(tabs.map((t) => d.js(t, "document.title")));
      return titles.every((x, i) => x.includes(urls[i].split("/").pop()));
    } finally { for (const t of tabs) await d.close(t); }
  }],
];

// --- Mesure ----------------------------------------------------------------------------------------------------------
const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1e3, mb: 1e6, gb: 1e9 };
function memory() {
  try {
    const used = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", container]).toString().split("/")[0].trim();
    const [, n, u] = used.match(/([\d.]+)\s*([a-zA-Z]+)/);
    return Math.round((Number(n) * UNITS[u.toLowerCase()]) / 1e6);
  } catch { return null; }
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const driver = kind === "camofox" ? camofox() : await cdp();
const t0 = Date.now();
await driver.start();
const startMs = Date.now() - t0; // démarrage du navigateur (à froid si le conteneur vient de naître)
const memBefore = memory();
const rows = [];
for (let run = 1; run <= RUNS; run++) {
  for (const [name, task] of TASKS) {
    const s = Date.now();
    let ok = false, error = "";
    try {
      ok = !!(await Promise.race([task(driver), new Promise((_, no) => setTimeout(() => no(new Error("délai dépassé")), TASK_MS))]));
    } catch (e) { error = String(e.message || e).slice(0, 200); }
    const row = { passage: run, tache: name, ms: Date.now() - s, ok, memoire_mo: memory(), ...(error && { erreur: error }) };
    rows.push(row);
    console.error(`${run} ${name.padEnd(18)} ${ok ? "ok " : "NON"} ${String(row.ms).padStart(6)} ms ${row.memoire_mo ?? "?"} Mo${error ? "  " + error : ""}`);
  }
}
await driver.end();

const byTask = Object.fromEntries(TASKS.map(([name]) => {
  const r = rows.filter((x) => x.tache === name);
  return [name, { reussite: `${r.filter((x) => x.ok).length}/${r.length}`, ms_mediane: median(r.map((x) => x.ms)) }];
}));
const summary = {
  navigateur: kind, conteneur: container, passages: RUNS, date: new Date().toISOString(),
  demarrage_ms: startMs, memoire_depart_mo: memBefore,
  memoire_pic_mo: Math.max(...rows.map((r) => r.memoire_mo ?? 0)),
  reussite: `${rows.filter((r) => r.ok).length}/${rows.length}`,
  reussite_pct: Math.round((100 * rows.filter((r) => r.ok).length) / rows.length),
  temps_total_median_s: Math.round(median([...Array(RUNS).keys()].map((i) => rows.filter((r) => r.passage === i + 1).reduce((a, r) => a + r.ms, 0))) / 100) / 10,
  par_tache: byTask, lignes: rows,
};
if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, lignes: undefined }, null, 1));
