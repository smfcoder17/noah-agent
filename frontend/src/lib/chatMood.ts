// Ce que fait l'agent dans le chat, lu dans son message : le visage du message en cours en découle (components/Thread.tsx).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { NoahState } from "./noahMotion";
import { t } from "@/i18n";

export type Mood = "rest" | "think" | "work" | "wait" | "done" | "error";

export const MOOD_FACE: Record<Mood, NoahState> = { rest: "idle", think: "thinking", work: "working", wait: "waiting", done: "pleased", error: "upset" };

const MOOD_WORD: Record<Mood, string> = { rest: "", think: t("Réfléchit…"), work: t("Travaille…"), wait: t("Attend ta réponse"), done: t("C'est fait"), error: t("Ça n'a pas abouti") };

type PartLike = { type: string; toolName?: string; result?: unknown; text?: string; args?: unknown };
type MessageLike = { content: readonly PartLike[]; status?: { type: string } };

const CHOICE = /```noah\s*\{[^`]*"type"\s*:\s*"choice"/; // comme CHOICE_RE côté serveur
const ASKS = new Map([["approval", t("Attend ton accord")], ["connexion", t("Attend que tu te connectes")]]);

const tools = (m: MessageLike) => m.content.filter((p) => p.type === "tool-call");
const unanswered = (m: MessageLike) => tools(m).find((p) => ASKS.has(p.toolName ?? "") && p.result === undefined);
const asksChoice = (m: MessageLike) => m.content.some((p) => p.type === "text" && CHOICE.test(p.text ?? ""));

/** Un seul outil vu pendant le tour, et il travaille : la réflexion, c'est avant. */
export function moodOf(m: MessageLike): Mood {
  if (unanswered(m)) return "wait";
  if (m.status?.type === "running") return tools(m).length ? "work" : "think";
  if (tools(m).some((p) => p.toolName === "error")) return "error";
  return asksChoice(m) ? "wait" : "rest";
}

/** La ligne à côté du visage : son statut de travail s'il en a un (« Lance une commande… »), sinon ce qu'il attend. */
export function moodLabel(m: MessageLike, mood: Mood): string {
  const line = tools(m).find((p) => p.toolName === "activity");
  if (line) {
    const label = String((line.args as { label?: unknown })?.label ?? "");
    return /[….!?]$/.test(label) ? label : `${label}…`;
  }
  const ask = unanswered(m);
  if (ask) return ASKS.get(ask.toolName ?? "") ?? MOOD_WORD.wait;
  return mood === "wait" && asksChoice(m) ? t("Attend ton choix") : MOOD_WORD[mood];
}

const LIVE: readonly Mood[] = ["think", "work", "wait"];
const HOLD = { done: 1800, error: 5000 }; // assez pour voir la réaction, puis le visage retourne au repos

// Un travail suivi près de la saisie finit sans message en cours : sa réponse arrive juste après, et c'est elle qui réagit.
const ARRIVAL = 2500;
let panelEnded = 0;

/**
 * L'humeur du message : son état, plus la petite réaction de fin. Une réaction n'a lieu que si on a vu le travail : rouvrir une
 * vieille conversation ne fait rien sauter. `elsewhere` : un travail se suit près de la saisie, c'est lui qui vit.
 */
export function useMood(base: Mood, isLast: boolean, elsewhere: boolean): Mood {
  const [ending, setEnding] = useState<"done" | "error" | null>(() =>
    isLast && Date.now() - panelEnded < ARRIVAL && !LIVE.includes(base) ? (base === "error" ? "error" : "done") : null,
  );
  const was = useRef(base);
  useEffect(() => {
    const before = was.current;
    was.current = base;
    if (!elsewhere && LIVE.includes(before) && !LIVE.includes(base)) setEnding(base === "error" ? "error" : "done");
  }, [base, elsewhere]);
  useEffect(() => {
    if (!ending) return;
    const timer = setTimeout(() => setEnding(null), HOLD[ending]);
    return () => clearTimeout(timer);
  }, [ending]);
  if (LIVE.includes(base)) return base; // un nouveau travail coupe la réaction
  return ending ?? "rest";
}

/** À appeler là où ce travail s'affiche : retient le moment où il s'arrête. */
export function usePanelEnd(active: boolean) {
  useEffect(() => {
    if (!active) return;
    return () => {
      panelEnded = Date.now();
    };
  }, [active]);
}

const wideQuery = window.matchMedia("(min-width: 768px)");
const onWide = (change: () => void) => {
  wideQuery.addEventListener("change", change);
  return () => wideQuery.removeEventListener("change", change);
};
/** La marge du fil n'existe qu'à partir de cette largeur (md) : un seul visage est créé, à la place qui se voit. */
export const useWide = () => useSyncExternalStore(onWide, () => wideQuery.matches);
