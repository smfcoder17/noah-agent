// Faux `codex app-server` pour les tests : JSON-RPC en lignes JSON sur l'entrée et la sortie standard, comme la documentation
// d'OpenAI (https://developers.openai.com/codex/app-server) : initialize (id 0), notification initialized, puis les requêtes.
// Il refuse toute requête reçue avant `initialized`, et répond account/rateLimits/read et account/read.
//   FAUX_CODEX_MODE=deconnecte : account/rateLimits/read rend une erreur ; =muet : ne répond jamais ; =vide : aucune fenêtre.
import { createInterface } from "node:readline";

if (process.argv[2] !== "app-server") process.exit(64);
const mode = process.env.FAUX_CODEX_MODE || "";
const say = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let ready = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") return say({ id: msg.id, result: { userAgent: "faux-codex/0.0.0" } });
  if (msg.method === "initialized") { ready = true; return; }
  if (!ready) return say({ id: msg.id, error: { code: -32002, message: "Not initialized" } });
  if (mode === "muet") return;
  if (msg.method === "account/rateLimits/read") {
    if (mode === "deconnecte") return say({ id: msg.id, error: { code: -32001, message: "not signed in" } });
    const rateLimits = mode === "vide" ? { limitId: "codex", primary: null, secondary: null }
      : { limitId: "codex", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1900500000 } };
    return say({ id: msg.id, result: { rateLimits, rateLimitsByLimitId: { codex: rateLimits } } });
  }
  if (msg.method === "account/read") return say({ id: msg.id, result: { account: { type: "chatgpt", email: "personne@example.com", planType: "plus" }, requiresOpenaiAuth: false } });
  say({ id: msg.id, error: { code: -32601, message: "unknown method" } });
});
