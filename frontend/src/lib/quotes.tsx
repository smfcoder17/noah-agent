// Passages cités : un extrait de réponse, un tableau, une image… joints au prochain message.
// Ils partent en tête du message sous forme de citations markdown (« > … »), que l'agent lit comme le contexte de la question.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type Quote = { label: string; text: string };

type Quotes = { quotes: Quote[]; add: (q: Quote) => void; remove: (i: number) => void };

export const QuoteContext = createContext<Quotes>({ quotes: [], add: () => {}, remove: () => {} });
export const useQuotes = () => useContext(QuoteContext);

const asBlock = (q: Quote) => q.text.trim().split("\n").map((l) => `> ${l}`).join("\n");

/** État des citations de la conversation, et `take` qui les vide en rendant le texte à mettre devant le message. */
export function useQuoteState() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const current = useRef(quotes);
  current.current = quotes;
  const add = useCallback((q: Quote) => setQuotes((all) => (all.some((x) => x.text === q.text) ? all : [...all, q].slice(-5))), []);
  const remove = useCallback((i: number) => setQuotes((all) => all.filter((_, j) => j !== i)), []);
  const take = useCallback(() => {
    const qs = current.current;
    if (!qs.length) return "";
    setQuotes([]);
    return qs.map(asBlock).join("\n\n") + "\n\n";
  }, []);
  const value = useMemo(() => ({ quotes, add, remove }), [quotes, add, remove]);
  return { value, take };
}

/** Sépare les citations de tête du reste d'un message de l'utilisateur. */
export function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const quotes: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  let block: string[] = [];
  for (; i < lines.length; i++) {
    if (lines[i].startsWith(">")) block.push(lines[i].replace(/^> ?/, ""));
    else if (!lines[i].trim() && block.length) {
      quotes.push(block.join("\n"));
      block = [];
    } else break;
  }
  if (block.length) quotes.push(block.join("\n"));
  return quotes.length ? { quotes, rest: lines.slice(i).join("\n").trim() } : { quotes: [], rest: text };
}

/** Texte cité pour un widget : ce que l'agent a besoin de relire, pas son JSON entier. */
export function widgetQuote(spec: Record<string, unknown>): Quote | null {
  const title = typeof spec.title === "string" ? spec.title : "";
  if (spec.type === "table" && Array.isArray(spec.columns) && Array.isArray(spec.rows)) {
    const cols = spec.columns as string[];
    const rows = (spec.rows as unknown[][]).slice(0, 30);
    const md = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(String).join(" | ")} |`)];
    return { label: `Tableau${title ? ` « ${title} »` : ""}`, text: `${title ? `Tableau « ${title} » :\n` : ""}${md.join("\n")}` };
  }
  if (spec.type === "chart" && Array.isArray(spec.labels) && Array.isArray(spec.series)) {
    const labels = spec.labels as string[];
    const series = spec.series as { name: string; values: number[] }[];
    const lines = series.map((s) => `${s.name} : ${labels.map((l, i) => `${l} ${s.values[i]}`).join(", ")}`);
    return { label: `Graphique${title ? ` « ${title} »` : ""}`, text: `Graphique${title ? ` « ${title} »` : ""} :\n${lines.join("\n")}` };
  }
  if (spec.type === "grid" && Array.isArray(spec.items)) {
    const items = (spec.items as { title?: string; subtitle?: string; url?: string }[]).slice(0, 20);
    const lines = items.map((it, i) => `${i + 1}. ${it.title ?? ""}${it.subtitle ? ` (${it.subtitle})` : ""}${it.url ? ` ${it.url}` : ""}`);
    return { label: `Liste${title ? ` « ${title} »` : ""}`, text: `${title || "Liste"} :\n${lines.join("\n")}` };
  }
  if (spec.type === "preview" && typeof spec.path === "string") {
    return { label: title || spec.path.split("/").pop()!, text: `Fichier : ${spec.path}` };
  }
  return null;
}

/** Une image du chat citée par son chemin dans la machine de l'agent (ou son adresse web). */
export function imageQuote(src: string, alt?: string): Quote {
  let path = src;
  try {
    const u = new URL(src, location.origin);
    path = u.searchParams.get("path") ?? (u.origin === location.origin ? decodeURIComponent(u.pathname) : src);
  } catch {
    /* adresse relative inattendue : on garde telle quelle */
  }
  return { label: `Image ${alt || path.split("/").pop()}`, text: `Image : ${path}` };
}
