// Installation de la CLI d'un abonnement (desktop/installateur.js) face à un faux installateur servi sur 127.0.0.1 : binaire déjà là
// (aucun téléchargement, aucune question), refus (rien de téléchargé), accord puis installation réelle d'un petit script, panne
// réseau, page de blocage au lieu d'un script, adresse hors éditeur, code de sortie non nul, délai, binaire retrouvé sans mise à
// jour du PATH, secrets masqués au journal, environnement sans clé. Les vraies adresses (https://claude.ai/install.ps1,
// https://x.ai/cli/install.ps1) ne sont jamais jointes ici.
//   node tests/desktop/installateur_test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const inst = require("../../desktop/installateur.js");
const win = process.platform === "win32";

let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`OK    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`ÉCHEC ${name}\n       ${String(e.stack || e).split("\n").slice(0, 4).join("\n       ")}`);
  }
};

const base = mkdtempSync(join(tmpdir(), "noah-inst-test-"));
const target = join(base, "bin", "grok-faux.txt"); // ce que « l'installateur » pose : le binaire n'est dans aucun PATH
let hits = [];
let body = "";
let status = 200;
const server = createServer((req, res) => {
  hits.push(req.url);
  if (req.url === "/redirige") { res.writeHead(302, { location: "https://evil.example/install.ps1" }); return res.end(); }
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const script = win
  ? `New-Item -ItemType Directory -Force -Path '${join(base, "bin")}' | Out-Null\nSet-Content -Path '${target}' -Value 'binaire'\nWrite-Output 'Installation : Authorization: Bearer sk-abcdefghijklmnop token=zzz123'\nWrite-Output \"cle=$env:XAI_API_KEY|$env:ANTHROPIC_API_KEY|fin\"\n`
  : `mkdir -p '${join(base, "bin")}'\necho binaire > '${target}'\necho "Installation : Authorization: Bearer sk-abcdefghijklmnop token=zzz123"\necho "cle=$XAI_API_KEY|$ANTHROPIC_API_KEY|fin"\n`;

const found = () => existsSync(target);
const locate = () => (found() ? { cmd: target, prefix: [] } : null);
const run = (opts = {}) => {
  const log = [], progress = [], asked = [];
  const promise = inst.ensure("grok", {
    locate,
    confirm: async (src, url) => { asked.push({ src, url }); return opts.accept ?? true; },
    onProgress: (step, line) => progress.push(line ? `${step}:${line}` : step),
    log: (line) => log.push(line),
  });
  return promise.then((result) => ({ result, log, progress, asked }));
};
const reset = () => { rmSync(join(base, "bin"), { recursive: true, force: true }); hits = []; body = script; status = 200; inst.configure({ sources: { grok: { ps1: `${origin}/install.ps1`, sh: `${origin}/install.sh` } } }); };

process.env.XAI_API_KEY = "xai-cle-de-la-personne";
process.env.ANTHROPIC_API_KEY = "sk-ant-cle-de-la-personne";

await step("les sources officielles : HTTPS, domaine exact de l'éditeur, taille annoncée", () => {
  assert.equal(inst.SOURCES.claude.ps1, "https://claude.ai/install.ps1");
  assert.equal(inst.SOURCES.claude.sh, "https://claude.ai/install.sh");
  assert.equal(inst.SOURCES.grok.ps1, "https://x.ai/cli/install.ps1");
  assert.equal(inst.SOURCES.grok.sh, "https://x.ai/cli/install.sh");
  assert.equal(inst.SOURCES.grok.mo, 260);
  inst.configure({});
  assert.equal(inst.checkUrl("https://x.ai/cli/install.ps1", "x.ai"), true);
  for (const bad of ["http://x.ai/cli/install.ps1", "https://x.ai.evil.com/install.ps1", "https://evil.com/x.ai", "https://user:pw@x.ai/i.ps1", "https://xx.ai/i.ps1", "file:///c:/x.ps1", "pas une adresse"]) assert.equal(inst.checkUrl(bad, "x.ai"), false, bad);
  assert.equal(inst.checkUrl("http://127.0.0.1:1/i.ps1", "x.ai"), false, "HTTP local refusé hors essais");
});

await step("binaire déjà présent : aucune question, aucun téléchargement", async () => {
  reset();
  mkdirSyncBin();
  const out = await run();
  assert.deepEqual(out.result, { ok: true, deja: true });
  assert.equal(out.asked.length, 0);
  assert.deepEqual(hits, []);
});
function mkdirSyncBin() { require("node:fs").mkdirSync(join(base, "bin"), { recursive: true }); writeFileSync(target, "x"); }

await step("refus de la personne : rien n'est téléchargé ni lancé, le refus est journalisé", async () => {
  reset();
  const out = await run({ accept: false });
  assert.deepEqual(out.result, { refuse: true });
  assert.equal(out.asked.length, 1);
  assert.equal(out.asked[0].src.nom, "Grok");
  assert.equal(out.asked[0].src.mo, 260);
  assert.deepEqual(hits, []);
  assert.equal(found(), false);
  assert.ok(out.log.some((l) => /refusée/.test(l)));
});

await step("accord : installation réelle du script, binaire retrouvé sans toucher au PATH, étapes visibles, dossier temporaire supprimé", async () => {
  reset();
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("noah-install-"));
  const out = await run();
  assert.deepEqual(out.result, { ok: true });
  assert.deepEqual(hits, [win ? "/install.ps1" : "/install.sh"]);
  assert.equal(found(), true);
  assert.deepEqual(out.progress.filter((p) => !p.includes(":")), ["accord", "telechargement", "installation", "verification"]);
  assert.ok(out.progress.some((p) => p.startsWith("installation:")), "les lignes de l'installateur sont rendues");
  assert.deepEqual(readdirSync(tmpdir()).filter((n) => n.startsWith("noah-install-")), before, "script temporaire supprimé");
});

await step("journal et progression sans secret ; l'installateur ne reçoit aucune clé d'API", async () => {
  reset();
  const out = await run();
  const text = [...out.log, ...out.progress].join("\n");
  assert.ok(!/sk-abcdefghijklmnop|zzz123|xai-cle|sk-ant-cle/.test(text), text);
  assert.ok(text.includes("[masqué]"), "la ligne à secret est masquée, pas supprimée");
  assert.ok(/cle=\|\|fin/.test(text), `variables d'environnement vides : ${text}`);
  const env = inst.cleanEnv({ PATH: "p", XAI_API_KEY: "a", ANTHROPIC_API_KEY: "b", OPENAI_API_KEY: "c", GITHUB_TOKEN: "d", HOME: "h" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
  assert.equal(inst.scrub("\x1b[31mBearer abc.def\x1b[0m"), "Bearer [masqué]");
});

await step("panne réseau : erreur « reseau », rien n'est lancé", async () => {
  reset();
  inst.configure({ sources: { grok: { ps1: "http://127.0.0.1:1/install.ps1", sh: "http://127.0.0.1:1/install.sh" } } });
  const out = await run();
  assert.equal(out.result.erreur, "reseau");
  assert.equal(found(), false);
  assert.ok(!out.progress.includes("installation"));
  status = 503;
  inst.configure({ sources: { grok: { ps1: `${origin}/install.ps1`, sh: `${origin}/install.sh` } } });
  assert.equal((await run()).result.erreur, "reseau", "réponse 503");
});

await step("page de blocage ou réponse vide à la place du script : refusée, rien n'est lancé", async () => {
  reset();
  body = "<!DOCTYPE html><html><body>Just a moment...</body></html>";
  assert.equal((await run()).result.erreur, "installateur");
  body = "";
  assert.equal((await run()).result.erreur, "installateur");
  assert.equal(found(), false);
});

await step("redirection vers un autre domaine : refusée", async () => {
  reset();
  inst.configure({ sources: { grok: { ps1: `${origin}/redirige`, sh: `${origin}/redirige` } } });
  assert.equal((await run()).result.erreur, "adresse");
  assert.equal(found(), false);
});

await step("adresse de l'installateur hors du domaine de l'éditeur : refusée avant toute question", async () => {
  reset();
  inst.configure({ sources: { grok: { ps1: "https://evil.example/install.ps1", sh: "https://evil.example/install.sh" } } });
  const out = await run();
  assert.equal(out.result.erreur, "adresse");
  assert.equal(out.asked.length, 0);
  assert.deepEqual(hits, []);
});
await step("l'installateur s'arrête avec un code d'erreur : erreur « installateur », code rendu, binaire non cherché", async () => {
  reset();
  body = win ? "Write-Output 'boum'\nexit 3\n" : "echo boum\nexit 3\n";
  const out = await run();
  assert.equal(out.result.erreur, "installateur");
  assert.equal(out.result.code, 3);
  assert.ok(out.log.some((l) => /code 3/.test(l)));
});

await step("installation terminée mais binaire introuvable : erreur « introuvable »", async () => {
  reset();
  body = win ? "Write-Output 'rien posé'\n" : "echo rien\n";
  const out = await run();
  assert.equal(out.result.erreur, "introuvable");
});

await step("installation trop longue : arrêtée, erreur « delai »", async () => {
  reset();
  body = win ? "Start-Sleep -Seconds 30\n" : "sleep 30\n";
  inst.configure({ sources: { grok: { ps1: `${origin}/install.ps1`, sh: `${origin}/install.sh` } }, minute: 30 }); // 15 minutes = 450 ms
  const out = await run();
  assert.equal(out.result.erreur, "delai");
  inst.configure({ sources: { grok: { ps1: `${origin}/install.ps1`, sh: `${origin}/install.sh` } }, minute: 60000 });
});

await step("Claude Code : même chemin, adresse de claude.ai, nom et taille pour la fenêtre d'accord", async () => {
  assert.equal(inst.SOURCES.claude.nom, "Claude Code");
  assert.equal(inst.SOURCES.claude.editeur, "Anthropic");
  assert.equal(inst.SOURCES.claude.site, "claude.ai");
  inst.configure({});
  const out = await inst.ensure("inconnu", { locate: () => null, confirm: async () => true });
  assert.equal(out.erreur, "inconnu");
});

server.close();
rmSync(base, { recursive: true, force: true });
console.log(failures ? `\n${failures} échec(s)` : "\nInstallateur : tout tient.");
process.exit(failures ? 1 : 0);
