// Rien d'interne à l'écran, aucune clé d'API en clair (0.4.0, L4 : X31 et X17). Le serveur fait ce nettoyage une fois pour toutes (server/noah/nettoyage.py) ;
// celui-ci est le filet de l'interface : un message déjà en base lu par un serveur plus ancien, et le message qu'on vient d'écrire, encore tel que tapé.
// Les deux suivent la même règle : les vecteurs d'essai de lib/nettoyage.test.ts sont ceux de tests/agents/nettoyage_test.py.
import { t } from "@/i18n";
import type { StoredMessage } from "./api";

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]+`)/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b/g;
// eslint-disable-next-line no-control-regex
const INVISIBLES = new RegExp("[" + "\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f" + String.fromCharCode(0x200b, 0x2060, 0xfeff) + String.fromCharCode(0xe000) + "-" + String.fromCharCode(0xf8ff) + "]", "g");
const ECHAPPE = /\\u([0-9a-fA-F]{4})(?:\\u([dD][c-fC-F][0-9a-fA-F]{2}))?|\\x([0-9a-fA-F]{2})/g;
const REACTION = /\[\[[^\[\]\w\n]{1,16}\]\]/g;
const SILENCE = /\[SILENT\]/gi;
const BALISES = /<\/?releve>/gi;
const CONSIGNE = /^\s*\[Personne ne t.a écrit/;
const RELEVE = /<releve>\s*\n?([\s\S]*?)(?:\n|<\/releve>)/;

function decoder(_: string, u: string | undefined, bas: string | undefined, x: string | undefined): string {
  let code: number;
  if (x !== undefined) code = parseInt(x, 16);
  else {
    code = parseInt(u as string, 16);
    if (bas && code >= 0xd800 && code <= 0xdbff) code = 0x10000 + ((code - 0xd800) << 10) + (parseInt(bas, 16) - 0xdc00);
    else if (code >= 0xd800 && code <= 0xdfff) return "";
  }
  if (code === 27) return String.fromCharCode(27); // la séquence ANSI qui suit part avec lui
  if ([0xa0, 0x202f, 0x2007, 0x2009, 0x200a, 0x3000].includes(code)) return " ";
  return (code < 32 && code !== 10 && code !== 9) || code === 127 || [0x200b, 0x2060, 0xfeff].includes(code) ? "" : String.fromCodePoint(code);
}

/** Le texte sans rien d'interne. Le code (blocs et `en ligne`) n'est pas touché. */
export function interne(texte: string | null | undefined): string {
  const text = String(texte ?? "");
  if (!text) return "";
  const parts = text.replace(ANSI, "").split(CODE);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(INVISIBLES, "").replace(ECHAPPE, decoder as never).replace(ANSI, "").replace(REACTION, "").replace(SILENCE, "").replace(BALISES, "");
  }
  for (let i = 1; i < parts.length; i += 2) parts[i] = parts[i].replace(INVISIBLES, "");
  const cleaned = parts.join("");
  return cleaned === text ? cleaned : cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

/** Vrai si l'agent a dit « ne rien écrire » : `[SILENT]` seul sur sa ligne, ou au début ou à la fin de son texte. */
export function silence(texte: string | null | undefined): boolean {
  const text = String(texte ?? "");
  const s = text.trim().toUpperCase();
  return /^[ \t]*\[SILENT\][ \t]*$/im.test(text) || s.startsWith("[SILENT]") || s.endsWith("[SILENT]");
}

export const estConsigne = (texte: string | null | undefined): boolean => CONSIGNE.test(String(texte ?? ""));

/** Ce que la personne lit à la place de la consigne de Noah : une ligne, du côté de l'agent. */
export function ligneConsigne(texte: string | null | undefined): string {
  const text = String(texte ?? "");
  if ((text.split("\n", 1)[0] ?? "").includes("s'est coupé")) return t("Noah reprend ce travail là où il s'est arrêté."); // i18n-ignore
  const found = RELEVE.exec(text);
  const titre = found ? interne(found[1]).split(/\s+/).filter(Boolean).join(" ") : "";
  return titre ? t("Noah a relevé : {titre}.", { titre }) : t("Noah a relevé quelque chose à traiter.");
}

/** Les lignes que le serveur écrit à la place de la consigne d'un ancien message (server/noah/nettoyage.py) : traduites à l'affichage. */
export function ligneInterne(texte: string): string {
  const relevee = /^Noah a relevé : (.+)\.$/.exec(texte);
  if (relevee) return t("Noah a relevé : {titre}.", { titre: relevee[1] });
  if (texte === "Noah a relevé quelque chose à traiter.") return t("Noah a relevé quelque chose à traiter."); // i18n-ignore
  if (texte === "Noah reprend ce travail là où il s'est arrêté.") return t("Noah reprend ce travail là où il s'est arrêté."); // i18n-ignore
  return texte;
}

// --- Les clés d'API : mêmes formes que server/noah/sensitive.py -------------------------------------------------------------------------------------

const KEYS = new RegExp(
  "(?<![\\w-])(?:" + [
    "(sk-)[A-Za-z0-9_-]{16,}",
    "((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{10,}",
    "(gh[pousr]_)[A-Za-z0-9]{20,}",
    "(github_pat_)[A-Za-z0-9_]{20,}",
    "(xox[abposr]-)[A-Za-z0-9-]{10,}",
    "(AKIA)[0-9A-Z]{16}(?![0-9A-Za-z])",
    "(AIza)[0-9A-Za-z_-]{30,}",
    "(gsk_|xai-|hf_|r8_|pplx-|nvapi-|tvly-|fc-)[A-Za-z0-9_-]{20,}",
    "(eyJ)[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
  ].join("|") + ")", "g");
const CONTEXT = /\b((?:api[ _-]?key|apikey|secret(?:[ _-]?key)?|access[ _-]?token|auth[ _-]?token|token|bearer|cl[ée](?: d'api| secr[èe]te)?)(?:\s*[:=]\s*|\s+(?:est\s+)?)["'`]?)([A-Za-z0-9][A-Za-z0-9_\-./+=]{23,})/gi;
export const CLE_MASQUEE = "(clé masquée)"; // i18n-ignore
const AFFICHE = `•••• ${CLE_MASQUEE}`;

export type CleCollee = { etiquette: string; valeur: string };

/** Le texte, ses clés masquées, et les clés qu'il contenait (étiquette lisible : « sk- », « ghp_ »…, la valeur en clair). Seule la saisie en cours
 *  s'en sert, pour offrir de la ranger au coffre : la valeur ne part nulle part ailleurs et ne se lit jamais dans un message reçu. */
export function masquer(texte: string): { texte: string; cles: CleCollee[] } {
  const cles: CleCollee[] = [];
  let masque = String(texte).replace(KEYS, (m, ...g: string[]) => {
    const prefixe = g.slice(0, 9).find((x) => typeof x === "string" && x) ?? "";
    cles.push({ etiquette: prefixe, valeur: m });
    return prefixe + AFFICHE;
  });
  masque = masque.replace(CONTEXT, (m, contexte: string, valeur: string) => {
    if (!(/[A-Za-z]/.test(valeur) && /\d/.test(valeur)) || /^(https?:|\/)/.test(valeur)) return m;
    cles.push({ etiquette: "", valeur });
    return contexte + AFFICHE;
  });
  return { texte: masque, cles };
}

export const masquerCles = (texte: string | null | undefined): string => masquer(String(texte ?? "")).texte;
/** Le texte contient une clé masquée : la carte « Ranger au coffre » s'offre. */
export const aUneCleMasquee = (texte: string | null | undefined): boolean => String(texte ?? "").includes(CLE_MASQUEE);
/** Les étiquettes des clés masquées d'un texte, dans l'ordre (« sk- », « ghp_ », ou vide quand la clé n'avait pas de préfixe connu). */
export function etiquettesMasquees(texte: string): string[] {
  return [...String(texte).matchAll(/([A-Za-z0-9_.-]*)•••• \(clé masquée\)/g)].map((m) => m[1]);
}

// Les clés tapées dans cette fenêtre, gardées en mémoire vive le temps de la session : ni stockage du navigateur, ni requête. Rechargée, la page les oublie.
const retenues: CleCollee[] = [];
export function retenirCles(texte: string): void {
  for (const c of masquer(texte).cles) if (!retenues.some((r) => r.valeur === c.valeur)) retenues.push(c);
  if (retenues.length > 20) retenues.splice(0, retenues.length - 20);
}
/** La clé tapée ici qui porte cette étiquette, la plus récente d'abord. Aucune : la personne la colle elle-même dans le coffre. */
export function cleRetenue(etiquette: string): string {
  for (let i = retenues.length - 1; i >= 0; i--) if (retenues[i].etiquette === etiquette) return retenues[i].valeur;
  return "";
}
export const oublierLesCles = (): void => { retenues.length = 0; };

// --- Ce que l'écran lit -----------------------------------------------------------------------------------------------------------------------------

export const lecture = (texte: string | null | undefined): string => masquerCles(interne(texte));

/** Un titre, une ligne de trace, un résumé : une ligne sans Markdown ni marque interne, sans clé en clair. */
export function ligne(texte: string | null | undefined): string {
  return lecture(texte)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`#>|]+|(?<!\w)_+|_+(?!\w)/g, " ")
    .split(/\s+/).filter(Boolean).join(" ");
}

/** Un message en base tel que l'écran le lit : sans marque interne, sans clé en clair ; null s'il ne s'affiche pas (`[SILENT]`). */
export function ancienMessage(m: StoredMessage): StoredMessage | null {
  if (m.role === "user") {
    return estConsigne(m.text) ? { ...m, role: "agent", text: ligneConsigne(m.text), detail: null, model: null } : { ...m, text: masquerCles(m.text) };
  }
  if (m.role === "agent" || m.role === "error") {
    if (silence(m.text) || !interne(m.text).trim()) return null;
  }
  const detail = typeof m.detail === "string" ? masquerCles(m.detail) : m.detail;
  if (m.role === "trace" && typeof detail === "string") {
    try {
      const d = JSON.parse(detail) as Record<string, unknown>;
      for (const k of ["entete", "consigne", "issue"]) if (typeof d[k] === "string") d[k] = lecture(d[k] as string);
      return { ...m, text: lecture(m.text), detail: JSON.stringify(d) };
    } catch { /* un détail qui n'est pas du JSON se lit tel quel */ }
  }
  return { ...m, text: lecture(m.text), detail };
}
