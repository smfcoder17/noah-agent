// Textes de l'app de bureau (desktop/textes.js) : chaque clé existe en français et en anglais, avec les mêmes {variables} ;
// chaque clé utilisée dans desktop/*.js et *.html existe, et aucune n'est orpheline ; plus de texte visible en dur en français.
//   node tests/desktop/textes_test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "desktop");
const textes = require(join(desktop, "textes.js"));
const { fr, en } = textes.dictionnaires;
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

const vars = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const sources = readdirSync(desktop).filter((f) => /\.(js|html)$/.test(f) && f !== "textes.js");
const read = (f) => readFileSync(join(desktop, f), "utf8");

check("mêmes clés en français et en anglais", () => {
  assert.deepEqual(Object.keys(fr).filter((k) => !(k in en)), [], "absentes en anglais");
  assert.deepEqual(Object.keys(en).filter((k) => !(k in fr)), [], "absentes en français");
});
check("aucun texte vide", () => {
  for (const [lang, dict] of Object.entries({ fr, en })) for (const [k, v] of Object.entries(dict)) assert.ok(typeof v === "string" && v.trim(), `${lang} ${k}`);
});
check("mêmes {variables} dans les deux langues", () => {
  for (const k of Object.keys(fr)) assert.deepEqual(vars(en[k] ?? ""), vars(fr[k]), k);
});
check("anglais sans ponctuation française (« », espace avant : ; ! ?)", () => {
  for (const [k, v] of Object.entries(en)) assert.doesNotMatch(v, /[«»]|\s[:;!?](\s|$)/, k);
});

// Clés utilisées : toute chaîne du code qui a la forme d'une clé (mots séparés par des points), sauf les noms de fichier.
const KEY = /["'`]([a-z_]+(?:\.[a-z_]+)+)["'`]/g;
const FILE = /\.(js|mjs|html|json|png|yml|yaml|md|env|exe)$|^agent\.noah\.desktop$/; // noms de fichier, identifiant de l'app
const used = new Map(); // clé → fichier
for (const f of sources) {
  const text = read(f);
  for (const m of text.matchAll(KEY)) if (!FILE.test(m[1])) used.set(m[1], f);
  for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.set(m[1], f);
}
check("chaque clé utilisée dans le code existe", () => {
  const missing = [...used].filter(([k]) => !(k in fr)).map(([k, f]) => `${f} : ${k}`);
  assert.deepEqual(missing, []);
});
check("aucune clé orpheline", () => {
  assert.deepEqual(Object.keys(fr).filter((k) => !used.has(k)), []);
});

check("chaque t(…) du code nomme une clé littérale ou un choix entre clés", () => {
  const odd = [];
  for (const f of sources.filter((s) => s.endsWith(".js"))) {
    for (const m of read(f).matchAll(/\bt\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      if (/^"[a-z_.]+"$/.test(arg) || /^[\w.]+\s*\?\s*"[a-z_.]+"\s*:\s*"[a-z_.]+"$/.test(arg) || /^(what|key)$/.test(arg)) continue;
      odd.push(`${f} : t(${arg}`);
    }
  }
  assert.deepEqual(odd, []);
});

check("le texte français des pages est celui du dictionnaire", () => {
  for (const f of sources.filter((s) => s.endsWith(".html"))) {
    const html = read(f);
    for (const m of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) assert.equal(m[2], fr[m[1]], `${f} : ${m[1]}`);
    for (const m of html.matchAll(/(placeholder|aria-label|title)="([^"]*)"[^>]*?data-i18n-\1="([^"]+)"/g)) assert.equal(m[2], fr[m[3]], `${f} : ${m[3]}`);
  }
});

check("les pages n'ont plus de texte visible hors data-i18n", () => {
  for (const f of sources.filter((s) => s.endsWith(".html"))) {
    let html = read(f).replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, "");
    // Attributs lus par la personne : chacun a son data-i18n-…, sauf les exemples de format (code) et alt vide.
    for (const m of html.matchAll(/<[^>]+>/g)) {
      for (const a of m[0].matchAll(/\s(placeholder|aria-label|title)="([^"]+)"/g)) {
        if (a[1] === "placeholder" && /^[A-Z]{4}-[A-Z]{4}$/.test(a[2])) continue;
        assert.ok(m[0].includes(`data-i18n-${a[1]}=`), `${f} : ${a[1]}="${a[2]}"`);
      }
    }
    html = html.replace(/<([a-z0-9]+)[^>]*data-i18n="[^"]+"[^>]*>[^<]*<\/\1>/g, "").replace(/<[^>]+>/g, " ");
    const left = html.split(/\s+/).filter((w) => /\p{L}/u.test(w)).join(" ");
    assert.ok(left === "" || /^(Noah Agent ?)+$/.test(left), `${f} : ${left}`);
  }
});

check("plus de texte en dur en français dans desktop/*.js (hors commentaires et i18n-ignore)", () => {
  const french = /[àâçéèêëîïôûùüÿœ]|\b(le|la|les|un|une|de|du|des|ce|cette|ton|ta|tes|pas|est|sur|dans|rien)\s/i;
  const found = [];
  for (const f of sources.filter((s) => s.endsWith(".js"))) {
    read(f).split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || line.includes("i18n-ignore")) return;
      const code = line.replace(/\s\/\/\s.*$/, ""); // commentaire en fin de ligne
      for (const s of code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
        const text = s[1] ?? s[2] ?? s[3];
        if (/\p{L}{2,}\s+\p{L}/u.test(text) && french.test(text)) found.push(`${f}:${i + 1} ${text.slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

check("bandeau.js transmet toutes les clés de bandeau.html", () => {
  const sent = [...read("bandeau.js").match(/PAGE_KEYS = \[([^\]]+)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const page = [...read("bandeau.html").matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(sent, page);
});

check("langue : français pour toute variante du français, anglais sinon", () => {
  for (const [code, lang] of [["fr", "fr"], ["fr-FR", "fr"], ["fr_CA", "fr"], ["en-US", "en"], ["de-DE", "en"], ["", "en"], ["frisian", "en"]]) {
    assert.equal(textes.normaliser(code), lang, code);
  }
  assert.equal(textes.langue(), "fr", "sans Electron : français");
});
check("t : variables remplacées en un seul passage, repli sur le français", () => {
  assert.equal(textes.t("connexion.joindre", { serveur: "https://x" }, "en"), "Can't reach https://x. Check the address.");
  assert.equal(textes.t("accord.commande.detail", { dossier: "{programme}", programme: "p", arguments: "[]", commande: "{dossier}" }, "fr").split("\n")[0], "Dans : {programme}");
  assert.equal(textes.t("menu.quitter", null, "de"), "Quitter");
  textes.choisir("en-GB");
  assert.equal(textes.t("menu.quitter"), "Quit");
  textes.choisir("fr");
});

if (failures) {
  console.log(`${failures} échec(s)`);
  process.exit(1);
}
console.log("Textes du bureau : tout est en ordre.");
