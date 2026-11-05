// G2.2 dans un vrai navigateur, sur le vrai serveur et la vraie interface compilée : ce que voit la personne qui scanne un
// QR déjà servi ou expiré. Il faut frontend/dist (npm run build dans frontend) et Docker ; aucune pile Noah n'est lancée.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/pairing/qr_navigateur.mjs [dossier des captures]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2] ? resolve(process.argv[2]) : null;
if (OUT) mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";

const NAME = "noah-essai-qr";
const PORT = 18651;
const BASE = `http://127.0.0.1:${PORT}`;
const SECONDS = 6;
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

try { docker("rm", "-f", NAME); } catch { /* rien à retirer */ }
docker("run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:8080`, "-e", "PYTHONPATH=/app", "-e", `QR_SECONDES=${SECONDS}`,
  "-v", `${resolve(ROOT, "server")}:/app`, "-v", `${resolve(ROOT, "frontend/dist")}:/web:ro`, "-v", `${resolve(ROOT, "tests")}:/tests:ro`,
  "--entrypoint", "python", "ghcr.io/smfcoder17/noah-server:edge", "/tests/pairing/qr_serveur.py");

const browser = await chromium.launch();
try {
  for (let i = 0; ; i++) {
    const up = await fetch(`${BASE}/api/status`).then((r) => r.ok).catch(() => false);
    if (up) break;
    if (i > 60) throw new Error("le serveur ne répond pas : " + docker("logs", "--tail", "20", NAME));
    await new Promise((r) => setTimeout(r, 500));
  }
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "motdepasse-a" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const newQr = async () => {
    const r = await fetch(`${BASE}/api/pairing`, { method: "POST", headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" }, body: "{}" });
    const body = await r.json();
    check(r.ok && body.adresse, `QR refusé par le serveur (${r.status}) : ${JSON.stringify(body)}`);
    return body.adresse;
  };
  const scan = async (adresse, label) => {
    // Chaque scan : un téléphone neuf (contexte vide), sans session.
    const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const page = await context.newPage();
    await page.goto(adresse);
    await page.waitForFunction(() => document.body.innerText.length > 20 && !document.body.innerText.startsWith("Chargement"));
    await page.waitForTimeout(400);
    if (OUT) await page.screenshot({ path: `${OUT}/${label}.png` });
    return { context, page, text: await page.evaluate(() => document.body.innerText), url: page.url() };
  };

  // 1. Premier scan : le nombre à recopier, et le jeton a quitté l'adresse.
  const qr = await newQr();
  const bits = Buffer.from(qr.split("#appairage=")[1], "base64url").length * 8;
  check(bits >= 128, `jeton du QR de ${bits} bits`);
  const first = await scan(qr, "1-premier-scan");
  check(/saisis/.test(first.text) && /\b\d{3}\b/.test(first.text), "premier scan sans nombre : " + first.text);
  check(!first.url.includes("appairage"), "le jeton reste dans l'adresse : " + first.url);
  console.log(`1. premier scan (jeton de ${bits} bits) : le nombre à recopier s'affiche, le jeton a quitté l'adresse`);

  // 2. Second scan du même QR : l'erreur est à l'écran, et rien d'autre ne se fait passer pour elle.
  const second = await scan(qr, "2-second-scan");
  check(/déjà servi/.test(second.text) && /nouveau code/.test(second.text), "second scan sans erreur à l'écran : " + second.text);
  check(!/saisis/.test(second.text), "second scan : un nombre est affiché");
  console.log(`2. second scan : « ${second.text.split("\n")[0]} »`);

  // 3. L'erreur n'est pas une impasse : « Continuer » mène à la connexion.
  await second.page.getByRole("button", { name: "Continuer vers Noah" }).click();
  await second.page.waitForSelector("input[type=password]");
  console.log("3. « Continuer vers Noah » mène à l'écran de connexion");

  // 4. QR expiré (ici au bout de quelques secondes) : l'erreur est à l'écran aussi.
  const late = await newQr();
  await new Promise((r) => setTimeout(r, (SECONDS + 1) * 1000));
  const expired = await scan(late, "3-qr-expire");
  check(/expiré/.test(expired.text) && /nouveau code/.test(expired.text), "QR expiré sans erreur à l'écran : " + expired.text);
  console.log(`4. QR expiré : « ${expired.text.split("\n")[0]} »`);
  for (const s of [first, second, expired]) await s.context.close();
  console.log("G2.2 dans le navigateur : tout est vert");
} finally {
  await browser.close();
  try { docker("rm", "-f", NAME); } catch { /* déjà retiré */ }
}
