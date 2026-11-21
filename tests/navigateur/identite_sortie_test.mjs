// Langue et fuseau derrière une sortie réseau : avec PROXY_HOST, Camofox ignore CAMOFOX_LOCALE et prend la langue que sa table donne au
// pays de l'adresse (en-CA) ; l'extension Noah remet celle que le serveur a choisie (fr-CA). Vraie extension, événements de Camofox.
//
//   docker run --rm -v "$PWD/launcher/camofox-noah:/p:ro" -v "$PWD/tests:/tests:ro" node:22-alpine node /tests/navigateur/identite_sortie_test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { keepIdentity } = await import(process.env.NOAH_PLUGIN || "/p/index.js");

// Ce que launchOptions() de camoufox-js a écrit avec geoip, pour une adresse de Montréal.
function launching(config) {
  const text = JSON.stringify(config), env = { PATH: "/bin" };
  for (let i = 0, k = 1; i < text.length; i += 32767, k++) env[`CAMOU_CONFIG_${k}`] = text.slice(i, i + 32767);
  return { env };
}
const read = (env) => JSON.parse(Object.keys(env).filter((k) => k.startsWith("CAMOU_CONFIG_")).sort((a, b) => +a.split("_")[2] - +b.split("_")[2]).map((k) => env[k]).join(""));
function run(env, config) {
  const events = new EventEmitter();
  keepIdentity({ events, log: () => {} }, env);
  const options = launching(config);
  events.emit("browser:launching", { options });
  return read(options.env);
}
const geoip = { "locale:language": "en", "locale:region": "CA", timezone: "America/Toronto", "geolocation:latitude": 45.5, "navigator.hardwareConcurrency": 8 };

// Avec la sortie : fr-CA, fuseau du serveur, et la machine n'est pas touchée.
const out = run({ PROXY_HOST: "noah-sortie", CAMOFOX_LOCALE: "fr-CA", CAMOFOX_TIMEZONE: "America/Toronto" }, geoip);
assert.equal(out["locale:language"], "fr");
assert.equal(out["locale:region"], "CA");
assert.equal(out["locale:all"], "fr-CA, fr");
assert.equal(out.timezone, "America/Toronto");
assert.equal(out["geolocation:latitude"], 45.5, "la position tirée de l'adresse reste");
assert.equal(out["navigator.hardwareConcurrency"], 8, "la machine reste");
console.log("avec la sortie : fr-CA remis sur la langue tirée de l'adresse (en-CA)");

// Base de position absente : le fuseau vient du serveur.
const sansGeo = run({ PROXY_HOST: "noah-sortie", CAMOFOX_LOCALE: "fr-CA", CAMOFOX_TIMEZONE: "America/Toronto" }, { "navigator.hardwareConcurrency": 4 });
assert.equal(sansGeo.timezone, "America/Toronto");
assert.equal(sansGeo["locale:language"], "fr");

// Sans proxy : rien ne change (Camofox applique lui-même l'identité). Sans identité : rien non plus.
assert.deepEqual(run({ CAMOFOX_LOCALE: "fr-FR", CAMOFOX_TIMEZONE: "Europe/Paris" }, geoip), geoip, "sans proxy, Camofox s'en charge");
assert.deepEqual(run({ PROXY_HOST: "noah-sortie" }, geoip), geoip, "identité inconnue : la langue de l'adresse reste");
assert.deepEqual(run({ PROXY_HOST: "noah-sortie", CAMOFOX_LOCALE: "n'importe quoi", CAMOFOX_TIMEZONE: "Europe/Paris" }, geoip), geoip, "une langue mal formée n'est pas posée");

// Une empreinte longue (deux variables CAMOU_CONFIG) est recousue sans perte.
const longue = { ...geoip, x: "y".repeat(40000) };
assert.equal(run({ PROXY_HOST: "noah-sortie", CAMOFOX_LOCALE: "fr-CA", CAMOFOX_TIMEZONE: "America/Toronto" }, longue).x.length, 40000);
console.log("OK : identité derrière une sortie réseau");
