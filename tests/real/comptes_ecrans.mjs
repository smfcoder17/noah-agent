// Comptes, dans un vrai navigateur, sur le vrai serveur et la vraie interface compilée, à largeur d'ordinateur puis de téléphone :
// code d'installation, mot de passe temporaire, confirmation par mot de passe et par courriel, profils, nouvel appareil. Chaque écran est
// capturé. Il faut frontend/dist (npm run build dans frontend) et Docker.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/comptes_ecrans.mjs <dossier des captures>
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(process.argv[2] || "captures-comptes");
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";

const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "ÉCHEC"} ${message}`);
  if (!ok) failures.push(message);
};

async function serve(name, port, mode) {
  try { docker("rm", "-f", name); } catch { /* rien à retirer */ }
  docker("run", "-d", "--name", name, "-p", `127.0.0.1:${port}:8080`, "-p", `127.0.0.1:${port + 1}:8081`, "-e", "PYTHONPATH=/app", "-e", `COMPTES_MODE=${mode}`,
    "-v", `${resolve(ROOT, "server")}:/app`, "-v", `${resolve(ROOT, "frontend/dist")}:/web:ro`, "-v", `${resolve(ROOT, "tests")}:/tests:ro`,
    "--entrypoint", "python", "ghcr.io/smfcoder17/noah-server:edge", "/tests/real/comptes_serveur.py");
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/api/status`).then((r) => r.ok).catch(() => false)) break;
    if (i > 80) throw new Error(`le serveur ne répond pas : ${docker("logs", "--tail", "30", name)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return base;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const SIZES = [["ordinateur", { width: 1200, height: 900 }], ["telephone", { width: 390, height: 844 }]];
let run = 0;

try {
  for (const [label, viewport] of SIZES) {
    const stem = (n) => `${OUT}/${label}-${n}.png`;
    const newPage = async (base, ip) => {
      const context = await browser.newContext({ viewport, locale: "fr-FR", extraHTTPHeaders: ip ? { "X-Forwarded-For": ip } : {} });
      const page = await context.newPage();
      await page.goto(base);
      return page;
    };
    const overflow = async (page, what) => {
      const wide = await page.evaluate(() => {
        const limit = document.documentElement.clientWidth;
        return [...document.querySelectorAll("[role=dialog] *, [role=alertdialog] *, form *")]
          .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > limit + 1 && !e.closest("[role=tablist]") && !e.closest("code"))
          .slice(0, 3).map((e) => `${e.tagName}.${String(e.className).slice(0, 40)}`);
      });
      check(!wide.length, `${label} : rien ne dépasse à droite (${what}) ${wide.join(" ; ")}`);
    };
    run += 10;

    // 1. Sans compte, sans le lien : le code est demandé, et l'écran dit où le lire.
    let name = `noah-essai-comptes-${run}`;
    let base = await serve(name, 18700 + run, "vide");
    let page = await newPage(base);
    await page.locator("#installation").waitFor({ timeout: 20000 });
    const home = await page.locator("body").innerText();
    check(/docker logs noah-server/.test(home) && /View logs/.test(home), `${label} : sans le lien, le code est demandé et l'écran dit où le trouver`);
    await page.screenshot({ path: stem("1-code-installation") });
    await overflow(page, "code d'installation");
    await page.locator("#installation").fill("BCDFGHJKLMNQ");
    await page.getByRole("button", { name: "Continuer" }).click();
    await page.getByText("Code d'installation incorrect").waitFor();
    check(true, `${label} : un faux code est refusé`);
    await page.context().close();
    docker("rm", "-f", name);

    // 2. Premier compte choisi au déploiement : un nouveau mot de passe avant toute autre chose.
    name = `noah-essai-comptes-${run + 1}`;
    base = await serve(name, 18700 + run + 3, "temporaire");
    page = await newPage(base);
    await page.locator("#username").fill("patronne");
    await page.locator("#password").fill("provisoire-tres-long");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.locator("#temporary-password").waitFor({ timeout: 20000 });
    await page.screenshot({ path: stem("2-mot-de-passe-temporaire") });
    await overflow(page, "mot de passe temporaire");
    await page.locator("#temporary-password").fill("provisoire-tres-long");
    await page.locator("#new-password").fill("mon-vrai-mot-de-passe");
    await page.locator("#new-password-again").fill("mon-vrai-mot-de-passe");
    await page.getByRole("button", { name: "Enregistrer et continuer" }).click();
    await page.locator("#temporary-password").waitFor({ state: "detached", timeout: 15000 });
    await page.waitForTimeout(800);
    check(!(await page.locator("#temporary-password").count()), `${label} : mot de passe changé, l'assistant continue`);
    await page.screenshot({ path: stem("3-apres-mot-de-passe") });
    await page.context().close();
    docker("rm", "-f", name);

    // 3. Propriétaire et profil : Réglages > Sécurité, Profils.
    name = `noah-essai-comptes-${run + 2}`;
    base = await serve(name, 18700 + run + 6, "");
    const box = `http://127.0.0.1:${18700 + run + 7}/`;
    const lastCode = async (to) => {
      const mails = await fetch(box).then((r) => r.json());
      const found = mails.reverse().find((m) => m.vers === to);
      return found.sujet.match(/(\d{6})/)[1];
    };
    page = await newPage(base, "203.0.113.5");
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill("motdepasse-a");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("button", { name: /Ouvrir le menu|Réglages/ }).first().waitFor({ timeout: 20000 });
    const openSettings = async (tab) => {
      if (viewport.width < 768) await page.getByRole("button", { name: "Ouvrir le menu" }).click();
      await page.getByRole("button", { name: /Réglages/ }).first().click();
      await page.getByRole("tab", { name: tab }).click();
    };
    await openSettings("Sécurité");
    const panel = page.getByRole("dialog").first();
    await page.locator("#smtp-hote").waitFor();
    await page.screenshot({ path: stem("4-securite"), fullPage: false });
    await overflow(page, "Réglages > Sécurité");
    await page.locator("#smtp-hote").fill("localhost");
    await page.locator("#smtp-port").fill("2525");
    await page.locator("#smtp-utilisateur").fill("noah");
    await page.locator("#smtp-password").fill("mot-de-passe-du-courriel");
    await page.locator("#smtp-expediteur").fill("noah@exemple.test");
    await page.locator("#smtp-expediteur").scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("5-reglage-envoi") });
    await panel.getByRole("button", { name: "Enregistrer" }).click();
    await page.getByText("Enregistré. Envoie un essai").waitFor();
    await page.locator("#smtp-trial").fill("essai@exemple.test");
    await panel.getByRole("button", { name: "Envoyer un essai" }).click();
    await page.getByText(/Essai parti|L'essai n'est pas parti/).waitFor();
    const said = await page.getByText(/Essai parti|L'essai n'est pas parti/).innerText();
    check(said.includes("Essai parti vers essai@exemple.test"), `${label} : réglage enregistré, essai parti : ${said}`);
    await page.locator("#smtp-trial").scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("6-essai-parti") });
    await page.locator("#mail-address").fill("alice@exemple.test");
    await panel.getByRole("button", { name: "Envoyer un code à cette adresse" }).click();
    await page.locator("#mail-activation").waitFor();
    await page.locator("#mail-activation").scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("7-activer-adresse") });
    await overflow(page, "activer l'adresse");
    await page.locator("#mail-activation").fill(await lastCode("alice@exemple.test"));
    await panel.getByRole("button", { name: "Activer", exact: true }).click();
    await page.getByText("Adresse active").waitFor();
    check(true, `${label} : adresse activée avec le code reçu`);

    // Une action critique : la fenêtre demande le code reçu par courriel.
    await page.getByRole("tab", { name: "Profils" }).click();
    await page.locator("li[data-profil=nina]").waitFor();
    await page.screenshot({ path: stem("8-profils") });
    await overflow(page, "Profils");
    const nina = page.locator("li[data-profil=nina]");
    await nina.getByRole("button", { name: "Appareils" }).click();
    await nina.getByText("Téléphone de Nina").waitFor();
    await nina.scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("9-appareils-du-profil") });
    await overflow(page, "appareils d'un profil");
    await nina.getByRole("button", { name: "Déconnecter Téléphone de Nina" }).click();
    await nina.getByText("Téléphone de Nina").waitFor({ state: "detached", timeout: 15000 });
    check(true, `${label} : appareil du profil coupé (mot de passe saisi il y a moins de 15 minutes)`);
    await nina.getByRole("button", { name: "Mot de passe" }).click();
    await page.locator(`li[data-profil=nina] input[type=password]`).fill("temporaire-nina");
    await nina.scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("10-reinitialiser") });
    await nina.getByRole("button", { name: "Réinitialiser son mot de passe" }).click();
    await page.locator("#proof-mail").waitFor();
    await page.screenshot({ path: stem("11-code-recu-par-courriel") });
    await overflow(page, "code reçu par courriel");
    await page.locator("#proof-mail").fill("000000");
    await page.getByRole("button", { name: "Confirmer" }).click();
    await page.getByText("Ce code est faux").waitFor();
    await page.screenshot({ path: stem("12-code-faux") });
    check(true, `${label} : un faux code est refusé dans la fenêtre, qui reste ouverte`);
    await page.locator("#proof-mail").fill(await lastCode("alice@exemple.test"));
    await page.getByRole("button", { name: "Confirmer" }).click();
    await nina.getByText("Mot de passe réinitialisé").waitFor({ timeout: 15000 });
    await nina.scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("13-reinitialise") });
    check(true, `${label} : mot de passe réinitialisé après le code`);

    // Réglages > Appareils : déconnecter tous les autres demande le code.
    await page.keyboard.press("Escape");

    // 4. Nouvel appareil : l'écran apparaît à l'ouverture, sans rien en mémoire dans le navigateur.
    const other = await newPage(base, "198.51.100.23");
    await other.locator("#username").fill("alice");
    await other.locator("#password").fill("motdepasse-a");
    await other.getByRole("button", { name: "Se connecter" }).click();
    await other.getByRole("button", { name: /Ouvrir le menu|Réglages/ }).first().waitFor({ timeout: 20000 });
    await page.reload();
    await page.getByText("Nouvel appareil sur ton compte").waitFor({ timeout: 15000 });
    const shown = await page.locator("[role=alertdialog]").innerText();
    check(/198\.51\.100\.23/.test(shown) && /Jamais vu/.test(shown), `${label} : l'écran donne l'appareil, l'adresse, le réseau et la date`);
    await page.screenshot({ path: stem("14-nouvel-appareil") });
    await overflow(page, "nouvel appareil");
    check(!(await other.getByText("Nouvel appareil sur ton compte").isVisible()), `${label} : pas sur l'appareil lui-même`);
    await page.getByRole("button", { name: "Ce n'est pas moi" }).click();
    await page.getByText("Cet appareil est déconnecté").waitFor();
    await page.screenshot({ path: stem("15-ce-n-est-pas-moi") });
    const status = await other.evaluate(() => fetch("/api/me").then((r) => r.status));
    check(status === 401, `${label} : la session signalée est coupée`);
    await page.getByRole("button", { name: "Changer mon mot de passe" }).click();
    await page.getByRole("tab", { name: "Sécurité" }).waitFor();
    await page.getByText("Changer mon mot de passe").first().waitFor();
    check(true, `${label} : l'écran mène au changement de mot de passe`);
    await page.screenshot({ path: stem("16-changer-mot-de-passe") });
    await page.getByRole("tab", { name: "Appareils" }).click();
    await page.getByText("Appareils connectés").first().waitFor();
    await page.getByText("Appareils connectés").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: stem("17-appareils") });
    await overflow(page, "Réglages > Appareils");
    await other.context().close();

    // 5. Depuis une session sans preuve récente : la fenêtre demande le mot de passe (jeton volé : il n'en sait rien).
    const stolen = await browser.newContext({ viewport, locale: "fr-FR" });
    const tokenPage = await stolen.newPage();
    const made = docker("exec", name, "python", "-c",
      "import os,glob;os.environ['NOAH_DATA_DIR']=glob.glob('/tmp/tmp*/noah.db')[0].rsplit('/',1)[0];os.environ.setdefault('LAUNCHER_KEY','x');os.environ.setdefault('NOAH_SECRET_KEY','y'*32);import sys;sys.path.insert(0,'/app');from noah import auth;print(auth.new_session(1,'Sans preuve','web','203.0.113.5'))").trim().split("\n").pop();
    await stolen.addCookies([{ name: "noah_session", value: made, url: base }]);
    await tokenPage.goto(base);
    const dismiss = tokenPage.getByRole("alertdialog").getByRole("button", { name: "Fermer", exact: true });
    await tokenPage.getByRole("button", { name: /Ouvrir le menu|Réglages/ }).first().waitFor({ timeout: 20000 });
    await tokenPage.waitForTimeout(800);
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    if (viewport.width < 768) await tokenPage.getByRole("button", { name: "Ouvrir le menu" }).click();
    await tokenPage.getByRole("button", { name: /Réglages/ }).first().click();
    await tokenPage.getByRole("tab", { name: "Appareils" }).click();
    tokenPage.on("dialog", (d) => d.accept());
    await tokenPage.getByRole("button", { name: "Déconnecter tous les autres appareils" }).click();
    await tokenPage.locator("#proof-password").waitFor();
    await tokenPage.screenshot({ path: stem("18-confirme-que-c-est-toi") });
    await overflow(tokenPage, "fenêtre de preuve");
    await tokenPage.locator("#proof-password").fill("mauvais-mot-de-passe");
    await tokenPage.getByRole("button", { name: "Confirmer" }).click();
    await tokenPage.getByText("Mot de passe ou code incorrect").waitFor();
    await tokenPage.screenshot({ path: stem("19-mauvais-mot-de-passe") });
    check(true, `${label} : sans preuve récente, déconnecter les autres demande le mot de passe, et un faux est refusé`);
    await tokenPage.getByRole("button", { name: "Annuler" }).click();
    await stolen.close();
    await page.context().close();
    docker("rm", "-f", name);
  }
} finally {
  await browser.close();
  for (const line of docker("ps", "-a", "--filter", "name=noah-essai-comptes-", "--format", "{{.Names}}").split("\n").filter(Boolean)) docker("rm", "-f", line);
}
console.log(failures.length ? `\n${failures.length} échec(s)` : "\nécrans des comptes : tout est vert");
process.exit(failures.length ? 1 : 0);
