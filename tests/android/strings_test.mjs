#!/usr/bin/env node
// L'app Android parle anglais par défaut et français sur un téléphone en français : chaque texte a ses deux versions.
//   node tests/android/strings_test.mjs
// 1. values/strings.xml (anglais) et values-fr/strings.xml (français) ont les mêmes clés et les mêmes %1$s.
// 2. Chaque R.string.x du Java existe, et chaque texte traduisible sert quelque part.
// 3. Plus de phrase écrite en dur dans un texte montré par le Java (Toast, notification, dialogue, refus d'un appel…).
// 4. L'écran de liaison (mobile/www) : mêmes clés et mêmes {variables} en fr et en en, et le HTML garde le français.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const app = join(root, "mobile/android/app/src");
const errors = [];
const fail = (message) => errors.push(message);

/** Les textes d'un strings.xml : nom -> valeur, sans ceux marqués translatable="false". */
function strings(file) {
  const xml = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const out = new Map();
  for (const [, attrs, value] of xml.matchAll(/<string\s+([^>]*)>([\s\S]*?)<\/string>/g)) {
    const name = (attrs.match(/name="([^"]+)"/) || [])[1];
    if (!name) continue;
    if (/translatable="false"/.test(attrs)) continue;
    if (out.has(name)) fail(`${relative(root, file)} : ${name} défini deux fois`);
    out.set(name, value);
  }
  return out;
}

const formats = (value) => (value.match(/%\d+\$[sd]/g) || []).sort().join(" ");

const en = strings(join(app, "main/res/values/strings.xml"));
const fr = strings(join(app, "main/res/values-fr/strings.xml"));
if (en.size < 20) fail(`values/strings.xml : ${en.size} textes seulement, ce contrôle ne regarde rien`);
for (const name of en.keys()) if (!fr.has(name)) fail(`values-fr/strings.xml : il manque ${name}`);
for (const name of fr.keys()) if (!en.has(name)) fail(`values/strings.xml : il manque ${name}`);
for (const [name, value] of en) {
  if (fr.has(name) && formats(value) !== formats(fr.get(name))) fail(`${name} : arguments différents (${formats(value)} / ${formats(fr.get(name))})`);
  for (const [lang, text] of [["en", value], ["fr", fr.get(name) || ""]]) {
    // aapt refuse une apostrophe non échappée, et lit mal un guillemet droit
    if (/(^|[^\\])'/.test(text)) fail(`${name} (${lang}) : apostrophe à échapper (\\')`);
  }
}
for (const dir of readdirSync(join(app, "main/res")).filter((d) => d.startsWith("values-") && d !== "values-fr" && d !== "values-night")) {
  try {
    statSync(join(app, "main/res", dir, "strings.xml"));
    fail(`${dir}/strings.xml : langue inattendue, à ajouter à ce test`);
  } catch {
    // pas de textes dans ce dossier
  }
}

// 2 et 3 : le Java des trois jeux de sources (main, et les variantes github et play).
function javaFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? javaFiles(path) : path.endsWith(".java") ? [path] : [];
  });
}
const sources = ["main", "github", "play"].flatMap((set) => javaFiles(join(app, set, "java")));
if (sources.length < 10) fail(`${sources.length} fichiers Java seulement : mauvais dossier`);
const used = new Set();
// Les textes qui ne se traduisent pas (nom de l'app, paquet) : ils existent, sans version française.
const fixed = new Set([...readFileSync(join(app, "main/res/values/strings.xml"), "utf8").matchAll(/<string\s+name="(\w+)"\s+translatable="false"/g)].map((m) => m[1]));
// Un texte montré : l'argument d'un de ces appels, quand c'est une phrase (espace ou lettre accentuée) écrite en dur.
const SHOWN = /\b(setText|makeText|reject|NotificationChannel|setContentTitle|setContentText|setTitle|setMessage|setContentDescription|createChooser|showCard|showOnUi|Refused|addAction|setPositiveButton|setNegativeButton|RemoteAction|setName)\s*\(/;
const PHRASE = {
  test: (code) => [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].some(([, s]) => /[A-Za-zÀ-ÿ]{2}/.test(s) && /[À-ÿ ]/.test(s)),
};
for (const file of sources) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [, name] of line.matchAll(/R\.string\.(\w+)/g)) {
      used.add(name);
      if (!en.has(name) && !fixed.has(name)) fail(`${relative(root, file)}:${i + 1} : R.string.${name} absent de values/strings.xml`);
    }
    const code = line.replace(/\/\/.*$/, "");
    if (/^\s*\*/.test(code) || /\bLog\.[a-z]\(/.test(code)) return;
    if (SHOWN.test(code) && PHRASE.test(code)) fail(`${relative(root, file)}:${i + 1} : texte en dur montré à la personne : ${line.trim()}`);
  });
}
for (const name of en.keys()) if (!used.has(name)) fail(`values/strings.xml : ${name} ne sert nulle part (texte orphelin)`);

// 4. L'écran de liaison, sans bundler : le dictionnaire de mobile/www/app.js et les data-i18n de index.html.
const appJs = readFileSync(join(root, "mobile/www/app.js"), "utf8");
const block = appJs.match(/const TEXTES = (\{[\s\S]*?\n\});/);
if (!block) fail("mobile/www/app.js : dictionnaire TEXTES introuvable");
else {
  const textes = Function(`"use strict"; return (${block[1]});`)();
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join(" ");
  for (const key of Object.keys(textes.fr)) {
    if (!(key in textes.en)) fail(`app.js : ${key} sans anglais`);
    else if (vars(textes.fr[key]) !== vars(textes.en[key])) fail(`app.js : ${key} n'a pas les mêmes variables en fr et en`);
  }
  for (const key of Object.keys(textes.en)) if (!(key in textes.fr)) fail(`app.js : ${key} sans français`);
  for (const [, key] of appJs.matchAll(/\bt\("(\w+)"/g)) if (!(key in textes.fr)) fail(`app.js : t("${key}") sans texte`);
  const html = readFileSync(join(root, "mobile/www/index.html"), "utf8");
  const seen = new Set();
  for (const [, key, text] of html.matchAll(/data-i18n="(\w+)"[^>]*>([^<]*)</g)) {
    seen.add(key);
    if (!(key in textes.fr)) fail(`index.html : data-i18n="${key}" sans texte`);
    else if (text.trim() !== textes.fr[key]) fail(`index.html : « ${text.trim()} » diffère du français de app.js pour ${key}`);
  }
  for (const [tag] of html.matchAll(/<input[^>]*>/g)) {
    const key = (tag.match(/data-i18n-placeholder="(\w+)"/) || [])[1];
    const placeholder = (tag.match(/placeholder="([^"]*)"/) || [])[1];
    if (!key) continue;
    seen.add(key);
    if (textes.fr[key] !== placeholder) fail(`index.html : placeholder de ${key} différent du français de app.js`);
  }
  const dynamic = new Set([...appJs.matchAll(/\bt\("(\w+)"/g)].map((m) => m[1]));
  for (const key of Object.keys(textes.fr)) if (!seen.has(key) && !dynamic.has(key)) fail(`app.js : ${key} ne sert nulle part`);
  if (seen.size < 8) fail(`index.html : ${seen.size} textes marqués seulement`);
  console.log(`écran de liaison : ${Object.keys(textes.fr).length} textes en fr et en en, ${seen.size} posés depuis le HTML`);
}

if (errors.length) {
  for (const e of errors) console.error("ECHEC : " + e);
  process.exit(1);
}
console.log(`Android : ${en.size} textes en anglais (values) et en français (values-fr), mêmes clés et mêmes arguments`);
console.log(`Java : ${sources.length} fichiers, ${used.size} textes lus par R.string, aucune phrase en dur montrée à la personne`);
