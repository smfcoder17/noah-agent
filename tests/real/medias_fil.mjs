// Vrai navigateur, vraie interface, vrai CSP : une image une seule fois avec ses actions, une copie réellement lue dans le presse-papiers,
// une vidéo qui ne contacte sa plateforme qu'après le clic et dont le cadre charge. Serveur : medias_fil_serveur.py.
//   NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/medias_fil.mjs <dossier des captures> [--hors-ligne]
// --hors-ligne : sans les plateformes (CI) ; le chargement des lecteurs n'est alors pas vérifié.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.NOAH_BASE || "http://127.0.0.1:8097";
const OUT = resolve(process.argv[2] || "captures");
const ONLINE = !process.argv.includes("--hors-ligne");
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok " : "ÉCHEC"} ${what}`);
  if (!ok) fails.push(what);
};

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fr-FR", acceptDownloads: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
const page = await context.newPage();
const errors = [], csp = [], outside = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Content Security Policy|Refused to frame/i.test(m.text())) csp.push(m.text()); });
context.on("request", (r) => { if (!r.url().startsWith(BASE) && /^https?:/.test(r.url())) outside.push(r.url()); });

await page.goto(BASE);
await page.locator("input:not([type=password])").first().fill("alice");
await page.locator('input[type="password"]').first().fill("motdepasse-essai");
await page.keyboard.press("Enter");
await page.locator("[data-composer-input]").waitFor({ timeout: 20000 });
const message = (mark) => page.locator("[data-noah-msg]", { hasText: mark }).first();
await message("CAS-TEXTE").waitFor({ timeout: 15000 });
await page.waitForTimeout(800);

// --- Image une seule fois ---------------------------------------------------------------
const images = (mark) => message(mark).locator('img[src*="/media?"]');
for (const [mark, count] of [["CAS-MEDIA", 1], ["CAS-DOUBLE", 1], ["CAS-NU", 1], ["CAS-PLUSIEURS", 3]]) {
  await images(mark).first().scrollIntoViewIfNeeded();
  check((await images(mark).count()) === count, `${mark} : ${count} image(s), vu ${await images(mark).count()}`);
  check(!/MEDIA:/.test(await message(mark).innerText()), `${mark} : le mot MEDIA n'apparaît pas`);
}
const sources = await images("CAS-PLUSIEURS").evaluateAll((all) => all.map((i) => i.getAttribute("src")));
check(new Set(sources).size === 3, "CAS-PLUSIEURS : trois images différentes");
check(/enregistrée dans a\.png/.test((await message("CAS-NU").innerText()).replace(/\s+/g, " ")), "CAS-NU : la phrase garde le nom du fichier");

// Les actions, sur une image venue d'un simple MEDIA:
const seul = message("CAS-MEDIA");
for (const name of ["Copier", "Agrandir", "Ouvrir dans un onglet", "Télécharger a.png"]) check((await seul.getByRole("button", { name, exact: true }).or(seul.getByRole("link", { name, exact: true })).count()) === 1, `CAS-MEDIA : action « ${name} »`);

// La copie : ce qui arrive dans le presse-papiers, lu et décodé.
const readClipboard = () => page.evaluate(async () => {
  const [item] = await navigator.clipboard.read();
  if (!item.types.includes("image/png")) return { types: item.types };
  const bitmap = await createImageBitmap(await item.getType("image/png"));
  return { types: item.types, width: bitmap.width, height: bitmap.height };
});
await page.evaluate(() => navigator.clipboard.writeText("rien"));
await seul.getByRole("button", { name: "Copier", exact: true }).click();
await seul.getByRole("button", { name: "Copiée" }).waitFor({ timeout: 5000 });
let clip = await readClipboard();
check(clip.width === 320 && clip.height === 180, `copie depuis le fil : image 320x180 dans le presse-papiers (${JSON.stringify(clip)})`);
// Un GIF : converti en PNG.
const gif = message("CAS-PLUSIEURS").locator("section", { hasText: "anime.gif" });
await gif.getByRole("button", { name: "Copier", exact: true }).click();
await gif.getByRole("button", { name: "Copiée" }).waitFor({ timeout: 5000 });
clip = await readClipboard();
check(clip.width === 1 && clip.height === 1, `copie d'un GIF : convertie en PNG (${JSON.stringify(clip)})`);
// Depuis la visionneuse.
await seul.getByRole("button", { name: "Agrandir" }).click();
const dialog = page.getByRole("dialog");
await dialog.getByRole("button", { name: "Copier l'image" }).click();
await dialog.getByRole("button", { name: "Copiée" }).waitFor({ timeout: 5000 });
check(true, "copie depuis la visionneuse");
const fromViewer = page.waitForEvent("download", { timeout: 8000 });
await dialog.getByRole("link", { name: "Télécharger" }).click();
check((await fromViewer).suggestedFilename() === "a.png", "téléchargement depuis la visionneuse");
await page.keyboard.press("Escape");
// Le téléchargement depuis le fil, y compris une image hors de l'espace de travail.
for (const [where, name] of [[seul, "a.png"], [gif, "anime.gif"]]) {
  const done = page.waitForEvent("download", { timeout: 8000 });
  await where.getByRole("link", { name: `Télécharger ${name}` }).click();
  check((await done).suggestedFilename() === name, `téléchargement de ${name}`);
}
await message("CAS-ABSENTE").getByText("n'est plus disponible").waitFor({ timeout: 8000 });
check(!(await message("CAS-ABSENTE").getByRole("button", { name: "Copier", exact: true }).count()), "image absente : un message, pas d'action de copie");

// --- Vidéos : carte, rien avant le clic ---------------------------------------------------
const cards = page.locator("[data-noah-video]");
check((await cards.count()) === 5, `5 cartes vidéo (${await cards.count()})`);
check((await page.locator("[data-noah-video] iframe").count()) === 0, "aucun cadre avant le clic");
check(outside.length === 0, `aucune requête vers l'extérieur avant le clic (${outside.slice(0, 3).join(", ")})`);
const yt = message("CAS-VIDEO").locator("[data-noah-video]");
const link = yt.getByRole("link", { name: "Ouvrir dans YouTube" });
check((await link.getAttribute("href")) === "https://www.youtube.com/watch?v=M7lc1UVf-VE" && (await link.getAttribute("target")) === "_blank" && (await link.getAttribute("rel")) === "noopener noreferrer", "« Ouvrir dans YouTube » : adresse, nouvel onglet, sans référent");
await page.screenshot({ path: `${OUT}/1-cartes.png` });

// Texte, liens et code ne bougent pas.
const texte = message("CAS-TEXTE");
check((await texte.locator("[data-noah-video]").count()) === 0, "adresse dans une phrase : pas de carte");
check((await texte.locator('a[href^="https://www.youtube.com/watch"]').count()) === 1 && (await texte.locator('a[href="https://example.com/video"]').count()) === 1, "les liens restent des liens");
check(/M7lc1UVf-VE/.test(await texte.locator("pre").innerText()), "le bloc de code garde l'adresse");
// L'agent écrit n'importe quoi.
const piege = message("CAS-PIEGE");
check((await piege.getByText("Vidéo non reconnue").count()) === 1 && !(await piege.locator('a[href^="javascript"], iframe').count()), "javascript: dans un widget : ni lien, ni cadre");
check((await piege.locator("[data-noah-video]").count()) === 0, "youtube.com.evil.com : pas de carte");

// Lecture : le cadre charge sous le vrai CSP, et une seule vidéo à la fois.
const statusOf = (host) => new Promise((done) => {
  const seen = (r) => { if (r.frame() !== page.mainFrame() && r.request().isNavigationRequest() && r.url().includes(host)) { page.off("response", seen); done({ status: r.status(), url: r.url(), xfo: r.headers()["x-frame-options"] }); } };
  page.on("response", seen);
  setTimeout(() => done(null), 20000);
});
const youtube = statusOf("youtube-nocookie.com");
await yt.getByRole("button", { name: /Lire ici/ }).click();
const frame = yt.locator("iframe");
await frame.waitFor({ timeout: 5000 });
check((await frame.getAttribute("src")).startsWith("https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?"), "le cadre vise youtube-nocookie");
check(/allow-scripts/.test(await frame.getAttribute("sandbox")) && !/top-navigation|allow-forms/.test(await frame.getAttribute("sandbox")), `bac à sable minimal : ${await frame.getAttribute("sandbox")}`);
check(!/microphone|camera|geolocation/.test(await frame.getAttribute("allow")), `permissions limitées : ${await frame.getAttribute("allow")}`);
if (ONLINE) {
  const r = await youtube;
  check(r?.status === 200, `YouTube : le cadre charge (${JSON.stringify(r)})`);
  await page.waitForTimeout(6000);
  const player = page.frames().find((f) => f.url().includes("youtube-nocookie.com/embed"));
  const state = player ? await player.evaluate(() => ({ error: document.querySelector(".ytp-error")?.innerText ?? null, time: document.querySelector("video")?.currentTime ?? 0 })).catch((e) => ({ erreur: e.message })) : null;
  check(!!state && !state.error && state.time > 0, `YouTube : la vidéo avance réellement, sans erreur (${JSON.stringify(state)})`);
  await page.screenshot({ path: `${OUT}/2-youtube.png` });
}
for (const [platform, host] of [["vimeo", "player.vimeo.com"], ["x", "platform.twitter.com"], ["tiktok", "tiktok.com"], ["instagram", "instagram.com"]]) {
  const card = page.locator(`[data-noah-video="${platform}"]`);
  await card.scrollIntoViewIfNeeded();
  const loaded = statusOf(host);
  await card.getByRole("button", { name: /Lire ici/ }).click();
  await card.locator("iframe").waitFor({ timeout: 5000 });
  check((await page.locator("[data-noah-video] iframe").count()) === 1, `${platform} : une seule vidéo à la fois`);
  if (ONLINE) {
    const r = await loaded;
    console.log(`   ${platform} : ${JSON.stringify(r)}`);
    await page.waitForTimeout(5000);
    await card.screenshot({ path: `${OUT}/3-${platform}.png` }).catch(() => {});
    // Une plateforme répond parfois 503 à un navigateur automatisé : c'est elle, pas nous. Le refus du CSP se lit plus bas.
    check(!!r && (r.status < 400 || r.status >= 500), `${platform} : le cadre part et la plateforme répond (${r?.status})`);
    if (platform === "x") check((await card.locator("iframe").boundingBox()).height < 600, "x : le cadre prend la hauteur de la publication");
  }
}
await page.locator("[data-noah-video]").filter({ has: page.locator("iframe") }).getByRole("button", { name: "Fermer" }).click();
check((await page.locator("[data-noah-video] iframe").count()) === 0, "« Fermer » retire le cadre");
check(csp.length === 0, `aucun refus du CSP (${csp.slice(0, 2).join(" | ")})`);

// --- Une réponse en direct, coupée par un outil -------------------------------------------
await page.locator("[data-composer-input]").fill("Encore");
await page.keyboard.press("Enter");
await message("CAS-FLUX").waitFor({ timeout: 15000 });
let most = 0;
for (let i = 0; i < 40; i++) {
  most = Math.max(most, await images("CAS-FLUX").count());
  if (/Deuxième partie/.test(await message("CAS-FLUX").innerText()) && (await message("CAS-FLUX").locator("[data-noah-video]").count())) break;
  await page.waitForTimeout(100);
}
await page.waitForTimeout(1500);
check((await images("CAS-FLUX").count()) === 1, `flux coupé par un outil : une image à la fin (${await images("CAS-FLUX").count()})`);
check(most <= 1, `flux coupé par un outil : jamais deux en même temps (${most})`);
check(!/MEDIA:/.test(await message("CAS-FLUX").innerText()), "flux : le mot MEDIA n'apparaît pas");
await page.reload();
await page.locator("[data-composer-input]").waitFor({ timeout: 20000 });
await message("CAS-TEXTE").waitFor({ timeout: 15000 });
await page.waitForTimeout(800);
const again = page.locator("[data-noah-msg]", { hasText: "Deuxième partie" }).first();
if (await again.count()) check((await again.locator('img[src*="/media?"]').count()) === 1, "après rechargement : toujours une image");

// --- Téléphone et sombre -------------------------------------------------------------------
for (const [name, scheme] of [["clair", "light"], ["sombre", "dark"]]) {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.emulateMedia({ colorScheme: scheme });
  await message("CAS-VIDEO").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const wide = await page.evaluate(() => [...document.querySelectorAll("[data-noah-video], [data-noah-msg] section")].filter((n) => n.getBoundingClientRect().right > innerWidth + 1).length);
  check(wide === 0, `375 px, ${name} : aucune carte ne dépasse (${wide})`);
  await page.screenshot({ path: `${OUT}/4-telephone-${name}.png` });
  const portrait = page.locator('[data-noah-video="tiktok"]');
  await portrait.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/5-portrait-${name}.png` });
}
check(errors.length === 0, `aucune erreur de page (${errors.slice(0, 2).join(" | ")})`);
await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} échec(s) :\n- ${fails.join("\n- ")}`);
  process.exit(1);
}
console.log("\nTout est bon.");
