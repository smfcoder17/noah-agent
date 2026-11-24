// Citer avec @ (un agent, un fichier, un dossier) et appeler une compétence avec / : détection de ce qu'on tape, suggestions gardées,
// et la forme que prend une pastille dans le message. Chargé à la demande (premier clic dans la saisie) : voir mentionsCore.ts pour le reste.
import { useEffect, useRef, useState } from "react";
import { get } from "./api";
import { TOKEN, mentionsOf, type Mention, type MentionKind } from "./mentionsCore";

export type { Mention, MentionKind };

// --- Ce qu'on tape -----------------------------------------------------------------------------------------------------

export type Trigger = { char: "@" | "/"; start: number; end: number; query: string };

const SKILL_QUERY = /^[\p{L}\p{N}._-]*$/u;
const BEFORE = /[\s([{"'«]/;
const WORD = /[\p{L}\p{N}_]/u;

/**
 * Ce que la personne est en train de citer : le mot qui finit au curseur, s'il commence par @ ou / après un espace (ou en tête).
 * `a@b.c` n'est pas une citation (le @ n'est pas au début du mot), `/home/user` non plus (une compétence n'a pas de barre) ;
 * une pastille déjà posée ne rouvre rien quand le curseur la retrouve.
 */
export function detectTrigger(text: string, caret: number, known?: Map<string, Mention>): Trigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const word = text.slice(start, caret);
  const char = word[0];
  if (char !== "@" && char !== "/") return null;
  if (known?.has(word)) return null;
  const query = word.slice(1);
  if (query.length > 80 || (char === "@" ? query.includes("@") : !SKILL_QUERY.test(query))) return null;
  return { char, start, end: caret, query };
}

// --- La pastille dans le texte, puis dans le message -------------------------------------------------------------------

/** Ce que la saisie montre pour une pastille. */
export const display = (m: Mention) => (m.kind === "competence" ? "/" : "@") + m.label;
/** Un libellé qui tient dans un lien markdown. */
export const cleanLabel = (s: string) => s.replace(/[[\]\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

export type Occurrence = { start: number; end: number; shown: string; mention: Mention };

/** Où les pastilles connues se trouvent dans le texte : après un espace ou en tête, sans que la suite du mot les prolonge. */
export function occurrences(text: string, known: Map<string, Mention>): Occurrence[] {
  const out: Occurrence[] = [];
  for (const shown of [...known.keys()].sort((a, b) => b.length - a.length)) {
    for (let from = 0, at = text.indexOf(shown); at >= 0; at = text.indexOf(shown, from)) {
      from = at + shown.length;
      const after = text[from];
      if ((at > 0 && !BEFORE.test(text[at - 1])) || (after && WORD.test(after)) || out.some((o) => at < o.end && from > o.start)) continue;
      out.push({ start: at, end: from, shown, mention: known.get(shown)! });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Ce que le serveur lit : `[@plan.md](noah:fichier/outputs/plan.md)` (même forme que server/noah/mentions.py). */
const encodeRef = (ref: string) => encodeURIComponent(ref).replace(/%2F/g, "/").replace(/\(/g, "%28").replace(/\)/g, "%29");
export const token = (m: Mention) => `[${m.kind === "competence" ? "/" : "@"}${m.label}](noah:${m.kind}/${encodeRef(m.ref)})`;

/** Le texte de la saisie, chaque pastille posée remplacée par son lien. Elles sont ensuite oubliées : le message est parti. */
export function serialize(agentId: string, text: string): string {
  const known = mentionsOf(agentId);
  let out = "";
  let at = 0;
  for (const o of occurrences(text, known)) {
    out += text.slice(at, o.start) + token(o.mention);
    at = o.end;
  }
  known.clear();
  return out + text.slice(at);
}

/** Retire de la mémoire les pastilles dont le texte a été effacé ou abîmé. */
export function prune(agentId: string, text: string) {
  const known = mentionsOf(agentId);
  if (!known.size) return;
  const kept = new Set(occurrences(text, known).map((o) => o.shown));
  for (const shown of [...known.keys()]) if (!kept.has(shown)) known.delete(shown);
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Un message avec ses pastilles : des morceaux de texte, et les pastilles entre eux. */
export function splitMentions(text: string): (string | Mention)[] {
  const out: (string | Mention)[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ kind: m[3] as MentionKind, label: m[2], ref: decode(m[4]) });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// --- Chercher ----------------------------------------------------------------------------------------------------------

/** Sans accent ni majuscule : « Équipe » se trouve en tapant « equ ». */
const ACCENTS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
export const plain = (s: string) => s.normalize("NFKD").replace(ACCENTS, "").toLowerCase();

/** 0 : le nom commence par la recherche ; 1 : un de ses mots ; 2 : elle s'y trouve ; null : rien (comme le serveur). */
export function scoreOf(name: string, query: string): number | null {
  if (!query) return 0;
  const hay = plain(name);
  const need = plain(query);
  if (hay.startsWith(need)) return 0;
  if (new RegExp(`[\\s._/-]${need.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay)) return 1;
  return hay.includes(need) ? 2 : null;
}

export type AgentHit = { id: string; nom: string; role: string; color: string; shape: string; detail: string };
export type FileHit = { type: "fichier" | "dossier"; chemin: string; nom: string; dossier: string; modifie: number; taille?: number; fichiers?: number };
export type SkillHit = { nom: string; titre: string; resume: string; origine: string; desactivee: boolean };
export type FilesAnswer = { fichiers: FileHit[]; dossiers: FileHit[]; indisponible?: boolean };

// --- Ce que le serveur a dit, gardé : la liste s'ouvre sans attendre la deuxième fois --------------------------------------

type Entry = { at: number; data: unknown; pending?: Promise<unknown> };
const cache = new Map<string, Entry>();
const FAILED_FOR = 3000;

export const peek = <T,>(key: string): T | undefined => cache.get(key)?.data as T | undefined;

/** La lecture, gardée `ttl` ms : une lecture déjà partie est partagée, une réponse vieille est servie et relue. Une panne vaut `empty`, 3 s. */
export function fetchCached<T>(key: string, path: string, ttl: number, empty: T): Promise<T> {
  const known = cache.get(key);
  if (known && known.data !== undefined && Date.now() - known.at < ttl) return Promise.resolve(known.data as T);
  if (known?.pending) return known.pending as Promise<T>;
  const pending = get<T>(path).then(
    (data) => { cache.set(key, { at: Date.now(), data }); return data; },
    () => { cache.set(key, { at: Date.now() - ttl + FAILED_FOR, data: empty }); return empty; },
  );
  cache.set(key, { at: known?.at ?? 0, data: known?.data, pending });
  return pending;
}

/** Une lecture gardée vue depuis un composant : la valeur gardée tout de suite si elle existe, la relecture ensuite. `keep` : garde la précédente en attendant. */
export function useCached<T>(key: string | null, path: string, ttl: number, empty: T, keep = false): { data: T | undefined; loading: boolean } {
  const [, bump] = useState(0);
  const last = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void fetchCached(key, path, ttl, empty).then(() => live && bump((n) => n + 1));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, ttl]);
  const hit = key ? peek<T>(key) : undefined;
  if (hit !== undefined) last.current = hit;
  return { data: hit ?? (keep ? last.current : undefined), loading: !!key && hit === undefined };
}

export const agentsKey = (agentId: string) => `${agentId}|agents`;
export const agentsPath = (agentId: string) => `/api/agents/${agentId}/mentions/agents`;
export const skillsKey = (agentId: string) => `${agentId}|competences`;
export const skillsPath = (agentId: string) => `/api/agents/${agentId}/mentions/competences`;
export const filesKey = (agentId: string, dossier: string, q: string) => `${agentId}|fichiers|${dossier}|${q}`;
export const filesPath = (agentId: string, dossier: string, q: string) =>
  `/api/agents/${agentId}/mentions/fichiers?dossier=${encodeURIComponent(dossier)}&q=${encodeURIComponent(q)}&limite=${dossier ? 50 : 8}`;

/** « outputs/rap » → le dossier « outputs » et la recherche « rap ». */
export function splitQuery(query: string): { dossier: string; q: string } {
  const at = query.lastIndexOf("/");
  return at < 0 ? { dossier: "", q: query } : { dossier: query.slice(0, at), q: query.slice(at + 1) };
}

export const AGENTS_TTL = 30_000;
export const SKILLS_TTL = 30_000;
export const FILES_TTL = 15_000;
