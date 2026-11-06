// Joindre un fichier à une page, de bout en bout : conteneur créé par le vrai lanceur, vraie extension, vrai Firefox, vrai
// noah.py depuis une autre machine, sur un réseau sans sortie. La page calcule l'empreinte de ce qu'elle a reçu.
//     node tests/navigateur/envoi_reel.mjs
// Il faut l'image du navigateur en local (4 Go). Aucune clé.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const SUFFIXE = randomBytes(3).toString("hex");
const AGENT = `env${SUFFIXE}`;
const NOM = `noah-browser-${AGENT}`;
const RESEAU = `noah-envoi-${SUFFIXE}`;
const LANCEUR = `noah-launcher:envoi-${SUFFIXE}`;
const image = readFileSync(join(ROOT, "launcher/launcher.py"), "utf8").match(/"BROWSER_IMAGE", "([^"]+)"/)[1];

function docker(...args) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 900000, maxBuffer: 1 << 26 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const must = (...args) => {
  const r = docker(...args);
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} : ${(r.err || r.out).slice(-800)}`);
  return r.out;
};

const temp = mkdtempSync(join(tmpdir(), "noah-envoi-"));
let code = 1;
try {
  must("build", "-q", "-t", LANCEUR, join(ROOT, "launcher"));
  must("network", "create", "--internal", RESEAU);
  const cle = randomBytes(24).toString("hex");
  must("run", "--rm", "--network", "none", "-v", "//var/run/docker.sock:/var/run/docker.sock", "-v", `${HERE}:/t:ro`,
    "-e", `AGENT_NETWORK=${RESEAU}`, "-e", `BROWSER_IMAGE=${image}`, "-e", "LAUNCHER_KEY=essai", "-e", "PYTHONPATH=/app", "--entrypoint", "python", LANCEUR,
    "/t/creer_navigateur.py", AGENT, cle, randomBytes(4).toString("hex"), randomBytes(24).toString("hex"));
  must("cp", join(HERE, "site_envoi.mjs"), `${NOM}:/tmp/site.mjs`);
  must("exec", "-d", NOM, "node", "/tmp/site.mjs");

  const tool = readFileSync(join(ROOT, "server/noah/hermes.py"), "utf8").match(/AGENT_TOOL = r'''([\s\S]*?)'''/)[1].replace("__TOKEN__", "essai");
  writeFileSync(join(temp, "noah.py"), tool);
  const r = spawnSync("docker", ["run", "--rm", "--network", RESEAU, "-v", `${temp}:/o:ro`, "-v", `${HERE}:/t:ro`, "python:3.12-slim",
    "python", "/t/envoi_reel.py", `http://${NOM}:9377`, cle, "/o/noah.py"], { encoding: "utf8", timeout: 900000, maxBuffer: 1 << 26 });
  console.log(r.stdout, (r.stderr || "").slice(-1500));
  code = r.status ?? 1;
  if (code !== 0) console.log("--- fin du journal du navigateur ---\n", docker("logs", "--tail", "25", NOM).out.slice(-2500));
} finally {
  docker("rm", "-fv", NOM);
  docker("volume", "rm", "-f", NOM);
  docker("rmi", "-f", LANCEUR);
  docker("network", "rm", RESEAU);
  rmSync(temp, { recursive: true, force: true });
}
console.log(code === 0 ? "\nEnvoi de fichier : prouvé avec le vrai Firefox." : "\nEnvoi de fichier : ÉCHEC.");
process.exit(code);
