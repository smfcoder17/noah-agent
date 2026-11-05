// G16.1 : les sources de tout ce qui est distribué sont publiques (serveur, lanceur, bureau, Android).
// La liste de ce qui est distribué vient des workflows, pas de ce fichier : une nouvelle image sans source fait échouer le test.
//
//   Sur le dépôt courant, sans réseau (CI) :
//     node tests/sources/sources_test.mjs --local
//   Pour de vrai, dans un conteneur neuf sans aucun identifiant : clone anonyme, API GitHub et registre GHCR sans jeton :
//     docker run --rm -v "$(pwd -W)/tests/sources:/t:ro" node:22-bookworm node /t/sources_test.mjs
//   Sabotages (le test doit échouer) : --saboter=depot, --saboter=bureau, --saboter=verrou, --saboter=image, --saboter=sous-module
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL = process.argv.includes("--local");
const SABOTAGE = (process.argv.find((a) => a.startsWith("--saboter=")) || "").split("=")[1] || "";
const REPO = SABOTAGE === "depot" ? "smfcoder17/noah-agent-inexistant" : process.env.NOAH_REPO || "smfcoder17/noah-agent";
const echecs = [];
const check = (nom, ok, detail = "") => {
  console.log(ok ? "OK   " : "ÉCHEC", nom, detail);
  if (!ok) echecs.push(nom);
};

const depotsGit = new Set();

/** Tout ce qui se lit dans une copie du dépôt : seuls les fichiers suivis par git comptent. */
function sourcesChecks(root) {
  const tracked = new Set(execFileSync("git", ["-c", "core.quotepath=off", "ls-files"], { cwd: root, maxBuffer: 1 << 28 }).toString().split("\n").filter(Boolean));
  const present = (p) => {
    const clean = p.replace(/^\.\//, "").replace(/\/$/, "");
    return clean === "." || tracked.has(clean) || [...tracked].some((t) => t.startsWith(`${clean}/`));
  };
  const read = (p) => readFileSync(join(root, p), "utf8");

  const release = read(".github/workflows/release.yml");
  const apps = read(".github/workflows/apps.yml");
  const images = [...release.matchAll(/- name: (\S+)\s+context: (\S+)\s+file: (\S+)/g)].map((m) => ({ nom: m[1], contexte: m[2], fichier: m[3] }));
  const dossiersApps = [...new Set([...apps.matchAll(/working-directory: (\S+)/g)].map((m) => m[1]))];
  console.log("distribué selon les workflows :", images.map((i) => i.nom).join(", "), "+ apps :", dossiersApps.join(", "));
  check("les 4 composants sont bien ceux que les workflows publient",
    images.some((i) => i.nom === "noah-server") && images.some((i) => i.nom === "noah-launcher") && dossiersApps.includes("desktop") && dossiersApps.includes("mobile"));

  for (const { nom, contexte, fichier } of images) {
    check(`${nom} : Dockerfile suivi par git`, tracked.has(fichier), fichier);
    if (!tracked.has(fichier)) continue;
    const texte = read(fichier);
    const copies = [...texte.matchAll(/^COPY\s+(?!--from)(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1));
    const absents = copies.map((c) => join(contexte, c).replace(/\\/g, "/")).filter((c) => !present(c));
    check(`${nom} : tout ce que COPY embarque est public (${copies.length} chemins)`, copies.length > 0 && absents.length === 0, absents.join(" "));
    check(`${nom} : aucun ADD depuis une adresse`, !/^ADD\s+https?:/m.test(texte));
    check(`${nom} : les dépendances Python viennent d'un index public`, !/--index-url|--extra-index-url|git\+ssh/.test(texte));
  }
  const reqs = "server/requirements.txt";
  check("serveur : requirements.txt suivi, sans dépôt privé", tracked.has(reqs) && !/--index-url|--extra-index-url|git\+|https?:\/\//.test(read(reqs)));

  // Bureau et Android : ce que electron-builder et Gradle assemblent.
  const bureau = JSON.parse(read("desktop/package.json"));
  const fichiersBureau = (bureau.build?.files || []).filter((f) => !/[*!]/.test(f));
  const absentsBureau = [bureau.main, ...fichiersBureau].filter((f) => f && !present(`desktop/${f}`));
  check(`bureau : point d'entrée et fichiers embarqués suivis (${fichiersBureau.length + 1})`, !!bureau.main && absentsBureau.length === 0, absentsBureau.join(" "));
  const capacitor = JSON.parse(read("mobile/capacitor.config.json"));
  const android = ["mobile/package.json", "mobile/capacitor.config.json", `mobile/${capacitor.webDir}`, "mobile/android/gradlew",
    "mobile/android/gradle/wrapper/gradle-wrapper.jar", "mobile/android/gradle/wrapper/gradle-wrapper.properties",
    "mobile/android/app/build.gradle", "mobile/android/app/src/main/AndroidManifest.xml"];
  const absentsAndroid = android.filter((p) => !present(p));
  check(`Android : ${android.length} éléments de construction suivis`, absentsAndroid.length === 0, absentsAndroid.join(" "));
  const gradle = [...tracked].filter((t) => /^mobile\/android\/.*\.gradle$/.test(t)).map(read).join("\n");
  const depots = [...gradle.matchAll(/maven\s*\{\s*url\s*['"=\s(]*([^'")\s]+)/g)].map((m) => m[1]).filter((u) => !/^(\$|project\b|rootProject|new\b)/.test(u) && /^https?:/.test(u));
  check("Android : aucun dépôt Maven privé", depots.every((u) => /(^https:\/\/(maven\.google\.com|repo\.maven\.apache\.org|jitpack\.io))/.test(u)), depots.join(" "));

  for (const verrou of ["frontend/package-lock.json", "desktop/package-lock.json", "mobile/package-lock.json"]) {
    if (!tracked.has(verrou)) {
      check(`${verrou} suivi`, false);
      continue;
    }
    const paquets = Object.entries(JSON.parse(read(verrou)).packages || {});
    const hors = paquets.filter(([, v]) => v.resolved && !v.resolved.startsWith("https://registry.npmjs.org/") && !v.link);
    // Un paquet pris directement sur GitHub : son dépôt est vérifié à part, sans identifiant.
    for (const [, v] of hors) {
      const m = v.resolved.match(/^git\+ssh:\/\/git@github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?#/);
      if (m) depotsGit.add(m[1]);
    }
    const prives = hors.filter(([, v]) => !/^git\+ssh:\/\/git@github\.com\//.test(v.resolved)).map(([k]) => k);
    check(`${verrou} : ${paquets.length} paquets, sur le registre public npm ou GitHub`, paquets.length > 1 && prives.length === 0, prives.slice(0, 5).join(" "));
  }
  check("aucun sous-module (il pourrait pointer vers un dépôt privé)", !tracked.has(".gitmodules"));
  check("licence présente", tracked.has("LICENSE"));
  return images;
}

async function anonymous(url, headers = {}) {
  return fetch(url, { headers: { "User-Agent": "noah-sources-test", ...headers }, signal: AbortSignal.timeout(30000) });
}

const MANIFESTES = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/** Les labels d'une image publiée, lus sans identifiant : ce que voit n'importe qui. */
async function publishedLabels(repo, tag) {
  const jeton = (await (await anonymous(`https://ghcr.io/token?scope=repository:${repo}:pull`)).json()).token;
  const auth = { Authorization: `Bearer ${jeton}`, Accept: MANIFESTES };
  const base = `https://ghcr.io/v2/${repo}`;
  const r = await anonymous(`${base}/manifests/${tag}`, auth);
  if (!r.ok) return { statut: r.status };
  let manifeste = await r.json();
  if (manifeste.manifests) {
    const plateforme = manifeste.manifests.find((m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64") || manifeste.manifests[0];
    manifeste = await (await anonymous(`${base}/manifests/${plateforme.digest}`, auth)).json();
  }
  const blob = await anonymous(`${base}/blobs/${manifeste.config.digest}`, { Authorization: auth.Authorization });
  return { statut: 200, labels: (await blob.json()).config?.Labels || {} };
}

const tmp = LOCAL ? "" : mkdtempSync(join(tmpdir(), "noah-sources-"));
try {
  let root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  if (!LOCAL) {
    // Clone sans aucun identifiant : ni aide, ni jeton, ni configuration de la machine.
    root = join(tmp, "depot");
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ASKPASS: "", SSH_ASKPASS: "" };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const clone = spawnSync("git", ["-c", "credential.helper=", "clone", "--quiet", "--single-branch", `https://github.com/${REPO}.git`, root], { env, encoding: "utf8", timeout: 240000 });
    check(`clone anonyme de ${REPO}`, clone.status === 0, (clone.stderr || "").trim().slice(0, 200));
    if (clone.status !== 0) throw new Error("clone impossible");
    console.log("commit public :", execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim());
    const depot = await anonymous(`https://api.github.com/repos/${REPO}`);
    const info = depot.ok ? await depot.json() : {};
    check("l'API GitHub dit le dépôt public, sans jeton", depot.ok && info.private === false && info.visibility === "public", `${depot.status} ${info.visibility}`);
  }
  if (!LOCAL && SABOTAGE) { // sur le clone : le dépôt courant reste intact
    const git = (...a) => execFileSync("git", a, { cwd: root });
    if (SABOTAGE === "bureau") git("rm", "-q", "desktop/main.js");
    if (SABOTAGE === "sous-module") {
      writeFileSync(join(root, ".gitmodules"), "[submodule \"x\"]\n\tpath = x\n\turl = git@github.com:prive/x.git\n");
      git("add", ".gitmodules");
    }
    if (SABOTAGE === "verrou") {
      const p = join(root, "desktop/package-lock.json");
      const lock = JSON.parse(readFileSync(p, "utf8"));
      const [nom] = Object.keys(lock.packages).filter((k) => k && lock.packages[k].resolved);
      lock.packages[nom].resolved = "https://npm.prive.exemple/paquet.tgz";
      writeFileSync(p, JSON.stringify(lock));
    }
    if (SABOTAGE === "image") {
      const p = join(root, ".github/workflows/release.yml");
      writeFileSync(p, readFileSync(p, "utf8").replace("file: launcher/Dockerfile", "file: prive/Dockerfile"));
    }
  }

  const images = sourcesChecks(root);

  if (!LOCAL) {
    // Ce qui est réellement en ligne : chaque image publiée dit de quel commit elle vient, et ce commit doit être public.
    for (const { nom } of images) {
      const repo = `smfcoder17/${nom}`;
      const { statut, labels } = await publishedLabels(repo, "edge");
      check(`${nom}:edge se lit sans identifiant sur GHCR`, statut === 200, String(statut));
      if (statut !== 200) continue;
      const source = labels["org.opencontainers.image.source"] || "";
      const commit = labels["org.opencontainers.image.revision"] || "";
      check(`${nom}:edge annonce ce dépôt comme source`, source === `https://github.com/${REPO}`, source);
      const vu = commit && (await anonymous(`https://api.github.com/repos/${REPO}/commits/${commit}`));
      check(`${nom}:edge vient d'un commit public`, !!vu && vu.ok, `${commit.slice(0, 12)} ${vu && vu.status}`);
    }

    // Les versions publiées et ce qu'elles joignent : chaque fichier doit venir d'une étiquette publique.
    const versions = await anonymous(`https://api.github.com/repos/${REPO}/releases?per_page=20`);
    const liste = versions.ok ? await versions.json() : [];
    const fichiers = liste.flatMap((v) => v.assets.map((a) => `${v.tag_name}/${a.name}`));
    console.log(`versions publiées : ${liste.length} ; fichiers joints : ${fichiers.length ? fichiers.join(", ") : "aucun"}`);
    for (const v of liste) {
      const tag = await anonymous(`https://api.github.com/repos/${REPO}/git/ref/tags/${v.tag_name}`);
      check(`version ${v.tag_name} : étiquette publique`, tag.ok, String(tag.status));
    }

    // Bureau et Android ne se prouvent pas à la lecture : la dernière construction de main part d'une machine vide de GitHub.
    for (const [workflow, nom] of [["apps.yml", "bureau et Android"], ["release.yml", "images"]]) {
      const r = await anonymous(`https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=5`);
      const runs = r.ok ? (await r.json()).workflow_runs : [];
      const dernier = runs[0];
      const reussi = runs.find((x) => x.conclusion === "success");
      console.log(`     ${nom} : dernière construction de main ${dernier ? `${dernier.conclusion} (${dernier.head_sha.slice(0, 8)}, ${dernier.created_at})` : "aucune"}`);
      check(`${nom} : au moins une construction réussie depuis les sources publiques`, !!reussi, reussi ? `${reussi.head_sha.slice(0, 8)} ${reussi.html_url}` : "");
    }

    // Ce que Noah fait tourner sans le construire : le code de ces projets doit se lire aussi.
    for (const tiers of ["NousResearch/hermes-agent", "jo-inc/camofox-browser", "daijro/camoufox", "caddyserver/caddy", ...depotsGit]) {
      const r = await anonymous(`https://github.com/${tiers}`);
      check(`composant tiers : ${tiers} se lit sans compte`, r.ok, String(r.status));
    }
  }
} catch (e) {
  check("le test a pu aller au bout", false, String(e.message || e).slice(0, 200));
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
}

if (SABOTAGE) {
  console.log(`\nSabotage « ${SABOTAGE} » : ${echecs.length ? `vu (${echecs.length} échec(s))` : "NON VU"}`);
  process.exit(echecs.length ? 0 : 1);
}
console.log(echecs.length ? `\n${echecs.length} échec(s) : ${echecs.join(" ; ")}` : `\nG16.1 ${LOCAL ? "(contrôles locaux)" : ""} : aucune source manquante.`);
process.exit(echecs.length ? 1 : 0);
