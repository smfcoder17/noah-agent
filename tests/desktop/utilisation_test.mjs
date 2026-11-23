// Utilisation des abonnements et Grok, côté bureau : vrais usage.js, claude.js, chatgpt.js, grok.js et actions.js face à de faux
// binaires (faux_claude.mjs, faux_grok.mjs) et un faux serveur OpenAI. Prouve la lecture de l'événement rate_limit_event de Claude
// Code, des limites du forfait ChatGPT (en-têtes et événement), le comptage des tours de Grok, le modèle exact de Claude, et
// qu'aucun jeton n'entre dans l'instantané qui part au serveur.
//   node tests/desktop/utilisation_test.mjs
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fakeElectron } from "./electron_factice.mjs";
import { fakeOpenAI } from "./faux_openai.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electron = fakeElectron();
const originalLoad = Module._load;
Module._load = function (id, ...rest) {
  return id === "electron" ? electron : originalLoad.call(this, id, ...rest);
};
const actions = require("../../desktop/actions.js");
const claude = require("../../desktop/claude.js");
const chatgpt = require("../../desktop/chatgpt.js");
const grok = require("../../desktop/grok.js");
const usage = require("../../desktop/usage.js");
const { t } = require("../../desktop/textes.js");
Module._load = originalLoad;

const base = mkdtempSync(join(tmpdir(), "noah-usage-"));
const grokTrace = join(base, "grok.jsonl");
process.env.FAUX_GROK_TRACE = grokTrace;
process.env.XAI_API_KEY = "xai-cle-de-la-personne"; // ne doit jamais atteindre la CLI
const traces = () => (existsSync(grokTrace) ? readFileSync(grokTrace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
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

const win = (snap, id) => snap.fenetres.find((w) => w.id === id);
const chat = (text, tools) => ({ messages: [{ role: "user", content: text }], ...(tools ? { tools } : {}) });
const TERMINAL = [{ type: "function", function: { name: "terminal", description: "Lance une commande", parameters: { type: "object", properties: { command: { type: "string" } } } } }];

await step("format Claude Code : utilization 0-1 devient un pourcentage, une fenêtre par nom, état et remise à zéro", () => {
  usage.reset();
  const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1795672800, rateLimitType: "seven_day", unifiedWindows: {
    seven_day: { utilization: 0.42, resetsAt: 1795672800, status: "allowed" }, five_hour: { utilization: 0.98, resetsAt: 1795000000, status: "allowed_warning" } } } };
  const windows = usage.fromClaudeEvent(event);
  assert.deepEqual(windows.map((w) => [w.id, w.pct, w.reset, w.etat]), [["seven_day", 42, 1795672800, "permis"], ["five_hour", 98, 1795000000, "bientot"]]);
  // Un événement sans fenêtres détaillées : le type de limite et les champs du dessus.
  assert.deepEqual(usage.fromClaudeEvent({ rate_limit_info: { rateLimitType: "five_hour", utilization: 0.1, resetsAt: 5, status: "rejected" } }).map((w) => [w.id, w.pct, w.etat]), [["five_hour", 10, "limite"]]);
  assert.deepEqual(usage.fromClaudeEvent({ type: "rate_limit_event" }), []);
  assert.deepEqual(usage.fromClaudeEvent({ rate_limit_info: { unifiedWindows: { "x y": { utilization: 0.5 } } } }), [], "un nom de fenêtre étrange est écarté");
});

await step("format OpenAI : used_percent, durée de fenêtre → 5 h / 7 jours / 30 jours, remise à zéro relative ou absolue", () => {
  const now = 1_000_000_000_000;
  const w = usage.fromCodexLimits({ primary: { used_percent: 9, window_minutes: 43200, resets_at: 1795000000 }, secondary: { used_percent: 100, window_minutes: 300, reset_after_seconds: 60 } }, now);
  assert.deepEqual(w.map((x) => [x.id, x.pct, x.reset, x.etat]), [["thirty_day", 9, 1795000000, "permis"], ["five_hour", 100, 1_000_000_060, "limite"]]);
  assert.equal(usage.windowId(1234, "x"), "minutes_1234");
});

await step("l'instantané garde la dernière valeur par fenêtre, compte les tours et ne retient que des champs connus", () => {
  usage.reset();
  usage.record("claude", { fenetres: [{ id: "five_hour", pct: 7, reset: 1, etat: "permis" }, { id: "seven_day", pct: 42, reset: 2, etat: "permis" }], offre: "max", modele: "claude-haiku-5-5", tour: true }, 1000);
  usage.record("claude", { fenetres: [{ id: "five_hour", pct: 9, reset: 1, etat: "permis" }], tour: true }, 2000);
  const s = usage.snapshot().claude;
  assert.equal(win(s, "five_hour").pct, 9);
  assert.equal(win(s, "seven_day").pct, 42, "l'autre fenêtre garde sa dernière valeur");
  assert.equal(s.tours, 2);
  assert.equal(s.mesure_le, 2000);
  assert.deepEqual(Object.keys(s).sort(), ["fenetres", "jetons", "mesure_le", "modele", "offre", "tours"]);
});

await step("les phrases du menu : 42 % de ta semaine avec la remise à zéro, en français et en anglais", () => {
  const snap = { fenetres: [{ id: "seven_day", pct: 42, reset: 1795672800, etat: "permis" }, { id: "five_hour", pct: 100, reset: null, etat: "limite" }], tours: 3 };
  const fr = usage.describe("claude", snap, t, "fr", 1795000000000);
  assert.match(fr[0], /^42 % de ta semaine, remise à zéro /);
  assert.match(fr[1], /^100 % de ta fenêtre de 5 h, limite atteinte$/);
  assert.match(usage.describe("claude", snap, t, "en", 1795000000000)[0], /^42% of your week, resets /);
  assert.deepEqual(usage.describe("grok", { fenetres: [], tours: 3 }, t, "fr"), ["3 tours comptés (xAI ne donne pas le reste)"]);
  assert.deepEqual(usage.describe("grok", null, t, "fr"), ["pas encore de mesure"]);
});

// --- Claude Code, faux binaire -----------------------------------------------------------------------------------------------
claude.configure({ program: { cmd: process.execPath, prefix: [join(here, "faux_claude.mjs")] } });
await claude.detect();

await step("Claude Code, tour du cerveau : l'utilisation est lue et le nom exact du modèle remonte (alias gardé pour le choix)", async () => {
  usage.reset();
  const out = await claude.brain({ body: chat("bonjour"), model: "sonnet" });
  assert.equal(out.ok, true);
  assert.equal(out.modele, "sonnet", "l'alias reste le choix");
  assert.equal(out.modele_exact, "claude-sonnet-5-5");
  assert.equal(out.reponse.model, "claude-sonnet-5-5");
  const s = usage.snapshot().claude;
  assert.equal(win(s, "seven_day").pct, 42);
  assert.equal(win(s, "five_hour").pct, 7);
  assert.equal(s.offre, "max");
  assert.equal(s.modele, "claude-sonnet-5-5");
  assert.equal(s.tours, 1);
});

await step("Claude Code, tâche confiée : même lecture, avec le modèle exact dans le résultat", async () => {
  usage.reset();
  const cwd = mkdtempSync(join(base, "tache-"));
  const out = await claude.run({ consigne: "résume", cwd });
  assert.equal(out.ok, true);
  assert.equal(out.modele_exact, "claude-sonnet-5-5");
  assert.equal(win(usage.snapshot().claude, "seven_day").pct, 42);
});

await step("Claude Code, limite atteinte : l'état « limite » est gardé", async () => {
  usage.reset();
  const out = await claude.brain({ body: chat("LIMITE svp"), model: "opus" });
  assert.equal(out.code, "limite");
  assert.ok(usage.snapshot().claude.fenetres.every((w) => w.etat === "limite"));
});

// --- ChatGPT, faux serveur OpenAI --------------------------------------------------------------------------------------------
const openai = await fakeOpenAI();
let sealed = null;
chatgpt.configure({ issuer: openai.origin, api: `${openai.origin}/v1`, storage: { read: () => sealed && JSON.parse(sealed), write: (d) => { sealed = d ? JSON.stringify(d) : null; } } });
const config = {};
await chatgpt.login({ open: (url) => openai.browser(url), read: () => config, write: (p) => Object.assign(config, p), port: 0 });
const gpt = (text) => chatgpt.call(chat(text), "gpt-essai");

await step("ChatGPT, limites dans les en-têtes de la réponse : fenêtres de 30 jours et de 5 h", async () => {
  usage.reset();
  const out = await gpt("bonjour EN_TETES");
  assert.equal(out.ok, true);
  const s = usage.snapshot().chatgpt;
  assert.equal(win(s, "thirty_day").pct, 9);
  assert.ok(win(s, "thirty_day").reset > Date.now() / 1000);
  assert.equal(win(s, "five_hour").pct, 30);
  assert.equal(s.tours, 1);
  assert.equal(s.jetons, 17);
  assert.deepEqual(chatgpt.limitHeaders().filter((h) => h.startsWith("x-codex")).sort(), ["x-codex-primary-reset-after-seconds", "x-codex-primary-used-percent", "x-codex-primary-window-minutes",
    "x-codex-secondary-reset-at", "x-codex-secondary-used-percent", "x-codex-secondary-window-minutes"]);
});

await step("ChatGPT, limites dans l'événement codex.rate_limits du flux", async () => {
  usage.reset();
  await gpt("bonjour EVENEMENT");
  const s = usage.snapshot().chatgpt;
  assert.equal(win(s, "seven_day").pct, 12.5);
});

await step("ChatGPT sans information de limite : seulement les tours, jamais un pourcentage inventé", async () => {
  usage.reset();
  await gpt("bonjour");
  const s = usage.snapshot().chatgpt;
  assert.deepEqual(s.fenetres, []);
  assert.equal(s.tours, 1);
  assert.match(usage.describe("chatgpt", s, t, "fr")[0], /^1 tour compté, pas de mesure du forfait reçue$/);
});

await step("ChatGPT, limite du forfait : l'état « limite » est gardé", async () => {
  usage.reset();
  const out = await gpt("LIMITE");
  assert.equal(out.statut, 429);
  assert.equal(usage.snapshot().chatgpt.fenetres[0].etat, "limite");
});

// --- Grok Build, faux binaire ------------------------------------------------------------------------------------------------
let saved = { connecte: false };
grok.configure({ program: { cmd: process.execPath, prefix: [join(here, "faux_grok.mjs")] }, minute: 200, changed: () => { saved = { ...grok.status() }; } });
await grok.detect();

await step("Grok : CLI détectée, connexion par `grok login` lancé par l'app, l'état connecté est gardé", async () => {
  assert.equal(grok.status().installe, true);
  assert.equal(grok.status().connecte, false);
  assert.deepEqual(grok.models(), [], "pas de modèle tant qu'il n'est pas connecté");
  const out = await grok.login();
  assert.equal(out.ok, true);
  assert.equal(grok.status().connecte, true);
  assert.equal(saved.connecte, true);
  assert.deepEqual(traces().at(-1).args, ["login"]);
});

await step("Grok, tour du cerveau : réponse Chat Completions, modèle annoncé par la CLI, tours et jetons comptés, aucune clé d'API transmise", async () => {
  usage.reset();
  const out = await grok.brain({ body: chat("bonjour"), model: "grok-4.3" });
  assert.equal(out.ok, true);
  assert.equal(out.reponse.choices[0].message.content, "réponse de Grok (grok-4.3)");
  assert.equal(out.modele_exact, "grok-4.3");
  assert.equal(out.reponse.usage.total_tokens, 108);
  const s = usage.snapshot().grok;
  assert.equal(s.tours, 1);
  assert.equal(s.jetons, 108);
  assert.deepEqual(s.fenetres, [], "xAI ne rend pas de pourcentage : aucune fenêtre inventée");
  const trace = traces().at(-1);
  assert.deepEqual(trace.xai, [], "XAI_API_KEY n'atteint jamais la CLI");
  for (const flag of ["--tools", "--disable-web-search", "--no-subagents", "--max-turns"]) assert.ok(trace.args.includes(flag), flag);
  assert.ok(!trace.args.includes("--yolo") && !trace.args.includes("--always-approve"));
  assert.ok(trace.prompt.includes("bonjour"));
  assert.deepEqual(grok.models(), [{ slug: "grok-4.3", nom: "Grok · grok-4.3" }], "les modèles sont ceux que la CLI annonce");
});

await step("Grok, outils de l'agent : appel traduit en tool_calls, puis conclusion avec le résultat de l'outil", async () => {
  const first = await grok.brain({ body: chat("OUTIL_TERMINAL", TERMINAL), model: "" });
  const call = first.reponse.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "terminal");
  assert.deepEqual(JSON.parse(call.function.arguments), { command: "echo bonjour" });
  const second = await grok.brain({ body: { messages: [{ role: "user", content: "OUTIL_TERMINAL" }, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: "bonjour" }], tools: TERMINAL } });
  assert.equal(second.reponse.choices[0].message.content, "Fini : bonjour");
});

await step("Grok, quota atteint : 429 et état « limite » ; non connecté : déconnexion constatée", async () => {
  usage.reset();
  const limit = await grok.brain({ body: chat("LIMITE"), model: "" });
  assert.equal(limit.code, "limite");
  assert.equal(usage.snapshot().grok.fenetres[0].etat, "limite");
  const off = await grok.brain({ body: chat("DECONNECTE"), model: "" });
  assert.equal(off.code, "deconnecte");
  assert.equal(grok.status().connecte, false);
  await grok.login();
  assert.equal(grok.status().connecte, true);
});

await step("Grok par le pont : coupé sur l'ordinateur sans le droit, puis un tour passe avec le droit", async () => {
  let rights = { grok: false, grokModele: "" };
  actions.configure({ autonomy: () => "auto", rights: () => rights });
  const ask = () => actions.perform({ id: `g-${Math.random()}`, agent: "Nadine", action: "grok", requete: chat("bonjour") }, {});
  const refused = await ask();
  assert.equal(refused.code, "coupe");
  rights = { grok: true, grokModele: "grok-4.3" };
  const ok = await ask();
  assert.equal(ok.ok, true);
  assert.equal(traces().at(-1).args[traces().at(-1).args.indexOf("--model") + 1], "grok-4.3", "le modèle du menu est celui de la CLI");
});

await step("Grok, déconnexion : `grok logout`, l'état et l'utilisation sont effacés", async () => {
  await grok.logout();
  assert.equal(grok.status().connecte, false);
  assert.equal(usage.snapshot().grok, undefined);
  assert.deepEqual(traces().at(-1).args, ["logout"]);
});

await step("l'instantané qui part au serveur ne contient aucun jeton, e-mail ni chemin", async () => {
  usage.reset();
  await claude.brain({ body: chat("bonjour"), model: "haiku" });
  await gpt("bonjour EN_TETES");
  const text = JSON.stringify(usage.snapshot());
  assert.ok(!/access_token|refresh_token|id_token|Bearer|franck@|oaiapp_|sk-|xai-cle/i.test(text), text);
  assert.ok(!/[A-Za-z]:\\|\/Users\//.test(text));
});

await openai.close();
console.log(failures ? `\n${failures} échec(s)` : "\nTout passe.");
process.exit(failures ? 1 : 0);
