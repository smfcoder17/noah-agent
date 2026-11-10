// De bout en bout : le vrai serveur dans Docker, le vrai noah.py de l'agent, la vraie boucle de l'application de bureau (sans
// sa fenêtre), un vrai disque. Prouve qu'un agent sur un serveur écrit dans un dossier de l'ordinateur, et rien en dehors.
//   node tests/desktop/pont_reel.mjs
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeElectron } from "./electron_factice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const NAME = `noah-pont-reel-${process.pid}`;
const PORT = 18000 + (process.pid % 900);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, ok ? "" : String(detail).slice(0, 400));
  if (!ok) echecs.push(nom);
};
const sha = (data) => createHash("sha256").update(data).digest("hex");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

const base = mkdtempSync(join(tmpdir(), "noah-pont-"));
const confie = join(base, "Documents");
const lecture = join(base, "Photos");
mkdirSync(confie);
mkdirSync(lecture);
writeFileSync(join(confie, "note.txt"), "écrit par la personne");
writeFileSync(join(confie, ".env"), "CLE=secrete");
writeFileSync(join(base, "dehors.txt"), "contenu-du-dehors");
writeFileSync(join(lecture, "vacances.txt"), "souvenir");

// Le serveur, avec un compte, un agent, sa conversation et une session d'ordinateur.
const BOOT = `
import json, os, sys
sys.path.insert(0, "/app")
os.environ.update(NOAH_DATA_DIR="/tmp/noah-data", LAUNCHER_KEY="x", NOAH_SECRET_KEY="y" * 32)
os.makedirs("/tmp/noah-data", exist_ok=True)
from noah import auth, db, hermes, main, relay
db.init()
first = not os.path.exists("/tmp/ready.json")
if first:
    user = auth.create_user("alice", "motdepasse-a")
    with db.connect() as c:
        c.execute("INSERT INTO agents (id, name, role, api_key, owner_id) VALUES ('a1', 'Nadine', '', 'k', ?)", (user,))
    # Comme dans l'app : #36 rattache chaque accord à la conversation de l'agent.
    main._new_conversation(user, "a1", "Pont réel", main=True)
    token = auth.new_session(user, "Bureau", "desktop")
tool = hermes.AGENT_TOOL.replace("http://noah-server:8080/agent-api", "http://127.0.0.1:8080/agent-api").replace("__TOKEN__", relay.token_for("a1"))
open("/tmp/noah.py", "w", encoding="utf8").write(tool)
if first:
    json.dump({"token": token, "appareil": auth.device_id(auth.digest(token))}, open("/tmp/ready.json", "w"))
import uvicorn
uvicorn.run(main.app, host="0.0.0.0", port=8080, log_level="warning")
`;
writeFileSync(join(base, "boot.py"), BOOT);
const started = docker("run", "-d", "--rm", "--name", NAME, "-p", `127.0.0.1:${PORT}:8080`, "-v", `${join(ROOT, "server")}:/app:ro`, "-v", `${join(base, "boot.py")}:/boot.py:ro`,
  "python:3.12-slim", "sh", "-c", "pip install -q -r /app/requirements.txt 2>/dev/null; python /boot.py");
if (started.status) {
  console.error(started.stderr);
  process.exit(2);
}

// Jamais bloquant : l'application tourne dans ce même processus, et doit pouvoir répondre à l'agent qui l'attend.
const agent = (...args) => new Promise((resolve) => {
  const child = spawn("docker", ["exec", NAME, "python3", "/tmp/noah.py", ...args], { env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  child.on("close", () => {
    try {
      resolve(JSON.parse(out));
    } catch {
      resolve({ illisible: out });
    }
  });
});

let listening;
let ended = false;
const finish = (code) => {
  if (ended) return;
  ended = true;
  listening?.stop();
  docker("rm", "-f", NAME);
  rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  console.log(echecs.length ? `\n${echecs.length} échec(s) : ${echecs.join(" ; ")}` : "\nPont réel : un agent sur le serveur travaille dans un dossier de l'ordinateur, et rien n'en sort.");
  process.exit(code);
};
process.on("uncaughtException", (e) => {
  console.error(e);
  echecs.push("exception");
  finish(1);
});

let ready = null;
for (let i = 0; i < 240 && !ready; i += 1) {
  await sleep(1000);
  const out = docker("exec", NAME, "cat", "/tmp/ready.json");
  if (out.status === 0 && out.stdout) {
    try {
      await fetch(`${ORIGIN}/api/status`);
      ready = JSON.parse(out.stdout);
    } catch {
      /* il démarre */
    }
  }
}
if (!ready) {
  console.error(docker("logs", NAME).stderr);
  echecs.push("le serveur ne démarre pas");
  finish(2);
}

// L'application de bureau, sans sa fenêtre : seules les surfaces Electron sont factices.
let autoriser = false;
const bandeaux = [], clics = [];
const electron = fakeElectron();
electron.session.defaultSession.cookies.get = async () => [{ value: ready.token }];
electron.shell = { openExternal: async () => {}, openPath: async () => "" };
electron.onRequest = (shown) => {
  bandeaux.push(shown);
  const response = autoriser ? 0 : shown.refuseIndex;
  // La vraie voie IPC de bandeau.js vérifie le fichier, la frame et l'identifiant d'affichage.
  queueMicrotask(() => clics.push({ id: shown.id, response, accepte: electron.answer(shown.id, response) }));
};
const charger = Module._load;
Module._load = function (demande, ...reste) {
  return demande === "electron" ? electron : charger.call(this, demande, ...reste);
};
const require = createRequire(import.meta.url);
const { listen, configure } = require(join(ROOT, "desktop/actions.js"));
require(join(ROOT, "desktop/bandeau.js")).create(electron.win);
configure({ autonomy: () => "auto" });
const dossiers = require(join(ROOT, "desktop/dossiers.js"));
Module._load = charger;

const store = dossiers.createStore(join(base, "profil", "dossiers.json"));
const documents = store.add(confie);
const photos = store.add(lecture);
store.setWrite(documents.id, true);
listening = listen(() => ORIGIN, store);

const online = async () => {
  for (let i = 0; i < 40; i += 1) {
    const list = (await agent("appareils")).appareils ?? [];
    if (list.find((d) => d.id === ready.appareil)?.en_ligne) return list;
    await sleep(500);
  }
  return [];
};

// 1. L'agent voit l'ordinateur et ses dossiers, jamais leur chemin.
const list = await online();
const moi = list.find((d) => d.id === ready.appareil);
check("l'agent voit l'ordinateur en ligne", moi?.en_ligne === true, JSON.stringify(list));
check("il voit les dossiers et leur droit", moi?.dossiers?.length === 2 && moi.dossiers.find((d) => d.nom === "Documents")?.ecriture === true, JSON.stringify(moi));
check("il ne voit aucun chemin", !JSON.stringify(list).includes(base.replace(/\\/g, "\\\\")) && !JSON.stringify(list).includes("chemin"), JSON.stringify(list));

// 2. Écrire un vrai fichier, gros et binaire.
const contenu = randomBytes(5 * 1024 * 1024);
writeFileSync(join(base, "local.bin"), contenu);
docker("cp", join(base, "local.bin"), `${NAME}:/tmp/rapport.bin`);
let out = await agent("ordinateur", "ecrire", "Documents", "rapports/lundi.pdf", "/tmp/rapport.bin");
const ecrit = join(confie, "rapports", "lundi.pdf");
check("l'agent écrit dans le dossier de l'ordinateur", out.ok === true && existsSync(ecrit), JSON.stringify(out));
check("le fichier arrive identique", existsSync(ecrit) && sha(readFileSync(ecrit)) === sha(contenu));
out = await agent("ordinateur", "ecrire", "Documents", "rapports/lundi.pdf", "/tmp/rapport.bin");
check("le même nom : une copie à côté, l'ancien reste", out.chemin === "rapports/lundi (2).pdf" && readdirSync(join(confie, "rapports")).length === 2, JSON.stringify(out));
const nbBandeaux = bandeaux.length;
check("écrire en Auto ne demande aucun accord", nbBandeaux === 0);

// 3. Lister et lire, sans fenêtre.
out = await agent("ordinateur", "lister", "Documents");
const noms = (out.elements ?? []).map((e) => e.nom);
check("lister montre le dossier, sans .env", noms.includes("note.txt") && noms.includes("rapports") && !noms.includes(".env"), JSON.stringify(out));
out = await agent("ordinateur", "lire", "Documents", "note.txt");
const lu = docker("exec", NAME, "cat", out.fichier ?? "/n-existe-pas");
check("lire copie le fichier dans la machine de l'agent", out.ok === true && lu.stdout === "écrit par la personne", JSON.stringify(out) + lu.stderr);
check("lire et écrire passent sans déranger la personne", bandeaux.length === nbBandeaux);

// 4. Ce qui ne doit pas passer.
out = await agent("ordinateur", "lire", "Documents", "../dehors.txt");
check("lire hors du dossier : refusé", out.refuse === true && !JSON.stringify(out).includes("contenu-du-dehors"), JSON.stringify(out));
out = await agent("ordinateur", "lire", "Documents", ".env");
check("lire un fichier sensible : refusé", out.refuse === true && !JSON.stringify(out).includes("secrete"), JSON.stringify(out));
out = await agent("ordinateur", "ecrire", "Documents", "../evade.bin", "/tmp/rapport.bin");
check("écrire hors du dossier : refusé", out.refuse === true && !existsSync(join(base, "evade.bin")), JSON.stringify(out));
out = await agent("ordinateur", "ecrire", "Photos", "neuf.bin", "/tmp/rapport.bin");
check("écrire en lecture seule : refusé", out.refuse === true && !existsSync(join(lecture, "neuf.bin")), JSON.stringify(out));
out = await agent("ordinateur", "lister", "Inconnu");
check("un dossier non confié : refusé", out.refuse === true, JSON.stringify(out));

// 5. Refus puis accord par le bandeau réel : le fichier témoin prouve ce qui s'est exécuté.
const avant = bandeaux.length;
autoriser = false;
const temoin = join(confie, "accord-execute.txt");
const ordre = process.platform === "win32"
  ? "Write-Output (Get-Location).Path; Set-Content -LiteralPath 'accord-execute.txt' -Value 'accorde'"
  : "/bin/pwd; printf accorde > accord-execute.txt";
out = await agent("ordinateur", "commande", ordre, "--dossier", "Documents");
check("refus reçu par noah:accord depuis le bandeau", bandeaux.length === avant + 1 && clics.at(-1)?.id === bandeaux.at(-1)?.id
  && clics.at(-1)?.response === bandeaux.at(-1)?.refuseIndex && clics.at(-1)?.accepte === true);
check("commande refusée dans le bandeau : rien ne s'exécute", out.refuse === true && !existsSync(temoin), JSON.stringify(out));
check("le bandeau dit que le dossier n'enferme pas la commande", /n'enferme pas/.test(bandeaux.at(-1)?.detail ?? ""));
check("le bandeau montre le dossier et la commande exacts", bandeaux.at(-1)?.detail.startsWith(`Dans : ${confie}\n`)
  && bandeaux.at(-1)?.detail.endsWith(`Commande :\n${ordre}`));
autoriser = true;
out = await agent("ordinateur", "commande", ordre, "--dossier", "Documents");
check("accord reçu par noah:accord depuis le nouveau bandeau", bandeaux.length === avant + 2 && clics.at(-1)?.id === bandeaux.at(-1)?.id
  && clics.at(-1)?.response === 0 && clics.at(-1)?.accepte === true);
check("commande acceptée : tourne dans le dossier confié", out.ok === true && out.code === 0 && out.dossier === "Documents"
  && (out.sortie ?? "").trim() === confie && existsSync(temoin) && readFileSync(temoin, "utf8").trim() === "accorde", JSON.stringify(out));

// 6. « Couper l'accès » arrête tout, tout de suite.
store.setCut(true);
out = await agent("ordinateur", "lister", "Documents");
check("accès coupé : l'agent est arrêté", out.coupe === true, JSON.stringify(out));
store.setCut(false);
autoriser = false;

// 7. Ordinateur éteint : le fichier attend sur le serveur, et arrive à la reconnexion, une seule fois.
listening.stop();
for (let i = 0; i < 20; i += 1) {
  const seen = (await agent("appareils")).appareils?.find((d) => d.id === ready.appareil);
  if (seen && !seen.en_ligne) break;
  await sleep(5000);
}
out = await agent("ordinateur", "ecrire", "Documents", "routine/resultat.pdf", "/tmp/rapport.bin");
check("ordinateur éteint : le fichier attend", out.attente === true && !existsSync(join(confie, "routine")), JSON.stringify(out));
const attente = (await agent("appareils")).appareils?.find((d) => d.id === ready.appareil)?.attente;
check("l'agent voit le fichier en attente", attente === 1, String(attente));
docker("restart", NAME);
await sleep(3000);
for (let i = 0; i < 120; i += 1) {
  try {
    await fetch(`${ORIGIN}/api/status`);
    break;
  } catch {
    await sleep(1000);
  }
}
listening = listen(() => ORIGIN, store);
const arrive = join(confie, "routine", "resultat.pdf");
for (let i = 0; i < 60 && !existsSync(arrive); i += 1) await sleep(500);
check("après un redémarrage du serveur, il arrive à la reconnexion", existsSync(arrive) && sha(readFileSync(arrive)) === sha(contenu));
await sleep(1500);
check("une seule fois", existsSync(join(confie, "routine")) && readdirSync(join(confie, "routine")).length === 1);
let restant = 1;
for (let i = 0; i < 20 && restant; i += 1) {
  restant = (await agent("appareils")).appareils?.find((d) => d.id === ready.appareil)?.attente ?? 0;
  if (restant) await sleep(500);
}
check("plus rien n'attend sur le serveur", restant === 0, String(restant));

finish(echecs.length ? 1 : 0);
