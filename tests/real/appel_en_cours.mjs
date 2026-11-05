// L'appel en cours dans un vrai navigateur : vue d'appel, barre gardée en naviguant, travail et artefacts montrés, raccrocher.
// Il faut un serveur où tourne un agent dont le modèle répète « Réponds seulement : X » (tests/real/faux_modele.py convient),
// et deux agents dans la liste. Le faux micro reste muet : la voix elle-même est testée par voix_ordre.mjs.
//     NOAH_URL=http://localhost:5173 NOAH_TOKEN=… NOAH_CAPTURES=dossier node tests/real/appel_en_cours.mjs
import { createRequire } from "node:module";

const BASE = process.env.NOAH_URL || "http://localhost:8080";
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT || "playwright");
const SHOTS = process.env.NOAH_CAPTURES;
const bad = [];
const check = (name, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", name, detail);
  if (!ok) bad.push(name);
};
// Une petite image, pour que l'artefact s'affiche sans dépendre d'un fichier de l'agent.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC", "base64");

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
for (const [label, viewport] of [["ordinateur", { width: 1280, height: 800 }], ["telephone", { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([{ name: "apollo_session", value: process.env.NOAH_TOKEN, url: BASE }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route(/\.png/, (r) => (r.request().resourceType() === "image" ? r.fulfill({ status: 200, contentType: "image/png", body: PNG }) : r.continue()));
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/appel-${label}-${name}.png` });
  const call = page.getByRole("region", { name: "Appel vocal" });
  const time = async () => (await call.innerText()).match(/\d+:\d\d/)?.[0];
  const openSidebar = async () => {
    const menu = page.getByRole("button", { name: "Ouvrir le menu" });
    if (await menu.isVisible()) await menu.click();
  };

  await page.goto(BASE);
  await page.getByRole("button", { name: /mode vocal|appel/i }).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /mode vocal|appel/i }).first().click();
  await call.waitFor({ timeout: 10000 });
  check(`${label} : la vue d'appel s'ouvre, avec le visage`, await call.locator("svg").first().isVisible());
  await page.waitForTimeout(1500);
  await shot("vue");

  await page.getByRole("button", { name: "Réduire l'appel" }).click();
  check(`${label} : réduite, l'appel reste une barre`, await call.getByRole("button", { name: "Raccrocher" }).isVisible());
  const box = page.getByRole("textbox").first();
  await box.fill("Réponds seulement : Voilà le graphe /opt/data/workspace/graphe.png et le rapport /opt/data/workspace/rapport.pdf");
  await box.press("Enter");
  check(`${label} : on peut écrire pendant l'appel`, await page.getByText("Voilà le graphe").first().waitFor({ timeout: 30000 }).then(() => true, () => false));
  await shot("barre");

  await call.getByRole("button", { name: "Agrandir l'appel" }).click();
  const image = call.getByRole("button", { name: /Ouvrir graphe.png/ });
  check(`${label} : l'artefact arrive dans la vue d'appel`, await image.waitFor({ timeout: 10000 }).then(() => true, () => false));
  check(`${label} : le fichier aussi`, await call.getByRole("button", { name: /rapport/ }).isVisible().catch(() => false));
  await shot("artefacts");
  await image.click();
  check(`${label} : l'artefact s'ouvre`, await page.getByRole("dialog").waitFor({ timeout: 5000 }).then(() => true, () => false));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Réduire l'appel" }).click();

  const before = await time();
  await openSidebar();
  const other = page.getByRole("button", { name: new RegExp(process.env.NOAH_AUTRE || "Second") }).first();
  await other.click();
  await page.waitForTimeout(2500);
  check(`${label} : en changeant d'agent, l'appel continue`, await call.isVisible() && (await time()) !== before, `${before} puis ${await time().catch(() => "?")}`);
  await shot("ailleurs");
  await openSidebar();
  await page.getByRole("button", { name: new RegExp(process.env.NOAH_AGENT || "Noah") }).first().click();
  await page.waitForTimeout(800);
  check(`${label} : au retour, la conversation est là`, await page.getByText("Voilà le graphe").first().isVisible());
  // Une réponse en route pendant un aller-retour entre agents n'est pas perdue.
  const RUN = Date.now() % 100000;
  await page.route(/\/api\/chat/, async (route) => {
    await new Promise((r) => setTimeout(r, 5000));
    await route.continue();
  }, { times: 1 });
  await box.fill(`Réponds seulement : Aller-retour ${RUN}`);
  await box.press("Enter");
  await openSidebar();
  await other.click();
  await page.waitForTimeout(800);
  await openSidebar();
  await page.getByRole("button", { name: new RegExp(process.env.NOAH_AGENT || "Noah") }).first().click();
  check(`${label} : la réponse en route arrive quand même`, await page.getByText(`Aller-retour ${RUN}`).nth(1).waitFor({ timeout: 30000 }).then(() => true, () => false));

  // Une adresse venue du modèle ne s'exécute pas.
  await box.fill(`Réponds seulement : [Piege ${RUN}](javascript:document.title='PIEGE'//files/raw/x)`);
  await box.press("Enter");
  await page.waitForTimeout(6000);
  check(`${label} : pas de carte pour un lien javascript`, !(await call.getByRole("button", { name: new RegExp(`Piege ${RUN}`) }).count()));
  await call.getByRole("button", { name: "Couper le micro" }).click();
  check(`${label} : le micro se coupe`, await call.getByRole("button", { name: "Rétablir le micro" }).isVisible());
  await call.getByRole("button", { name: "Raccrocher" }).click();
  await page.waitForTimeout(500);
  check(`${label} : raccrocher ferme l'appel`, !(await call.isVisible()));
  check(`${label} : aucune erreur dans la page`, errors.length === 0, errors.join(" | ").slice(0, 300));
  await context.close();
}
await browser.close();
if (bad.length) process.exit(1);
console.log("OK");
