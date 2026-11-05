// Double vérification et accord d'un appareil dans un vrai navigateur, sur le vrai serveur et l'interface compilée, avec les captures.
// Il faut frontend/dist (npm run build dans frontend) et Docker ; aucune pile Noah n'est lancée.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/double_verification_ecran.mjs <dossier des captures>
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(process.argv[2] || ".");
mkdirSync(OUT, { recursive: true });
process.env.MSYS_NO_PATHCONV = "1";

const NAME = "noah-essai-double";
const PORT = 18652;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "motdepasse-a";
const docker = (...args) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const check = (ok, what) => {
  if (!ok) throw new Error(`ÉCHEC : ${what}`);
  console.log(`OK    ${what}`);
};

/** Ce que calcule l'application du téléphone (RFC 6238), sans passer par le serveur. */
function appCode(secret, offset = 0) {
  let bits = "";
  for (const ch of secret) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const digest = createHmac("sha1", key).update(counter).digest();
  const at = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(at) & 0x7fffffff) % 1000000).padStart(6, "0");
}

try { docker("rm", "-f", NAME); } catch { /* rien à retirer */ }
docker("run", "-d", "--name", NAME, "-p", `127.0.0.1:${PORT}:8080`, "-e", "PYTHONPATH=/app", "-e", "QR_SECONDES=600",
  "-v", `${resolve(ROOT, "server")}:/app`, "-v", `${resolve(ROOT, "frontend/dist")}:/web:ro`, "-v", `${resolve(ROOT, "tests")}:/tests:ro`,
  "--entrypoint", "python", "ghcr.io/smfcoder17/noah-server:edge", "/tests/pairing/qr_serveur.py");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (let i = 0; ; i++) {
    if (await fetch(`${BASE}/api/status`).then((r) => r.ok).catch(() => false)) break;
    if (i > 60) throw new Error("le serveur ne répond pas : " + docker("logs", "--tail", "20", NAME));
    await new Promise((r) => setTimeout(r, 500));
  }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "fr-FR" });
  const page = await context.newPage();
  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

  // Connexion ordinaire, puis Réglages > Sécurité.
  const signIn = async () => {
    await page.locator("#username").fill("alice");
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Se connecter" }).click();
  };
  const openDevices = async () => {
    await page.getByRole("button", { name: /Réglages/ }).first().click();
    await page.getByRole("tab", { name: "Sécurité" }).click();
  };
  await page.goto(BASE);
  await signIn();
  await page.getByRole("button", { name: /Réglages/ }).first().waitFor({ timeout: 20000 });
  await openDevices();
  const panel = page.getByRole("dialog");
  await panel.getByText("Double vérification", { exact: true }).scrollIntoViewIfNeeded();
  await shot("1-reglage-desactive");

  // Activation : mot de passe, QR et clé, premier code, codes de secours.
  await panel.getByRole("button", { name: "Activer la double vérification" }).click();
  await page.locator("#double-password").fill("mauvais-mdp");
  await panel.getByRole("button", { name: "Continuer" }).click();
  await panel.getByText("Mot de passe ou code incorrect").waitFor();
  check(true, "activer avec un mauvais mot de passe : l'écran le dit");
  await page.locator("#double-password").fill(PASSWORD);
  await panel.getByRole("button", { name: "Continuer" }).click();
  await page.locator("#double-secret").waitFor();
  await page.locator("#double-first-code").scrollIntoViewIfNeeded();
  await shot("2-reglage-qr");
  const secret = (await page.locator("#double-secret").innerText()).replaceAll(" ", "");
  check(/^[A-Z2-7]{32}$/.test(secret), "la clé se lit en clair");
  await page.locator("#double-first-code").fill(appCode(secret));
  await panel.getByRole("button", { name: "Activer", exact: true }).click();
  await page.locator("#double-spare").waitFor();
  await page.locator("#double-spare").scrollIntoViewIfNeeded();
  await shot("3-codes-secours");
  const spare = (await page.locator("#double-spare li").allInnerTexts());
  check(spare.length === 8, "8 codes de secours montrés");
  await panel.getByRole("button", { name: "Je les ai notés" }).click();
  await panel.getByRole("button", { name: "Désactiver la double vérification" }).waitFor();
  await panel.getByRole("button", { name: "Désactiver la double vérification" }).scrollIntoViewIfNeeded();
  await shot("4-reglage-active");
  check(!(await page.locator("body").innerText()).includes(spare[0]), "les codes ne se revoient plus");
  await page.keyboard.press("Escape");

  // Déconnexion, puis l'écran de connexion et ses deux étapes.
  await context.clearCookies();
  await page.goto(BASE);
  await page.locator("#username").waitFor();
  await shot("5-connexion");
  await signIn();
  await page.locator("#login-code").waitFor();
  check((await context.cookies()).length === 0, "bon mot de passe sans code : pas de cookie de session");
  await shot("6-connexion-code");
  await page.locator("#login-code").fill(appCode(secret) === "000000" ? "000001" : "000000");
  await page.getByRole("button", { name: "Valider" }).click();
  await page.getByText("Ce code est faux").waitFor();
  await shot("7-connexion-code-faux");
  check(true, "mauvais code : l'écran le dit, et reste sur le code");
  await page.locator("#login-code").fill(spare[0]);
  await page.getByRole("button", { name: "Valider" }).click();
  await page.getByRole("button", { name: /Réglages/ }).first().waitFor({ timeout: 20000 });
  check(true, "connexion avec un code de secours");

  // Un appareil demande à être relié, dans une session vieille de plus de 15 minutes : la preuve s'affiche.
  const cookie = (await context.cookies()).find((c) => c.name === "noah_session").value;
  const age = () => docker("exec", NAME, "python", "-c",
    `import hashlib,glob,sqlite3,time;d=glob.glob('/tmp/*/noah.db')[0];c=sqlite3.connect(d);c.execute("UPDATE sessions SET mdp_a=? WHERE token=?",(time.time()-1000,hashlib.sha256(${JSON.stringify(cookie)}.encode()).hexdigest()));c.commit()`);
  age();
  await openDevices();
  await panel.getByRole("button", { name: "Relier un appareil" }).click();
  const short = (await panel.locator("p.font-mono.text-2xl").innerText()).trim();
  const asked = await (await fetch(`${BASE}/api/pairing/claim`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: short, appareil: "Pixel de Franck", type: "android" }) })).json();
  await page.locator("#grant-password").waitFor();
  await page.locator("#grant-code").waitFor();
  await page.locator("#grant-password").scrollIntoViewIfNeeded();
  await shot("8-accord-preuve");
  check(await panel.getByRole("button", { name: "Autoriser" }).isDisabled(), "sans la preuve, le bouton reste fermé");
  await page.getByLabel("Nombre affiché sur l'appareil").fill(asked.verification);
  await page.locator("#grant-password").fill(PASSWORD);
  await page.locator("#grant-code").fill(spare[1]);
  await panel.getByRole("button", { name: "Autoriser" }).click();
  await page.getByText("Pixel de Franck").first().waitFor();
  for (let i = 0; i < 20; i++) {
    const polled = await fetch(`${BASE}/api/pairing/flow/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sondage: asked.sondage }) });
    if (polled.status === 200) break;
    if (i === 19) throw new Error(`sondage : ${polled.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  check(true, "mot de passe, code et nombre : l'appareil est relié");
  await page.keyboard.press("Escape");

  // L'app de bureau demande l'accord dans le navigateur, même session vieillie : la page d'accord demande aussi la preuve.
  age();
  const desktop = await (await fetch(`${BASE}/api/pairing/flow`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appareil: "Ordinateur du bureau", type: "desktop" }) })).json();
  const tab = await context.newPage();  // l'app ouvre un nouvel onglet ; la demande se lit au chargement de la page
  await tab.goto(desktop.adresse);
  await tab.locator("#grant-password").waitFor();
  await tab.screenshot({ path: `${OUT}/9-accord-navigateur-preuve.png` });
  const allow = tab.getByRole("button", { name: "Autoriser cet appareil" });
  check(await allow.isDisabled(), "page d'accord : sans la preuve, le bouton reste fermé");
  await tab.locator("#grant-password").fill("mauvais-mdp");
  await tab.locator("#grant-code").fill(spare[2]);
  await allow.click();
  await tab.getByText("Mot de passe ou code incorrect").waitFor();
  check((await tab.locator("#grant-code").inputValue()) === "", "mauvaise preuve : l'écran le dit, et le code est à ressaisir");
  await tab.locator("#grant-password").fill(PASSWORD);
  await tab.locator("#grant-code").fill(spare[2]);
  await allow.click();
  await tab.getByText("Appareil autorisé").waitFor();
  check(true, "page d'accord : mot de passe et code, l'appareil est autorisé");
  await tab.close();

  // Mot de passe oublié : la case et son explication.
  await context.clearCookies();
  await page.goto(BASE);
  await page.getByRole("button", { name: "Mot de passe oublié ?" }).click();
  await page.locator("#cut-double").scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1100, height: 1100 });
  await shot("10-recuperation");
  check(true, "la récupération dit qu'elle peut couper la double vérification");
  console.log("captures dans", OUT);
} finally {
  await browser.close();
  try { docker("rm", "-f", NAME); } catch { /* déjà parti */ }
}
