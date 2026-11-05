// Le dessin natif (NoahFace) comparé au vrai composant de l'interface (Noah.tsx), forme par forme, détail par détail.
// Il faut les images de NoahFaceTest, récupérées avec : adb pull /sdcard/Android/data/agent.noah.mobile/files/visages <dossier>
//     NOAH_PLAYWRIGHT=<chemin de playwright> node tests/android/visages_compare.mjs <dossier> [planche.png]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const front = createRequire(`${root}/frontend/package.json`);
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const [dir, sheet] = process.argv.slice(2);
const SHAPES = ["gomme", "bulle", "cube", "goutte", "pastille"];
const DETAILS = ["aucun", "lunettes", "antenne", "sourcils", "joues"];
const COLOR = "#8b6cf0";
const SIZE = 256;

// Le vrai composant, compilé pour Node et rendu en SVG.
const bundled = await front("esbuild").build({
  stdin: {
    contents: `import { renderToStaticMarkup as r } from "react-dom/server"; import { createElement as e } from "react"; import { Noah } from "./components/Noah"; export const svg = (color, shape, detail) => r(e(Noah, { color, shape, detail }));`,
    resolveDir: `${root}/frontend/src`,
    loader: "js",
  },
  bundle: true, format: "cjs", platform: "node", write: false, jsx: "automatic", logLevel: "silent",
  alias: { "@": `${root}/frontend/src` },
  nodePaths: [`${root}/frontend/node_modules`],
});
const mod = { exports: {} };
new Function("module", "exports", "require", bundled.outputFiles[0].text)(mod, mod.exports, front);
const { svg } = mod.exports;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
const dataUrl = (b) => `data:image/png;base64,${b.toString("base64")}`;
const rows = [];
const cells = [];
const compare = (a, b) => page.evaluate(async ([a, b, size]) => {
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  const pixels = async (src) => {
    const c = new OffscreenCanvas(size, size).getContext("2d");
    c.drawImage(await load(src), 0, 0, size, size);
    return c.getImageData(0, 0, size, size).data;
  };
  const [x, y] = [await pixels(a), await pixels(b)];
  let far = 0, sum = 0;
  for (let i = 0; i < x.length; i += 4) {
    const d = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]), Math.abs(x[i + 3] - y[i + 3]));
    sum += d;
    if (d > 40) far++;
  }
  return { moyen: sum / (size * size), loin: (100 * far) / (size * size) };
}, [a, b, SIZE]);
let witness = null; // le web de la dernière forme face au natif d'une autre : la mesure doit voir la différence
for (const shape of SHAPES) {
  for (const detail of DETAILS) {
    const markup = svg(COLOR, shape, detail === "aucun" ? "" : detail);
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><span style="display:grid;place-items:center;overflow:hidden;width:${SIZE}px;height:${SIZE}px;border-radius:30%;background:linear-gradient(160deg,#fff,color-mix(in srgb,${COLOR} 16%,#fff))"><div style="width:82%;height:82%;transform:translateY(4%)">${markup.replace("<svg", '<svg style="width:100%;height:100%;display:block"')}</div></span>`);
    const web = await page.screenshot({ omitBackground: true });
    const native = readFileSync(`${dir}/${shape}-${detail}.png`);
    const diff = await compare(dataUrl(web), dataUrl(native));
    if (shape === "pastille" && detail === "aucun") witness = await compare(dataUrl(web), dataUrl(readFileSync(`${dir}/gomme-aucun.png`)));
    rows.push({ shape, detail, ...diff });
    cells.push({ shape, detail, web: dataUrl(web), native: dataUrl(native) });
  }
}
let worst = 0;
for (const r of rows) {
  worst = Math.max(worst, r.loin);
  console.log(`${r.shape.padEnd(9)}${r.detail.padEnd(10)} écart moyen ${r.moyen.toFixed(2).padStart(5)} / 255, pixels très différents ${r.loin.toFixed(2).padStart(5)} %`);
}
if (sheet) {
  await page.setViewportSize({ width: 5 * 2 * 132 + 40, height: 5 * 150 + 30 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:10px;background:#14161a;color:#ddd;font:12px sans-serif;display:grid;grid-template-columns:repeat(5,1fr);gap:8px">${cells
    .map((c) => `<div><div>${c.shape} ${c.detail} (web, natif)</div><img width=128 src="${c.web}"><img width=128 src="${c.native}"></div>`)
    .join("")}`);
  writeFileSync(sheet, await page.screenshot());
}
await browser.close();
console.log(`pire combinaison : ${worst.toFixed(2)} % de pixels très différents ; témoin (pastille face à gomme) : ${witness.loin.toFixed(2)} %`);
process.exit(worst > 3 || witness.loin < 3 ? 1 : 0);
