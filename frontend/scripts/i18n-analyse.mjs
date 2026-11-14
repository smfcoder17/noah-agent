// Lit le code de l'interface et en tire, pour les langues :
//  - les clés : premier argument littéral de t(…) et tr(…) ;
//  - les restes : textes visibles écrits en dur, hors de t() (texte JSX, attributs visibles, chaînes françaises).
// Sert au test src/i18n/i18n.test.ts et, en ligne de commande, à trouver ce qui reste à traduire :
//   node scripts/i18n-analyse.mjs [fichier ou dossier…]   (par défaut src/)
// Un texte qui ne doit pas être traduit (valeur échangée avec le serveur, identifiant) porte le commentaire
// « i18n-ignore » sur sa ligne ou la ligne d'avant ; « i18n-ignore-fichier » en tête exclut tout le fichier.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ICI = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.resolve(ICI, "../src");

export function fichiers(racines = [SRC]) {
  const out = [];
  const visite = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (/node_modules|__fixtures__|[\\/]i18n$/.test(p)) return;
      for (const f of fs.readdirSync(p)) visite(path.join(p, f));
    } else if (/\.(tsx?|jsx?)$/.test(p) && !/\.test\.|\.d\.ts$|test-setup/.test(p)) out.push(p);
  };
  for (const r of racines) visite(path.resolve(r));
  return out.sort();
}

const ACCENT = /[àâçéèêëîïôûùüœÀÂÇÉÈÊÎÔÛ«»]/;
const MOTS_FR = /(^|[\s(])(le|la|les|des|du|un|une|ton|ta|tes|ses|pour|est|pas|sur|avec|dans|et|ou|ce|cette|il|elle|ne|plus|tu|te|son|sa|aux|au|par|qui|que|quand|sans|mais|encore|déjà|rien|tout|tous|ici|puis|aucun|aucune|vos|votre|nous|vous)(?=[\s,.:!?)]|$)|\b[ldnqst]'\w/i;
const ATTR_VISIBLES = new Set(["aria-label", "aria-description", "title", "placeholder", "alt", "label", "aria-placeholder", "aria-roledescription", "aria-valuetext", "description", "hint", "message", "text", "titre", "tooltip", "confirmLabel", "cancelLabel", "emptyLabel", "subtitle", "heading", "srLabel", "sub", "detail"]);
const PROPS_VISIBLES = new Set(["label", "title", "hint", "description", "placeholder", "message", "text", "titre", "texte", "detail", "aide", "subtitle", "heading", "tooltip", "empty", "vide", "resume", "explication", "sub", "help", "short", "long", "intro", "cta", "action", "question", "reponse", "consigne", "prompt", "libelle", "body", "info", "warning", "erreur", "error", "why", "pourquoi", "exemple", "example", "legende", "caption"]);
// Marques et sigles : écrits pareil dans toutes les langues. Tout autre mot visible passe par t().
const NOMS_PROPRES = /^((Noah( Agent)?|OK|Google|Gmail|Ollama( Cloud)?|OpenRouter|OpenAI|Anthropic|Mistral|Android|iPhone|iOS|Windows|macOS|Linux|Telegram|WhatsApp|Discord|Slack|GitHub|Hostinger|Cloudflare|Chrome|Firefox|Safari|YouTube|TikTok|Instagram|Facebook|LinkedIn|Notion|Stripe|Brollss|API|URL|PDF|QR|HTTPS?|SMTP|IMAP|MCP|JSON|CSV|SVG|PNG|JPEG|MP3|MP4|VNC|SSH|DNS|IP|ID|Wi-Fi|Hermes|X|Camofox|Chromium|Groq|Cerebras|Gemini|Claude|GPT|DeepSeek|Kimi|Qwen|Llama|xAI|Grok|ElevenLabs|Mammouth|Fal|Replicate|Hugging Face|Pexels|Unsplash|Spotify|Docker|Caddy|Traefik)( |$))+$|^[\d\s.,:;%/+×·•–—|()#\-→←↑↓✓✕…]+$/;
const TECHNIQUE = /^(Enter|Escape|Esc|Tab|Backspace|Delete|Space|Shift|Control|Alt|Meta|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Content-Type|Accept-Language|Authorization|Bearer|Accept|Cache-Control|Location|Origin|Range|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|UTC|Inter|Figtree|Geist)$/;

export const pareilFrancais = (s) => ACCENT.test(s) || MOTS_FR.test(s);
const lettres = (s) => /\p{L}{2,}/u.test(s);

function ignore(sf, node, lignes) {
  const l = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  return /i18n-ignore/.test(lignes[l] || "") || /i18n-ignore/.test(lignes[l - 1] || "");
}

/** Analyse un fichier : { cles: [{cle, ligne}], restes: [{texte, ligne}], dynamiques: [ligne] }. */
export function analyser(fichier) {
  const texte = fs.readFileSync(fichier, "utf8");
  const sf = ts.createSourceFile(fichier, texte, ts.ScriptTarget.Latest, true, fichier.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lignes = texte.split(/\r?\n/);
  const cles = [], restes = [], dynamiques = [];
  if (/i18n-ignore-fichier/.test(texte.slice(0, 600))) return { cles: collecteCles(sf, cles, dynamiques), restes, dynamiques };
  const ligne = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const reste = (n, s) => { if (!ignore(sf, n, lignes)) restes.push({ texte: s.replace(/\s+/g, " ").trim().slice(0, 120), ligne: ligne(n) }); };

  const dansT = (n) => {
    // n est-il (dans) le premier argument d'un appel t/tr, ou une valeur de variables d'un tel appel ?
    for (let p = n.parent, enfant = n; p; enfant = p, p = p.parent) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && /^(t|tr|tServeur)$/.test(p.expression.text)) return p.arguments[0] === enfant;
      if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isFunctionLike(p) || ts.isBlock(p)) return false;
    }
    return false;
  };
  const horsCode = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isLiteralTypeNode(p) || ts.isTypeNode(p)) return true;
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && /^(require|import)$/.test(p.expression.text)) return true;
      if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
    }
    return false;
  };
  const nomAttr = (n) => (ts.isJsxAttribute(n.parent) ? n.parent.name.getText(sf) : null);
  const nomProp = (n) => {
    const p = n.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === n) return p.name.getText(sf).replace(/["']/g, "");
    return null;
  };

  const visite = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(t|tr)$/.test(n.expression.text) && n.arguments.length) {
      const a = n.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) cles.push({ cle: a.text, ligne: ligne(a) });
      else dynamiques.push(ligne(a));
    }
    if (ts.isJsxText(n)) {
      const s = n.getText(sf).trim();
      if (lettres(s) && !NOMS_PROPRES.test(s)) reste(n, s);
    } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !dansT(n) && !horsCode(n)) {
      const s = n.text;
      const attr = nomAttr(n), prop = nomProp(n);
      if (/^(className|class|style|href|src|type|role|id|key|name|data-[\w-]+|for|htmlFor|value|variant|size|lang|rel|target|autoComplete|inputMode|method|d|viewBox|fill|stroke)$/.test(attr || "")) { /* technique */ }
      else if (attr && ATTR_VISIBLES.has(attr) && lettres(s) && !NOMS_PROPRES.test(s)) reste(n, s);
      else if (prop && PROPS_VISIBLES.has(prop) && lettres(s) && /\s/.test(s.trim()) && !/^[\w-]+(\s[\w-]+)*$/.test(s) ) reste(n, s);
      else if (prop && PROPS_VISIBLES.has(prop) && lettres(s) && pareilFrancais(s)) reste(n, s);
      else if (lettres(s) && /\s/.test(s.trim()) && pareilFrancais(s) && !/^[\w.-]+$/.test(s)) reste(n, s);
      else if (lettres(s) && ACCENT.test(s) && !/^[\w-]+$/u.test(s.normalize("NFD").replace(/[̀-ͯ]/g, ""))) reste(n, s);
      else if (/^\p{Lu}\p{Ll}+([ '’-]\p{L}+)*[.…!?]?$/u.test(s) && !TECHNIQUE.test(s) && !NOMS_PROPRES.test(s)) reste(n, s); // un mot qui commence par une majuscule : un libellé
    } else if (ts.isTemplateExpression(n) && !dansT(n) && !horsCode(n)) {
      const morceaux = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
      if (lettres(morceaux) && pareilFrancais(morceaux)) reste(n, n.getText(sf));
    }
    ts.forEachChild(n, visite);
  };
  visite(sf);
  return { cles, restes, dynamiques };
}

function collecteCles(sf, cles, dynamiques) {
  const visite = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(t|tr)$/.test(n.expression.text) && n.arguments.length) {
      const a = n.arguments[0];
      const ligne = sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1;
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) cles.push({ cle: a.text, ligne });
      else dynamiques.push(ligne);
    }
    ts.forEachChild(n, visite);
  };
  visite(sf);
  return cles;
}

export const variables = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Ligne de commande : liste ce qui reste à traduire et les clés absentes du dictionnaire anglais.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cibles = process.argv.slice(2);
  let total = 0;
  for (const f of fichiers(cibles.length ? cibles : [SRC])) {
    const { restes, dynamiques } = analyser(f);
    const rel = path.relative(path.resolve(ICI, ".."), f);
    for (const r of restes) console.log(`${rel}:${r.ligne}  ${r.texte}`);
    for (const l of dynamiques) console.log(`${rel}:${l}  [clé non littérale dans t()]`);
    total += restes.length + dynamiques.length;
  }
  console.log(`\n${total} texte(s) à traiter`);
}
