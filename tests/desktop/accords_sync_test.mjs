// #36 : le vrai processus d'actions publie sa fenêtre puis clôture avant d'exécuter.
// Electron et le transport sont simulés ; aucun accès au vrai presse-papiers.
//   node tests/desktop/accords_sync_test.mjs
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
const realFetch = globalThis.fetch;
let log = [];
let response = 0;
const electron = {
  BrowserWindow: { getAllWindows: () => [{ isVisible: () => true }] },
  clipboard: { writeText: () => log.push("action") },
  dialog: { showMessageBox: async () => { log.push("fenetre-locale"); return { response }; } },
  session: { defaultSession: { cookies: { get: async () => [{ value: "jeton-natif" }] } } },
  shell: {},
};
Module._load = function (id, ...rest) { return id === "electron" ? electron : originalLoad.call(this, id, ...rest); };
const actions = require("../../desktop/actions.js");
Module._load = originalLoad;

try {
  for (const scenario of ["accepte", "refuse", "serveur-refuse", "ouverture-refusee"]) {
    log = [];
    response = scenario === "refuse" ? 1 : 0;
    let fetched = false;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    globalThis.fetch = async (url, options = {}) => {
      assert.equal(options.headers.Authorization, "Bearer jeton-natif");
      if (url.endsWith("/battement")) return { ok: true, json: async () => ({ compte: "alice" }) };
      if (url.includes("/next?")) {
        if (fetched) return new Promise(() => {});
        fetched = true;
        return { status: 200, json: async () => ({ id: "locale", agent: "Noah", action: "presse_papiers", texte: "Exactement ce texte" }) };
      }
      if (url.endsWith("/accords/locale")) {
        log.push("demande");
        const body = JSON.parse(options.body);
        assert.equal(body.detail, "Exactement ce texte");
        assert.match(body.message, /presse-papiers/);
        return { ok: scenario !== "ouverture-refusee", json: async () => ({ id: "accord-1" }) };
      }
      if (url.endsWith("/accords/locale/reponse")) {
        log.push("cloture");
        assert.deepEqual(JSON.parse(options.body), { id: "accord-1", approve: response === 0 });
        return { ok: scenario !== "serveur-refuse" };
      }
      if (url.endsWith("/encore/locale")) return { ok: true };
      if (url.endsWith("/result/locale")) {
        log.push("resultat");
        finish(JSON.parse(options.body));
        return { ok: true };
      }
      throw new Error(`Requete inattendue : ${url}`);
    };
    const listener = actions.listen(() => "https://noah.test");
    let timeout;
    try {
      const result = await Promise.race([done, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Pas de resultat")), 3000); })]);
      if (scenario === "accepte") {
        assert.deepEqual(log, ["demande", "fenetre-locale", "cloture", "action", "resultat"]);
        assert.equal(result.ok, true);
      } else {
        assert.equal(log.includes("action"), false, scenario);
        assert.equal(result.refuse, true, scenario);
      }
      if (scenario === "ouverture-refusee") assert.equal(log.includes("fenetre-locale"), false);
      console.log(`OK #36 bureau : ${scenario}`);
    } finally {
      clearTimeout(timeout);
      listener.stop();
    }
  }
} finally {
  globalThis.fetch = realFetch;
  Module._load = originalLoad;
}
