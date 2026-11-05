// Ce que la personne voit et comprend, dans un vrai navigateur, sur le vrai serveur et la vraie interface compilée : QR volé
// avant elle, lien d'un autre compte, connexion forcée par une page étrangère, alerte de nouvel appareil, page d'accord du
// bureau. Il faut frontend/dist (npm run build dans frontend) et Docker.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/pairing/attaques_navigateur.mjs [dossier des captures]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2] ? resolve(process.argv[2]) : null;
if (OUT) mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";

const NAME = "noah-essai-qr-attaques";
const PORT = 18654;
const EVIL_PORT = 18655;
const BASE = `http://127.0.0.1:${PORT}`;
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const check = (ok, message) => {
  if (!ok) throw new Error(message);
  console.log("ok  ", message);
};
const json = { "Content-Type": "application/json" };
const shot = async (page, name) => {
  if (OUT) await page.screenshot({ path: `${OUT}/${name}.png` });
};

try { docker("rm", "-f", NAME); } catch { /* rien à retirer */ }
docker("run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:8080`, "-e", "PYTHONPATH=/app", "-e", "QR_SECONDES=600",
  "-v", `${resolve(ROOT, "server")}:/app`, "-v", `${resolve(ROOT, "frontend/dist")}:/web:ro`, "-v", `${resolve(ROOT, "tests")}:/tests:ro`,
  "--entrypoint", "python", "ghcr.io/smfcoder17/noah-server:edge", "/tests/pairing/attaques_serveur.py");

// La page étrangère : même machine, autre port. Même « site » pour le navigateur, comme un voisin de sous-domaine, le cas
// le plus dur pour le cookie SameSite=Lax.
const evil = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Page étrangère</title><p>Gagne un cadeau</p>");
}).listen(EVIL_PORT, "127.0.0.1");

const browser = await chromium.launch({ channel: "chrome" });
const signIn = async (who, password) => {
  const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: json, body: JSON.stringify({ username: who, password }) });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return { cookie, value: cookie.split("=")[1] };
};
const screenFor = async ({ value }, viewport = { width: 1100, height: 760 }) => {
  const context = await browser.newContext({ viewport, locale: "fr-FR" });
  await context.addCookies([{ name: "noah_session", value, url: BASE }]);
  const page = await context.newPage();
  return { context, page };
};
const text = (page) => page.evaluate(() => document.body.innerText);
const settle = (page) => page.waitForFunction(() => document.body.innerText.length > 20 && !document.body.innerText.startsWith("Chargement"));

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${BASE}/api/status`).then((r) => r.ok).catch(() => false)) break;
    if (i > 60) throw new Error("le serveur ne répond pas : " + docker("logs", "--tail", "20", NAME));
    await new Promise((r) => setTimeout(r, 500));
  }
  const alice = await signIn("alice", "motdepasse-a");
  const bruno = await signIn("bruno", "motdepasse-b");
  const apiAs = (s) => async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { ...json, Cookie: s.cookie, Origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const asBruno = apiAs(bruno);

  // 1. L'écran d'origine : le QR s'affiche ; un voleur le scanne avant la personne.
  const origin = await screenFor(alice);
  await origin.page.goto(BASE);
  await settle(origin.page);
  await origin.page.getByRole("button", { name: "Réglages" }).click();
  await origin.page.getByRole("tab", { name: "Appareils" }).click({ timeout: 5000 });
  await origin.page.getByRole("button", { name: "Relier un appareil" }).click();
  await origin.page.getByText(/Valable encore/).waitFor();
  await shot(origin.page, "1-qr-affiche");
  const code = (await text(origin.page)).match(/[B-Z]{4}-[B-Z]{4}/)[0];
  const thief = await fetch(`${BASE}/api/pairing/claim`, { method: "POST", headers: json,
    body: JSON.stringify({ code, appareil: "iPhone de Franck", type: "android" }) }).then((r) => r.json());
  check(thief.attente && !thief.token, "QR volé : le voleur reçoit une demande en attente, pas une session");
  await origin.page.getByText("Un appareil a utilisé ton code").waitFor({ timeout: 8000 });
  await shot(origin.page, "2-ecran-origine-qr-vole");
  const seen = await text(origin.page);
  check(/iPhone de Franck/.test(seen) && /accès à rien/.test(seen) && /Sinon, refuse/.test(seen), "écran d'origine : nom de l'appareil, et la phrase dit qu'il n'a accès à rien");
  check(/demande faite/.test(seen), "écran d'origine : le moment de la demande est affiché");
  check(!/Valable encore/.test(seen) && !seen.includes(code), "écran d'origine : le code utilisé n'est plus affiché comme s'il valait encore");
  check(await origin.page.getByRole("button", { name: "Autoriser" }).isDisabled(), "écran d'origine : Autoriser reste grisé tant que le nombre n'est pas saisi");

  // La personne essaie son propre téléphone ensuite.
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, locale: "fr-FR" });
  const phonePage = await phone.newPage();
  await phonePage.goto(`${BASE}/#appairage=${code}`); // le même code, après le voleur (le QR n'existe qu'en HTTPS)
  await settle(phonePage);
  await phonePage.waitForTimeout(300);
  await shot(phonePage, "3-telephone-code-deja-servi");
  check(/déjà servi/.test(await text(phonePage)) && /refuse la demande/.test(await text(phonePage)), "téléphone de la personne : le code a déjà servi, et quoi faire si ce n'est pas elle");
  await phone.close();

  // Refus, puis l'écran propose un autre code.
  await origin.page.getByRole("button", { name: "Refuser" }).click();
  await origin.page.getByRole("button", { name: /Ce code a servi/ }).waitFor();
  check(true, "après refus : l'écran propose un autre code");

  // 2. Lien du compte de Bruno ouvert dans le navigateur connecté d'Alice : rien ne change.
  const brunoQr = await asBruno("POST", "/api/pairing", {});
  const tab = await origin.context.newPage();
  await tab.goto(brunoQr.body.adresse);
  await settle(tab);
  await tab.waitForTimeout(300);
  await shot(tab, "4-lien-autre-compte-navigateur-connecte");
  const seenTab = await text(tab);
  check(/déjà connecté/.test(seenTab) && /ignore-le/.test(seenTab), "lien d'un autre compte, navigateur connecté : refus clair à l'écran");
  const me = await tab.evaluate(() => fetch("/api/me").then((r) => r.json()));
  check(me.username === "alice", "la session d'Alice n'a pas bougé");
  await tab.close();

  // 3. Connexion forcée : Bruno a accepté sa demande, une page étrangère la fait récupérer par un navigateur sans session.
  const qrB = await asBruno("POST", "/api/pairing", {});
  const flow = await fetch(`${BASE}/api/pairing/claim`, { method: "POST", headers: json, body: JSON.stringify({ code: qrB.body.code }) }).then((r) => r.json());
  const pending = (await asBruno("GET", "/api/pairing/pending")).body.demandes[0];
  await asBruno("POST", `/api/pairing/flow/${pending.id}/autoriser`, { verification: flow.verification });
  const victim = await browser.newContext({ viewport: { width: 1000, height: 700 }, locale: "fr-FR" });
  const lure = await victim.newPage();
  await lure.goto(`http://127.0.0.1:${EVIL_PORT}/`);
  await lure.evaluate(async ({ url, sondage }) => {
    await fetch(url, { method: "POST", mode: "no-cors", credentials: "include", body: new Blob([JSON.stringify({ sondage })]) }).catch(() => {});
  }, { url: `${BASE}/api/pairing/flow/poll`, sondage: flow.sondage });
  await lure.waitForTimeout(300);
  check(!(await victim.cookies(BASE)).some((c) => c.name === "noah_session"), "page étrangère de même site : aucun cookie posé (fixation refusée)");
  await lure.evaluate(async ({ url }) => {
    await fetch(url, { method: "POST", mode: "no-cors", credentials: "include", body: new Blob([JSON.stringify({ username: "bruno", password: "motdepasse-b" })]) }).catch(() => {});
  }, { url: `${BASE}/api/login` });
  await lure.waitForTimeout(300);
  check(!(await victim.cookies(BASE)).some((c) => c.name === "noah_session"), "connexion forcée par une page étrangère : aucun cookie posé");
  await victim.close();

  // 4. Navigateur sans session, parcours complet : le nombre, l'accord, puis le compte relié dit à l'écran.
  const qrC = await asBruno("POST", "/api/pairing", {});
  const fresh = await browser.newContext({ viewport: { width: 390, height: 780 }, locale: "fr-FR" });
  const freshPage = await fresh.newPage();
  await freshPage.goto(qrC.body.adresse);
  await settle(freshPage);
  await freshPage.getByText(/Ne le donne à personne/).waitFor();
  await shot(freshPage, "5-nombre-sur-le-telephone");
  const number = (await text(freshPage)).match(/\b\d{3}\b/)[0];
  const asked = (await asBruno("GET", "/api/pairing/pending")).body.demandes[0];
  await asBruno("POST", `/api/pairing/flow/${asked.id}/autoriser`, { verification: number });
  await freshPage.getByText("Ce navigateur est relié").waitFor({ timeout: 8000 });
  await shot(freshPage, "6-compte-relie");
  check(/compte bruno/.test(await text(freshPage)), "après l'accord : l'écran dit à quel compte ce navigateur est relié");
  await freshPage.getByRole("button", { name: /Ce n'est pas mon compte/ }).click();
  await freshPage.waitForSelector("input[type=password]");
  check(true, "« Ce n'est pas mon compte » déconnecte et revient à la connexion");
  await fresh.close();

  // 5. Alerte de nouvel appareil sur l'écran déjà connecté : l'état est sur le serveur.
  await origin.page.reload();
  await settle(origin.page);
  check(!(await origin.page.getByText("Nouvel appareil sur ton compte").isVisible()), "pas de fausse alerte sans nouvel appareil");
  await signIn("alice", "motdepasse-a");
  await origin.page.reload();
  await origin.page.getByText("Nouvel appareil sur ton compte").waitFor({ timeout: 8000 });
  await shot(origin.page, "7-alerte-nouvel-appareil");
  check(true, "un nouvel appareil sur le compte s'affiche sur l'écran déjà connecté");
  await origin.page.getByRole("button", { name: "Ce n'est pas moi" }).first().click();
  await origin.page.getByRole("button", { name: "Plus tard" }).click();
  await origin.page.getByText("Nouvel appareil sur ton compte").waitFor({ state: "hidden", timeout: 8000 });
  check(true, "l'alerte permet de le déconnecter tout de suite");

  // 6. Flux du bureau : la demande d'un inconnu ouverte par un lien, la page d'accord telle que la personne la voit.
  const asked2 = await fetch(`${BASE}/api/pairing/flow`, { method: "POST", headers: { ...json, "X-Forwarded-For": "203.0.113.50" }, body: JSON.stringify({ appareil: "Ordinateur de Franck", type: "desktop" }) }).then((r) => r.json());
  const approval = await origin.context.newPage();
  await approval.goto(asked2.adresse);
  await approval.getByRole("dialog").waitFor({ timeout: 8000 });
  await shot(approval, "8-page-accord-bureau");
  const seen2 = await text(approval);
  check(/Ordinateur de Franck/.test(seen2) && /il ne prouve rien/.test(seen2), "page d'accord : le nom, et il est dit qu'il ne prouve rien");
  check(/Demande faite/.test(seen2) && /valable encore/.test(seen2), "page d'accord : âge et délai");
  check(/Ne le donne à personne/.test(seen2), "page d'accord : le nombre ne se donne à personne");
  await approval.close();
  console.log("attaques dans le navigateur : tout est vert");
} finally {
  await browser.close();
  evil.close();
  try { docker("rm", "-f", NAME); } catch { /* déjà retiré */ }
}
