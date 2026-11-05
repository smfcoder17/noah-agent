// J2 et G3 : la vraie app de bureau reliée à un vrai serveur, puis une conversation.
// D'abord le flux navigateur (G3.1), avec un navigateur à part déjà connecté au compte. Puis la liaison par code, avec un mauvais
// nombre. Conversation, écrire pendant le travail, relance, jeton (G3.3), lien de QR ouvert dans la fenêtre, coupure du serveur (G3.6).
// Serveur : l'agent répète « Réponds seulement : X » (faux_modele.py sur un VPS, ou bureau_serveur.py en local, qui capture le trafic).
// Les réglages de l'app restent dans un dossier d'essai.
//     NOAH_URL=https://… NOAH_TOKEN=… NOAH_BUREAU="…/Noah Agent.exe" NOAH_DOSSIER=… NOAH_PLAYWRIGHT=… node tests/real/bureau_vps.mjs
// Coupure jouée par le test : NOAH_COUPER="docker stop x" NOAH_RELANCER="docker start x". Avec NOAH_COUPURE=<message> seul, il
// attend que quelqu'un coupe et relance le serveur. Sans aucun des deux, pas de coupure. NOAH_TRAFIC=1 : le serveur est bureau_serveur.py.
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL;
const TOKEN = process.env.NOAH_TOKEN;
const DIR = process.env.NOAH_DOSSIER;
const { _electron: electron, chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
mkdirSync(DIR, { recursive: true });
const PROFILE = `${DIR}/profil`;
rmSync(PROFILE, { recursive: true, force: true }); // chaque essai part d'une app jamais reliée
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
const api = async (method, path, body, token = TOKEN) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const open = async () => {
  const app = await electron.launch({ executablePath: process.env.NOAH_BUREAU, args: [`--user-data-dir=${PROFILE}`] });
  return { app, page: await app.firstWindow() };
};
const traffic = async () => (process.env.NOAH_TRAFIC ? (await fetch(`${BASE}/_essai/trafic`)).json() : []);
const composer = (page) => page.locator("[data-composer-input]").first();
const seen = (locator, timeout = 60000) => locator.waitFor({ timeout }).then(() => true, () => false);
const sessionCookie = (app, url = BASE) => app.evaluate(async ({ session }, u) => (await session.defaultSession.cookies.get({ url: u, name: "noah_session" }))[0] || null, url);

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
if (process.env.NOAH_TRAFIC) await fetch(`${BASE}/_essai/trafic`, { method: "POST" });
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
  await page.screenshot({ path: `${DIR}/bureau-attente-navigateur.png` });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.addCookies([{ name: "noah_session", value: TOKEN, url: BASE }]);
  const web = await context.newPage();
  await web.goto(opened);
  const accept = web.getByRole("button", { name: /Autoriser/ }).first();
  check("le navigateur demande d'autoriser cet appareil", await seen(accept, 30000));
  const shown = (await web.locator("b.font-mono").first().innerText()).trim(); // pas le premier nombre de la page : l'adresse IP en a aussi
  await web.screenshot({ path: `${DIR}/bureau-navigateur.png` });
  check("il affiche le nombre à recopier", !!shown, shown);
  await accept.click();
  await web.waitForTimeout(1500);
  await page.fill("#number", shown || "");
  check("flux navigateur : l'app arrive sur le compte", await seen(composer(page)), `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await browser.close();
  // Oublier ce serveur, puis passer à la liaison par code.
  await app.close();
  rmSync(PROFILE, { recursive: true, force: true });
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

  const box = composer(page);
  check("l'app s'ouvre sur le compte du serveur", await seen(box), `${((Date.now() - t0) / 1000).toFixed(0)} s depuis le lancement`);
  check("elle affiche bien le serveur", page.url().startsWith(BASE), page.url().slice(0, 60));
  await page.screenshot({ path: `${DIR}/bureau-compte.png` });

  const mark = Date.now() % 100000;
  await box.fill(`Réponds seulement : Bureau ${mark}`);
  await box.press("Enter");
  check("conversation avec l'agent du serveur", await seen(page.getByText(`Bureau ${mark}`).nth(1)));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${DIR}/bureau-conversation.png` });

  // Écrire pendant que l'agent travaille : la saisie reste ouverte, une question reçoit sa réponse, le travail continue.
  if (process.env.NOAH_TRAFIC) {
    await box.fill(`Travaille longtemps ${mark}`);
    await box.press("Enter");
    check("l'écran dit ce que l'agent fait", await seen(page.getByText("Cherche « prix du cuivre »").first(), 20000));
    check("la saisie reste ouverte pendant le travail", await box.isEnabled());
    await box.fill("Tu en es où ?");
    await box.press("Enter");
    check("une question pendant le travail a sa réponse", await seen(page.getByText("Là : ").first(), 20000));
    check("le bouton Arrêter reste là", await page.getByRole("button", { name: "Arrêter" }).isVisible());
    await page.screenshot({ path: `${DIR}/bureau-pendant-travail.png` });
    await fetch(`${BASE}/_essai/finir`, { method: "POST" });
    check("le travail se termine", await seen(page.getByText(`Travaille longtemps ${mark}`).nth(1), 20000));
  }

  // Rouvrir l'app : elle reste reliée, sans rien redemander.
  await app.close();
  ({ app, page } = await open());
  check("après réouverture, elle reste reliée", await seen(composer(page)));
  check("et la conversation est là", await seen(page.getByText(`Bureau ${mark}`).first(), 30000));
  await page.screenshot({ path: `${DIR}/bureau-reouverte.png` });

  // G3.3 : le jeton de cet appareil, lu dans l'app, n'est écrit en clair nulle part dans son profil, et il ne dure pas sur le disque.
  const cookie = await sessionCookie(app);
  check("l'app a bien un jeton d'appareil", !!cookie && cookie.value !== TOKEN);
  check("son cookie n'a pas de durée de vie", !!cookie?.session && !cookie?.expirationDate);
  const config = JSON.parse(readFileSync(`${PROFILE}/config.json`, "utf8"));
  check("il est chiffré dans ses réglages", typeof config.jeton === "string" && !Buffer.from(config.jeton, "base64").includes(cookie.value));
  await app.close();
  const found = inClear(PROFILE, cookie.value);
  check("jeton en clair nulle part dans le profil", found.length === 0, found.join(", ").slice(0, 200));
  const stored = inClear(PROFILE, "noah_session").filter((f) => /Cookies/.test(f));
  check("aucun cookie de session dans la base de cookies", stored.length === 0, stored.join(", ").slice(0, 200));
  ({ app, page } = await open());
  await composer(page).waitFor({ timeout: 60000 });

  // Lien de QR de type web ouvert dans la fenêtre : jamais le cookie de 30 jours d'un navigateur.
  const { adresse } = await api("POST", "/api/pairing");
  await page.evaluate((url) => {
    location.href = url;
    location.reload();
  }, adresse);
  const verification = await page.locator("p.font-mono").first().innerText({ timeout: 30000 }).catch(() => "");
  await page.screenshot({ path: `${DIR}/bureau-qr-dans-la-fenetre.png` });
  const { demandes } = await api("GET", "/api/pairing/pending");
  check("le QR dans la fenêtre demande un accord", demandes.length === 1 && !!verification);
  await api("POST", `/api/pairing/flow/${demandes[0]?.id}/autoriser`, { verification });
  check("il arrive sur le compte", await seen(composer(page), 30000));
  const fromQr = await sessionCookie(app);
  check("QR : cookie sans durée de vie", !!fromQr?.session && !fromQr?.expirationDate, JSON.stringify({ session: fromQr?.session, expire: fromQr?.expirationDate }));
  check("QR : session de fenêtre, elle ne fabrique pas d'accès durable", (await api("POST", "/api/pairing", undefined, fromQr?.value)).status === 403);
  await app.close();
  check("QR : pas dans le profil", inClear(PROFILE, fromQr.value).length === 0);
  ({ app, page } = await open());
  await composer(page).waitFor({ timeout: 60000 });
  check("à la relance, l'app reprend son propre jeton", (await sessionCookie(app))?.value === cookie.value);

  // G3.1 : capture du trafic reçu par le serveur pendant tout ce qui précède.
  if (process.env.NOAH_TRAFIC) {
    const seenAll = await traffic();
    check("mot de passe du compte absent de tout le trafic", seenAll.length > 50 && !seenAll.some((r) => r.mdp), `${seenAll.length} requêtes`);
    check("aucune connexion par mot de passe", !seenAll.some((r) => r.p === "/api/login"));
    const windowed = seenAll.filter((r) => /Electron\//.test(r.ua));
    const plain = windowed.filter((r) => !/NoahApp\/\S+ Desktop$/.test(r.ua));
    check("la fenêtre s'annonce comme l'app", windowed.length > 0 && plain.length === 0, `${windowed.length} requêtes ; sans l'annonce : ${[...new Set(plain.map((r) => `${r.m} ${r.p}`))].join(", ").slice(0, 400)}`);
  }

  // G3.6 : le serveur coupe et revient. L'app reprend seule en moins de 30 s, sans redemander la liaison, sans qu'on touche à rien.
  const cut = process.env.NOAH_COUPER;
  if (cut || process.env.NOAH_COUPURE) {
    const alive = async () => (await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(4000) }).catch(() => null))?.ok;
    const outage = async () => {
      if (cut) execSync(cut, { stdio: "ignore" });
      else console.log("COUPE MAINTENANT :", process.env.NOAH_COUPURE);
      while (await alive()) await page.waitForTimeout(1000);
    };
    const comeBack = async () => {
      if (process.env.NOAH_RELANCER) execSync(process.env.NOAH_RELANCER, { stdio: "ignore" });
      while (!(await alive())) await page.waitForTimeout(500);
      return Date.now();
    };
    const answers = async (back) => {
      const mark2 = Date.now() % 100000;
      await composer(page).fill(`Réponds seulement : Retour ${mark2}`);
      await composer(page).press("Enter");
      const ok = await seen(page.getByText(`Retour ${mark2}`).nth(1), 30000);
      return { ok, seconds: (Date.now() - back) / 1000 };
    };
    const devicesBefore = (await api("GET", "/api/devices")).appareils?.length;

    // 1. Fenêtre ouverte pendant la coupure.
    await composer(page).waitFor({ timeout: 60000 });
    await outage();
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${DIR}/bureau-pendant-coupure.png` });
    let back = await comeBack();
    await page.waitForTimeout(500);
    const open1 = await answers(back);
    check("fenêtre ouverte : l'app répond après le retour, en moins de 30 s", open1.ok && open1.seconds < 30, `${open1.seconds.toFixed(1)} s après le retour`);
    check("elle ne redemande pas la liaison", !(await page.locator("#remote").count()) && !!(await sessionCookie(app)));
    await page.screenshot({ path: `${DIR}/bureau-apres-coupure.png` });

    // 2. Rechargement pendant la coupure : l'écran d'attente, puis retour seul sur le compte.
    await outage();
    await page.reload().catch(() => {});
    const waiting = await page.waitForFunction(() => /Reconnexion|ne répond pas|Nouvel essai/.test(document.body.innerText), null, { timeout: 30000 }).then(() => true, () => false);
    await page.screenshot({ path: `${DIR}/bureau-attente-reconnexion.png` });
    check("rechargée pendant la coupure : l'écran dit qu'elle se reconnecte", waiting, (await page.locator("body").innerText().catch(() => "")).slice(0, 120));
    back = await comeBack();
    const reloaded = await seen(composer(page), 30000);
    check("et revient seule sur le compte en moins de 30 s", reloaded, `${((Date.now() - back) / 1000).toFixed(1)} s après le retour`);

    // 3. App lancée pendant la coupure.
    await app.close();
    await outage();
    ({ app, page } = await open());
    await page.waitForFunction(() => /ne répond pas/.test(document.body.innerText), null, { timeout: 40000 }).catch(() => {});
    await page.screenshot({ path: `${DIR}/bureau-lancee-pendant-coupure.png` });
    back = await comeBack();
    const launched = await seen(composer(page), 30000);
    check("lancée pendant la coupure : elle arrive sur le compte en moins de 30 s", launched, `${((Date.now() - back) / 1000).toFixed(1)} s après le retour`);
    const open3 = await answers(back);
    check("et la conversation reprend", open3.ok);
    check("aucune nouvelle liaison sur le serveur", (await api("GET", "/api/devices")).appareils?.length === devicesBefore, `${devicesBefore} appareils`);
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
