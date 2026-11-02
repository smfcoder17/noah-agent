// G7.7 : pendant une prise en main, aucune capture d'écran. L'agent ne peut pas couper le mode privé avec sa clé, et
// un redémarrage du navigateur ne le perd pas.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine \
//     sh -c "mkdir -p /data && node /tests/handoff/private_test.mjs"
import assert from "node:assert/strict";

process.env.CAMOFOX_API_KEY = "cle-agent";
process.env.NOAH_PRIVATE_KEY = "cle-serveur";

let loads = 0;
async function browser() {
  // Nouvelle instance du module à chaque fois : comme un navigateur qui redémarre.
  const { default: register } = await import(`/p/index.js?n=${++loads}`);
  const stack = [];
  const app = { use: (fn) => stack.push(fn), router: { stack } };
  register(app, { events: { on() {} }, log() {} });
  return (method, path, { auth, query = {} } = {}) => {
    let status = 200;
    let passed = false;
    const res = { status: (c) => ((status = c), res), json: () => res };
    stack[0]({ method, path, query, headers: { authorization: auth && `Bearer ${auth}` } }, res, () => (passed = true));
    return passed ? "suivant" : status;
  };
}

let call = await browser();
const shot = () => call("GET", "/tabs/t1/screenshot");
assert.equal(shot(), "suivant");

assert.equal(call("POST", "/noah/prive", { auth: "cle-agent", query: { secondes: "3600" } }), 403);
assert.equal(call("POST", "/noah/prive", { query: { secondes: "3600" } }), 403);
assert.equal(call("POST", "/noah/prive", { auth: "cle-serveur", query: { secondes: "3600" } }), 200);
assert.equal(shot(), 423);
assert.equal(call("GET", "/tabs/t1/snapshot", { query: { includeScreenshot: "true" } }), 423);
console.log("1. mode privé posé par le serveur : captures refusées (423)");

assert.equal(call("POST", "/noah/prive", { auth: "cle-agent", query: { secondes: "0" } }), 403);
assert.equal(shot(), 423);
console.log("2. l'agent ne peut pas le couper avec sa propre clé (403), les captures restent refusées");

call = await browser();
assert.equal(shot(), 423);
console.log("3. navigateur redémarré pendant la prise en main : toujours en privé");

assert.equal(call("POST", "/noah/prive", { auth: "cle-serveur", query: { secondes: "0" } }), 200);
assert.equal(shot(), "suivant");
call = await browser();
assert.equal(shot(), "suivant");
console.log("4. fin de la prise en main : captures permises, et après redémarrage aussi");

delete process.env.NOAH_PRIVATE_KEY;
call = await browser();
assert.equal(call("POST", "/noah/prive", { auth: "", query: { secondes: "0" } }), 403);
assert.equal(call("POST", "/noah/prive", { auth: "undefined", query: { secondes: "0" } }), 403);
console.log("5. navigateur sans clé du mode privé : personne ne le pilote");
console.log("mode privé : tout est vert");
