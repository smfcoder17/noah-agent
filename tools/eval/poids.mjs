// Budgets B2 (poids du premier écran) et B2 bis (compression déclarée par chaque voie de déploiement). Node seul, aucun navigateur.
//   cd frontend && npm run build && cd .. && node tools/eval/poids.mjs
// B2 : le script d'entrée, les modules préchargés et les feuilles de style que frontend/dist/index.html désigne, en gzip, additionnés.
// Les morceaux chargés à la demande (`lazy`) n'y sont pas : index.html ne les nomme pas.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { jugerTout } from "./cliquet.mjs";

const racine = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(racine, "frontend", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("ÉCHEC  frontend/dist/index.html absent : lancer d'abord `npm run build` dans frontend.");
  process.exit(1);
}
const html = readFileSync(join(dist, "index.html"), "utf8");
const liens = [
  ...[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link\b[^>]*\brel="(?:modulepreload|stylesheet)"[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]),
].filter((u) => u.startsWith("/"));
let total = 0;
for (const url of liens) {
  const fichier = join(dist, url);
  const octets = gzipSync(readFileSync(fichier), { level: 6 }).length;
  total += octets;
  console.log(`       ${url.padEnd(40)} ${(octets / 1000).toFixed(1).padStart(7)} ko gzip`);
}
if (!liens.length) {
  console.error("ÉCHEC  index.html ne désigne aucun script : le contrôle ne mesurerait rien.");
  process.exit(1);
}

// B2 bis : chaque voie de déploiement déclare la compression. Contrôle de texte, comme le reste de deploy/.
const lire = (f) => readFileSync(join(racine, f), "utf8");
const caddy = (f) => /^\s*encode\b.*\bgzip\b/m.test(lire(f));
const voies = {
  "Caddy (deploy/Caddyfile et le Caddyfile de deploy/docker-compose.yml)": caddy("deploy/Caddyfile") && caddy("deploy/docker-compose.yml"),
  "Traefik (deploy/docker-compose.traefik.yml)": /traefik\.http\.middlewares\.[\w-]+\.compress\b/.test(lire("deploy/docker-compose.traefik.yml")),
};
for (const [voie, ok] of Object.entries(voies)) console.log(`       compression ${ok ? "déclarée" : "ABSENTE "} : ${voie}`);
const sans = Object.values(voies).filter((ok) => !ok).length;

const ok = jugerTout([
  ["B2.gzip_ko", Math.round(total / 100) / 10],
  ["B2bis.voies_sans_compression", sans],
]);
process.exit(ok ? 0 : 1);
