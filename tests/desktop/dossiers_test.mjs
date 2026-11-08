// Les barrières de l'application de bureau, sur un vrai disque : confinement, droits, écriture sans perte, accords.
//   node tests/desktop/dossiers_test.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const d = require(join(ROOT, "desktop/dossiers.js"));
const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, ok ? "" : detail);
  if (!ok) echecs.push(nom);
};
const refused = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof d.Refus;
  }
};
const refusedAsync = async (fn) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof d.Refus;
  }
};

const base = mkdtempSync(join(tmpdir(), "noah-dossiers-"));
const dehors = join(base, "dehors");
const racine = join(base, "confie");
mkdirSync(dehors);
mkdirSync(join(racine, "sous"), { recursive: true });
writeFileSync(join(dehors, "secret.txt"), "à ne pas lire");
writeFileSync(join(racine, "note.txt"), "bonjour");
writeFileSync(join(racine, "sous", "a.txt"), "a");
writeFileSync(join(racine, ".env"), "CLE=secrete");
mkdirSync(join(racine, ".git"));
writeFileSync(join(racine, ".git", "config"), "x");
// Une jonction marche sans droit particulier sous Windows ; ailleurs, c'est un lien ordinaire.
symlinkSync(dehors, join(racine, "sortie"), "junction");
// Sous Windows, un lien vers un fichier demande un droit que tout le monde n'a pas : ces deux cas se jouent alors sous Linux.
let liensFichier = true;
try {
  symlinkSync(join(dehors, "secret.txt"), join(racine, "lien.txt"), "file");
  symlinkSync(join(base, "n-existe-pas"), join(racine, "mort"), "file");
} catch (e) {
  if (e.code !== "EPERM") throw e;
  liensFichier = false;
  console.log("(liens vers un fichier non permis ici)");
}

// 1. Confinement.
for (const [nom, chemin] of [
  ["remontée", "../dehors/secret.txt"],
  ["remontée cachée au milieu", "sous/../../dehors/secret.txt"],
  ["remontée en barres Windows", "..\\dehors\\secret.txt"],
  ["chemin absolu", join(dehors, "secret.txt")],
  ["racine Unix", "/etc/passwd"],
  ["disque Windows", "C:\\Windows\\win.ini"],
  ["flux alternatif", "note.txt:secret"],
  ["nom réservé", "sous/con.txt"],
  ["point final", "note.txt."],
  ["octet nul", "note\0.txt"],
]) check(`refus : ${nom}`, await refusedAsync(() => d.read(racine, chemin)));
check("refus : jonction qui sort du dossier", await refusedAsync(() => d.read(racine, "sortie/secret.txt")));
if (liensFichier) {
  check("refus : lien vers un fichier dehors", await refusedAsync(() => d.read(racine, "lien.txt")));
  check("refus : lien mort, dont la cible serait créée dehors", refused(() => d.resolve(racine, "mort")));
}
check("lecture permise dans le dossier", (await d.read(racine, "sous/a.txt")).data.toString() === "a");

// 2. Fichiers sensibles.
for (const nom of [".env", ".git/config"]) check(`sensible refusé : ${nom}`, await refusedAsync(() => d.read(racine, nom)));
for (const nom of [".env.local", "id_rsa", "cle.pem", "coffre.kdbx", "wallet.dat", ".ssh/known_hosts", "sous/.aws/config", ".credentials.json", "prod.env", ".envrc", "id_ed25519_github", "id_rsa.bak", "application_default_credentials.json", "secrets.prod.yaml", "secrets/db.yaml", ".bash_history", "ConsoleHost_history.txt", "Login Data", "Local State", "logins.json", "key4.db", "terraform.tfstate", ".vault-token", "token.json", "wallet.json", "seed.txt", "kubeconfig", "mots de passe.txt", "mot_de_passe.csv", "mdp.txt", "login.keychain-db", "authorized_keys"]) {
  check(`sensible refusé à l'écriture : ${nom}`, await refusedAsync(() => d.write({ nom: "x", chemin: racine, ecriture: true }, nom, Buffer.from("x"))));
}
check("un document ordinaire n'est pas pris pour un secret", d.resolve(racine, "Secret Santa 2026.docx") && d.resolve(racine, "rapport tokens.pdf") !== null);
for (const nom of ["fichier\nfaux.txt", "facture\u202Efdp.exe", "a\u200Bb.txt", "a\u0001b.txt"]) check(`nom trompeur refusé : ${JSON.stringify(nom)}`, refused(() => d.resolve(racine, nom)));
check("un emoji composé reste permis", d.resolve(racine, "famille 👨‍👩‍👧.txt") !== null);
const dossierCles = join(base, ".ssh");
mkdirSync(dossierCles);
check("un dossier de clés confié lui-même reste refusé", d.refusedRoot(dossierCles) && refused(() => d.resolve(dossierCles, "authorized_keys")));
check("un disque entier ne se confie pas", d.refusedRoot(process.platform === "win32" ? "C:\\" : "/"));
const vu = d.list(racine);
const noms = vu.elements.map((e) => e.nom);
check("la liste montre le dossier", noms.includes("note.txt") && noms.includes("sous"));
check("la liste cache sensibles et ce qui sort", !noms.some((n) => [".env", ".git", "sortie", "lien.txt", "mort"].includes(n)), noms.join());
check("la liste dit qu'il y a des éléments cachés", vu.caches >= (liensFichier ? 4 : 3), String(vu.caches));

// 3. Écriture.
const lecture = { id: "l", nom: "lecture", chemin: racine, ecriture: false };
const ecriture = { id: "e", nom: "ecriture", chemin: racine, ecriture: true };
check("lecture seule : écriture refusée", await refusedAsync(() => d.write(lecture, "neuf.txt", Buffer.from("x"))) && !existsSync(join(racine, "neuf.txt")));
let r = await d.write(ecriture, "neuf/profond/rapport.txt", Buffer.from("v1"));
check("écrit et crée les dossiers", r.ok && readFileSync(join(racine, "neuf/profond/rapport.txt"), "utf8") === "v1" && r.chemin === "neuf/profond/rapport.txt", JSON.stringify(r));
let asked = 0;
const non = async () => (asked += 1, false);
const oui = async () => (asked += 1, true);
r = await d.write(ecriture, "note.txt", Buffer.from("autre"));
check("sans accord : l'ancien reste, une copie à côté", readFileSync(join(racine, "note.txt"), "utf8") === "bonjour" && r.chemin === "note (2).txt" && r.copie, JSON.stringify(r));
r = await d.write(ecriture, "note.txt", Buffer.from("refusé"), { remplacer: true, ask: non });
check("remplacer refusé : copie, et l'accord a bien été demandé", readFileSync(join(racine, "note.txt"), "utf8") === "bonjour" && asked === 1 && r.chemin === "note (3).txt", JSON.stringify(r));
r = await d.write(ecriture, "note.txt", Buffer.from("remplacé"), { remplacer: true, ask: oui });
check("remplacer accepté : remplacé d'un coup", readFileSync(join(racine, "note.txt"), "utf8") === "remplacé" && r.chemin === "note.txt", JSON.stringify(r));
r = await d.write(ecriture, "lance.ps1", Buffer.from("x"), { ask: non });
check("un programme demande un accord, refusé : rien d'écrit", r.refuse && !existsSync(join(racine, "lance.ps1")), JSON.stringify(r));
const avantActifs = asked;
const actifs = ["a.scf", "desktop.ini", "autorun.inf", "a.pif", "a.docm", "a.chm", "a.iso", "a.library-ms", "a.settingcontent-ms", "a.msc", "a.application", "a.xll", ".gitconfig", ".bashrc", "Makefile", "package.json", ".vscode/tasks.json", "a.html", "a.svg", "sans-extension"];
for (const nom of actifs) {
  r = await d.write(ecriture, nom, Buffer.from("x"), { ask: non });
  check(`peut agir, donc accord demandé : ${nom}`, r.refuse === true && !existsSync(join(racine, nom)), JSON.stringify(r));
}
check("chaque type actif a bien ouvert une fenêtre", asked === avantActifs + actifs.length, String(asked - avantActifs));
asked = 0;
for (const nom of ["doc.pdf", "tableau.xlsx", "photo.jpg", "notes.md", "donnees.csv", "video.mp4", "config.json"]) {
  r = await d.write(ecriture, `sains/${nom}`, Buffer.from("x"), { ask: non });
  check(`document : écrit sans déranger : ${nom}`, r.ok === true && asked === 0, JSON.stringify(r));
}
asked = 3;
r = await d.write(ecriture, "note.txt", Buffer.from("tard"), { recheck: () => ({ coupe: true }) });
check("accès coupé juste avant de publier : rien d'écrit", r.coupe === true && !existsSync(join(racine, "note (4).txt")), JSON.stringify(r));
if (process.platform === "win32") {
  await d.write(ecriture, "marque.pdf", Buffer.from("x"));
  check("le fichier porte la marque d'Internet", readFileSync(join(racine, "marque.pdf:Zone.Identifier"), "utf8").includes("ZoneId=3"));
}
const erreurDisque = await d.write(ecriture, "note.txt/sous/x.txt", Buffer.from("x")).catch((e) => d.explain(e));
check("une erreur du système ne dit jamais le chemin", !JSON.stringify(erreurDisque).includes(base) && !JSON.stringify(erreurDisque).includes(base.replace(/\\/g, "\\\\")), JSON.stringify(erreurDisque));
check("le remplacement passe aussi par « ask », jamais par le serveur", asked === 3, String(asked));
const ensemble = await Promise.all([1, 2, 3, 4, 5].map((n) => d.write(ecriture, "course.txt", Buffer.from(String(n)))));
check("écritures simultanées : aucune perte", new Set(ensemble.map((x) => x.chemin)).size === 5, JSON.stringify(ensemble.map((x) => x.chemin)));
check("aucun fichier temporaire laissé", !readdirSync(racine).some((n) => n.endsWith(".tmp")));
check("taille : 50 Mo au plus", await refusedAsync(() => d.write(ecriture, "gros.bin", Buffer.alloc(d.MAX_FILE + 1))));
check("contenu altéré en route : refusé", await refusedAsync(() => d.write(ecriture, "x.txt", Buffer.from("x"), { attendu: "0".repeat(64) })));
check("écrire à travers une jonction : refusé", await refusedAsync(() => d.write(ecriture, "sortie/x.txt", Buffer.from("x"))) && !existsSync(join(dehors, "x.txt")));

// 4. Ce que l'ordinateur retient.
const fichier = join(base, "profil", "dossiers.json");
let store = d.createStore(fichier);
const f = store.add(racine);
check("un dossier arrive en lecture seule", f.ecriture === false);
check("le serveur ne reçoit jamais le chemin", !JSON.stringify(store.shown()).includes("confie\\") && !("chemin" in store.shown()[0]));
store.attach("https://a.exemple", "c1");
store.setWrite(f.id, true);
store = d.createStore(fichier);
check("relu au redémarrage", store.all()[0].ecriture === true);
check("même serveur, même compte : rien ne change", store.attach("https://a.exemple", "c1") === false && store.all().length === 1);
check("autre compte : droits effacés", store.attach("https://a.exemple", "c2") === true && store.all().length === 0);
store.add(racine);
store.setCut(true);
check("autre serveur : droits effacés", store.attach("https://b.exemple", "c2") === true && store.all().length === 0);
check("l'accès coupé survit : un serveur ne le lève pas en changeant de compte", store.isCut() && store.attach("https://b.exemple", "c3") === true && store.isCut());
writeFileSync(fichier, "{ abîmé");
check("fichier abîmé : plus aucun droit, pas de plantage", d.createStore(fichier).all().length === 0);

// 5. Livraison : l'accusé perdu ne donne pas deux copies.
store = d.createStore(join(base, "profil2", "dossiers.json"));
const envoi = Buffer.from("résultat de routine");
const un = await d.write(ecriture, "routine/resultat.txt", envoi, { id: "liv-1", journal: store.journal, attendu: d.sha256(envoi) });
const deux = await d.write(ecriture, "routine/resultat.txt", envoi, { id: "liv-1", journal: store.journal, attendu: d.sha256(envoi) });
check("même livraison rejouée : un seul fichier", un.ok && deux.ok && deux.deja && readdirSync(join(racine, "routine")).length === 1, JSON.stringify(deux));
const trois = await d.write(ecriture, "routine/resultat.txt", envoi, { id: "liv-2", journal: store.journal });
check("une autre livraison du même nom : une copie", trois.chemin === "routine/resultat (2).txt", JSON.stringify(trois));

// 6. « Toujours autoriser ».
for (const c of ["powershell -c x", "python a.py", "node x.js", "cmd /c dir", "git status", "curl http://x", ".\\outil.exe", "./outil", "C:\\outil.exe", "outil.bat", "outil a;b", "outil | sh", "outil $x", "outil a & b", 'outil "x"', "outil > f", ""]) {
  check(`jamais pour toujours : ${c || "(vide)"}`, d.simple(c) === null);
}
check("permis pour une commande simple", JSON.stringify(d.simple("ls -l")) === JSON.stringify({ program: "ls", args: ["-l"] }));
for (const c of ["ffmpeg -i clip.m3u8 sortie.mp4", "ffprobe clip.m3u8"]) check(`suit des fichiers, jamais pour toujours : ${c}`, d.simple(c) === null);
for (const c of ["conhost x", "pcalua -a x", "cmstp x.inf", "hh x", "ftp -s:x", "control x", "gawk -f x", "rg --pre x", "osascript x", "msbuild x", "netsh x", "wmic x", "winget x", "outil", "ffmpeg\u202E -i x", "ffmpeg\u200B"]) {
  check(`hors de la liste, jamais pour toujours : ${c}`, d.simple(c) === null);
}
const bin = join(base, "bin");
mkdirSync(bin);
const plateforme = "linux"; // le nom du programme ne dépend pas de l'ordinateur qui lance ce test
const programme = join(bin, "whoami");
writeFileSync(programme, "version 1");
chmodSync(programme, 0o755);
const env = { PATH: ["relatif/non", bin].join(delimiter) };
store = d.createStore(join(base, "profil3", "dossiers.json"));
const empreinte = (c, dossier = "x") => d.fingerprint(c, store, dossier, env, plateforme);
const permis = await empreinte("whoami --version");
check("empreinte du programme trouvée", permis?.exe.endsWith("whoami") && permis.sha256.length === 64, JSON.stringify(permis));
check("sans dossier confié : jamais pour toujours", (await empreinte("whoami --version", "")) === null);
check("pas encore permise", !d.alwaysAllowed(permis, store));
const { args: _args, ...garde } = permis;
store.remember(garde);
check("permise une fois retenue", d.alwaysAllowed(await empreinte("whoami --version"), store));
check("une autre commande reste à demander", !d.alwaysAllowed(await empreinte("whoami --autre"), store));
check("un autre dossier reste à demander", !d.alwaysAllowed(await empreinte("whoami --version", "y"), store));
store.forgetAlways("whoami --version", "x");
check("oubliée à la demande", !d.alwaysAllowed(await empreinte("whoami --version"), store));
store.remember(garde);
writeFileSync(programme, "version 2, piégée");
check("le programme a changé : on redemande", !d.alwaysAllowed(await empreinte("whoami --version"), store));
const partage = join(base, "partage");
mkdirSync(partage);
writeFileSync(join(partage, "hostname"), "x");
store.add(partage);
const envPartage = { PATH: partage };
check("un programme dans un dossier confié n'est jamais permis pour toujours", (await d.fingerprint("hostname", store, "x", envPartage, plateforme)) === null);

// 7. L'application : fenêtres d'accord, sur le vrai actions.js avec un Electron factice.
let reponse = 1;
const boites = [], colle = [], ouvert = [];
let enCours = 0, maximum = 0;
const electron = {
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: (t) => colle.push(t) },
  dialog: {
    showMessageBox: async (_, o) => {
      enCours += 1;
      maximum = Math.max(maximum, enCours);
      boites.push(o);
      await new Promise((res) => setTimeout(res, 15));
      enCours -= 1;
      return { response: reponse };
    },
  },
  Notification: class { on() {} show() { ouvert.push("notification"); } },
  session: {},
  shell: { openExternal: async (u) => ouvert.push(u), openPath: async (p) => (ouvert.push(p), "") },
};
const charger = Module._load;
Module._load = function (demande, ...reste) {
  return demande === "electron" ? electron : charger.call(this, demande, ...reste);
};
const { perform } = require(join(ROOT, "desktop/actions.js"));
Module._load = charger;

let n = boites.length;
let out = await perform({ action: "lancer", agent: "A", cible: "calc'; Remove-Item x #" });
check("nom d'application piégé : refusé avant la fenêtre", out.erreur && boites.length === n, JSON.stringify(out));
out = await perform({ action: "lancer", agent: "A", cible: "C:\\Windows\\calc" });
check("un chemin n'est pas un nom d'application", out.erreur && boites.length === n);
check("le nom n'entre jamais dans le texte du script", readFileSync(join(ROOT, "desktop/actions.js"), "utf8").includes("$env:NOAH_APP"));
out = await perform({ action: "presse_papiers", agent: "A", texte: "x".repeat(2001) });
check("texte trop long pour être montré : refusé, rien de copié", out.erreur && colle.length === 0 && boites.length === n);
writeFileSync(join(racine, "piege.exe"), "x");
writeFileSync(join(racine, "piege.inconnu"), "x");
writeFileSync(join(racine, "ok.pdf"), "x");
for (const nom of ["piege.exe", "piege.inconnu"]) {
  out = await perform({ action: "ouvrir", agent: "A", cible: join(racine, nom) });
  check(`ouvrir refuse ce qui n'est pas sur la liste : ${nom}`, out.erreur && boites.length === n, JSON.stringify(out));
}
out = await perform({ action: "ouvrir", agent: "A", cible: `${racine}\\sous\\..\\ok.pdf`.replace(/\\/g, "/") });
check("ouvrir refuse un chemin qui remonte", out.erreur && boites.length === n, JSON.stringify(out));
reponse = 0;
out = await perform({ action: "ouvrir", agent: "A", cible: join(racine, "ok.pdf") });
check("ouvrir montre le chemin réel et l'ouvre après accord", out.ok && boites.at(-1).detail.endsWith("ok.pdf") && ouvert.at(-1).endsWith("ok.pdf"), JSON.stringify(out));
const avantClic = colle.length;
out = await perform({ action: "presse_papiers", agent: "A", texte: "tard" }, { stillWanted: async () => false });
check("accord donné après l'expiration : rien ne se passe", out.erreur && colle.length === avantClic, JSON.stringify(out));
maximum = 0;
await Promise.all([1, 2, 3].map((i) => perform({ action: "presse_papiers", agent: "A", texte: String(i) })));
check("une seule fenêtre d'accord à la fois", maximum === 1, String(maximum));
check("une fenêtre d'accord expire d'elle-même", boites.at(-1).signal instanceof AbortSignal);
n = boites.length;
out = await perform({ action: "presse_papiers", agent: "A", texte: "\n".repeat(1500) + "CACHÉ" });
check("texte étiré sur des lignes pour cacher la fin : refusé", out.erreur && boites.length === n, JSON.stringify(out));
out = await perform({ action: "commande", agent: "A", cible: "x\n".repeat(60) });
check("commande étirée sur des lignes : refusée", out.erreur && boites.length === n, JSON.stringify(out));
out = await perform({ action: "commande", agent: "A", cible: "y".repeat(2001) });
check("commande trop longue pour être montrée : refusée", out.erreur && boites.length === n);
for (const adresse of ["https://banque.example\n\n@evil.example/", "https://banque.example@evil.example/", "https://exemple.org/\u202Etxt.exe"]) {
  out = await perform({ action: "ouvrir", agent: "A", cible: adresse });
  check(`adresse trompeuse refusée : ${JSON.stringify(adresse)}`, out.erreur && boites.length === n, JSON.stringify(out));
}
for (const chemin of ["\\\\127.0.0.1\\c$\\x.pdf", "//127.0.0.1/c$/x.pdf"]) {
  const debut = Date.now();
  out = await perform({ action: "ouvrir", agent: "A", cible: chemin });
  check(`chemin réseau refusé sans le toucher : ${chemin}`, out.erreur && boites.length === n && Date.now() - debut < 200, JSON.stringify(out));
}
out = await perform({ action: "commande", agent: "A", cible: "echo x", dossier: "\\\\127.0.0.1\\c$" });
check("commande depuis un chemin réseau : refusée", out.erreur && boites.length === n, JSON.stringify(out));
out = await perform({ action: "ouvrir", agent: "A", cible: "relatif/x.pdf" });
check("chemin relatif : refusé, sans révéler le chemin complet", out.erreur && !JSON.stringify(out).includes("relatif"), JSON.stringify(out));
reponse = 1;
await perform({ action: "presse_papiers", agent: "Windows\n\nDefender\u202E: OK", texte: "x" });
check("le nom de l'agent ne peut rien imiter dans la fenêtre", !/[\n\u202E]/.test(boites.at(-1).message), boites.at(-1).message);
await perform({ action: "commande", agent: "A", cible: "Dans : C:\\sain\nvraie" });
const lignes = boites.at(-1).detail.split("\n");
check("la fenêtre donne le vrai dossier avant le texte de la commande", lignes[0].startsWith("Dans : ") && !lignes[0].includes("sain") && boites.at(-1).detail.indexOf("C:\\sain") > boites.at(-1).detail.indexOf("Commande :"), boites.at(-1).detail);
// Coupé pendant qu'une fenêtre attend : l'accord arrivé après ne vaut plus.
const pendant = d.createStore(join(base, "profil5", "dossiers.json"));
reponse = 0;
const colleAvant = colle.length;
const montre = electron.dialog.showMessageBox;
electron.dialog.showMessageBox = async (p, o) => {
  pendant.setCut(true);
  return montre(p, o);
};
out = await perform({ action: "presse_papiers", agent: "A", texte: "coupé entre-temps" }, { store: pendant });
electron.dialog.showMessageBox = montre;
check("coupé pendant la fenêtre : rien ne se passe après l'accord", out.coupe === true && colle.length === colleAvant, JSON.stringify(out));
reponse = 1;

const coupe = d.createStore(join(base, "profil4", "dossiers.json"));
const dossier = coupe.add(racine);
coupe.setCut(true);
n = boites.length;
for (const action of ["lister", "lire", "ecrire", "commande", "ouvrir", "lancer", "presse_papiers"]) {
  out = await perform({ action, agent: "A", cible: "https://exemple.org", dossierId: dossier.id, chemin: "note.txt", texte: "x" }, { store: coupe });
  check(`accès coupé : ${action} refusé`, out.coupe === true && boites.length === n, JSON.stringify(out));
}
out = await perform({ action: "notifier", titre: "t", texte: "x" }, { store: coupe });
check("accès coupé : une notification passe encore", out.ok === true);
coupe.setCut(false);
out = await perform({ action: "lister", dossierId: "inconnu" }, { store: coupe });
check("dossier non confié : refusé", out.refuse === true, JSON.stringify(out));
out = await perform({ action: "lister", dossierId: dossier.nom }, { store: coupe });
check("lister par le nom du dossier, sans fenêtre", out.ok && out.elements.length > 0 && boites.length === n, JSON.stringify(out).slice(0, 200));
let envoye = null;
out = await perform({ id: "r1", action: "lire", dossierId: dossier.id, chemin: "sous/a.txt" }, { store: coupe, upload: async (id, data) => (envoye = [id, data.toString()]) });
check("lire envoie le fichier, sans fenêtre", out.ok && envoye?.[0] === "r1" && envoye[1] === "a" && boites.length === n, JSON.stringify(out));
out = await perform({ id: "r2", action: "lire", dossierId: dossier.id, chemin: "../dehors/secret.txt" }, { store: coupe, upload: async () => (envoye = "fuite") });
check("lire hors du dossier : refusé, rien d'envoyé", out.refuse && envoye !== "fuite", JSON.stringify(out));
out = await perform({ id: "w1", action: "ecrire", dossierId: dossier.id, chemin: "ecrit.txt" }, { store: coupe, download: async () => Buffer.from("x") });
check("écrire en lecture seule : refusé", out.refuse && !existsSync(join(racine, "ecrit.txt")), JSON.stringify(out));
coupe.setWrite(dossier.id, true);
out = await perform({ id: "w2", action: "ecrire", dossierId: dossier.id, chemin: "ecrit.txt", sha256: d.sha256(Buffer.from("x")) }, { store: coupe, download: async () => Buffer.from("x") });
check("écrire avec le droit : écrit, sans fenêtre", out.ok && readFileSync(join(racine, "ecrit.txt"), "utf8") === "x" && boites.length === n, JSON.stringify(out));
out = await perform({ id: "w3", action: "ecrire", dossierId: dossier.id, chemin: "ecrit2.txt" }, { store: coupe, download: async () => { throw Object.assign(new Error("réseau"), { plusTard: true }); } });
check("réseau coupé pendant la livraison : réessayée plus tard", out.plus_tard === true, JSON.stringify(out));

// Ranger : déplacer, renommer, créer un dossier, corbeille. Sans fenêtre, rien d'écrasé, rien hors du dossier.
const corbeille = [];
const jeter = async (cible) => {
  corbeille.push(cible);
  rmSync(cible, { recursive: true, force: true }); // la vraie corbeille garde l'élément : ici on vérifie seulement qu'il y part
};
const ctxRange = { store: coupe, trash: jeter, download: async () => Buffer.from("v2") };
n = boites.length;
out = await perform({ action: "creer_dossier", dossierId: dossier.id, chemin: "rangement/2026" }, ctxRange);
check("créer un dossier, sans fenêtre", out.ok && fs.statSync(join(racine, "rangement/2026")).isDirectory() && boites.length === n, JSON.stringify(out));
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "ecrit.txt", vers: "rangement/2026/ecrit.txt" }, ctxRange);
check("déplacer dans le dossier, sans fenêtre", out.ok && existsSync(join(racine, "rangement/2026/ecrit.txt")) && !existsSync(join(racine, "ecrit.txt")) && boites.length === n, JSON.stringify(out));
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement/2026/ecrit.txt", vers: "rangement/2026/renomme.txt" }, ctxRange);
check("renommer, sans fenêtre", out.ok && existsSync(join(racine, "rangement/2026/renomme.txt")), JSON.stringify(out));
writeFileSync(join(racine, "rangement/occupe.txt"), "à garder");
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement/2026/renomme.txt", vers: "rangement/occupe.txt" }, ctxRange);
check("déplacer sur un nom pris : refusé, rien d'écrasé", out.refuse && readFileSync(join(racine, "rangement/occupe.txt"), "utf8") === "à garder", JSON.stringify(out));
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement/occupe.txt", vers: "../dehors/vole.txt" }, ctxRange);
check("déplacer hors du dossier : refusé", out.refuse && !existsSync(join(dehors, "vole.txt")) && existsSync(join(racine, "rangement/occupe.txt")), JSON.stringify(out));
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement", vers: "rangement/2026/dedans" }, ctxRange);
check("un dossier dans lui-même : refusé", out.refuse && existsSync(join(racine, "rangement")), JSON.stringify(out));
reponse = 1;
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement/occupe.txt", vers: "rangement/occupe.ps1" }, ctxRange);
check("renommer en programme : fenêtre, refusé", out.refuse && boites.length === n + 1 && existsSync(join(racine, "rangement/occupe.txt")), JSON.stringify(out));
// Revue : un dossier déplacé vers un endroit lu par un outil (.github) demande l'accord, comme ses fichiers un à un.
mkdirSync(join(racine, "staging/workflows"), { recursive: true });
writeFileSync(join(racine, "staging/workflows/run.yml"), "on: push");
n = boites.length;
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "staging", vers: ".github" }, ctxRange);
check("dossier déplacé vers .github : fenêtre, refusé", out.refuse && boites.length === n + 1 && existsSync(join(racine, "staging/workflows/run.yml")), JSON.stringify(out));
// Revue : l'accès coupé pendant la fenêtre arrête le déplacement.
const montreAvant = electron.dialog.showMessageBox;
electron.dialog.showMessageBox = async (...a) => { coupe.setWrite(dossier.id, false); return montreAvant(...a).then(() => ({ response: 0 })); };
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement/occupe.txt", vers: "rangement/occupe.bat" }, ctxRange);
electron.dialog.showMessageBox = montreAvant;
coupe.setWrite(dossier.id, true);
check("écriture retirée pendant la fenêtre : rien ne bouge", out.refuse && existsSync(join(racine, "rangement/occupe.txt")) && !existsSync(join(racine, "rangement/occupe.bat")), JSON.stringify(out));
n = boites.length;
out = await perform({ action: "corbeille", dossierId: dossier.id, chemin: "rangement/2026/renomme.txt" }, ctxRange);
check("corbeille, sans fenêtre", out.ok && out.corbeille && corbeille.length === 1 && !existsSync(join(racine, "rangement/2026/renomme.txt")) && boites.length === n, JSON.stringify(out));
out = await perform({ action: "corbeille", dossierId: dossier.id, chemin: "" }, ctxRange);
check("corbeille du dossier confié lui-même : refusé", out.refuse && existsSync(racine), JSON.stringify(out));
out = await perform({ action: "corbeille", dossierId: dossier.id, chemin: "../dehors/secret.txt" }, ctxRange);
check("corbeille hors du dossier : refusé", out.refuse && existsSync(join(dehors, "secret.txt")), JSON.stringify(out));
out = await perform({ id: "w9", action: "ecrire", dossierId: dossier.id, chemin: "rangement/occupe.txt", remplacer: true, sha256: d.sha256(Buffer.from("v2")) }, ctxRange);
check("remplacer : l'ancienne version part à la corbeille, sans fenêtre", out.ok && readFileSync(join(racine, "rangement/occupe.txt"), "utf8") === "v2" && corbeille.length === 2 && boites.length === n, JSON.stringify(out));
coupe.setWrite(dossier.id, false);
out = await perform({ action: "deplacer", dossierId: dossier.id, chemin: "rangement/occupe.txt", vers: "x.txt" }, ctxRange);
const lectureSeule = out.refuse;
out = await perform({ action: "corbeille", dossierId: dossier.id, chemin: "rangement/occupe.txt" }, ctxRange);
check("lecture seule : ni déplacer ni corbeille", lectureSeule && out.refuse && existsSync(join(racine, "rangement/occupe.txt")), JSON.stringify(out));
coupe.setWrite(dossier.id, true);
for (const cmd of ["cd", "cd ..", "pwd", "Set-Location \"C:\\Mes documents\"", "Get-Location"]) {
  out = await perform({ action: "commande", agent: "A", cible: cmd, dossierId: dossier.id }, ctxRange);
  check(`« ${cmd} » seul : rien à faire, aucune fenêtre`, out.ok && boites.length === n, JSON.stringify(out));
}
out = await perform({ action: "commande", agent: "A", cible: "cd ..; Remove-Item x", dossierId: dossier.id }, ctxRange);
check("« cd » suivi d'autre chose : fenêtre comme avant", boites.length === n + 1, JSON.stringify(out));
n = boites.length;

// Coupé pendant la lecture : le contenu ne part pas.
const lecteur = d.createStore(join(base, "profil7", "dossiers.json"));
const lu = lecteur.add(racine);
const lectureLente = d.read;
let envoiApresCoupure = false;
d.read = async (...args) => {
  const out = await lectureLente(...args);
  lecteur.setCut(true);
  return out;
};
out = await perform({ id: "c1", action: "lire", dossierId: lu.id, chemin: "sous/a.txt" }, { store: lecteur, upload: async () => (envoiApresCoupure = true) });
d.read = lectureLente;
check("coupé pendant une lecture : rien ne part", out.coupe === true && !envoiApresCoupure, JSON.stringify(out));
// Le journal tient plus longtemps que le serveur ne peut redonner.
const journal = d.createStore(join(base, "profil8", "dossiers.json")).journal;
journal.note("premier", "h");
for (let i = 0; i < 600; i += 1) journal.note(`autre-${i}`, "h");
check("une livraison ancienne reste connue, même après 600 autres", journal.find("premier") !== null);
// Une écriture qui échoue en route ne laisse rien de partiel.
const ouvrir = fs.promises.open;
fs.promises.open = async (...args) => {
  const f = await ouvrir(...args);
  if (String(args[0]).endsWith(".tmp")) f.writeFile = async () => { throw Object.assign(new Error("plein"), { code: "ENOSPC" }); };
  return f;
};
const echecDisque = await d.write(ecriture, "plein.txt", Buffer.from("x")).catch((e) => e.code);
fs.promises.open = ouvrir;
check("disque plein : aucun fichier partiel", echecDisque === "ENOSPC" && !readdirSync(racine).some((n) => n.endsWith(".tmp")), String(echecDisque));

// 8. La boucle d'écoute : rien ne s'obtient d'un serveur tant que serveur et compte ne sont pas vérifiés.
const { listen } = require(join(ROOT, "desktop/actions.js"));
electron.session.defaultSession = { cookies: { get: async () => [{ value: "jeton" }] } };
const vraiFetch = globalThis.fetch;
const appels = [];
let battement = 503;
globalThis.fetch = async (url, init = {}) => {
  const chemin = new URL(url).pathname;
  appels.push(chemin);
  if (chemin.endsWith("/battement")) return new Response(JSON.stringify({ compte: "c1" }), { status: battement });
  if (chemin.endsWith("/next")) {
    await new Promise((res) => setTimeout(res, 50));
    return new Response(null, { status: 204 });
  }
  return new Response("{}", { status: 200 });
};
const autre = d.createStore(join(base, "profil6", "dossiers.json"));
autre.attach("https://ancien.exemple", "c1");
const garde2 = autre.add(racine);
const ecoute = listen(() => "https://nouveau.exemple", autre);
await new Promise((res) => setTimeout(res, 300));
check("autre serveur : les droits s'effacent avant de lui parler", autre.all().length === 0 && garde2.id.length > 0);
check("battement refusé : aucune demande n'est récupérée", !appels.some((c) => c.endsWith("/next")), appels.join());
ecoute.stop();
await new Promise((res) => setTimeout(res, 3200));
appels.length = 0;
battement = 404;
const ancienServeur = listen(() => "https://nouveau.exemple", autre);
await new Promise((res) => setTimeout(res, 300));
check("serveur d'avant les dossiers : l'application fonctionne encore", appels.some((c) => c.endsWith("/next")), appels.join());
ancienServeur.stop();
globalThis.fetch = vraiFetch;

rmSync(base, { recursive: true, force: true });
console.log(echecs.length ? `\n${echecs.length} échec(s) : ${echecs.join(" ; ")}` : "\nDossiers de l'ordinateur : tout tient.");
process.exit(echecs.length ? 1 : 0);
