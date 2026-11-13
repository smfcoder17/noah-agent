// Ce qu'un message montre, sans navigateur : adresses de vidéos (bonnes et piégées), image affichée une seule fois, hôtes du CSP.
//     node tests/chat/medias_test.mjs
// Un clic sur Lecture, le vrai CSP et la copie de l'image : tests/real/medias_fil.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMBED_HOSTS, linkMessage, plainWidgets, videoFromUrl } from "../../frontend/src/lib/chatMedia.ts";

const ID = "dQw4w9WgXcQ";
const fileUrl = (p) => `/raw/${p.split("/").pop()}`;
const link = (text, extra = {}) => linkMessage(text, { fileUrl, ...extra });
const widgets = (out) => [...out.matchAll(/```noah\n(.*?)\n```/g)].map((m) => JSON.parse(m[1]));
const previews = (out) => widgets(out).filter((w) => w.type === "preview").map((w) => w.path);
const videos = (out) => widgets(out).filter((w) => w.type === "video");

// --- Bonnes adresses ------------------------------------------------------------------
const GOOD = [
  [`https://www.youtube.com/watch?v=${ID}`, "youtube", `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://m.youtube.com/watch?feature=share&v=${ID}&list=PL1`, "youtube", `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1`, `https://www.youtube.com/watch?v=${ID}`],
  [`https://youtu.be/${ID}?si=abc_DEF&t=90`, "youtube", `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1&start=90`, `https://www.youtube.com/watch?v=${ID}&t=90s`],
  [`https://youtu.be/${ID}?t=1m30s`, "youtube", `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1&start=90`, `https://www.youtube.com/watch?v=${ID}&t=90s`],
  [`https://www.youtube.com/shorts/${ID}`, "youtube", `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1`, `https://www.youtube.com/shorts/${ID}`],
  [`https://www.youtube.com/live/${ID}?si=x`, "youtube", `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1`, `https://www.youtube.com/watch?v=${ID}`],
  ["https://vimeo.com/76979871", "vimeo", "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1", "https://vimeo.com/76979871"],
  ["https://vimeo.com/76979871/abc123def0", "vimeo", "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1&h=abc123def0", "https://vimeo.com/76979871/abc123def0"],
  ["https://x.com/nasa/status/1234567890123456789", "x", "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true", "https://x.com/nasa/status/1234567890123456789"],
  ["https://twitter.com/nasa/status/1234567890123456789/video/1?s=20", "x", "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true", "https://x.com/nasa/status/1234567890123456789"],
  ["https://x.com/i/web/status/1234567890123456789", "x", "https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true", "https://x.com/i/status/1234567890123456789"],
  ["https://www.tiktok.com/@compte.un/video/7234567890123456789?lang=fr", "tiktok", "https://www.tiktok.com/embed/v2/7234567890123456789", "https://www.tiktok.com/@compte.un/video/7234567890123456789"],
  ["https://vm.tiktok.com/ZMabc123/", "tiktok", null, "https://vm.tiktok.com/ZMabc123/"],
  ["https://www.instagram.com/reel/CxYz_12-ab/?igsh=abc", "instagram", "https://www.instagram.com/reel/CxYz_12-ab/embed/", "https://www.instagram.com/reel/CxYz_12-ab/"],
  ["https://instagram.com/compte/p/CxYz_12-ab/", "instagram", "https://www.instagram.com/p/CxYz_12-ab/embed/", "https://www.instagram.com/p/CxYz_12-ab/"],
];
for (const [url, platform, embed, open] of GOOD) {
  const v = videoFromUrl(url);
  assert.ok(v, `reconnue : ${url}`);
  assert.equal(v.platform, platform, url);
  assert.equal(v.embedUrl, embed, url);
  assert.equal(v.openUrl, open, url);
  // L'adresse canonique, celle qu'on met dans le widget, redonne la même vidéo.
  assert.equal(videoFromUrl(v.openUrl)?.key, v.key, `aller-retour : ${url}`);
}
assert.equal(videoFromUrl(`https://www.youtube.com/shorts/${ID}`).portrait, true);
assert.equal(videoFromUrl(`https://youtu.be/${ID}`).portrait, false);
console.log(`1. ${GOOD.length} adresses reconnues, cadre et ouverture reconstruits`);

// --- Adresses piégées -----------------------------------------------------------------
const BAD = [
  `https://youtube.com.evil.com/watch?v=${ID}`,
  `https://evil-youtube.com/watch?v=${ID}`,
  `https://www.youtube.com@evil.com/watch?v=${ID}`,
  `https://evil.com/www.youtube.com/watch?v=${ID}`,
  `https://evil.com/?u=https://www.youtube.com/watch?v=${ID}`,
  `https://user:pw@www.youtube.com/watch?v=${ID}`,
  `https://www.youtube.com:8443/watch?v=${ID}`,
  `https://youtube.com./watch?v=${ID}`,
  `javascript:alert(1)//https://www.youtube.com/watch?v=${ID}`,
  `JaVaScRiPt:alert(1)`,
  `data:text/html,<script>alert(1)</script>`,
  `file:///etc/passwd`,
  `//www.youtube.com/watch?v=${ID}`,
  `ftp://www.youtube.com/watch?v=${ID}`,
  `https://www.youtube.com/watch?v=${ID}"onload="alert(1)`,
  `https://www.youtube.com/watch?v=abc%22def%3C12`,
  `https://www.youtube.com/watch?v=short`,
  `https://www.youtube.com/watch?v=${ID}${ID}`,
  `https://www.youtube.com/embed/../../evil`,
  `https://www.youtube.com/embed/${ID}/../x`,
  `https://www.youtube.com/@chaine`,
  `https://www.youtube.com/playlist?list=PL1`,
  `https://youtu.be/${ID}/autre`,
  `https://www.youtube.com\\@evil.com/watch?v=${ID}`,
  `https://vimeo.com.evil.com/76979871`,
  `https://vimeo.com/channels`,
  `https://vimeo.com/76979871abc`,
  `https://x.com/nasa`,
  `https://x.com/nasa/status/abc`,
  `https://x.com/na"sa/status/1234567890123456789`,
  `https://x.com.evil.com/nasa/status/1234567890123456789`,
  `https://x.com/nasa/status/1234567890123456789/photo/1`,
  `https://www.tiktok.com/@compte/video/abc`,
  `https://www.tiktok.com.evil.com/@compte/video/7234567890123456789`,
  `https://www.instagram.com/compte/`,
  `https://www.instagram.com/reel/a'b/`,
  `https://www.dailymotion.com/video/x8abc`,
  ``,
  null,
  42,
  { toString: () => `https://youtu.be/${ID}` },
];
for (const url of BAD) assert.equal(videoFromUrl(url), null, `refusée : ${String(url)}`);
console.log(`2. ${BAD.length} adresses piégées ou inconnues refusées`);

// Les adresses de cadre ne viennent que des hôtes admis, et le CSP du serveur liste exactement ceux-là.
for (const [url] of GOOD) {
  const embed = videoFromUrl(url).embedUrl;
  if (embed) assert.ok(EMBED_HOSTS.includes(new URL(embed).hostname), embed);
}
const python = readFileSync(new URL("../../server/noah/exposition.py", import.meta.url), "utf8");
const frameSrc = /"frame-src ([^"]+)"/.exec(python)[1].split(" ");
assert.deepEqual([...frameSrc].sort(), ["'self'", ...EMBED_HOSTS.map((h) => `https://${h}`)].sort(), "frame-src et interface d'accord");
console.log("3. Le CSP du serveur et l'interface admettent exactement les mêmes hôtes");

// --- Vidéo dans le texte --------------------------------------------------------------
const YT = `https://www.youtube.com/watch?v=${ID}`;
assert.deepEqual(videos(link(`Regarde :\n\n${YT}\n\nC'est court.`)).map((w) => w.url), [YT], "seule sur sa ligne");
assert.deepEqual(videos(link(`- ${YT}`)).map((w) => w.url), [YT], "dans une liste");
assert.deepEqual(videos(link(`<${YT}>`)).map((w) => w.url), [YT], "entre chevrons");
assert.deepEqual(videos(link(`${YT}.`)).map((w) => w.url), [YT], "avec un point final");
assert.deepEqual(videos(link(`[Ma démo](${YT})`)), [{ type: "video", url: YT, title: "Ma démo" }], "lien titré seul");
assert.equal(videos(link(`Regarde ${YT} ce soir.`)).length, 0, "dans une phrase : reste un lien");
assert.equal(link(`Regarde ${YT} ce soir.`), `Regarde ${YT} ce soir.`);
assert.equal(link("```\n" + YT + "\n```"), "```\n" + YT + "\n```", "bloc de code intact");
assert.equal(link("~~~\n" + YT + "\n~~~"), "~~~\n" + YT + "\n~~~", "bloc de code ~~~ intact");
assert.equal(link("    " + YT), "    " + YT, "code indenté intact");
assert.equal(link("`" + YT + "`"), "`" + YT + "`", "code en ligne intact");
assert.equal(link("https://example.com/video"), "https://example.com/video", "plateforme inconnue : reste un lien");
assert.equal(link(`https://youtube.com.evil.com/watch?v=${ID}`), `https://youtube.com.evil.com/watch?v=${ID}`, "faux hôte : reste du texte");
assert.equal(videos(link(`${YT}\n\n${YT}`)).length, 1, "deux fois la même : une carte");
assert.equal(videos(link(`https://youtu.be/${ID}\n`, { before: YT })).length, 0, "déjà montrée dans une autre partie");
// Pendant l'écriture, la dernière ligne peut encore grandir ; dès qu'elle est finie, la carte paraît.
assert.equal(videos(link(`Voici\nhttps://x.com/nasa/status/12345`, { streaming: true })).length, 0, "ligne en cours : pas de carte");
assert.equal(videos(link(`Voici\nhttps://x.com/nasa/status/12345\nSuite`, { streaming: true })).length, 1, "ligne finie : la carte");
assert.equal(videos(link(`Voici\nhttps://x.com/nasa/status/12345`)).length, 1, "réponse finie : la carte");
console.log("4. Une adresse seule sur sa ligne devient une carte ; phrases, code et plateformes inconnues ne bougent pas");

// --- Une image, une fois --------------------------------------------------------------
const A = "/opt/data/workspace/captures/a.png";
const B = "/opt/data/workspace/outputs/b.jpg";
const FENCE_A = '```noah\n{"type":"preview","path":"' + A + '"}\n```';
assert.deepEqual(previews(link(`MEDIA:${A}`)), [A], "MEDIA seul : le widget aux actions");
assert.ok(!link(`MEDIA:${A}`).includes("MEDIA:"), "le mot MEDIA ne reste pas");
assert.ok(!link(`MEDIA:${A}`).includes("!["), "pas d'image Markdown sans actions");
assert.deepEqual(previews(link(`Voici.\nMEDIA:${A}\n\n${FENCE_A}`)), [A], "MEDIA puis aperçu");
assert.deepEqual(previews(link(`${FENCE_A}\n\nMEDIA:${A}`)), [A], "aperçu puis MEDIA");
assert.deepEqual(previews(link(`MEDIA:${A}\n\n\`\`\`noah\n{"type":"preview","path":"captures/a.png"}\n\`\`\``)), ["captures/a.png"], "aperçu en chemin relatif");
assert.deepEqual(previews(link(`MEDIA:${A}\nMEDIA:${A}`)), [A], "MEDIA répété");
assert.deepEqual(previews(link(`MEDIA:${A}\nEnregistrée dans ${A}.`)), [A], "MEDIA puis chemin nu");
assert.deepEqual(previews(link(`Enregistrée dans ${A}.\nMEDIA:${A}`)), [A], "chemin nu puis MEDIA");
assert.deepEqual(previews(link(A)), [A], "chemin nu seul");
assert.deepEqual(previews(link("`" + A + "`")), [A], "chemin entre accents");
assert.deepEqual(previews(link(`![capture](${A})`)), [A], "image Markdown");
assert.deepEqual(previews(link(`[capture](${A})`)), [A], "lien Markdown vers l'image");
assert.deepEqual(previews(link(`MEDIA:${A}\nMEDIA:${B}\nMEDIA:/tmp/c.webp`)), [A, B, "/tmp/c.webp"], "plusieurs images, dans l'ordre");
assert.deepEqual(previews(link(`MEDIA:${A} MEDIA:${B}`)), [A, B], "deux MEDIA sur une ligne");
assert.deepEqual(previews(link(`${A}, ${B}`)), [A, B], "deux chemins nus sur une ligne");
assert.deepEqual(previews(link("MEDIA:/opt/data/workspace/captures/mon image.png")), ["/opt/data/workspace/captures/mon image.png"], "un espace dans le nom");
assert.equal(previews(link("```\nMEDIA:" + A + "\n```")).length, 0, "dans un bloc de code : intact");
assert.equal(previews(link("https://exemple.com/tmp/photo.png")).length, 0, "la fin d'une adresse web n'est pas un fichier de l'agent");
assert.ok(link(`Enregistrée dans ${A}.`).includes("Enregistrée dans `a.png`."), "la phrase garde son sens");
assert.ok(link(`Enregistrée dans ${A}.`).indexOf("```noah") > link(`Enregistrée dans ${A}.`).indexOf("a.png"), "l'image suit la phrase");
const table = link(`| Nom | Fichier |\n|---|---|\n| a | ${A} |\n| b | x |\n\nFin`);
assert.ok(/\| a \| `a\.png` \|\n\| b \| x \|\n+```noah/.test(table), "un tableau n'est pas coupé par l'image");
// Une grille qui montre l'image compte aussi.
assert.equal(previews(link(`MEDIA:${A}\n\n\`\`\`noah\n{"type":"grid","items":[{"title":"t","image":"${A}"}]}\n\`\`\``)).length, 0, "déjà dans une grille");
assert.equal(previews(link(`MEDIA:${A}\n\n\`\`\`noah\n{"type":"posts","items":[{"text":"t","image":"${A}"}]}\n\`\`\``)).length, 0, "déjà dans un post");
assert.equal(previews(link(`${A}\n\n\`\`\`noah\n{"type":"products","items":[{"title":"t","images":["${A}"]}]}\n\`\`\``)).length, 0, "déjà dans un produit");
console.log("5. Chaque forme de citation (MEDIA, chemin nu, Markdown, plusieurs images) donne un seul widget");

// Une réponse coupée par un outil : plusieurs parties, un seul affichage, y compris quand le flux reprend et répète un widget.
assert.deepEqual(previews(link(`Suite\nMEDIA:${A}`, { before: `Début\nMEDIA:${A}` })), [], "déjà citée dans la partie d'avant");
assert.deepEqual(previews(link(`MEDIA:${A}`, { after: FENCE_A })), [], "un widget plus loin s'en charge");
assert.deepEqual(previews(link(FENCE_A, { before: `MEDIA:${A}` })), [A], "et ce widget se montre");
assert.deepEqual(previews(link(FENCE_A, { before: FENCE_A })), [], "widget répété dans la partie suivante");
assert.deepEqual(previews(link(`${FENCE_A}\n\n${FENCE_A}`)), [A], "widget répété dans la même partie");
assert.deepEqual(previews(link(`MEDIA:${B}`, { before: `MEDIA:${A}` })), [B], "une autre image passe");
// Pendant l'écriture : le chemin qui arrive ne s'affiche pas, l'image paraît entière, et le bloc pas encore fermé ne la double pas.
assert.equal(link("Voici\nMEDIA:/opt/data/workspace/captures/a", { streaming: true }).trim(), "Voici", "chemin en cours caché");
assert.deepEqual(previews(link(`Voici\nMEDIA:${A}\n\n\`\`\`noah\n{"type":"preview","pa`, { streaming: true })), [A], "bloc qui commence");
assert.deepEqual(previews(link(`Voici\nMEDIA:${A}\n\n\`\`\`noah\n{"type":"preview","path":"${A}"`, { streaming: true })), [], "bloc qui nomme l'image : un seul sera montré");
console.log("6. Parties d'une réponse, flux repris et écriture en cours : toujours une seule image");

// Les autres fichiers ne changent pas de comportement.
assert.deepEqual(previews(link("/opt/data/workspace/apps/x/index.html")), ["/opt/data/workspace/apps/x/index.html"], "page en aperçu");
assert.equal(link("/opt/data/workspace/notes.txt"), "[notes.txt](/raw/notes.txt)", "fichier : un lien");
assert.deepEqual(previews(link("MEDIA:/opt/data/workspace/outputs/a.mp4")), ["/opt/data/workspace/outputs/a.mp4"], "vidéo locale en MEDIA");
assert.ok(!link("MEDIA:/opt/data/workspace/outputs/a.mp4").includes("MEDIA:"), "sans le mot MEDIA");
assert.equal(link("Texte **ordinaire**\n\n- point\n"), "Texte **ordinaire**\n\n- point\n", "texte intact au caractère près");
const plain = plainWidgets(link(`MEDIA:${A}\n${YT}\n/opt/data/workspace/apps/x/index.html`), fileUrl, (p) => `/media/${p.split("/").pop()}`);
assert.ok(plain.includes("![a.png](/media/a.png)") && plain.includes(YT) && plain.includes("[index.html](/raw/index.html)") && !plain.includes("```"), plain);
console.log("7. Autres fichiers, texte ordinaire et version pour l'appel inchangés");
