// J2 et G3 : la vraie app de bureau, installée depuis l'installateur de la CI, reliée à un vrai serveur, puis une conversation.
// D'abord le flux navigateur (G3.1), avec un navigateur à part déjà connecté au compte. Puis la liaison par code, avec un mauvais nombre.
// Il faut un serveur où tourne un agent dont le modèle répète « Réponds seulement : X » (tests/real/faux_modele.py convient).
// Les réglages de l'app restent dans un dossier d'essai.
//     NOAH_URL=https://… NOAH_TOKEN=… NOAH_BUREAU="…/Noah Agent.exe" NOAH_DOSSIER=… NOAH_PLAYWRIGHT=… node tests/real/bureau_vps.mjs
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL;
const TOKEN = process.env.NOAH_TOKEN;
const DIR = process.env.NOAH_DOSSIER;
const { _electron: electron, chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
mkdirSync(DIR, { recursive: true });
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const open = async () => {
  const app = await electron.launch({ executablePath: process.env.NOAH_BUREAU, args: [`--user-data-dir=${DIR}/profil`] });
  return { app, page: await app.firstWindow() };
};

// Le jeton d'appareil ne doit se trouver en clair dans aucun fichier du profil (G3.3).
const inClear = (dir, needle) => readdirSync(dir).flatMap((name) => {
  const path = `${dir}/${name}`;
  try {
    if (statSync(path).isDirectory()) return inClear(path, needle);
    return readFileSync(path).includes(needle) ? [path] : [];
  } catch {
    return []; // fichier tenu ouvert par l'app
  }
});

const t0 = Date.now();
let { app, page } = await open();
try {
  await page.waitForSelector("#remote", { timeout: 30000 });
  await page.screenshot({ path: `${DIR}/bureau-accueil.png` });
  await page.click("#remote");
  await page.fill("#server", BASE);

  // G3.1 : flux navigateur. Le navigateur du système est remplacé par un navigateur d'essai, connecté par le jeton du test.
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => void global.__opened.push(url);
  });
  check("aucun champ de mot de passe dans l'app", (await page.locator("input[type=password]").count()) === 0);
  await page.click("#go");
  let opened = "";
  for (let i = 0; i < 40 && !opened; i++) {
    opened = (await app.evaluate(() => global.__opened[0] || "")) || "";
    await page.waitForTimeout(250);
  }
  check("le flux ouvre le navigateur sur le serveur", opened.startsWith(BASE), opened.slice(0, 60));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.addCookies([{ name: "apollo_session", value: TOKEN, url: BASE }]);
  const web = await context.newPage();
  await web.goto(opened);
  const accept = web.getByRole("button", { name: /Autoriser/ }).first();
  check("le navigateur demande d'autoriser cet appareil", await accept.waitFor({ timeout: 30000 }).then(() => true, () => false));
  const shown = ((await web.locator("body").innerText()).match(/\b\d{3}\b/) || [])[0];
  await web.screenshot({ path: `${DIR}/bureau-navigateur.png` });
  check("il affiche le nombre à recopier", !!shown, shown);
  await accept.click();
  await web.waitForTimeout(1500);
  await page.fill("#number", shown || "");
  await page.getByPlaceholder(/Écris à ton agent/).first().waitFor({ timeout: 60000 }).then(
    () => check("flux navigateur : l'app arrive sur le compte", true, `${((Date.now() - t0) / 1000).toFixed(0)} s`),
    () => check("flux navigateur : l'app arrive sur le compte", false),
  );
  await browser.close();
  // Oublier ce serveur, puis passer à la liaison par code.
  await app.close();
  const { rmSync } = await import("node:fs");
  rmSync(`${DIR}/profil`, { recursive: true, force: true });
  ({ app, page } = await open());
  await page.waitForSelector("#remote", { timeout: 30000 });
  await page.click("#remote");
  await page.fill("#server", BASE);
  await page.click("#toggle");
  // L'accord se donne depuis un appareil déjà relié, avec le nombre que l'ordinateur affiche. Un mauvais nombre annule la demande.
  const ask = async () => {
    const { code } = await api("POST", "/api/pairing");
    await page.fill("#code", code);
    await page.click("#go");
    await page.waitForFunction(() => /\b\d{3}\b/.test(document.getElementById("go")?.textContent || ""), null, { timeout: 30000 });
    const number = (await page.textContent("#go")).match(/\b\d{3}\b/)[0];
    const { demandes } = await api("GET", "/api/pairing/pending");
    return { number, id: demandes[0].id };
  };
  const first = await ask();
  await page.screenshot({ path: `${DIR}/bureau-nombre.png` });
  const refused = await api("POST", `/api/pairing/flow/${first.id}/autoriser`, { verification: first.number === "111" ? "222" : "111" });
  check("un mauvais nombre est refusé", refused.ok !== true);
  const said = await page.waitForFunction(() => document.getElementById("error")?.textContent.trim(), null, { timeout: 20000 }).then((h) => h.jsonValue(), () => "");
  check("et l'app le dit", !!said, String(said).slice(0, 100));
  const second = await ask();
  const allowed = await api("POST", `/api/pairing/flow/${second.id}/autoriser`, { verification: second.number });
  check("le bon nombre autorise cet ordinateur", allowed.ok === true);

  const box = page.getByRole("textbox", { name: /agent/i }).or(page.getByPlaceholder(/Écris à ton agent/)).first();
  check("l'app s'ouvre sur le compte du serveur", await box.waitFor({ timeout: 60000 }).then(() => true, () => false), `${((Date.now() - t0) / 1000).toFixed(0)} s depuis le lancement`);
  check("elle affiche bien le serveur", page.url().startsWith(BASE), page.url().slice(0, 60));

  const mark = Date.now() % 100000;
  await box.fill(`Réponds seulement : Bureau ${mark}`);
  await box.press("Enter");
  check("conversation avec l'agent du serveur", await page.getByText(`Bureau ${mark}`).nth(1).waitFor({ timeout: 60000 }).then(() => true, () => false));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${DIR}/bureau-conversation.png` });

  // Rouvrir l'app : elle reste reliée, sans rien redemander.
  await app.close();
  ({ app, page } = await open());
  check("après réouverture, elle reste reliée", await page.getByPlaceholder(/Écris à ton agent/).first().waitFor({ timeout: 60000 }).then(() => true, () => false));
  check("et la conversation est là", await page.getByText(`Bureau ${mark}`).first().waitFor({ timeout: 30000 }).then(() => true, () => false));
  await page.screenshot({ path: `${DIR}/bureau-reouverte.png` });

  // G3.3 : le jeton de cet appareil, lu dans l'app, n'est écrit en clair nulle part dans son profil.
  const cookie = await app.evaluate(async ({ session }, url) => (await session.defaultSession.cookies.get({ url, name: "apollo_session" }))[0]?.value, BASE);
  check("l'app a bien un jeton d'appareil", !!cookie && cookie !== TOKEN);
  const config = JSON.parse(readFileSync(`${DIR}/profil/config.json`, "utf8"));
  check("il est chiffré dans ses réglages", typeof config.jeton === "string" && !Buffer.from(config.jeton, "base64").includes(cookie));
  await app.close();
  const found = inClear(`${DIR}/profil`, cookie);
  check("jeton en clair nulle part dans le profil", found.length === 0, found.join(", ").slice(0, 200));
  ({ app, page } = await open());

  // G3.6 : le serveur coupe et revient. L'app reprend seule, sans redemander la liaison. Le test attend que quelqu'un le redémarre.
  if (process.env.NOAH_COUPURE) {
    const box2 = page.getByPlaceholder(/Écris à ton agent/).first();
    await box2.waitFor({ timeout: 60000 });
    console.log("COUPE MAINTENANT :", process.env.NOAH_COUPURE);
    const alive = async () => (await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(4000) }).catch(() => null))?.ok;
    while (await alive()) await page.waitForTimeout(1000);
    console.log("serveur coupé");
    while (!(await alive())) await page.waitForTimeout(1000);
    const back = Date.now();
    console.log("serveur revenu");
    const m2 = Date.now() % 100000;
    let answered = false;
    while (!answered && Date.now() - back < 120_000) {
      await box2.fill(`Réponds seulement : Retour ${m2}`);
      await box2.press("Enter");
      answered = await page.getByText(`Retour ${m2}`).nth(1).waitFor({ timeout: 15000 }).then(() => true, () => false);
    }
    check("après la coupure, l'app reprend sans redemander la liaison", answered && !(await page.locator("#remote").count()), `${((Date.now() - back) / 1000).toFixed(0)} s après le retour`);
    await page.screenshot({ path: `${DIR}/bureau-apres-coupure.png` });
  }
} catch (e) {
  console.log("ÉCHEC", String(e).slice(0, 400));
  bad.push("exception");
  await page.screenshot({ path: `${DIR}/bureau-erreur.png` }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}
if (bad.length) process.exit(1);
console.log("OK");
