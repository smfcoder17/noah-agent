// « Brancher » dans l'app de bureau (desktop/brancher.js), avec les vrais modules claude.js et grok.js face aux faux binaires
// (faux_claude.mjs, faux_grok.mjs) : détection -> installation proposée -> connexion -> accord -> prêt, chaque étape visible dans
// l'état, refus propres (installation, connexion, accord), aucune étape sautée, rien d'écrit sans accord. L'installateur lui-même
// (téléchargement, script) est éprouvé par installateur_test.mjs : ici il est simulé en posant le faux binaire.
//   node tests/desktop/brancher_test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const claude = require("../../desktop/claude.js");
const grok = require("../../desktop/grok.js");
const { create } = require("../../desktop/brancher.js");

let failures = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`OK    ${name}`); } catch (e) { failures += 1; console.log(`ÉCHEC ${name}\n       ${String(e.stack || e).split("\n").slice(0, 4).join("\n       ")}`); }
};

const base = mkdtempSync(join(tmpdir(), "noah-brancher-test-"));
const FAKE_CLAUDE = { cmd: process.execPath, prefix: [join(HERE, "faux_claude.mjs")] };
const FAKE_GROK = { cmd: process.execPath, prefix: [join(HERE, "faux_grok.mjs")] };
const ABSENT = { cmd: join(base, "absent.exe"), prefix: [] };
const present = (program) => program !== ABSENT;
const state = join(base, "claude-etat");

/** Un décor : réglages en mémoire, CLI absentes ou présentes, et la trace de tout ce que l'écran a vu. */
function setup({ claudeThere = false, grokThere = false, accept = true, installFails = null, accepted = true } = {}) {
  let claudeProgram = claudeThere ? FAKE_CLAUDE : ABSENT;
  let grokProgram = grokThere ? FAKE_GROK : ABSENT;
  rmSync(state, { force: true });
  process.env.FAUX_CLAUDE_ETAT = state;
  delete process.env.FAUX_CLAUDE_LOGIN;
  claude.configure({ program: claudeProgram });
  grok.configure({ program: grokProgram, connected: false, models: [] });
  const config = {};
  const seen = { asked: [], opened: [], steps: [], changed: 0, installAsked: 0, writes: [] };
  let gpt = false;
  const chatgpt = { connected: () => gpt, login: async ({ open }) => { open("https://auth.openai.example/login"); gpt = true; } };
  let plugger;
  const deps = {
    claude, grok, chatgpt,
    install: async (which, onStep) => {
      seen.installAsked += 1;
      onStep("accord");
      seen.steps.push(plugger.state(which));
      if (!accepted) return { refuse: true };
      if (installFails) return { erreur: installFails };
      onStep("installation");
      seen.steps.push(plugger.state(which));
      if (which === "claude") claude.configure({ program: FAKE_CLAUDE }); else grok.configure({ program: FAKE_GROK, connected: false, models: [] });
      await deps.claude.detect(); await deps.grok.detect(); // comme installCli, à la fin de l installation
      return { ok: true };
    },
    consent: async (which) => { seen.asked.push(which); return accept; },
    openExternal: (url) => seen.opened.push(url),
    read: () => ({ ...config }),
    write: (patch) => { seen.writes.push(patch); Object.assign(config, patch); },
    changed: () => { seen.changed += 1; },
  };
  plugger = create(deps);
  return { plugger, seen, config };
}

await step("Claude Code : absent -> installation proposée -> connexion -> accord « cerveau » -> prêt, étapes visibles", async () => {
  const { plugger, seen, config } = setup();
  assert.deepEqual(plugger.summary("claude"), { installe: false, connecte: false, cerveau: false, occupe: false });
  const done = plugger.plug("claude");
  assert.equal(plugger.state("claude").etape, "detection");
  const out = await done;
  assert.deepEqual(out, { etape: "pret" });
  assert.deepEqual(seen.steps.map((s) => `${s.etape}:${s.detail}`), ["installation:accord", "installation:installation"]);
  assert.equal(seen.installAsked, 1);
  assert.deepEqual(seen.asked, ["claude"], "l'accord « cerveau » est demandé une fois, avec l'avertissement existant");
  assert.deepEqual(config, { abonnement_claude_cerveau: true });
  assert.ok(existsSync(state), "la connexion a vraiment eu lieu (auth login --claudeai)");
  assert.deepEqual(plugger.summary("claude"), { installe: true, connecte: true, cerveau: true, occupe: false });
  assert.ok(seen.changed >= 2, "le menu et le battement sont prévenus");
  assert.deepEqual(seen.opened, []);
});

await step("Claude Code déjà installé, connecté et permis : aucune installation, aucune question, prêt tout de suite", async () => {
  const { plugger, seen, config } = setup({ claudeThere: true });
  writeFileSync(state, "connecte");
  config.abonnement_claude_cerveau = true;
  assert.deepEqual(await plugger.plug("claude"), { etape: "pret" });
  assert.equal(seen.installAsked, 0);
  assert.deepEqual(seen.asked, []);
  assert.deepEqual(seen.writes, []);
});

await step("Claude Code installé mais pas connecté : connexion seulement, puis accord", async () => {
  const { plugger, seen } = setup({ claudeThere: true });
  assert.deepEqual(await plugger.plug("claude"), { etape: "pret" });
  assert.equal(seen.installAsked, 0);
  assert.deepEqual(seen.asked, ["claude"]);
});

await step("installation refusée : rien d'autre ne se passe (ni connexion, ni accord, ni réglage)", async () => {
  const { plugger, seen } = setup({ accepted: false });
  assert.deepEqual(await plugger.plug("claude"), { etape: "erreur", erreur: "refus_installation" });
  assert.equal(existsSync(state), false);
  assert.deepEqual(seen.asked, []);
  assert.deepEqual(seen.writes, []);
});

await step("installation en échec : la raison courte est rendue, pas d'accord demandé", async () => {
  const { plugger, seen } = setup({ installFails: "reseau" });
  assert.deepEqual(await plugger.plug("claude"), { etape: "erreur", erreur: "installation", raison: "reseau" });
  assert.deepEqual(seen.asked, []);
});

await step("connexion qui échoue : erreur « connexion », aucun accord demandé, aucun droit écrit", async () => {
  const { plugger, seen } = setup({ claudeThere: true });
  process.env.FAUX_CLAUDE_LOGIN = "0";
  assert.deepEqual(await plugger.plug("claude"), { etape: "erreur", erreur: "connexion" });
  assert.deepEqual(seen.asked, []);
  assert.deepEqual(seen.writes, []);
});

await step("accord refusé : l'abonnement reste débranché, le droit n'est pas écrit", async () => {
  const { plugger, seen, config } = setup({ claudeThere: true, accept: false });
  assert.deepEqual(await plugger.plug("claude"), { etape: "erreur", erreur: "refus_accord" });
  assert.deepEqual(seen.asked, ["claude"]);
  assert.equal(config.abonnement_claude_cerveau, undefined);
});

await step("deux appuis pendant l'enchaînement : une seule installation, une seule question", async () => {
  const { plugger, seen } = setup();
  const [a, b] = await Promise.all([plugger.plug("claude"), plugger.plug("claude")]);
  assert.deepEqual(a, b);
  assert.equal(seen.installAsked, 1);
  assert.deepEqual(seen.asked, ["claude"]);
});

await step("Grok : le code d'appareil et l'adresse sont montrés pendant la connexion, l'adresse est ouverte, puis accord", async () => {
  process.env.FAUX_GROK_DEVICE = "https://accounts.x.ai/device";
  const { plugger, seen, config } = setup({ grokThere: true });
  const shown = [];
  const poll = setInterval(() => { const s = plugger.state("grok"); if (s?.code) shown.push(s); }, 20);
  const out = await plugger.plug("grok");
  clearInterval(poll);
  delete process.env.FAUX_GROK_DEVICE;
  assert.deepEqual(out, { etape: "pret" });
  assert.ok(shown.length > 0, "le code a été visible à l'écran");
  assert.equal(shown[0].code, "WXYZ-2468");
  assert.deepEqual(seen.opened, ["https://accounts.x.ai/device"]);
  assert.deepEqual(seen.asked, ["grok"]);
  assert.deepEqual(config, { abonnement_grok: true });
});

await step("ChatGPT : connexion par le navigateur, aucun avertissement de plus, droit écrit", async () => {
  const { plugger, seen, config } = setup();
  assert.deepEqual(await plugger.plug("chatgpt"), { etape: "pret" });
  assert.deepEqual(seen.opened, ["https://auth.openai.example/login"]);
  assert.deepEqual(seen.asked, []);
  assert.deepEqual(config, { abonnement_chatgpt: true });
  assert.equal(seen.installAsked, 0, "ChatGPT ne s'installe pas : la connexion passe par Noah");
});

await step("un nom d'abonnement inconnu est refusé, sans rien lancer", async () => {
  const { plugger, seen } = setup();
  assert.deepEqual(await plugger.plug("../../etc"), { etape: "erreur", erreur: "inconnu" });
  assert.equal(plugger.state("../../etc"), null);
  assert.equal(seen.installAsked, 0);
});

rmSync(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} échec(s)` : "\nTout passe.");
process.exit(failures ? 1 : 0);
