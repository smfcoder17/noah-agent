// Clic droit sur un fichier de l'agent (desktop/fichiers.js) : nom sûr, rien d'écrasé, pas d'ouverture d'un clic pour un programme.
//   node tests/desktop/fichiers_test.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const f = require(join(dirname(fileURLToPath(import.meta.url)), "../../desktop/fichiers.js"));
const fails = [];
const check = (name, ok, detail = "") => { console.log(ok ? "OK   " : "ÉCHEC", name, ok ? "" : detail); if (!ok) fails.push(name); };

check("nom sans chemin ni caractère piégé", f.safeName("../../Windows/a‮txt.exe") === "a_txt.exe" && f.safeName("CON.txt") === "fichier" && f.safeName("") === "fichier", f.safeName("../../Windows/a‮txt.exe"));
check("un document s'ouvre, un programme non", f.entries("rapport.pdf", "win32").map((e) => e.id).join() === "ouvrir,ouvrir-avec,dossier"
  && f.entries("installe.exe", "win32").map((e) => e.id).join() === "dossier" && f.entries("x.ps1", "win32").map((e) => e.id).join() === "dossier");
check("sans « Ouvrir avec » hors Windows", !f.entries("a.pdf", "linux").some((e) => e.id === "ouvrir-avec"));
const dir = mkdtempSync(join(tmpdir(), "noah-fichiers-"));
const fetcher = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("contenu").buffer });
const a = await f.download(fetcher, "x", "note.txt", dir);
const b = await f.download(fetcher, "x", "note.txt", dir);
check("téléchargé sans écraser", a.endsWith("note.txt") && b.endsWith("note (2).txt") && readFileSync(b, "utf8") === "contenu", `${a} ${b}`);
let refused = false;
try { await f.download(async () => ({ ok: false, status: 403 }), "x", "n.txt", dir); } catch { refused = true; }
check("réponse refusée : rien d'écrit", refused);
rmSync(dir, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} échec(s)` : "\nClic droit sur un fichier : tout tient.");
process.exit(fails.length ? 1 : 0);
