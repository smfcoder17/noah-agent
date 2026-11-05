// G0.5 : l'image du navigateur contient déjà son binaire, et un premier lancement sans aucun accès sortant le démarre.
// Vrai conteneur, créé par le vrai code du lanceur (image construite depuis launcher/Dockerfile), sur un réseau Docker
// sans sortie. Le test passe seulement si le vrai Firefox a rendu une page : /health ne prouve pas que le navigateur démarre.
//     node tests/navigateur/hors_ligne_test.mjs                     l'image déclarée au lanceur
//     node tests/navigateur/hors_ligne_test.mjs --sabotage=binaire    image sans binaire : le test doit échouer
// Il faut l'image du navigateur en local (4 Go). Aucune clé.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const BIN = "/root/.cache/camoufox/camoufox-bin";
const SABOTAGE = (process.argv.find((a) => a.startsWith("--sabotage=")) || "").split("=")[1] || "";
const SUFFIXE = randomBytes(3).toString("hex");
const AGENT = `g05${SUFFIXE}`;
const NOM = `noah-browser-${AGENT}`;
const RESEAU = `noah-g05-${SUFFIXE}`;
const LANCEUR = `noah-launcher:g05-${SUFFIXE}`;

// L'image réelle : celle que le dépôt déclare au lanceur et au VPS, pas un nom recopié ici.
const declared = readFileSync(join(ROOT, "launcher/launcher.py"), "utf8").match(/"BROWSER_IMAGE", "([^"]+)"/)[1];
const compose = readFileSync(join(ROOT, "deploy/docker-compose.yml"), "utf8").match(/BROWSER_IMAGE: (\S+)/)[1];
if (declared !== compose) throw new Error(`Le lanceur (${declared}) et le compose du VPS (${compose}) n'annoncent pas la même image`);
let image = declared;

function docker(...args) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 420000, maxBuffer: 1 << 26 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const must = (...args) => {
  const r = docker(...args);
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} : ${(r.err || r.out).slice(-800)}`);
  return r.out;
};

const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, detail);
  if (!ok) echecs.push(nom);
};

const derivee = `noah-g05-sabotee:${SUFFIXE}`;
try {
  must("build", "-q", "-t", LANCEUR, join(ROOT, "launcher"));
  must("network", "create", "--internal", RESEAU);
  if (SABOTAGE === "binaire") {
    must("run", "--name", `${NOM}-s`, "--network", "none", "--entrypoint", "rm", image, "-rf", "/root/.cache/camoufox/camoufox-bin", "/root/.cache/camoufox/camoufox");
    must("commit", `${NOM}-s`, derivee);
    image = derivee;
  }
  console.log("image :", image, docker("image", "inspect", image, "--format", "{{json .RepoDigests}}").out);

  // 1. Le binaire est dans les couches de l'image : lu sans jamais démarrer le service, sans réseau.
  const stat = docker("run", "--rm", "--network", "none", "--entrypoint", "stat", image, "-c", "%s %A", BIN);
  check("le binaire est dans l'image", stat.code === 0 && /x/.test(stat.out), stat.out || stat.err.slice(0, 120));
  const version = docker("run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/root/.cache/camoufox/version.json");
  if (version.code === 0) console.log("     version du binaire :", version.out);

  // 2. Conteneur neuf, créé et démarré par launcher._ensure_browser.
  const cle = randomBytes(24).toString("hex");
  must("run", "--rm", "--network", "none", "-v", "//var/run/docker.sock:/var/run/docker.sock", "-v", `${HERE}:/t:ro`,
    "-e", `AGENT_NETWORK=${RESEAU}`, "-e", `BROWSER_IMAGE=${image}`, "-e", "LAUNCHER_KEY=essai", "-e", "PYTHONPATH=/app", "--entrypoint", "python", LANCEUR,
    "/t/creer_navigateur.py", AGENT, cle, randomBytes(4).toString("hex"), randomBytes(24).toString("hex"));

  const internal = must("network", "inspect", RESEAU, "--format", "{{.Internal}}");
  const relie = must("inspect", NOM, "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}").trim();
  check("le navigateur est sur un réseau sans sortie", internal === "true" && relie === RESEAU, `${relie} internal=${internal}`);

  must("cp", join(HERE, "pilote_hors_ligne.mjs"), `${NOM}:/tmp/pilote.mjs`);
  const jeton = `hors-ligne-${randomBytes(6).toString("hex")}`;
  const p = docker("exec", NOM, "node", "/tmp/pilote.mjs", jeton, cle);
  let v = {};
  try {
    v = JSON.parse(p.out.split("\n").pop());
  } catch {
    check("le pilote a répondu", false, (p.err || p.out).slice(0, 300));
  }
  const principal = (v.processus || []).filter((e) => e.endsWith("camoufox-bin"));
  console.log("     mesuré :", JSON.stringify({ ...v, sante: v.sante && { ok: v.sante.ok, engine: v.sante.engine }, processus: `${(v.processus || []).length} dont ${principal.length} principal` }));

  check("aucune route sortante dans le conteneur", v.route_sortante === false);
  check("un appel vers Internet échoue bien", v.sortie_bloquee === true);
  check("le service répond sans réseau", !!v.sante?.ok, `${v.attente_sante_s} s`);
  check("le vrai Firefox a rendu la page", v.page_lue === true, (v.erreurs || []).join(" | ").slice(0, 400));
  check("une capture PNG sort du navigateur", v.capture_octets > 1000, `${v.capture_octets} octets`);
  check("le processus camoufox-bin tourne", principal.length > 0);
  check("aucune extension à aller chercher : uBlock est exclu", !v.extension, (v.extension || "").slice(0, 80));

  // 3. Aucune tentative de téléchargement : la moindre ligne de ce genre veut dire qu'un autre premier lancement dépend du réseau.
  const journal = docker("logs", "--tail", "600", NOM);
  const lignes = `${journal.out}\n${journal.err}`.split("\n");
  const tente = lignes.filter((l) => /downloading|retrying \(|failed to download|EAI_AGAIN|addons\.mozilla\.org|timed out/i.test(l));
  check("aucune tentative de téléchargement dans les journaux", tente.length === 0, tente.slice(0, 3).join(" ").slice(0, 300));
  if (echecs.length) console.log("--- fin du journal du navigateur ---\n" + lignes.slice(-20).join("\n").slice(-2000));
} finally {
  docker("rm", "-fv", NOM);
  docker("volume", "rm", "-f", NOM);
  docker("rm", "-fv", `${NOM}-s`);
  docker("rmi", "-f", derivee);
  docker("rmi", "-f", LANCEUR);
  docker("network", "rm", RESEAU);
}

if (SABOTAGE) {
  const vu = echecs.includes("le vrai Firefox a rendu la page");
  console.log(`\nSabotage « ${SABOTAGE} » : ${vu ? "vu" : "NON VU"} (${echecs.length} contrôle(s) en échec)`);
  process.exit(vu ? 0 : 1);
}
console.log(echecs.length ? `\n${echecs.length} échec(s) : ${echecs.join(" ; ")}` : "\nG0.5 : le navigateur démarre et rend une page sans aucun accès sortant.");
process.exit(echecs.length ? 1 : 0);
