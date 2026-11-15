// Forfait ChatGPT par l'ordinateur, côté bureau : vrais chatgpt.js, responses.js et actions.js face à un faux serveur OpenAI.
// Prouve la connexion officielle (PKCE, client inscrit, état vérifié, jeton d'identité signé), le jeton gardé sur l'ordinateur,
// la traduction Chat Completions ↔ Responses (texte, outils, résultats d'outil), la limite du forfait et le renouvellement.
//   node tests/desktop/chatgpt_test.mjs
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { fakeElectron } from "./electron_factice.mjs";
import { fakeOpenAI } from "./faux_openai.mjs";

const require = createRequire(import.meta.url);
const electron = fakeElectron();
const originalLoad = Module._load;
Module._load = function (id, ...rest) {
  return id === "electron" ? electron : originalLoad.call(this, id, ...rest);
};
const actions = require("../../desktop/actions.js");
const chatgpt = require("../../desktop/chatgpt.js");
const responses = require("../../desktop/responses.js");
Module._load = originalLoad;

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

const openai = await fakeOpenAI();
let sealed = null;
const config = {};
chatgpt.configure({ issuer: openai.origin, api: `${openai.origin}/v1`, storage: { read: () => sealed && JSON.parse(sealed), write: (d) => { sealed = d ? JSON.stringify(d) : null; } } });
let rights = { claude: false, claudeProfil: "fichiers", claudeMinutes: 30, chatgpt: true, chatgptModele: "" };
actions.configure({ autonomy: () => "auto", rights: () => rights });
const read = () => config;
const write = (patch) => Object.assign(config, patch);
const turn = (requete) => actions.perform({ id: `c-${Math.random()}`, agent: "Nadine", action: "chatgpt", requete }, {});

try {
  await step("connexion refusée chez OpenAI : rien n'est gardé", async () => {
    await assert.rejects(chatgpt.login({ open: (url) => openai.browser(url, { deny: true }), read, write, port: 0 }), /refused/);
    assert.equal(chatgpt.connected(), false);
    assert.equal(sealed, null);
  });

  await step("connexion officielle : client inscrit, PKCE, état vérifié, jeton d'identité signé, portée du forfait", async () => {
    const out = await chatgpt.login({ open: (url) => openai.browser(url), read, write, port: 0 });
    assert.equal(out.ok, true);
    assert.equal(openai.state.wrongState, 400, "un retour avec un autre état est refusé");
    assert.equal(openai.state.lastAuthorize.agent_name_hint, "Noah Agent");
    assert.equal(openai.state.lastAuthorize.ext_agent_host_id, config.chatgpt_hote, "l'identifiant de l'ordinateur est gardé et réutilisé");
    const saved = JSON.parse(sealed);
    assert.equal(saved.client_id, "oaiapp_essai");
    assert.equal(saved.subject, "user-42");
    assert.ok(saved.access_token && saved.refresh_token);
    assert.deepEqual(chatgpt.models(), [{ slug: "gpt-essai", nom: "GPT Essai" }], "seuls les modèles listés");
  });

  await step("le battement dit « connecté », jamais le jeton", async () => {
    const beat = JSON.stringify(actions.subscriptions());
    assert.equal(actions.subscriptions().chatgpt.connecte, true);
    const saved = JSON.parse(sealed);
    assert.ok(!beat.includes(saved.access_token) && !beat.includes(saved.refresh_token) && !beat.includes("franck@"), beat);
  });

  await step("un tour texte : Chat Completions → Responses (instructions, store:false, stream:true) → Chat Completions", async () => {
    const out = await turn({ messages: [{ role: "system", content: "Tu es Nadine." }, { role: "user", content: "Bonjour" }], temperature: 0.3, max_tokens: 50 });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.reponse.choices[0].message.content, "réponse du forfait (gpt-essai)");
    assert.equal(out.reponse.choices[0].finish_reason, "stop");
    assert.equal(out.reponse.usage.prompt_tokens, 12);
    const sent = openai.state.seen.at(-1);
    assert.equal(sent.instructions, "Tu es Nadine.");
    assert.equal(sent.store, false);
    assert.equal(sent.stream, true);
    assert.ok(!("temperature" in sent) && !("max_tokens" in sent));
  });

  await step("outils : passés par additional_tools ; l'appel revient en tool_calls ; le résultat repart en function_call_output", async () => {
    const tools = [{ type: "function", function: { name: "lire", description: "Lit un fichier", parameters: { type: "object", properties: { chemin: { type: "string" } } } } }];
    let out = await turn({ messages: [{ role: "user", content: "Lis notes.txt" }], tools });
    const call = out.reponse.choices[0].message.tool_calls[0];
    assert.equal(out.reponse.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(call, { id: "appel-1", type: "function", function: { name: "lire", arguments: "{\"chemin\":\"notes.txt\"}" } });
    assert.equal(openai.state.seen.at(-1).input[0].type, "additional_tools");
    out = await turn({ messages: [{ role: "user", content: "Lis notes.txt" }, { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: "appel-1", content: "pomme, poire" }], tools });
    const input = openai.state.seen.at(-1).input;
    assert.ok(input.some((i) => i.type === "function_call" && i.call_id === "appel-1"));
    assert.ok(input.some((i) => i.type === "function_call_output" && i.call_id === "appel-1" && i.output === "pomme, poire"));
    assert.equal(out.reponse.choices[0].message.content, "réponse du forfait (gpt-essai)");
  });

  await step("historique réparé : un résultat d'outil orphelin est retiré, un appel sans résultat en reçoit un vide", () => {
    const fixed = responses.repairToolHistory([{ type: "function_call_output", call_id: "x", output: "?" }, { type: "function_call", call_id: "y", name: "f", arguments: "{}" }]);
    assert.deepEqual(fixed.map((i) => `${i.type}:${i.call_id}`), ["function_call:y", "function_call_output:y"]);
  });

  await step("limite du forfait atteinte en cours de flux : statut 429, le serveur basculera", async () => {
    const out = await turn({ messages: [{ role: "user", content: "LIMITE" }] });
    assert.equal(out.ok, undefined);
    assert.equal(out.statut, 429);
    assert.equal(out.code, "subscription_sharing_usage_limit_exceeded");
  });

  await step("jeton expiré : renouvelé à l'adresse officielle, puis l'appel passe", async () => {
    const saved = JSON.parse(sealed);
    sealed = JSON.stringify({ ...saved, expires_at: Date.now() - 1000 });
    chatgpt.configure({ storage: { read: () => sealed && JSON.parse(sealed), write: (d) => { sealed = d ? JSON.stringify(d) : null; } } });
    const out = await turn({ messages: [{ role: "user", content: "Encore" }] });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(openai.state.refreshes, 1);
    assert.notEqual(JSON.parse(sealed).access_token, saved.access_token);
  });

  await step("forfait coupé sur l'ordinateur : refusé sans appeler OpenAI", async () => {
    rights = { ...rights, chatgpt: false };
    const before = openai.state.seen.length;
    const out = await turn({ messages: [{ role: "user", content: "x" }] });
    assert.equal(out.code, "coupe");
    assert.equal(openai.state.seen.length, before);
    rights = { ...rights, chatgpt: true };
  });

  await step("déconnexion : le jeton est effacé de l'ordinateur", async () => {
    chatgpt.logout();
    assert.equal(sealed, null);
    assert.equal(chatgpt.connected(), false);
    assert.equal((await turn({ messages: [{ role: "user", content: "x" }] })).code, "deconnecte");
  });
} finally {
  await openai.close();
}
// Sans process.exit : sous Windows, quitter avec des connexions fetch encore ouvertes fait échouer libuv.
process.exitCode = failures ? 1 : 0;
console.log(failures ? `${failures} échec(s)` : "Forfait ChatGPT sur l'ordinateur : connexion officielle, jeton local, traduction et limite tiennent.");
