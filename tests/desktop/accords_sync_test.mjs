// #36 : le vrai processus d'actions publie sa fenêtre puis clôture avant d'exécuter.
// Electron et le transport sont simulés ; aucun accès au vrai presse-papiers.
//   node tests/desktop/accords_sync_test.mjs
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { fakeElectron } from "./electron_factice.mjs";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;
let log = [];
let response = 0;
const electron = fakeElectron();
const realCookies = electron.session.defaultSession.cookies.get;
electron.clipboard.writeText = () => log.push("action");
electron.onRequest = (shown) => {
  log.push("bandeau-local");
  queueMicrotask(() => electron.answer(shown.id, response));
};
Module._load = function (id, ...rest) { return id === "electron" ? electron : originalLoad.call(this, id, ...rest); };
const actions = require("../../desktop/actions.js");
require("../../desktop/bandeau.js").create(electron.win);
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
        assert.deepEqual(log, ["demande", "bandeau-local", "cloture", "action", "resultat"]);
        assert.equal(result.ok, true);
      } else {
        assert.equal(log.includes("action"), false, scenario);
        if (scenario === "refuse") assert.equal(result.refuse, true);
        else {
          assert.match(result.erreur, /accord.*pas/);
          assert.equal(result.refuse, undefined);
        }
      }
      if (scenario === "ouverture-refusee") assert.equal(log.includes("bandeau-local"), false);
      console.log(`OK #36 bureau : ${scenario}`);
    } finally {
      clearTimeout(timeout);
      listener.stop();
    }
  }

  // Pilote les vrais rappels de l'observateur, sans attendre des secondes réelles.
  // Le vrai listen() passe par auth(), /encore/, la publication et la clôture.
  for (const source of ["auth-erreur", "auth-vide", "encore-http", "encore-reseau"]) {
    for (const recovery of [true, false]) {
      log = [];
      let observe, shown, fetched = false, failing = false, closed;
      let displayed, completed;
      const ready = new Promise((resolve) => { displayed = resolve; });
      const done = new Promise((resolve) => { completed = resolve; });
      globalThis.setInterval = (fn, ms, ...args) => {
        if (ms === 1000) observe = fn;
        return realSetInterval(fn, ms === 1000 ? 3600000 : ms, ...args);
      };
      electron.session.defaultSession.cookies.get = async () => {
        if (failing && source === "auth-erreur") throw new Error("Trousseau temporairement indisponible");
        if (failing && source === "auth-vide") return [];
        return realCookies();
      };
      electron.onRequest = (state) => { shown = state; displayed(); };
      globalThis.fetch = async (url, options = {}) => {
        if (url.endsWith("/battement")) return { ok: true, json: async () => ({ compte: "alice" }) };
        if (url.includes("/next?")) {
          if (fetched) return new Promise(() => {});
          fetched = true;
          return { status: 200, json: async () => ({ id: "reprise", action: "presse_papiers", texte: "après reprise" }) };
        }
        if (url.endsWith("/encore/reprise")) {
          if (failing && source === "encore-reseau") throw new Error("Connexion coupée");
          return { ok: !(failing && source === "encore-http"), status: failing ? 503 : 200 };
        }
        if (url.endsWith("/accords/reprise")) return { ok: true, json: async () => ({ id: "accord-reprise" }) };
        if (url.endsWith("/accords/reprise/reponse")) {
          closed = JSON.parse(options.body);
          log.push("cloture");
          return { ok: true };
        }
        if (url.endsWith("/result/reprise")) { completed(JSON.parse(options.body)); return { ok: true }; }
        throw new Error(`Requête inattendue : ${url}`);
      };
      const listener = actions.listen(() => "https://noah.test");
      let timeout;
      try {
        await Promise.race([ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Bandeau absent")), 3000); })]);
        failing = true;
        await observe(); await observe();
        assert.equal(electron.view.visible, true);
        assert.equal(closed, undefined);
        assert.equal(log.includes("action"), false);
        if (recovery) {
          failing = false; await observe(); // remet le compteur à zéro
          failing = true; await observe(); await observe();
          assert.equal(electron.view.visible, true);
          failing = false; await observe();
          electron.answer(shown.id, 0);
        } else {
          await observe(); // troisième échec consécutif
        }
        const result = await done;
        assert.deepEqual(closed, { id: "accord-reprise", approve: recovery });
        assert.equal(electron.view.visible, false);
        if (recovery) {
          assert.equal(result.ok, true);
          assert.deepEqual(log, ["cloture", "action"]);
        } else {
          assert.match(result.erreur, /trois fois de suite.*indisponible/);
          assert.equal(result.refuse, undefined);
          assert.equal(log.includes("action"), false);
          assert.equal(electron.answer(shown.id, 0), false);
        }
        console.log(`OK #35 GLM 1 : ${source}, ${recovery ? "deux échecs tolérés, succès remet à zéro, accord exécuté" : "trois échecs consécutifs, erreur distincte du refus, aucun effet"}`);
      } finally {
        clearTimeout(timeout);
        listener.stop();
        globalThis.setInterval = realSetInterval;
        electron.session.defaultSession.cookies.get = realCookies;
      }
    }
  }

  for (const scenario of ["expiration", "vue-interrompue", "publication-lente", "expire-avant-affichage", "expire-a-publication", "fenetre-fermee"]) {
    log = [];
    let fetched = false, expire, closed, onDisplay, finish;
    const ready = new Promise((resolve) => { onDisplay = resolve; });
    const done = new Promise((resolve) => { finish = resolve; });
    let time = realNow();
    Date.now = () => time;
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay > 279000 && delay <= 280000) expire = fn;
      return realSetTimeout(fn, delay, ...args);
    };
    electron.onRequest = (shown) => {
      log.push("affichage"); onDisplay();
      if (scenario === "publication-lente") { time += 279000; queueMicrotask(() => electron.answer(shown.id, 0)); }
    };
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith("/battement")) return { ok: true, json: async () => ({ compte: "alice" }) };
      if (url.includes("/next?")) {
        if (fetched) return new Promise(() => {});
        fetched = true;
        return { status: 200, json: async () => ({ id: "delai", action: "presse_papiers", texte: "après publication" }) };
      }
      if (url.endsWith("/encore/delai")) return { ok: scenario !== "expire-avant-affichage", status: scenario === "expire-avant-affichage" ? 410 : 200 };
      if (url.endsWith("/accords/delai")) {
        if (scenario === "expire-a-publication") return { ok: false, status: 410 };
        if (scenario === "publication-lente") time += 280001;
        return { ok: true, json: async () => ({ id: "accord-delai" }) };
      }
      if (url.endsWith("/accords/delai/reponse")) {
        closed = JSON.parse(options.body); log.push("cloture"); return { ok: true };
      }
      if (url.endsWith("/result/delai")) { finish(JSON.parse(options.body)); return { ok: true }; }
      throw new Error(`Requête inattendue : ${url}`);
    };
    const listener = actions.listen(() => "https://noah.test");
    let timeout;
    try {
      const notShown = scenario === "expire-avant-affichage" || scenario === "expire-a-publication";
      if (!notShown) {
        await Promise.race([ready, new Promise((_, reject) => { timeout = realSetTimeout(() => reject(new Error("Bandeau absent")), 3000); })]);
        if (scenario === "expiration") { assert.equal(typeof expire, "function"); time += 280001; expire(); }
        if (scenario === "vue-interrompue") electron.view.webContents.emit("render-process-gone");
        if (scenario === "fenetre-fermee") assert.doesNotThrow(() => electron.win.destroy());
      }
      const result = await done;
      if (scenario === "publication-lente") {
        assert.equal(result.ok, true);
        assert.deepEqual(log, ["affichage", "cloture", "action"]);
      } else {
        assert.match(result.erreur, ["vue-interrompue", "fenetre-fermee"].includes(scenario) ? /interrompu/ : /expiré/);
        assert.equal(result.refuse, undefined);
        assert.equal(log.includes("action"), false);
      }
      if (notShown) {
        assert.match(result.erreur, /sans avoir été affichée/);
        assert.deepEqual(log, []);
        assert.equal(closed, undefined);
      } else assert.deepEqual(closed, { id: "accord-delai", approve: scenario === "publication-lente" });
      console.log(`OK #35/#36 : ${scenario}, délai à l'affichage, clôture cohérente et aucun faux refus`);
    } finally {
      clearTimeout(timeout); listener.stop();
      Date.now = realNow; globalThis.setTimeout = realSetTimeout;
    }
  }
} finally {
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
  globalThis.setTimeout = realSetTimeout;
  Date.now = realNow;
  electron.session.defaultSession.cookies.get = realCookies;
  Module._load = originalLoad;
}
