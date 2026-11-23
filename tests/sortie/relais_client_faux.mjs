// L'« ordinateur » de tests/sortie/relais_docker_test.sh : le vrai module du bureau (desktop/relais.js), sans Electron.
// Remplacés pour le banc, et seulement eux : la résolution DNS (le faux site a un nom public inventé ; un autre nom « interne »
// résout vers une adresse privée) et la prise sortante (qui joint le vrai faux site). Tout le reste est celui de l'app : le refus des
// destinations privées après résolution, les ports, le plafond, la prise WebSocket, le multiplexage, la reconnexion.
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";

const { create } = createRequire(import.meta.url)("/repo/desktop/relais.js");
const SERVEUR = process.env.SERVEUR;
const SITE_REEL = process.env.SITE_REEL;
const PUBLIQUE = "93.184.216.34";
const jeton = fs.readFileSync("/shared/token", "utf8").trim();

const relais = create({
  lien: async () => ({ origin: SERVEUR, token: jeton }),
  journal: (ligne) => console.log(ligne),
  resolve: async (hote) => {
    if (hote === "site.essai.test") return [PUBLIQUE];
    if (hote === "interne.essai.test") return ["10.9.8.7"];
    throw new Error("inconnu");
  },
  connect: (adresse, port) => new Promise((ok, ko) => {
    const s = net.connect({ host: adresse === PUBLIQUE ? SITE_REEL : adresse, port });
    s.once("connect", () => { s.removeAllListeners("error"); ok(s); });
    s.once("error", ko);
  }),
  permettreClair: true, // le banc parle en http au faux serveur ; l'app réelle refuse tout sauf https
  nom: () => "PC-ESSAI",
  delais: [300, 600, 1200],
});
process.on("SIGTERM", () => process.exit(0));
relais.start();
setInterval(() => {}, 1 << 30);
