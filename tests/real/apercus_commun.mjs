// Ce que les essais d'aperçu partagent : les fichiers de apercus_serveur.py, et ce que le navigateur montre vraiment de chacun.

export const SEULEMENT = process.env.NOAH_SEULEMENT;
export const FILES = [
  ["image", "outputs/image.png"],
  ["video", "outputs/video.mp4"],
  ["markdown", "outputs/rapport.md"],
  ["texte", "outputs/notes.txt"],
  ["html", "outputs/page.html"],
  ["pdf", "outputs/doc.pdf"],
  ["app", "apps/demo/index.html"],
].filter(([k]) => !SEULEMENT || k === SEULEMENT);

/** Ce que le navigateur montre vraiment dans la zone d'aperçu `zone` (un locator). Rend { ok, why }. */
export async function verdict(kind, zone, page) {
  const ok = (why) => ({ ok: true, why });
  const ko = (why) => ({ ok: false, why });
  if (kind === "image") {
    const img = zone.locator("img").first();
    await img.waitFor({ timeout: 8000 }).catch(() => {});
    const w = await img.evaluate((i) => i.complete && i.naturalWidth).catch(() => 0);
    return w > 0 ? ok(`image ${w} px de large`) : ko("l'image ne s'affiche pas");
  }
  if (kind === "video") {
    // Le lecteur peut être flottant (hors de la zone) : on le cherche dans toute la page.
    const video = page.locator("video").locator("visible=true").first();
    await video.waitFor({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const s = await video.evaluate((v) => ({ ready: v.readyState, err: v.error?.code ?? null, dur: v.duration, h: v.getBoundingClientRect().height })).catch(() => null);
    if (!s) return ko("pas de lecteur vidéo");
    if (s.err || s.ready < 2 || !(s.dur > 2)) return ko(`vidéo non lue (prêt ${s.ready}, erreur ${s.err}, durée ${s.dur})`);
    return s.h >= 80 ? ok(`vidéo lue, ${s.dur.toFixed(1)} s`) : ko(`lecteur de ${s.h} px de haut`);
  }
  if (kind === "markdown") {
    await zone.getByText("Rapport du jour").first().waitFor({ timeout: 8000 }).catch(() => {});
    const text = (await zone.innerText().catch(() => "")) || "";
    const titre = await zone.locator("h1, h2").filter({ hasText: "Rapport du jour" }).count();
    const items = await zone.locator("li").count();
    const table = await zone.locator("table").count();
    if (!text.includes("Rapport du jour")) return ko("le texte du fichier n'apparaît pas");
    return titre && items >= 2 && table ? ok("titre, liste et tableau rendus") : ko(`Markdown non rendu (titre ${titre}, items ${items}, tableau ${table})`);
  }
  if (kind === "texte") {
    const a = zone.getByText("première ligne").first();
    await a.waitFor({ timeout: 8000 }).catch(() => {});
    if (!(await a.count())) return ko("le texte n'apparaît pas");
    // Deux lignes du fichier sont deux lignes à l'écran : une phrase collée ne se lit pas comme un journal ou une liste.
    const apart = await zone.evaluate((root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const top = (needle) => { for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length); return r.getBoundingClientRect().top; } } return null; };
      w.currentNode = w.root;
      const first = top("première ligne");
      w.currentNode = w.root;
      const second = top("seconde ligne");
      return first !== null && second !== null && second > first + 4;
    });
    return apart ? ok("lignes conservées") : ko("les retours à la ligne du texte sont perdus");
  }
  if (kind === "pdf") {
    const frame = zone.locator("iframe").first();
    await frame.waitFor({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    // Le lecteur de PDF du navigateur se pose dans le cadre sous forme d'un <embed> ; un cadre isolé ne le reçoit pas (et on ne peut pas y lire).
    const etat = await frame.evaluate((e) => ({ isole: e.hasAttribute("sandbox"), embed: !!e.contentDocument?.querySelector("embed[type=\"application/pdf\"], object[type=\"application/pdf\"]") })).catch(() => ({ isole: true, embed: false }));
    const viewer = page.frames().some((f) => /^chrome-extension:|^chrome-untrusted:/.test(f.url()));
    return !etat.isole && (etat.embed || viewer) ? ok("lecteur PDF affiché") : ko(`le PDF ne s'affiche pas (cadre ${etat.isole ? "isolé" : "ouvert"}, lecteur ${etat.embed || viewer ? "présent" : "absent"})`);
  }
  // html et app : la page vit dans un cadre isolé ; son script doit tourner, ses fichiers voisins se charger, le cadre avoir de la place.
  const frame = zone.locator("iframe").first();
  await frame.waitFor({ timeout: 8000 }).catch(() => {});
  if (!(await frame.count())) return ko("pas de cadre");
  const box = await frame.boundingBox();
  const cadre = () => page.frames().find((f) => f !== page.mainFrame() && /apercu|files\/raw/.test(f.url()));
  for (let i = 0; i < 40 && !cadre(); i++) await page.waitForTimeout(200); // le cadre se charge à son tour, après son lien d'aperçu
  const inner = cadre();
  if (!inner) return ko("la page n'est pas chargée dans le cadre");
  await page.waitForTimeout(1200);
  const texte = await inner.locator("h1").first().innerText().catch(() => "");
  const attendu = kind === "app" ? "chargee" : "script exécuté";
  if (!texte.includes(attendu)) return ko(`la page ne s'exécute pas ou ses fichiers ne se chargent pas (« ${texte.slice(0, 40)} »)`);
  if (kind === "html") {
    const logo = await inner.locator("img").first().evaluate((i) => i.complete && i.naturalWidth).catch(() => 0);
    if (!logo) return ko("la page vit mais son image voisine ne se charge pas");
  }
  return box.height >= 300 ? ok(`page vivante, cadre de ${Math.round(box.height)} px`) : ko(`cadre de ${Math.round(box.height)} px de haut : la page est écrasée`);
}

export async function ouvrirPanneauFichiers(page) {
  const onglet = page.getByRole("tab", { name: "Fichiers" }).or(page.getByRole("button", { name: "Fichiers", exact: true }));
  if (!(await onglet.first().isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Ouvrir ou fermer le panneau" }).locator("visible=true").first().click();
  }
  await onglet.locator("visible=true").first().click();
  await page.waitForTimeout(600);
}

/** Ouvre l'aperçu d'un fichier depuis la liste du panneau Fichiers. Une vidéo n'a pas de bouton « Aperçu » : on ouvre sa ligne par son nom. Faux si la ligne manque. */
export async function ouvrirDepuisLePanneau(page, path) {
  await ouvrirPanneauFichiers(page);
  const file = path.split("/").pop();
  const eye = page.getByRole("button", { name: `Aperçu de ${file}`, exact: true });
  const open = (await eye.count()) ? eye.first() : page.getByRole("button", { name: new RegExp(`^(\\S*/)?${file.replace(".", "\\.")}`) }).first();
  if (!(await open.count())) return false;
  await open.click();
  return true;
}

/** Ouvre la carte du fichier dans la conversation (le message « CAS-<nom> » du serveur d'essai). */
export async function ouvrirDepuisLaConversation(page, path) {
  const message = page.locator("[data-noah-msg]", { hasText: `CAS-${path.split("/").pop()}` }).first();
  await message.scrollIntoViewIfNeeded();
  await message.getByRole("button").first().click();
}

/** La zone où l'aperçu s'affiche : panneau de droite, ou plein écran sur téléphone. */
export async function zoneDApercu(page) {
  const zone = page.locator(".file-preview, .element-viewer").locator("visible=true").first();
  await zone.waitFor({ timeout: 8000 }).catch(() => {});
  return zone;
}

/** Le verdict d'un aperçu, sans jamais lever : un navigateur qui plante est un aperçu cassé. */
export async function juger(kind, page) {
  return verdict(kind, await zoneDApercu(page), page).catch((e) => ({ ok: false, why: `le navigateur a échoué : ${String(e.message).split("\n")[0]}` }));
}

/** Un fichier ouvert seul dans un onglet du navigateur : ce que la personne y voit. */
export async function jugerOnglet(kind, onglet) {
  const ok = (why) => ({ ok: true, why });
  const ko = (why) => ({ ok: false, why });
  const vu = await onglet.evaluate(() => {
    const v = document.querySelector("video"), i = document.querySelector("img");
    return { type: document.contentType, texte: document.body?.innerText ?? "", video: v ? { prêt: v.readyState, erreur: v.error?.code ?? null } : null, image: i ? i.naturalWidth : null };
  }).catch((e) => ({ erreur: e.message }));
  if (vu.erreur) return ko(`onglet illisible : ${vu.erreur.slice(0, 60)}`);
  if (kind === "image") return vu.image > 0 ? ok("image affichée") : ko("onglet sans image");
  if (kind === "video") return vu.video && vu.video.prêt >= 2 ? ok("vidéo lue") : ko(`la vidéo ne se lit pas dans son onglet (prêt ${vu.video?.prêt}, erreur ${vu.video?.erreur})`);
  if (kind === "pdf") return vu.type === "application/pdf" ? ok("lecteur PDF") : ko(`type ${vu.type}`);
  if (kind === "html") return /script exécuté/.test(vu.texte) ? ok("page vivante") : ko("la page ne s'exécute pas");
  return /première ligne|Rapport du jour/.test(vu.texte) ? ok("texte affiché") : ko("onglet sans texte");
}

export function afficherTableau(lignes) {
  console.log(`\n${"type".padEnd(10)} ${"lieu".padEnd(32)} résultat`);
  for (const l of lignes) console.log(`${l.kind.padEnd(10)} ${l.lieu.padEnd(32)} ${l.ok ? "marche" : "CASSÉ"} : ${l.why}`);
  const casses = lignes.filter((l) => !l.ok).length;
  console.log(casses ? `\n${casses} aperçu(s) cassé(s)` : "\ntous les aperçus marchent");
  return casses;
}

