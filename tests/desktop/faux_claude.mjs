// Faux binaire `claude` pour les tests : mêmes formes de sortie que la CLI (auth status --json, -p --output-format stream-json).
// Il écrit vraiment dans son dossier de travail, et note ses arguments dans FAUX_CLAUDE_TRACE.
//   « LENT » dans la consigne : il travaille longtemps (arrêt, délai) ; « LIMITE » : la limite de l'abonnement est atteinte.
import { appendFileSync, writeFileSync } from "node:fs";
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

let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", async () => {
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
