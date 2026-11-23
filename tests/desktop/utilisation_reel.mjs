// Essai RÉEL des abonnements sur cet ordinateur, avec les vrais binaires et les vrais comptes : l'utilisation lue par les modules du
// bureau (claude.js, chatgpt.js, grok.js, usage.js), sans l'interface Electron. Il dépense un peu de chaque abonnement (un mot de réponse).
// Ne saisit jamais d'identifiant : la connexion ChatGPT et Grok se fait dans le navigateur de la personne.
//   node tests/desktop/utilisation_reel.mjs claude            Claude Code (déjà connecté) : un tour cerveau, une tâche confiée
//   node tests/desktop/utilisation_reel.mjs chatgpt           ouvre la connexion ChatGPT, attend le clic, puis un tour
//   node tests/desktop/utilisation_reel.mjs grok              Grok Build : installé ? connexion (`grok login`) puis un tour
//   node tests/desktop/utilisation_reel.mjs claude chatgpt grok
//   NOAH_SANS_NAVIGATEUR=1 : n'ouvre pas le navigateur, attend seulement (pour vérifier qu'on arrive bien au point de connexion)
// Rien n'est affiché qui ressemble à un jeton : seulement des pourcentages, des états, des noms d'en-têtes et des noms de modèles.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "../../desktop");
const usage = require(join(root, "usage.js"));
const claude = require(join(root, "claude.js"));
const chatgpt = require(join(root, "chatgpt.js"));
const grok = require(join(root, "grok.js"));
const { t } = require(join(root, "textes.js"));

const wanted = new Set(process.argv.slice(2));
if (!wanted.size) { console.log("Usage : node tests/desktop/utilisation_reel.mjs claude|chatgpt|grok [...]"); process.exit(2); }
const chat = (text) => ({ messages: [{ role: "user", content: text }] });
const show = (provider) => {
  const snap = usage.snapshot()[provider];
  console.log(`  instantané « ${provider} » :`, JSON.stringify(snap));
  for (const line of usage.describe(provider, snap, t, "fr")) console.log(`  → ${line}`);
};
let failed = 0;
const ok = (name, good, detail = "") => { console.log(good ? "OK   " : "ÉCHEC", name, good ? "" : detail); if (!good) failed += 1; };
const openBrowser = (url) => new Promise((resolve) => {
  if (process.env.NOAH_SANS_NAVIGATEUR === "1") { const u = new URL(url); console.log(`  (essai à blanc : le navigateur ne s'ouvre pas ; la page serait ${u.origin}${u.pathname})`); return; } // reste en attente, comme avant le clic
  // Le navigateur par défaut de la personne ; l'adresse ne porte aucun secret (état et défi PKCE à usage unique).
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`], { stdio: "ignore", windowsHide: true });
  child.on("close", resolve);
});

if (wanted.has("claude")) {
  console.log("\n=== Claude Code (réel) ===");
  const status = await claude.detect();
  ok("Claude Code installé et connecté", status.installe && status.connecte, JSON.stringify(status));
  console.log(`  offre : ${status.offre}, méthode : ${status.methode}`);
  usage.reset();
  const turn = await claude.brain({ body: chat("Réponds uniquement par le mot : ok"), model: "haiku" });
  ok("tour du cerveau réel", turn.ok === true, JSON.stringify(turn));
  console.log(`  alias demandé : haiku, modèle exact servi : ${turn.modele_exact}, réponse : ${JSON.stringify(turn.reponse?.choices?.[0]?.message?.content)}`);
  show("claude");
  const dir = mkdtempSync(join(tmpdir(), "noah-reel-"));
  writeFileSync(join(dir, "notes.txt"), "pomme\npoire\n");
  const task = await claude.run({ consigne: "Réponds uniquement par le mot : ok. N'utilise aucun outil.", cwd: dir, profile: "fichiers", minutes: 5 });
  ok("tâche confiée réelle", task.ok === true, JSON.stringify(task));
  console.log(`  modèle exact de la tâche : ${task.modele_exact}, coût estimé : ${task.cout_estime_usd}`);
  show("claude");
  const windows = usage.snapshot().claude?.fenetres ?? [];
  ok("au moins une fenêtre d'utilisation lue (pourcentage réel)", windows.some((w) => typeof w.pct === "number"), JSON.stringify(windows));
  rmSync(dir, { recursive: true, force: true });
}

if (wanted.has("chatgpt")) {
  console.log("\n=== ChatGPT (réel) : connexion dans TON navigateur ===");
  let sealed = null; // en mémoire seulement : rien n'est écrit sur le disque
  const config = {};
  chatgpt.configure({ storage: { read: () => sealed && JSON.parse(sealed), write: (d) => { sealed = d ? JSON.stringify(d) : null; } } });
  console.log("  Ton navigateur va s'ouvrir sur la page de connexion OpenAI : connecte-toi et autorise Noah Agent (10 minutes).");
  try {
    await chatgpt.login({ open: openBrowser, read: () => config, write: (p) => Object.assign(config, p) });
    ok("connexion « Sign in with ChatGPT »", chatgpt.connected());
    console.log(`  modèles du compte : ${chatgpt.models().map((m) => m.slug).join(", ") || "(aucun)"}`);
    usage.reset();
    const model = chatgpt.models()[0]?.slug;
    const out = await chatgpt.call(chat("Réponds uniquement par le mot : ok"), model);
    ok("tour réel par le forfait", out.ok === true, JSON.stringify(out).slice(0, 300));
    console.log(`  en-têtes de limites vus sur la réponse (noms seulement) : ${chatgpt.limitHeaders().join(", ") || "(aucun)"}`);
    show("chatgpt");
  } catch (e) {
    ok("connexion « Sign in with ChatGPT »", false, String(e.message).slice(0, 200));
  } finally {
    chatgpt.logout();
  }
}

if (wanted.has("grok")) {
  console.log("\n=== Grok Build (réel) ===");
  let saved = false;
  grok.configure({ changed: () => { saved = true; }, minute: 60000 });
  const status = await grok.detect();
  if (!status.installe) {
    console.log("  Grok Build n'est pas installé sur ce PC. Installation officielle (PowerShell) : irm https://x.ai/cli/install.ps1 | iex");
    ok("Grok Build installé", false, "voir la ligne ci-dessus");
  } else {
    console.log("  Grok Build trouvé. La connexion s'ouvre dans ton navigateur (commande officielle : grok login).");
    const login = await grok.login();
    ok("connexion `grok login`", login.ok === true, JSON.stringify(login));
    usage.reset();
    const out = await grok.brain({ body: chat("Réponds uniquement par le mot : ok"), model: "" });
    ok("tour réel par Grok Build", out.ok === true, JSON.stringify(out).slice(0, 400));
    console.log(`  modèle annoncé par la CLI : ${out.modele_exact}, modèles connus : ${grok.models().map((m) => m.slug).join(", ")}`);
    show("grok");
    ok("l'état connecté a été gardé", saved);
  }
}

console.log(failed ? `\n${failed} échec(s)` : "\nEssai réel : tout est passé.");
process.exit(failed ? 1 : 0);
