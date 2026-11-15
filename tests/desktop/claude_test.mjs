// Tâches confiées à Claude Code, côté bureau : vrais actions.js, claude.js, bandeau.js et dossiers.js ; un faux binaire `claude`
// (faux_claude.mjs) à la place du vrai. Prouve le droit local, le dossier en écriture, l'accord en Prudent, les outils fixés par
// l'app, la consigne par l'entrée standard, la progression, une tâche à la fois, l'arrêt, le délai et la limite d'abonnement.
//   node tests/desktop/claude_test.mjs
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fakeElectron } from "./electron_factice.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electron = fakeElectron();
const originalLoad = Module._load;
Module._load = function (id, ...rest) {
  return id === "electron" ? electron : originalLoad.call(this, id, ...rest);
};
const actions = require("../../desktop/actions.js");
const bandeau = require("../../desktop/bandeau.js");
const dossiers = require("../../desktop/dossiers.js");
const claude = require("../../desktop/claude.js");
bandeau.create(electron.win);
Module._load = originalLoad;

const base = mkdtempSync(join(tmpdir(), "noah-claude-"));
const traceFile = join(base, "trace.jsonl");
process.env.FAUX_CLAUDE_TRACE = traceFile;
const traces = () => (existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const FAKE = { cmd: process.execPath, prefix: [join(here, "faux_claude.mjs")] };
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`ÉCHEC ${name}\n       ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`);
  }
};

let autonomy = "auto";
let rights = { claude: true, claudeProfil: "fichiers", claudeMinutes: 30, chatgpt: false, chatgptModele: "" };
actions.configure({ autonomy: () => autonomy, rights: () => rights });
const store = dossiers.createStore(join(base, "profil", "dossiers.json"));
const projet = join(base, "Projet");
const photos = join(base, "Photos");
mkdirSync(projet);
mkdirSync(photos);
const confie = store.add(projet);
store.setWrite(confie.id, true);
const lecture = store.add(photos);
const lines = [];
const ctx = (more = {}) => ({ store, progress: (_id, line) => lines.push(line), flush: async () => {}, ...more });
const task = (consigne, more = {}) => ({ id: `t-${Math.random()}`, agent: "Nadine", action: "claude", consigne, dossierId: confie.id, ...more });

try {
  await step("détection : connecté et offre, sans e-mail ni organisation", async () => {
    claude.configure({ program: FAKE });
    const s = await claude.detect();
    assert.deepEqual(s, { installe: true, connecte: true, offre: "max", methode: "claude.ai" });
    const beat = JSON.stringify(actions.subscriptions());
    assert.ok(!beat.includes("franck@") && !beat.includes("org-secret") && !beat.includes("Org secrète"), beat);
    assert.equal(actions.subscriptions().claude.permis, true);
    claude.configure({ program: { cmd: join(base, "absent.exe"), prefix: [] } });
    assert.equal((await claude.detect()).installe, false);
    claude.configure({ program: FAKE });
    await claude.detect();
  });

  await step("droit coupé sur l'ordinateur : refusé, rien n'est lancé", async () => {
    rights = { ...rights, claude: false };
    const out = await actions.perform(task("Résume le dossier."), ctx());
    assert.equal(out.refuse, true);
    assert.match(out.message, /coupé/);
    assert.equal(traces().length, 0);
    rights = { ...rights, claude: true };
  });

  await step("dossier en lecture seule ou non confié : refusé", async () => {
    assert.equal((await actions.perform(task("x", { dossierId: lecture.id }), ctx())).refuse, true);
    assert.equal((await actions.perform(task("x", { dossierId: "inconnu" }), ctx())).refuse, true);
    assert.equal(traces().length, 0);
  });

  await step("Auto : la tâche tourne dans le dossier confié, le résultat revient avec les fichiers modifiés", async () => {
    const out = await actions.perform(task("Résume le dossier dans resultat.md."), ctx());
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.texte, "J'ai écrit resultat.md avec le résumé demandé.");
    assert.deepEqual(out.fichiers, ["resultat.md"]);
    assert.equal(out.cout_estime_usd, 0.0421);
    assert.equal(out.session, "sess-1234");
    assert.equal(out.dossier, "Projet");
    assert.ok(existsSync(join(projet, "resultat.md")));
    const [run] = traces();
    assert.equal(run.cwd, projet);
    assert.equal(run.prompt, "Résume le dossier dans resultat.md.");
    assert.ok(run.args.includes("--restricted") && run.args.includes("--strict-mcp-config"), run.args.join(" "));
    assert.equal(run.args[run.args.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write");
    assert.ok(!run.args.join(" ").includes("Bash") && !run.args.includes("--dangerously-skip-permissions") && !run.args.includes("--bare"));
    assert.ok(lines.some((l) => l.startsWith("Write resultat.md")) && lines.some((l) => l.includes("Je lis le dossier")), lines.join(" | "));
  });

  await step("une consigne qui ressemble à une option reste une consigne (entrée standard)", async () => {
    const out = await actions.perform(task("--dangerously-skip-permissions --tools Bash"), ctx());
    assert.equal(out.ok, true);
    const run = traces().at(-1);
    assert.equal(run.prompt, "--dangerously-skip-permissions --tools Bash");
    assert.ok(!run.args.includes("--dangerously-skip-permissions") && !run.args.includes("Bash"));
  });

  await step("outils complets : seulement si la personne les a choisis sur l'ordinateur", async () => {
    rights = { ...rights, claudeProfil: "complet" };
    await actions.perform(task("Lance les tests."), ctx());
    const run = traces().at(-1);
    assert.ok(!run.args.includes("--restricted"));
    assert.match(run.args[run.args.indexOf("--tools") + 1], /Bash/);
    rights = { ...rights, claudeProfil: "fichiers" };
  });

  await step("Prudent : le bandeau montre le dossier, les outils et la consigne ; refus = rien ne tourne, accord = la tâche part", async () => {
    autonomy = "prudent";
    const before = traces().length;
    let shown;
    electron.onRequest = (s) => { shown = s; queueMicrotask(() => electron.answer(s.id, s.refuseIndex)); };
    let out = await actions.perform(task("Range les notes."), ctx());
    assert.equal(out.refuse, true);
    assert.equal(traces().length, before);
    assert.match(shown.message, /Claude Code/);
    assert.ok(shown.detail.startsWith(`Dans : ${projet}\n`) && shown.detail.includes("Read, Glob, Grep, Edit, Write") && shown.detail.endsWith("Consigne :\nRange les notes."), shown.detail);
    electron.onRequest = (s) => queueMicrotask(() => electron.answer(s.id, 0));
    out = await actions.perform(task("Range les notes."), ctx());
    assert.equal(out.ok, true);
    assert.equal(traces().length, before + 1);
    autonomy = "auto";
  });

  await step("une tâche à la fois ; la demande retirée par le serveur arrête la CLI", async () => {
    let wanted = true;
    const started = Date.now();
    const running = actions.perform(task("LENT"), ctx({ stillWanted: async () => wanted }));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(actions.subscriptions().claude.occupe, true);
    const second = await actions.perform(task("Autre chose"), ctx());
    assert.match(second.erreur, /tourne déjà/);
    wanted = false;
    const out = await running;
    assert.equal(out.arret, "annule", JSON.stringify(out));
    assert.equal(out.ok, false);
    assert.ok(Date.now() - started < 10000, "arrêtée en moins de 10 s");
    assert.equal(claude.busy(), false);
  });

  await step("« Couper l'accès » arrête la tâche en cours", async () => {
    const running = actions.perform(task("LENT"), ctx());
    await new Promise((r) => setTimeout(r, 700));
    store.setCut(true);
    const out = await running;
    store.setCut(false);
    assert.ok(out.coupe === true || out.arret === "coupe", JSON.stringify(out));
  });

  await step("délai dépassé : la CLI est arrêtée", async () => {
    claude.configure({ program: FAKE, minute: 800 });
    const out = await actions.perform(task("LENT", { minutes: 1 }), ctx());
    claude.configure({ program: FAKE, minute: 60000 });
    assert.equal(out.arret, "delai", JSON.stringify(out));
  });

  await step("limite de l'abonnement : dite à l'agent", async () => {
    const out = await actions.perform(task("LIMITE"), ctx());
    assert.equal(out.ok, false);
    assert.equal(out.limite, true);
    assert.match(out.erreur, /limit/);
  });
} finally {
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
}
if (failures) {
  console.log(`${failures} échec(s)`);
  process.exit(1);
}
console.log("Claude Code sur l'ordinateur : droits, accord, outils, arrêt et résultat tiennent.");
process.exit(0);
