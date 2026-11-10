// Prépare les deux ressources officielles, sans installer de paquet. À lancer avec accès réseau.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
const assets = [
  ["frontend/src/assets/fonts/Figtree.ttf", "https://raw.githubusercontent.com/google/fonts/main/ofl/figtree/Figtree%5Bwght%5D.ttf", "SIL OFL 1.1"],
  ["frontend/src/assets/fonts/OFL.txt", "https://raw.githubusercontent.com/google/fonts/main/ofl/figtree/OFL.txt", "SIL OFL 1.1"],
  ["frontend/src/assets/providers/mammouth.svg", "https://info.mammouth.ai/img/mammouth/logo.svg", "Marque Mammouth, https://info.mammouth.ai/docs/branding-kit/"],
];
const manifest = [];
for (const [path, url, licence] of assets) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Ressource refusée : ${url} (${r.status})`);
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length > 1_000_000 || !data.length) throw new Error(`Taille inattendue : ${path}`);
  if (path.endsWith(".svg") && (!/<svg\b/.test(data.toString()) || /<script|<foreignObject|\son\w+=|(?:href|src)\s*=\s*["']https?:/i.test(data.toString()))) throw new Error("SVG à vérifier avant de le livrer");
  if (path.endsWith(".ttf") && data.readUInt32BE(0) !== 0x00010000 && data.subarray(0, 4).toString() !== "OTTO") throw new Error("Police illisible");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data);
  manifest.push({ path, url, licence, octets: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
mkdirSync("docs/epics/0.1.6/mesures", { recursive: true });
writeFileSync("docs/epics/0.1.6/mesures/ressources.json", JSON.stringify({ date: new Date().toISOString(), assets: manifest }, null, 2));
console.log("Figtree et logo Mammouth préparés. Relancer le build et vérifier les captures.");
