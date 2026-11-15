// A5 (lot A, 0.3.0), côté bureau : le lien noah-agent://abonnements/claude (ou /chatgpt) ouvre l'app, ou la ramène au premier plan,
// sur l'écran de cet abonnement. Prouve la lecture du lien (un seul mot, jamais une action) et le branchement dans main.js et
// package.json : protocole enregistré, instance unique, seconde instance et macOS (open-url) menés à openSubscription.
// La fenêtre réelle n'est pas lancée ici (Electron simulé ailleurs) : voir abonnements.md, « Reste à faire ».
//   node tests/desktop/liens_test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
const liens = require(join(desktop, "liens.js"));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`OK    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`ÉCHEC ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
  }
};

check("le lien nomme un abonnement, et rien d'autre", () => {
  assert.equal(liens.subscriptionOf("noah-agent://abonnements/claude"), "claude");
  assert.equal(liens.subscriptionOf("noah-agent://abonnements/chatgpt/"), "chatgpt");
  assert.equal(liens.subscriptionOf("NOAH-AGENT://abonnements/Claude?depuis=web"), "claude");
  assert.equal(liens.subscriptionOf("noah-agent:abonnements/chatgpt"), "chatgpt");
  for (const bad of ["noah-agent://abonnements/codex", "noah-agent://abonnements/claude/connexion", "noah://abonnements/claude",
    "https://exemple.fr/noah-agent://abonnements/claude", "noah-agent://commande/rm", "", null]) {
    assert.equal(liens.subscriptionOf(bad), null, String(bad));
  }
});

check("Windows et Linux : le lien arrive dans la ligne de commande (première ou seconde instance)", () => {
  assert.equal(liens.fromArgv(["C:\\Noah\\Noah Agent.exe", "--allow-file-access", "noah-agent://abonnements/claude"]), "claude");
  assert.equal(liens.fromArgv(["electron", "."]), null);
  assert.equal(liens.fromArgv(undefined), null);
});

const main = readFileSync(join(desktop, "main.js"), "utf8");
check("main.js : instance unique ; la seconde instance ramène l'app au premier plan sur l'abonnement du lien", () => {
  assert.match(main, /if \(!app\.requestSingleInstanceLock\(\)\) \{\s*app\.quit\(\);/);
  assert.match(main, /app\.on\("second-instance", \(_e, argv\) => \{\s*show\(\);\s*openSubscription\(liens\.fromArgv\(argv\)\);/);
  assert.match(main, /app\.setAsDefaultProtocolClient\(liens\.SCHEME\)/);
  assert.match(main, /app\.on\("open-url", \(e, url\) => \{[\s\S]{0,400}openSubscription\(liens\.subscriptionOf\(url\)\)/);
  assert.match(main, /let askedSubscription = liens\.fromArgv\(process\.argv\);/, "premier lancement par le lien");
  assert.match(main, /detectClaude\(\)\.then\(\(\) => openSubscription\(askedSubscription\)\)/);
  const clicked = main.match(/shell\.openExternal\(url\);\s*else openSubscription\(liens\.subscriptionOf\(url\)\);/g) || [];
  assert.equal(clicked.length, 2, "lien cliqué dans l'app (navigation et nouvelle fenêtre) : son écran, sans repasser par le système");
  assert.match(main, /function openSubscription\(page\) \{[\s\S]{0,300}show\(\);[\s\S]{0,300}subscriptionsMenu\(page\)\.submenu/);
});

check("package.json : le protocole noah-agent est déclaré à l'installation", () => {
  const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
  assert.ok(pkg.build.protocols.some((p) => p.schemes.includes("noah-agent") && p.schemes.includes("noah")), JSON.stringify(pkg.build.protocols));
});

check("menu Abonnements : « Claude Code comme cerveau » est un droit local, demandé avec un avertissement", () => {
  assert.match(main, /claudeCerveau: c\.abonnement_claude_cerveau === true/);
  assert.match(main, /t\("abonnement\.claude\.cerveau"\), type: "checkbox", checked: r\.claudeCerveau, enabled: c\.connecte/);
  assert.match(main, /askSystem\(t\("abonnement\.claude\.cerveau"\), t\("abonnement\.claude\.cerveau_avertissement"\)/);
});

check("D9 : setup.html reconnu par son chemin (espaces, .asar, casse de Windows), jamais un autre fichier", () => {
  const win = "C:\\Program Files\\Noah Agent\\resources\\app.asar\\setup.html";
  const sent = ["file:///C:/Program%20Files/Noah%20Agent/resources/app.asar/setup.html",
    "file:///c:/program%20files/noah%20agent/RESOURCES/app.asar/setup.html?x=1#y",
    "file:///C:/Program%20Files/Noah%20Agent/resources/app.asar/./sub/../setup.html",
    "file:///C:/Program Files/Noah Agent/resources/app.asar/setup.html"];
  for (const url of sent) assert.equal(liens.sameFile(url, win, "win32"), true, url);
  for (const url of ["file:///C:/Users/x/Downloads/setup.html", "file:///C:/Program%20Files/Noah%20Agent/resources/app.asar.unpacked/setup.html",
    "https://exemple.fr/setup.html", "data:text/html,setup.html", "file://autre-pc/partage/app.asar/setup.html", "pas une adresse"]) {
    assert.equal(liens.sameFile(url, win, "win32"), false, url);
  }
  const nix = "/opt/Noah Agent/resources/app.asar/setup.html";
  assert.equal(liens.sameFile("file:///opt/Noah%20Agent/resources/app.asar/setup.html", nix, "linux"), true);
  assert.equal(liens.sameFile("file:///opt/noah%20agent/resources/app.asar/setup.html", nix, "linux"), false, "Linux : la casse compte");
  assert.match(main, /const stayHome = \(e, url\) => \{\s*if \(url\.startsWith\("data:"\) \|\| liens\.sameFile\(url, SETUP_FILE\) \|\| sameOrigin\(url\)\) return;/);
  assert.match(main, /const fromSetup = \(e\) => liens\.sameFile\(e\.senderFrame\.url, SETUP_FILE\);/);
  assert.ok(!/=== SETUP_URL/.test(main), "plus de comparaison d'URL à l'égalité stricte");
});

if (failures) {
  console.log(`${failures} échec(s)`);
  process.exit(1);
}
console.log("Liens noah-agent:// : lus, branchés, déclarés.");
