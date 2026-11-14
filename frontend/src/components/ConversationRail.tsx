// Repères de la conversation : de petits traits à droite du fil, un par demande. Au survol, de quoi il s'agit ; au clic, on y va.
// Ils se déduisent des messages déjà chargés : rien à ranger, rien à enregistrer.
//
// Par page de dix : la colonne montre les repères des dix demandes les plus récentes. Remonter dans le fil les remplace par
// les dix d'avant, et ainsi de suite — elle reste courte quelle que soit la longueur de la conversation. Passé trois messages
// au-dessus du bas, « Revenir en bas » apparaît près d'elle.
import { useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { splitQuotes } from "@/lib/quotes";
import { cn, messageMoment } from "@/lib/utils";
import { t } from "@/i18n";

export const RAIL_PAGE = 10; // repères par fenêtre
const FEWEST = 2; // en dessous, rien à naviguer
export const AWAY = 3; // messages au-dessus du bas avant de proposer « Revenir en bas »

type Mark = { id: string; label: string; when: string };

/** Ce qu'un message mérite d'afficher comme repère : chaque demande, et le résultat d'une routine, qui arrive seul. */
export function markOf(message: { id: string; role: string; content: readonly { type: string; text?: string }[]; createdAt?: Date }): Mark | null {
  const text = message.content.find((p) => p.type === "text")?.text ?? "";
  const when = message.createdAt ? messageMoment(message.createdAt) : "";
  if (message.role === "user") {
    const line = splitQuotes(text).rest.split("\n")[0].replace(/\s*\(ta demande : .*$/, "").trim();
    return line ? { id: message.id, label: line.slice(0, 70), when } : null;
  }
  const routine = text.match(/^\*\*Routine « (.+?) »\*\*/);
  return routine ? { id: message.id, label: t("Routine : {nom}", { nom: routine[1] }).slice(0, 70), when } : null;
}

// Un message qui ne change pas garde son objet : son repère n'est calculé qu'une fois.
const markCache = new WeakMap<object, Mark | null>();
function cachedMark(message: Parameters<typeof markOf>[0]): Mark | null {
  if (!markCache.has(message)) markCache.set(message, markOf(message));
  return markCache.get(message) ?? null;
}

/** La fenêtre de dix qui contient le repère `index` : 0 pour les dix plus anciens, jusqu'à la dernière page. */
export function pageOf(index: number, total: number) {
  return Math.min(Math.max(0, Math.ceil(total / RAIL_PAGE) - 1), Math.max(0, Math.floor(index / RAIL_PAGE)));
}

export function ConversationRail() {
  // Les repères en une chaîne : pendant qu'une réponse s'écrit, la liste des messages change à chaque image, pas les repères.
  // L'effet de mesure ci-dessous ne repart donc que lorsqu'un repère apparaît ou change.
  const key = useAuiState((s) => JSON.stringify(s.thread.messages.flatMap((m) => cachedMark(m as never) ?? [])));
  const marks = useMemo(() => JSON.parse(key) as Mark[], [key]);
  const rail = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [page, setPage] = useState<number | null>(null); // null : la fenêtre suit la lecture
  const [away, setAway] = useState(0); // messages sous l'écran, vers le bas du fil

  const box = () => rail.current?.closest("[data-noah-thread]")?.querySelector<HTMLElement>("[data-noah-viewport]") ?? null;

  useEffect(() => {
    const viewport = box();
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = viewport.getBoundingClientRect().top + 120;
      const bottom = viewport.getBoundingClientRect().bottom;
      let found = -1;
      let below = 0;
      for (const [i, { id }] of marks.entries()) {
        const el = viewport.querySelector(`[data-noah-msg="${CSS.escape(id)}"]`);
        if (!el) continue;
        const where = el.getBoundingClientRect().top;
        if (where <= top) found = i;
        if (where > bottom) below += 1;
      }
      setCurrent(found >= 0 ? marks[found].id : marks[0]?.id ?? null);
      // La fenêtre suit la lecture tant que la personne n'a pas choisi une page à la main.
      setPage((chosen) => chosen ?? pageOf(Math.max(0, found), marks.length));
      // Le bas du fil : le nombre de repères sous l'écran ; un fil sans repère compte par sa hauteur.
      const rest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      setAway(rest <= 40 ? 0 : Math.max(below, Math.ceil(rest / 120)));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [marks]);

  const go = useCallback((id: string) => {
    box()?.querySelector(`[data-noah-msg="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const backToBottom = useCallback(() => {
    const viewport = box();
    if (!viewport) return;
    setPage(null); // la fenêtre reprend sa place au bas du fil
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, []);

  if (marks.length < FEWEST) {
    return away >= AWAY ? (
      <button
        type="button"
        onClick={backToBottom}
        className="absolute right-3 bottom-28 z-20 flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted md:right-4"
      >
        <ArrowDown className="size-3.5" aria-hidden />
        {t("Revenir en bas")}
      </button>
    ) : <nav ref={rail} hidden />;
  }
  const shown = marks.slice((page ?? 0) * RAIL_PAGE, (page ?? 0) * RAIL_PAGE + RAIL_PAGE);
  return (
    <>
      {away >= AWAY && (
        <button
          type="button"
          onClick={backToBottom}
          className="absolute right-3 bottom-28 z-20 flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium shadow-md hover:bg-muted md:right-4"
        >
          <ArrowDown className="size-3.5" aria-hidden />
          {t("Revenir en bas")}
          <span className="text-muted-foreground tabular-nums">{away}</span>
        </button>
      )}
      <nav ref={rail} aria-label={t("Repères de la conversation")} className="pointer-events-none absolute top-1/2 right-1 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col items-end md:flex">
        {shown.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => go(m.id)}
            aria-label={t("Aller à : {repere}", { repere: m.label })}
            aria-current={m.id === current ? "location" : undefined}
            className="group pointer-events-auto relative flex h-[9px] w-7 cursor-pointer items-center justify-end pr-1"
          >
            <span className={cn("h-0.5 rounded-full transition-all group-hover:w-5 group-hover:bg-accent group-focus-visible:w-5 group-focus-visible:bg-accent", m.id === current ? "w-4 bg-foreground/70" : "w-2.5 bg-muted-foreground/40")} />
            <span className="pointer-events-none absolute top-1/2 right-full mr-1 hidden w-max max-w-64 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-xs shadow-md group-hover:flex group-focus-visible:flex">
              <span className="truncate font-medium">{m.label}</span>
              {m.when && <span className="text-[11px] text-muted-foreground">{m.when}</span>}
            </span>
          </button>
        ))}
      </nav>
    </>
  );
}
