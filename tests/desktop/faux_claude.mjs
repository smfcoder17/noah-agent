// Faux binaire `claude` pour les tests : mêmes formes de sortie que la CLI (auth status --json, -p --output-format stream-json).
// Il écrit vraiment dans son dossier de travail, et note ses arguments dans FAUX_CLAUDE_TRACE.
//   « LENT » dans la consigne : il travaille longtemps (arrêt, délai) ; « LIMITE » : la limite de l'abonnement est atteinte.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const trace = (what) => process.env.FAUX_CLAUDE_TRACE && appendFileSync(process.env.FAUX_CLAUDE_TRACE, JSON.stringify(what) + "\n");
const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (args[0] === "auth" && args[1] === "status") {
  // La vraie CLI rend aussi l'e-mail et l'organisation : Noah ne doit pas les garder.
  const connected = process.env.FAUX_CLAUDE_CONNECTE !== "0";
  process.stdout.write(JSON.stringify({ loggedIn: connected, authMethod: "claude.ai", subscriptionType: "max", apiProvider: "firstParty",
    email: "franck@exemple.fr", orgId: "org-secret", orgName: "Org secrète" }));
  process.exit(0);
}

// Tour du cerveau (--system-prompt-file) : mêmes formes que la vraie CLI avec --json-schema (structured_output dans le résultat).
//   « OUTIL_TERMINAL » : demande l'outil terminal, puis répond quand son résultat est dans la conversation ;
//   « ILLISIBLE » : une première réponse qui n'est pas du JSON, valide à la relance ; « TOUJOURS_ILLISIBLE » : jamais valide ;
//   « OUTIL_INCONNU » : un outil qui n'existe pas ; « LENT » : ne répond jamais (arrêt) ; « LIMITE » : limite atteinte.
const brain = async (prompt) => {
  const at = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const model = at("--model");
  const schema = at("--json-schema");
  const system = readFileSync(at("--system-prompt-file"), "utf8");
  trace({ args, prompt, system, cwd: process.cwd(), cerveau: true });
  const usage = { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 7 };
  const done = (fields) => { say({ type: "result", subtype: "success", is_error: false, session_id: "s-cerveau", num_turns: 1, total_cost_usd: 0.01, duration_ms: 50, usage, ...fields }); process.exit(0); };
  say({ type: "system", subtype: "init", session_id: "s-cerveau", tools: [], model });
  if (prompt.includes("LENT")) await new Promise(() => setInterval(() => {}, 1000));
  if (prompt.includes("LIMITE")) {
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached. Your limit will reset at 5pm.", usage });
    process.exit(1);
  }
  if (!schema) return done({ result: `réponse de Claude Code (${model})` });
  const retried = prompt.includes("a été refusée");
  if (prompt.includes("TOUJOURS_ILLISIBLE") || (prompt.includes("ILLISIBLE") && !retried)) return done({ result: "Voici ma réponse, sans JSON." });
  if (prompt.includes("OUTIL_INCONNU")) return done({ result: "", structured_output: { texte: "", appels: [{ nom: "rm_rf", arguments: {} }] } });
  if (prompt.includes("OUTIL_TERMINAL") && !prompt.includes("<<résultat de l'outil")) {
    return done({ result: "", structured_output: { texte: "Je regarde.", appels: [{ nom: "terminal", arguments: { command: "echo bonjour" } }] } });
  }
  const result = prompt.match(/<<résultat de l'outil[^>]*>>\n([^\n]*)/)?.[1];
  return done({ result: "", structured_output: { texte: result ? `Fini : ${result}` : `réponse de Claude Code (${model})`, appels: [] } });
};

let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", async () => {
  if (args.includes("--system-prompt-file")) return brain(prompt);
  trace({ args, prompt, cwd: process.cwd() });
  const session = "sess-1234";
  say({ type: "system", subtype: "init", session_id: session, cwd: process.cwd(), tools: [] });
  if (prompt.includes("LENT")) {
    for (let i = 0; ; i += 1) {
      say({ type: "assistant", message: { content: [{ type: "text", text: `étape ${i}` }] } });
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (prompt.includes("LIMITE")) {
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached. Your limit will reset at 5pm.", session_id: session, num_turns: 1, total_cost_usd: 0 });
    process.exit(1);
  }
  const file = join(process.cwd(), "resultat.md");
  say({ type: "assistant", message: { content: [{ type: "text", text: "Je lis le dossier puis j'écris le résumé." }, { type: "tool_use", name: "Glob", input: { pattern: "**/*" } }] } });
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: file, content: "# Résumé\n" } }] } });
  writeFileSync(file, `# Résumé\n\n${prompt}\n`);
  say({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
  say({ type: "result", subtype: "success", is_error: false, result: "J'ai écrit resultat.md avec le résumé demandé.", session_id: session, num_turns: 3,
    total_cost_usd: 0.0421, duration_ms: 1200 });
  process.exit(0);
});
