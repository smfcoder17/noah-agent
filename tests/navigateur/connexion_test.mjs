// Se connecter à un site : les routes de l'extension du navigateur. La clé de l'agent n'y ouvre rien, l'origine est vérifiée dans le script
// même qui écrit, personne ne lit l'onglet pendant ce temps, et le mot de passe ne reste pas dans le champ. Ici, une fausse page, sans
// Firefox : le vrai navigateur se vérifie dans tests/real/connexion_vraie.sh.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine \
//     sh -c "mkdir -p /data && node /tests/navigateur/connexion_test.mjs"
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

process.env.CAMOFOX_API_KEY = "cle-agent";
process.env.NOAH_PRIVATE_KEY = "cle-serveur";
const MOT_DE_PASSE = "faux-mot-de-passe-Zq81x";
const ORIGINE = "https://www.site.fr";

// --- Une fausse page, juste ce que le script de remplissage regarde -----------------------------------------------------
class FakeInput {
  constructor(attrs = {}) {
    Object.assign(this, { type: "text", name: "", id: "", placeholder: "", autocomplete: "", maxLength: -1, disabled: false, readOnly: false, form: null, labels: [], hidden: false, events: [], order: 0, _value: "" }, attrs);
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  getAttribute(name) { return name === "aria-label" ? this.aria || null : null; }
  getClientRects() { return this.hidden ? [] : [1]; }
  focus() {}
  dispatchEvent(e) { this.events.push(e.type); return true; }
  compareDocumentPosition(other) { return other.order > this.order ? 4 : 2; }
  asElement() { return this; }
  async press() { page.sent++; }
  async click() { page.sent++; }
}
globalThis.HTMLInputElement = FakeInput;
globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.getComputedStyle = () => ({ visibility: "visible" });

const page = {
  sent: 0, reloads: 0, inputs: [], button: null, afterEval: null, leave: false, url: `${ORIGINE}/login`,
  setOrigin(origin) { globalThis.location = { origin, href: `${origin}/login` }; },
  frames() { return [frame]; },
  isClosed: () => false,
  async evaluate(fn, arg) {
    const out = fn(arg);
    if (page.afterEval) { const after = page.afterEval; page.afterEval = null; after(); }
    return out;
  },
  async waitForTimeout() {
    await new Promise((r) => setTimeout(r, 1));
    if (page.sent && !page.leave) { page.inputs = []; globalThis.document.reset(); }
  },
  async reload() {
    page.reloads++;
    if (page.reloadError) throw new Error(page.reloadError);
  },
};
const frame = {
  url: () => globalThis.location.href,
  page: () => page,
  evaluate: (fn, arg) => page.evaluate(fn, arg),
  evaluateHandle: async (fn, arg) => { const el = fn(arg); return { asElement: () => el || null }; },
};
globalThis.document = {
  querySelectorAll: (selector) => (selector === "input" ? page.inputs : page.button ? [page.button] : []),
  reset() {},
};

function loginPage(extra = []) {
  const form = { getAttribute: () => null, querySelectorAll: () => (page.button ? [page.button] : []) };
  const user = new FakeInput({ name: "username", autocomplete: "username", form, order: 1 });
  const password = new FakeInput({ type: "password", autocomplete: "current-password", form, order: 2 });
  page.button = new FakeInput({ type: "submit", form, textContent: "Entrer", value: "" });
  page.inputs = [user, password, ...extra.map((a) => new FakeInput({ form, order: 3, ...a }))];
  page.sent = 0;
  page.leave = false;
  page.setOrigin(ORIGINE);
  return { user, password, form };
}

// --- L'extension, branchée sur cette page -------------------------------------------------------------------------------
const { default: register } = await import("/p/index.js");
const stack = [];
const logs = [];
const events = new EventEmitter();
const session = { tabGroups: new Map([["noah", new Map([["t1", { page }]])]]) };
const ctx = {
  events, log: (...a) => logs.push(JSON.stringify(a)), sessions: new Map([["noah", session]]), normalizeUserId: (u) => u,
  withUserLimit: (_, fn) => fn(),
};
register({ use: (fn) => stack.push(fn), router: { stack } }, ctx);

async function call(method, path, { key, body, query = {}, raw } = {}) {
  const req = Readable.from(raw !== undefined ? [Buffer.from(raw)] : body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, path, query, headers: { authorization: key && `Bearer ${key}` } });
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      headersSent: false,
      status: (c) => ((status = c), res),
      set: () => res,
      json: (data) => { res.headersSent = true; resolve({ status, data, text: JSON.stringify(data) }); return res; },
    };
    stack[0](req, res, () => resolve({ status: "suivant" }));
  });
}
const FILL = { userId: "noah", onglet: "t1", origine: ORIGINE, identifiant: "alice@exemple.fr", motDePasse: MOT_DE_PASSE };
const fill = (over = {}) => call("POST", "/noah/remplir", { key: "cle-serveur", body: { ...FILL, ...over } });

let { user, password } = loginPage();
for (const path of ["/noah/remplir", "/noah/page"]) {
  assert.equal((await call("POST", path, { key: "cle-agent", body: FILL, query: { userId: "noah" } })).status, 403);
  assert.equal((await call("POST", path, { body: FILL, query: { userId: "noah" } })).status, 403);
}
assert.equal(password.value, "");
console.log("1. l'agent, avec sa clé du navigateur, n'ouvre pas ces routes (403) : rien n'est écrit");

let r = await call("POST", "/noah/page", { key: "cle-serveur", query: { userId: "noah" } });
assert.deepEqual(r.data, { ok: true, onglet: "t1", origine: ORIGINE, champs: { identifiant: true, motDePasse: true, code: false } });
page.setOrigin("null");
globalThis.location.href = "about:blank";
r = await call("POST", "/noah/page", { key: "cle-serveur", query: { userId: "noah" } });
assert.equal(r.data.origine, null);
page.setOrigin(ORIGINE);
console.log("2. l'origine lue est celle de la page ; une page sans adresse web n'en a pas");

r = await fill();
assert.equal(r.status, 200, r.text);
assert.equal(user.value, "alice@exemple.fr");
assert.equal(password.value, MOT_DE_PASSE);
assert.ok(user.events.includes("input") && password.events.includes("input"), "un site comme React ne lit que l'événement de saisie");
assert.equal(page.sent, 1, "le formulaire part aussitôt");
assert.deepEqual([r.data.page, r.data.complet, r.data.rempli], ["changee", true, ["identifiant", "motDePasse"]]);
assert.ok(!r.text.includes(MOT_DE_PASSE), "le résultat ne recopie pas le secret");
console.log("3. page remplie, formulaire envoyé, résultat sans le secret");

// La page change de site juste après le contrôle d'avant : le script qui écrit le voit quand même.
({ password } = loginPage());
page.afterEval = () => page.setOrigin("https://piege.io");
const seen = page.frames;
page.frames = () => [{ ...frame, url: () => `${ORIGINE}/login` }];
r = await fill();
page.frames = seen;
assert.equal(r.status, 409, r.text);
assert.equal(password.value, "", "le script a refusé d'écrire");
console.log("4. l'origine change entre le contrôle et l'écriture : le script qui écrit refuse");

({ password } = loginPage());
page.setOrigin("https://www.site.fr.piege.io");
r = await fill();
assert.equal(r.status, 409, r.text);
assert.equal(password.value, "");
console.log("5. une autre origine dès le départ : refus, rien n'est écrit");

({ password } = loginPage());
page.leave = true;
let during = null;
const wait = page.waitForTimeout;
page.waitForTimeout = async () => {
  during ??= await Promise.all(["/tabs/t1/snapshot", "/tabs/t1/evaluate", "/tabs/t1/screenshot", "/snapshot", "/act"].map((p) => call("GET", p)));
  await wait();
};
r = await fill();
page.waitForTimeout = wait;
assert.deepEqual(during.map((d) => d.status), [423, 423, 423, 423, 423]);
assert.equal((await call("GET", "/tabs/t1/snapshot")).status, "suivant");
console.log("6. pendant le remplissage, personne ne lit l'onglet (423) ; après, si");

assert.equal(r.data.page, "meme");
assert.equal(password.value, "", "formulaire resté affiché : le champ est vidé");
console.log("7. formulaire resté affiché : le mot de passe ne reste pas dans le champ, et c'est dit");

({ password } = loginPage());
page.reloads = 0;
events.emit("tab:evaluate", { tabId: "t1", expression: "window.location.href" });
await fill();
assert.equal(page.reloads, 0, "la lecture qu'Hermes fait de lui-même ne compte pas");
({ password } = loginPage());
events.emit("tab:evaluate", { tabId: "t1", expression: "document.addEventListener('input', voler)" });
await fill();
assert.equal(page.reloads, 1, "un script lancé par l'agent : page rechargée avant d'écrire");
({ password } = loginPage());
await fill();
assert.equal(page.reloads, 1, "une seule fois");
console.log("8. l'agent a lancé un script dans l'onglet : la page est rechargée avant d'écrire");

({ password } = loginPage());
page.inputs[0].form = password.form;
password.form.getAttribute = (name) => (name === "method" ? "GET" : null);
r = await fill();
assert.equal(r.status, 422, r.text);
assert.equal(password.value, "");
console.log("9. un formulaire en GET mettrait le mot de passe dans l'adresse : refus");

let others = loginPage([{ type: "password", name: "leurre", hidden: true }, { type: "password", autocomplete: "new-password", name: "nouveau" }]);
const [, , hidden, fresh] = page.inputs;
page.inputs = [hidden, fresh, others.user, others.password];
await fill();
assert.equal(others.password.value, MOT_DE_PASSE);
assert.equal(hidden.value, "", "un champ caché n'est jamais rempli");
assert.equal(fresh.value, "", "ni celui d'un nouveau mot de passe");
console.log("10. un champ caché ou de nouveau mot de passe n'est pas rempli");

({ password } = loginPage());
assert.equal((await call("POST", "/noah/remplir", { key: "cle-serveur", raw: JSON.stringify({ ...FILL, motDePasse: "x".repeat(9000) }) })).status, 413);
assert.equal((await call("POST", "/noah/remplir", { key: "cle-serveur", raw: MOT_DE_PASSE })).status, 400);
assert.equal(password.value, "");
console.log("11. demande trop longue ou illisible : refusée");

assert.equal((await call("POST", "/noah/prive", { key: "cle-serveur", query: { secondes: "60" } })).status, 200);
({ password } = loginPage());
r = await fill();
assert.equal(r.status, 423, r.text);
assert.equal(password.value, "");
assert.equal((await call("POST", "/noah/prive", { key: "cle-serveur", query: { secondes: "0" } })).status, 200);
console.log("12. la personne a la main sur l'écran : rien n'est écrit sous ses doigts");

({ password } = loginPage());
events.emit("tab:evaluate", { tabId: "t1", expression: "x" });
page.reloadError = `erreur qui cite ${MOT_DE_PASSE}`;
r = await fill();
page.reloadError = "";
assert.equal(r.status, 500);
assert.ok(!r.text.includes(MOT_DE_PASSE), "la réponse ne recopie pas une erreur de page");
assert.ok(!logs.some((line) => line.includes(MOT_DE_PASSE) || line.includes("alice@")), logs.join("\n"));
console.log("13. une panne : ni la réponse ni le journal ne citent la valeur");

({ password, user } = loginPage());
page.inputs = [user];
user.form.getAttribute = () => null;
page.leave = true; // la page ne change pas : le champ du mot de passe arrive à l'écran suivant
const step = page.waitForTimeout;
page.waitForTimeout = async () => {
  if (page.sent && !page.inputs.includes(password)) page.inputs = [password];
  await step();
};
r = await fill();
page.waitForTimeout = step;
assert.equal(user.value, "alice@exemple.fr");
assert.equal(r.data.complet, true, r.text);
assert.deepEqual(r.data.rempli, ["identifiant", "motDePasse"]);
assert.equal(page.sent, 2);
console.log("14. identifiant d'abord, mot de passe à l'écran suivant");

const boxes = Array.from({ length: 6 }, (_, i) => new FakeInput({ maxLength: 1, order: i }));
loginPage();
page.inputs = boxes;
r = await fill({ identifiant: undefined, motDePasse: undefined, code: "482913" });
assert.equal(r.status, 200, r.text);
assert.deepEqual(r.data.rempli, ["code"]);
console.log("15. un code en six cases");

console.log("connexion dans le navigateur : tout est vert");
process.exit(0);
