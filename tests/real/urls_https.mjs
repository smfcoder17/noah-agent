// G5.1 dans un vrai navigateur : vrai serveur Noah (code du dépôt monté), vrai Caddy (réglages du compose du VPS, avec un
// certificat interne), vrai Chrome. Les adresses lues sont celles que la personne voit : journal du serveur, sortie de get.sh,
// barre d'adresse, Réglages > Appareils, QR code. Sans clé, sans agent, sans toucher à la pile Noah.
//     cd frontend && npm ci && npm run build && cd .. && NOAH_PLAYWRIGHT=… node tests/real/urls_https.mjs
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NOAH_PLAYWRIGHT || "playwright");
const qrcode = createRequire(join(ROOT, "frontend/package.json"))("qrcode-generator");
const IMAGE = process.env.NOAH_SERVER_IMAGE || "ghcr.io/smfcoder17/noah-server:edge";
const S = randomBytes(3).toString("hex");
const [SERVEUR, CADDY, RESEAU] = [`noah-g51-server-${S}`, `noah-g51-caddy-${S}`, `noah-g51-${S}`];
const [P_HTTP, P_HTTPS, P_DIRECT] = [18480, 18443, 18481];
const DOMAINE = "noah.test";
const MOT = randomBytes(12).toString("hex");
const NOM = `essai${S}`;

const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, detail);
  if (!ok) echecs.push(nom);
};
const docker = (...a) => {
  const r = spawnSync("docker", a, { encoding: "utf8", timeout: 240000, maxBuffer: 1 << 26 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
const must = (...a) => {
  const r = docker(...a);
  if (r.code !== 0) throw new Error(`docker ${a.slice(0, 2).join(" ")} : ${(r.err || r.out).slice(-500)}`);
  return r.out;
};
const dort = (ms) => new Promise((r) => setTimeout(r, ms));

/** Les réglages Caddy du VPS, tels quels, sauf l'émetteur : pas de Let's Encrypt pour un nom de test. */
function caddyfile() {
  const compose = readFileSync(join(ROOT, "deploy/docker-compose.yml"), "utf8");
  const bloc = compose.split("content: |\n")[1].split(/\nnetworks:/)[0].split("\n").map((l) => l.replace(/^ {6}/, "")).join("\n");
  const adapte = bloc.replace(/tls \{\s*on_demand\s*\}/, "tls internal {\n      on_demand\n    }");
  if (adapte === bloc) throw new Error("bloc tls introuvable dans le compose du VPS");
  return adapte;
}

const SECURE = /http:\/\/[^\s"'<>)]+/g;
/** Tout ce qui se voit ou se copie sur la page : texte, liens, champs. */
const adressesEnClair = (page) => page.evaluate(() => {
  const vus = [document.body.innerText];
  for (const e of document.querySelectorAll("a[href], input, textarea, [title], [aria-label]")) vus.push(e.getAttribute("href") || "", e.getAttribute("placeholder") || "", e.value || "", e.getAttribute("title") || "", e.getAttribute("aria-label") || "");
  return vus.join("\n");
}).then((t) => t.match(SECURE) || []);

async function ouvreAppareils(page) {
  await page.getByRole("button", { name: /^Réglages$/ }).first().click({ timeout: 30000 });
  await page.getByRole("tab", { name: "Appareils" }).click();
  const [retour] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/pairing") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Relier un appareil" }).click(),
  ]);
  await page.getByText(/Valable encore/).waitFor({ timeout: 10000 });
  return retour.json();
}
const svgQR = (page) => page.locator(".size-56 svg").count();

const tmp = mkdtempSync(join(tmpdir(), "noah-g51-"));
let navigateur;
try {
  must("network", "create", RESEAU);
  must("run", "-d", "--name", SERVEUR, "--network", RESEAU, "--network-alias", "server", "-p", `${P_DIRECT}:8080`,
    "-e", `NOAH_DOMAIN=${DOMAINE}`, "-e", "NOAH_SETUP_CODE=auto", "-e", "PYTHONDONTWRITEBYTECODE=1",
    "-v", `${join(ROOT, "server/noah")}:/app/noah:ro`, "-v", `${join(ROOT, "frontend/dist")}:/app/web:ro`, IMAGE);
  const cf = join(tmp, "Caddyfile");
  writeFileSync(cf, caddyfile());
  must("run", "-d", "--name", CADDY, "--network", RESEAU, "-p", `${P_HTTP}:80`, "-p", `${P_HTTPS}:443`, "-v", `${cf}:/etc/caddy/Caddyfile:ro`, "caddy:2.10-alpine");

  // 1. Le journal du serveur : c'est là que le Docker Manager de Hostinger envoie la personne.
  let journal = "";
  for (let i = 0; i < 90 && !/installation=/.test(journal); i++) {
    await dort(1000);
    const l = docker("logs", SERVEUR);
    journal = `${l.out}\n${l.err}`;
  }
  const lien = journal.match(/https?:\/\/\S+\?installation=(\w+)/);
  check("le journal donne un lien de création du compte", !!lien, lien ? "" : journal.slice(-300));
  if (!lien) throw new Error("pas de lien");
  check("ce lien est en HTTPS, sur le nom du serveur", lien[0].startsWith(`https://${DOMAINE}/`), lien[0].replace(lien[1], "…"));
  const clairs = journal.match(SECURE) || [];
  check("aucune adresse http:// dans le journal du serveur", clairs.length === 0, clairs.join(" "));

  // 2. Le vrai get.sh, sur ce vrai journal.
  writeFileSync(join(tmp, "journal.txt"), journal);
  const script = spawnSync("docker", ["run", "--rm", "-v", `${ROOT}:/depot:ro`, "-v", `${tmp}:/j:ro`, "alpine:3", "sh", "/depot/tests/pwa/sortie_scripts.sh", "/depot", "/j/journal.txt"], { encoding: "utf8", timeout: 120000 });
  const sortie = (script.stdout || "").split("=== install.sh")[0];
  check("get.sh, sur le journal réel, finit par le lien HTTPS", sortie.includes(lien[0]), sortie.trim().split("\n").pop().replace(lien[1], "…"));
  check("get.sh, sur le journal réel, ne montre aucun http://", !/http:\/\//.test(sortie));

  navigateur = await chromium.launch({ channel: "chrome", headless: true, args: [`--host-resolver-rules=MAP ${DOMAINE}:443 127.0.0.1:${P_HTTPS},MAP ${DOMAINE}:80 127.0.0.1:${P_HTTP}`] });

  // 3. L'adresse tapée sans https arrive en HTTPS ; le lien ouvre l'assistant en contexte sécurisé.
  const ctx = await navigateur.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`http://${DOMAINE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  check("http://nom redirige vers https://nom", page.url().startsWith(`https://${DOMAINE}/`), page.url());
  await page.goto(lien[0], { waitUntil: "domcontentloaded" });
  check("le lien s'ouvre en contexte sécurisé", await page.evaluate(() => isSecureContext && location.protocol === "https:"));
  await page.getByText("Bienvenue sur Noah Agent").waitFor({ timeout: 20000 });
  check("l'assistant ne montre aucune adresse http://", (await adressesEnClair(page)).length === 0);

  const cree = await page.evaluate(async ([username, password, installation]) => {
    const r = await fetch("/api/setup/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, installation }) });
    return r.status;
  }, [NOM, MOT, lien[1]]);
  check("le compte se crée par ce lien", cree === 200, String(cree));
  // L'essai du modèle n'est pas le sujet ici : on passe la fin de l'assistant.
  must("exec", SERVEUR, "python", "-c", "from noah import db; db.set_setting('onboarded', '1')");
  await page.goto(`https://${DOMAINE}/`, { waitUntil: "domcontentloaded" });

  // 4. HTTPS : QR code et adresse, tous deux en HTTPS. Le QR est comparé à celui de l'adresse attendue, module par module.
  const r = await ouvreAppareils(page);
  check("Appareils : l'API donne une adresse HTTPS", r.adresse.startsWith(`https://${DOMAINE}/#appairage=`) && r.serveur === `https://${DOMAINE}`, r.serveur);
  check("Appareils : l'adresse HTTPS se lit à l'écran", await page.getByText(`https://${DOMAINE}`, { exact: true }).isVisible());
  const attendu = qrcode(0, "M");
  attendu.addData(r.adresse);
  attendu.make();
  const dessin = attendu.createSvgTag({ cellSize: 6, margin: 2, scalable: true }).match(/ d="([^"]+)"/)?.[1];
  const affiche = await page.locator(".size-56 svg path").first().getAttribute("d").catch(() => null);
  check("Appareils : le QR code porte exactement cette adresse HTTPS", !!dessin && dessin === affiche);
  check("Appareils : aucune adresse http:// à l'écran", (await adressesEnClair(page)).length === 0);
  await ctx.close();

  // 5. Noah ouvert sans HTTPS : ce qu'on ne peut plus donner à un téléphone n'apparaît plus.
  const lan = Object.values(networkInterfaces()).flat().find((a) => a.family === "IPv4" && !a.internal && /^(192\.168\.|10\.)/.test(a.address))?.address;
  check("cette machine a une adresse sur le réseau local", !!lan, lan);
  const origines = [[`http://127.0.0.1:${P_DIRECT}`, true, "boucle locale"], [`http://localhost:${P_DIRECT}`, true, "localhost"], ...(lan ? [[`http://${lan}:${P_DIRECT}`, false, "IP du réseau local"]] : [])];
  for (const [origine, sur, nom] of origines) {
    const c = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
    // L'app de bureau d'une version d'avant répondrait ceci : l'adresse ne doit pas revenir par là.
    await c.addInitScript(() => {
      window.noahDesktop = {
        pickFolder: async () => null, openPath: async () => {},
        lanStatus: async () => ({ open: true, url: "http://192.168.1.50:8080" }), openLan: async () => ({ open: true, url: "http://192.168.1.50:8080" }),
      };
    });
    const p = await c.newPage();
    await p.goto(origine, { waitUntil: "domcontentloaded", timeout: 30000 });
    check(`${nom} : isSecureContext vaut ${sur}`, (await p.evaluate(() => isSecureContext)) === sur);
    const statut = await p.evaluate(async ([username, password]) => (await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) })).status, [NOM, MOT]);
    check(`${nom} : connexion`, statut === 200, String(statut));
    await p.reload({ waitUntil: "domcontentloaded" });
    await ouvreAppareils(p);
    const vues = await adressesEnClair(p);
    check(`${nom} : aucune adresse http:// à l'écran`, vues.length === 0, vues.join(" "));
    check(`${nom} : aucun QR code d'adresse http://`, (await svgQR(p)) === 0);
    check(`${nom} : la personne sait qu'il faut une adresse HTTPS`, await p.getByText(/pas en HTTPS/).isVisible());
    check(`${nom} : le bouton d'ouverture au Wi-Fi a disparu`, (await p.getByRole("button", { name: /Wi-Fi/ }).count()) === 0);
    await c.close();
  }
} catch (e) {
  check("le parcours est allé au bout", false, String(e.message || e).slice(0, 400));
} finally {
  if (navigateur) await navigateur.close();
  docker("rm", "-fv", SERVEUR);
  docker("rm", "-fv", CADDY);
  docker("network", "rm", RESEAU);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
}
console.log(echecs.length ? `\n${echecs.length} échec(s) :\n- ${echecs.join("\n- ")}` : "\nG5.1 : première adresse en HTTPS, aucun http://IP:port dans un vrai navigateur.");
process.exit(echecs.length ? 1 : 0);
