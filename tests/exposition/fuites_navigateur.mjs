// La vraie interface dans Chrome, connecté et non connecté : tout le trafic et la console sont capturés, puis cherchés pour des
// clés, jetons, chemins internes et mots de passe. Vérifie aussi que la CSP ne casse rien : aucune violation, aperçu en bac à
// sable, vrai noVNC. Hors CI : demande la pile de serveur_essai.py (témoins plantés, Hermes simulé), avec un Caddy devant sur BASE
// et les fichiers noVNC de l'image du navigateur montés dans /novnc. Elle ne vise jamais un hôte réel.
//   NOAH_PLAYWRIGHT=.../node_modules/playwright BASE=http://127.0.0.1:18443 node tests/exposition/fuites_navigateur.mjs
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.BASE || "http://127.0.0.1:18443";
const PASSWORD = process.env.MOT_DE_PASSE || "motdepasse-essai";
const SECRETS = /sk-SENTINELLE|CLE-MEDIA-SENTINELLE|CLE-AGENT|LAUNCHER_KEY|NOAH_SECRET_KEY|\/secrets\/|\/opt\/noah|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|Traceback/;
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "OK    " : "ÉCHEC "} ${name}${detail ? ` : ${String(detail).slice(0, 400)}` : ""}`); if (!ok) failed++; };

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function visit(label, steps) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const leaks = [], csp = [], external = [], logs = [];
  page.on("console", (m) => { const t = m.text(); logs.push(t); if (/Content Security Policy|Content-Security-Policy/i.test(t)) csp.push(t); if (SECRETS.test(t) || t.includes(PASSWORD)) leaks.push(`console : ${t}`); });
  page.on("pageerror", (e) => { if (/Content Security Policy/i.test(e.message)) csp.push(e.message); });
  page.on("request", (r) => {
    if (!r.url().startsWith(BASE) && /^https?:/.test(r.url())) external.push(r.url());
    if (SECRETS.test(r.url()) || r.url().includes(PASSWORD)) leaks.push(`adresse : ${r.url()}`);
  });
  page.on("response", async (r) => {
    if (!r.url().startsWith(BASE)) return;
    const body = await r.text().catch(() => "");
    if (SECRETS.test(body)) leaks.push(`${r.url()} : ${body.match(SECRETS)[0]}`);
    if (body.includes(PASSWORD)) leaks.push(`mot de passe dans ${r.url()}`);
    if (r.url().endsWith("/api/login") && /"token"/.test(body)) leaks.push("jeton de session dans la réponse de connexion");
  });
  await steps(page, context);
  await page.waitForTimeout(500);
  check(`${label} : aucune clé, aucun chemin interne, aucun mot de passe`, !leaks.length, leaks.join(" | "));
  check(`${label} : aucune violation de CSP`, !csp.length, csp.join(" | "));
  check(`${label} : aucune requête vers un tiers`, !external.length, external.join(" | "));
  return { context, page };
}

// Non connecté : l'écran de connexion s'affiche, rien de plus.
const anon = await visit("non connecté", async (page) => {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByLabel(/utilisateur|nom/i).first().waitFor({ timeout: 10000 });
});
const meta = await anon.page.locator('meta[name="robots"]').getAttribute("content");
check("balise robots dans la page", meta === "noindex, nofollow, noarchive", meta);
await anon.context.close();

// Connecté : la connexion, l'application, un aperçu, l'écran noVNC.
const logged = await visit("connecté", async (page, context) => {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByLabel(/utilisateur|nom/i).first().fill("alice");
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForResponse((r) => r.url().endsWith("/api/agents"), { timeout: 15000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  const cookie = (await context.cookies()).find((c) => c.name === "noah_session");
  check("cookie HttpOnly, SameSite=Lax", cookie?.httpOnly && cookie?.sameSite === "Lax", JSON.stringify({ httpOnly: cookie?.httpOnly, sameSite: cookie?.sameSite }));
  check("le cookie n'est pas lisible par le script", !(await page.evaluate(() => document.cookie)).includes("noah_session"));

  // L'aperçu : dans un cadre en bac à sable, son script tourne, avec une origine opaque.
  const link = await page.evaluate(async () => (await (await fetch("/api/agents/a1/apercu", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "app/page.html" }) })).json()).url);
  await page.evaluate((src) => { const f = document.createElement("iframe"); f.id = "essai-apercu"; f.src = src; f.sandbox = "allow-scripts allow-forms allow-popups allow-modals"; document.body.append(f); }, link);
  const preview = page.frameLocator("#essai-apercu").locator("#x");
  await preview.waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
  const said = await preview.textContent();
  check("aperçu en bac à sable : son script tourne, origine opaque", said === "script ok null", said);

  // Le vrai noVNC, avec l'adresse que donne le serveur : ses modules se chargent, le mot de passe reste hors de l'adresse.
  const screen = await page.evaluate(async () => (await (await fetch("/api/agents/a1/screen-url")).json()).url);
  check("mot de passe de l'écran hors de ce qui part au serveur", !screen.split("#")[0].includes("password"), screen.split("#")[0]);
  await page.evaluate((src) => { const f = document.createElement("iframe"); f.id = "essai-ecran"; f.src = src; document.body.append(f); }, screen);
  const novnc = page.frameLocator("#essai-ecran").locator("#noVNC_control_bar, #noVNC_status").first();
  await novnc.waitFor({ state: "attached", timeout: 10000 });
  const ready = await page.frameLocator("#essai-ecran").locator("html").evaluate((h) => h.className || "chargé", null).catch((e) => "");
  await page.waitForTimeout(1500);
  check("noVNC s'ouvre sous sa CSP", !!ready, ready);
});
await logged.context.close();
await browser.close();
console.log(failed ? `${failed} échec(s)` : "OK : aucune fuite dans le navigateur");
process.exit(failed ? 1 : 0);
