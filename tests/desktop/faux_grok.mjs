// Faux binaire `grok` (Grok Build, xAI) pour les tests : mêmes formes que la documentation de la CLI sans interface
// (https://github.com/xai-org/grok-build, user-guide/14-headless-mode.md) : `--output-format streaming-messages-json`, soit
// system/init avec `model`, assistant, puis result avec usage (input_tokens, cache_read_input_tokens, output_tokens, total_tokens).
// Il note ses arguments et l'environnement reçu dans FAUX_GROK_TRACE.
//   « LIMITE » dans la consigne : quota atteint ; « DECONNECTE » : pas connecté ; « LENT » : ne répond jamais ;
//   « OUTIL_TERMINAL » : demande l'outil terminal, puis conclut quand son résultat est dans la conversation.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const trace = (what) => process.env.FAUX_GROK_TRACE && appendFileSync(process.env.FAUX_GROK_TRACE, JSON.stringify(what) + "\n");
const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const xai = () => Object.keys(process.env).filter((k) => /^xai_/i.test(k));

if (args[0] === "--version") { console.log("grok 0.0.0-faux"); process.exit(0); }
if (args[0] === "login") {
  trace({ args, connexion: true });
  // Code d'appareil, comme la CLI 1.0.x : adresse de vérification et code, puis attente de la validation (FAUX_GROK_DEVICE).
  if (process.env.FAUX_GROK_DEVICE) { process.stdout.write(`\x1b[1mTo sign in, open ${process.env.FAUX_GROK_DEVICE}\x1b[0m\nand enter the code: WXYZ-2468\nWaiting for authorization...\n`); await new Promise((r) => setTimeout(r, 150)); }
  process.exit(process.env.FAUX_GROK_LOGIN === "0" ? 1 : 0);
}
if (args[0] === "logout") { trace({ args }); process.exit(0); }

const prompt = readFileSync(at("--prompt-file"), "utf8");
const model = at("--model") || "grok-4.3";
trace({ args, prompt, cwd: process.cwd(), xai: xai() });
const usage = { input_tokens: 90, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 8, reasoning_tokens: 0, total_tokens: 108 };
const done = (fields) => { say({ type: "result", subtype: "success", is_error: false, session_id: "g-1", num_turns: 1, usage, ...fields }); process.exit(0); };
say({ type: "system", subtype: "init", session_id: "g-1", model, tools: [], cwd: process.cwd() });
if (prompt.includes("LENT")) await new Promise(() => setInterval(() => {}, 1000));
if (prompt.includes("DECONNECTE")) { process.stderr.write("Error: not logged in. Please log in with `grok login`.\n"); process.exit(1); }
if (prompt.includes("LIMITE")) { say({ type: "result", subtype: "error_during_execution", is_error: true, result: "Usage limit reached for your plan.", usage }); process.exit(1); }
// Sans outils, la consigne ne demande pas de JSON : la CLI rend du texte ; avec des outils ("Comment répondre"), l'objet demandé.
const json = prompt.includes("# Comment répondre");
if (prompt.includes("OUTIL_TERMINAL") && !prompt.includes("<<résultat de l'outil")) {
  done({ result: JSON.stringify({ texte: "Je regarde.", appels: [{ nom: "terminal", arguments: { command: "echo bonjour" } }] }) });
}
const result = prompt.match(/<<résultat de l'outil[^>]*>>\n([^\n]*)/)?.[1];
const texte = result ? `Fini : ${result}` : `réponse de Grok (${model})`;
done({ result: json ? JSON.stringify({ texte, appels: [] }) : texte });
