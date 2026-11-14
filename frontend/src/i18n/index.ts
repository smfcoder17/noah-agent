// Langues de l'interface. Le texte français reste écrit tel quel dans le code et sert de clé : t("Réglages").
// Les autres langues sont des dictionnaires « français → traduction » (src/i18n/en/*.ts). Une clé absente d'un
// dictionnaire fait échouer i18n.test.ts ; à l'exécution, elle s'affiche en français plutôt que vide.
//
// Langue choisie : celle mémorisée dans Réglages > Apparence, sinon celle du navigateur, sinon l'anglais.
// Elle est lue une fois au chargement : en changer recharge la page, si bien que les textes calculés au chargement
// d'un module (listes, libellés) suivent aussi.
import type { ReactNode } from "react";
import { Fragment, createElement } from "react";
import { en } from "./en";

export const LANGUES = { fr: "Français", en: "English" } as const;
export type Langue = keyof typeof LANGUES;

const CLE = "noah-langue";
const DICTIONNAIRES: Record<Langue, Record<string, string> | null> = { fr: null, en };

function depuisNavigateur(): Langue {
  const liste = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of liste) {
    const code = (l || "").toLowerCase().slice(0, 2);
    if (code in LANGUES) return code as Langue;
  }
  return "en";
}

function lire(): Langue {
  try {
    const v = localStorage.getItem(CLE);
    if (v && v in LANGUES) return v as Langue;
  } catch {
    /* stockage indisponible */
  }
  return depuisNavigateur();
}

let courante: Langue = lire();
if (typeof document !== "undefined") document.documentElement.lang = courante;

export const langue = (): Langue => courante;
/** Langue mémorisée par la personne, ou null si l'interface suit le navigateur. */
export function langueChoisie(): Langue | null {
  try {
    const v = localStorage.getItem(CLE);
    return v && v in LANGUES ? (v as Langue) : null;
  } catch {
    return null;
  }
}

/** Change la langue (null : celle du navigateur), la mémorise et recharge l'interface. */
export function choisirLangue(l: Langue | null, recharger = true) {
  try {
    if (l) localStorage.setItem(CLE, l);
    else localStorage.removeItem(CLE);
  } catch {
    /* stockage indisponible : vaut pour cette page seulement */
  }
  courante = l ?? depuisNavigateur();
  if (typeof document !== "undefined") document.documentElement.lang = courante;
  if (recharger && typeof location !== "undefined") location.reload();
}

/** Pour les dates et nombres : toLocaleDateString(locale(), …). */
export const locale = (): string => {
  if (courante === "fr") return "fr-FR";
  const nav = typeof navigator === "undefined" ? "" : navigator.language || "";
  return nav.toLowerCase().startsWith("en") ? nav : "en-US";
};

const brut = (fr: string): string => DICTIONNAIRES[courante]?.[fr] ?? fr;

/**
 * Texte traduit. `fr` est le texte français exact, littéral (le test le lit dans le code).
 * Variables : t("Bonjour {nom}", { nom }) ; les accolades sont gardées dans la traduction.
 */
export function t(fr: string, vars?: Record<string, string | number>): string {
  const s = brut(fr);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Comme t, avec des éléments React à la place des variables : tr("Ouvre {lien} pour voir", { lien: <a>…</a> }). */
export function tr(fr: string, vars: Record<string, ReactNode>): ReactNode {
  const morceaux = brut(fr).split(/\{(\w+)\}/g);
  return createElement(Fragment, null, ...morceaux.map((m, i) => (i % 2 ? createElement(Fragment, { key: i }, m in vars ? vars[m] : `{${m}}`) : m)));
}

/** Message d'erreur du serveur (en français) traduit s'il est connu : textes fixes, puis modèles à variables. */
export function tServeur(message: string): string {
  const dico = DICTIONNAIRES[courante];
  if (!dico || !message) return message;
  if (dico[message]) return dico[message];
  for (const [fr, trad] of modeles(dico)) {
    const m = fr.re.exec(message);
    if (m) return trad.replace(/\{(\w+)\}/g, (x, k: string) => (fr.noms.includes(k) ? m[fr.noms.indexOf(k) + 1] : x));
  }
  return message;
}

let cache: [{ re: RegExp; noms: string[] }, string][] | null = null;
function modeles(dico: Record<string, string>) {
  if (cache) return cache;
  cache = [];
  for (const [fr, trad] of Object.entries(dico)) {
    if (!/\{\w+\}/.test(fr)) continue;
    const noms: string[] = [];
    const motif = fr.split(/(\{\w+\})/g).map((p) => {
      const v = /^\{(\w+)\}$/.exec(p);
      if (v) {
        noms.push(v[1]);
        return "(.+?)";
      }
      return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    cache.push([{ re: new RegExp(`^${motif}$`, "s"), noms }, trad]);
  }
  return cache;
}
