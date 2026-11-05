// Du clic au premier mot à l'écran, dans un vrai navigateur, sur la pile d'essai (compose.essai.yml, tests/real/vitesse.py pour le détail).
//   NOAH_URL=http://127.0.0.1:18090 NOAH_TOKEN=… NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/vitesse_ecran.mjs [tours]
// L'horloge est celle de la page : de la touche Entrée à la première image qui montre « Réflexion… », puis le premier mot de la réponse.
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL;
const TOKEN = process.env.NOAH_TOKEN;
const TOURS = Number(process.argv[2] || 8);
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.addCookies([{ name: "noah_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
await page.goto(BASE);
const composer = page.getByPlaceholder(/Écris à ton agent/).first();
await composer.waitFor({ timeout: 30000 }).catch(async (e) => {
  console.log("écran :", (await page.locator("body").innerText()).slice(0, 400));
  throw e;
});

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };
const rows = [];
for (let i = 0; i < TOURS; i++) {
  const word = `Bonjour${i}x${Date.now() % 1000}`;
  await composer.fill(`Réponds seulement : ${word}`);
  await page.evaluate((expected) => {
    const seen = (window.__mesure = { t0: 0, reflexion: 0, mot: 0 });
    const stamp = () => {
      if (!seen.t0) return;
      const text = document.body.innerText;
      if (!seen.reflexion && text.includes("Réflexion")) seen.reflexion = performance.now() - seen.t0;
      const count = text.split(expected).length - 1; // le message envoyé le contient une fois, la réponse une seconde
      if (!seen.mot && count >= 2) seen.mot = performance.now() - seen.t0;
    };
    new MutationObserver(stamp).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Enter" && !seen.t0) seen.t0 = performance.now(); }, { capture: true, once: true });
  }, word);
  await composer.press("Enter");
  await page.waitForFunction(() => window.__mesure.mot > 0, null, { timeout: 60000 }).catch(() => {});
  rows.push(await page.evaluate(() => {
    const m = window.__mesure;
    const posts = performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/chat") && e.startTime >= m.t0);
    m.post = posts[0] ? posts[0].startTime - m.t0 : null;
    m.reponse = posts[0] ? posts[0].responseStart - m.t0 : null;
    return m;
  }));
  await page.waitForTimeout(600);
}
console.log(rows.map((r) => `Réflexion ${Math.round(r.reflexion)} ms, POST parti ${Math.round(r.post ?? -1)} ms, premiers octets ${Math.round(r.reponse ?? -1)} ms, mot ${Math.round(r.mot)} ms`).join("\n"));
console.log(`médianes : « Réflexion » ${median(rows.map((r) => r.reflexion))} ms, premier mot ${median(rows.filter((r) => r.mot).map((r) => r.mot))} ms`);
await browser.close();
