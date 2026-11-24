// 0.4.3 : Grok connecté dans un terminal (`grok login`) restait « non connecté » dans l'app installée. La présence du fichier
// de connexion de la CLI suffit ; il n'est jamais lu.
//   node tests/desktop/grok_connexion_test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const grok = require("../../desktop/grok.js");
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GROK = { cmd: process.execPath, prefix: [join(HERE, "faux_grok.mjs")] };
const dir = mkdtempSync(join(tmpdir(), "noah-grok-auth-"));
const auth = join(dir, "auth.json");
let changes = 0;
try {
  grok.configure({ program: FAKE_GROK, connected: false, models: [], auth, changed: () => { changes++; } });
  await grok.detect();
  assert.equal(grok.status().connecte, false, "sans fichier de connexion : non connecté");
  writeFileSync(auth, '{"jeton":"factice"}');
  await grok.detect();
  assert.equal(grok.status().connecte, true, "connecté hors de l'app : reconnu");
  assert.equal(changes, 1, "l'app garde le nouvel état");
  rmSync(auth);
  await grok.detect();
  assert.equal(grok.status().connecte, false, "déconnecté hors de l'app : reconnu");
  // Faux binaire sans fichier imposé : l'état gardé par l'app reste la seule source (les autres tests en dépendent).
  grok.configure({ program: FAKE_GROK, connected: true, auth: null });
  await grok.detect();
  assert.equal(grok.status().connecte, true);
  console.log("Connexion de Grok faite hors de l'app : tout tient.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
