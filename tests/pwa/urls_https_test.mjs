// G5.1 : aucune page, ni la doc ni la sortie d'un script, ne donne http://IP:port, et la première adresse d'un VPS est en HTTPS.
// Sans navigateur et sans clé (CI). Le parcours dans un vrai navigateur est dans tests/real/urls_https.mjs.
//     node tests/pwa/urls_https_test.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, detail);
  if (!ok) echecs.push(nom);
};

// http:// suivi d'une IP, ou d'une variable ou d'un exemple qui en tient lieu.
const HTTP_IP = /http:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|<[^>\s]*(?:ip|adresse)[^>\s]*>|\$\{[^}]*\b(?:ip|lan\w*|addr\w*)\b[^}]*\}|\$(?:ip|lan\w*|addr\w*)\b|\{(?:ip|lan\w*|addr\w*)\}|ip[:/`\s])/i;
// Ne sont pas montrés comme adresse de Noah : tests et textes qui citent le critère ou d'autres projets.
// tools/eval, docs/epics/<version>/mesures et rapports : bancs et traces de travail des bancs locaux, jamais publiées ni affichées.
const HORS_CHAMP = /^(tests\/|docs\/epics\/[^/]+\/(mesures\/|rapport)|docs\/(references|grille-validation|journal-hill-climb|etat)\.md$|LICENSE$|.*package-lock\.json$|mobile\/android\/)/;
// Adresses de la boucle locale qui ne servent jamais d'adresse de Noah à un autre appareil.
const INTERNES = [
  ["desktop/noah.js", "http://127.0.0.1:${env.NOAH_PORT", "la fenêtre de l'app de bureau charge Noah en local, sans barre d'adresse"],
  ["get.sh", "urlopen('http://127.0.0.1:8080/api/status')", "question posée au serveur depuis son conteneur, jamais affichée"],
  ["server/noah/accounts.py", 'REDIRECT = "http://127.0.0.1:1/"', "retour OAuth de Google, jamais ouvert"],
  ["frontend/src/components/AgentPowers.tsx", 'placeholder="http://127.0.0.1:…/callback', "retour OAuth d'un outil, à recopier"],
];

const fichiers = spawnSync("git", ["-c", "core.quotepath=off", "ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }).stdout.split("\n").filter((f) => f && !HORS_CHAMP.test(f));
const trouves = [];
let lus = 0;
for (const f of fichiers) {
  let texte;
  try {
    texte = readFileSync(join(ROOT, f), "utf8");
  } catch {
    continue;
  }
  lus++;
  texte.split("\n").forEach((ligne, i) => {
    if (HTTP_IP.test(ligne) && !INTERNES.some(([fichier, extrait]) => f === fichier && ligne.includes(extrait))) trouves.push(`${f}:${i + 1} ${ligne.trim().slice(0, 90)}`);
  });
}
check(`aucun http://IP:port dans ${lus} fichiers suivis`, lus > 100 && trouves.length === 0, `\n     ${trouves.join("\n     ")}`);

// La règle elle-même : si elle ne voit pas ces lignes, elle ne regarde rien.
for (const exemple of ["ouvre `http://<adresse-IP-du-PC>:8080`", "return `http://${ip}:8080`", "http://192.168.1.5:8080", "http://IP:port", 'f"http://{ip}:8080"']) {
  check(`la règle voit : ${exemple}`, HTTP_IP.test(exemple));
}
check("la règle laisse https et localhost", !HTTP_IP.test("https://1-2-3-4.sslip.io") && !HTTP_IP.test("http://localhost:8080"));

// VPS : seul Caddy publie un port, et le port 80 ne fait que rediriger vers HTTPS.
const compose = readFileSync(join(ROOT, "deploy/docker-compose.yml"), "utf8");
const services = compose.split(/^services:/m)[1].split(/^configs:/m)[0];
const blocs = Object.fromEntries(services.split(/^  (?=\w[\w-]*:\s*$)/m).filter((b) => b.trim()).map((b) => [b.split(":")[0].trim(), b]));
check("VPS : le serveur ne publie aucun port", !/^\s+ports:/m.test(blocs.server));
check("VPS : le lanceur ne publie aucun port", !/^\s+ports:/m.test(blocs.launcher));
check("VPS : http:// redirige vers https://", /http:\/\/ \{[\s\S]*?redir https:\/\/\{host\}\{uri\} permanent/.test(compose));
const traefik = readFileSync(join(ROOT, "deploy/docker-compose.traefik.yml"), "utf8");
check("Traefik : le serveur reste sur la boucle locale, le routeur sur websecure", /NOAH_PUBLISH:-127\.0\.0\.1:/.test(traefik) && /entrypoints: websecure/.test(traefik));

// La sortie réelle des scripts : un serveur qui écrit son lien, un autre qui n'a pas encore d'adresse.
const tmp = mkdtempSync(join(tmpdir(), "noah-g51-"));
const lance = (journal) => {
  writeFileSync(join(tmp, "journal.txt"), journal);
  const r = spawnSync("docker", ["run", "--rm", "-v", `${ROOT}:/depot:ro`, "-v", `${tmp}:/j:ro`, "alpine:3", "sh", "/depot/tests/pwa/sortie_scripts.sh", "/depot", "/j/journal.txt"], { encoding: "utf8", timeout: 240000 });
  return { code: r.status, get: (r.stdout || "").split("=== install.sh")[0], install: (r.stdout || "").split("=== install.sh")[1] || "", err: r.stderr };
};
const pret = "\n\n  Noah est prêt. Ouvre ce lien pour créer ton compte :\n\n    https://1-2-3-4.sslip.io/#installation=BCDFGHJKLMNP\n\n  Code d'installation : BCDFGHJKLMNP\n";
const uvicorn = "INFO:     Uvicorn running on http://0.0.0.0:8080 (Press CTRL+C to quit)\n";
const a = lance(uvicorn + pret);
check("les scripts tournent (faux docker)", a.code === 0, a.code ? (a.get + a.err).slice(-400) : "");
check("get.sh donne le lien HTTPS, le code après le #", a.get.includes("https://1-2-3-4.sslip.io/#installation=BCDFGHJKLMNP") && !/\?installation=/.test(a.get), a.get.trim().split("\n").pop());
check("get.sh ne donne aucune adresse http://", !/http:\/\//.test(a.get));
const b = lance("INFO: démarrage\n");
check("get.sh sans adresse encore connue : aucune adresse inventée", !/https?:\/\/\S/.test(b.get.replace(/https:\/\/get\.docker\.com/g, "")), b.get.trim().split("\n").pop());
// Installation sur l'ordinateur : pas de certificat possible ; localhost est un contexte sécurisé (voir tests/real/urls_https.mjs).
const urls = a.install.match(/https?:\/\/[^\s)]+/g) || [];
check("install.sh ne donne que localhost", urls.length > 0 && urls.every((u) => /^http:\/\/localhost:\d+/.test(u) || u.startsWith("https://docs.docker.com") || u.startsWith("https://get.docker.com")), urls.join(" "));
rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });

console.log(echecs.length ? `\n${echecs.length} échec(s)` : "\nG5.1 (lecture et sortie des scripts) : aucun http://IP:port.");
process.exit(echecs.length ? 1 : 0);
