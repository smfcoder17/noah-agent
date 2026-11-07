// Repères de la conversation : de petits traits à droite du fil, un par demande. Au survol, de quoi il s'agit ; au clic, on y va.
// Ils se déduisent des messages déjà chargés : rien à ranger, rien à enregistrer.
import { useAuiState } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitQuotes } from "@/lib/quotes";
import { messageMoment } from "@/lib/utils";
import { cn } from "@/lib/utils";

const MOST = 30;
const FEWEST = 4;

type Mark = { id: string; label: string; when: string };

/** Ce qu'un message mérite d'afficher comme repère : chaque demande, et le résultat d'une routine, qui arrive seul. */
function markOf(message: { id: string; role: string; content: readonly { type: string; text?: string }[]; createdAt?: Date }): Mark | null {
  const text = message.content.find((p) => p.type === "text")?.text ?? "";
  const when = message.createdAt ? messageMoment(message.createdAt) : "";
  if (message.role === "user") {
    const line = splitQuotes(text).rest.split("\n")[0].replace(/\s*\(ta demande : .*$/, "").trim();
    return line ? { id: message.id, label: line.slice(0, 70), when } : null;
  }
  const routine = text.match(/^\*\*Routine « (.+?) »\*\*/);
  return routine ? { id: message.id, label: `Routine : ${routine[1]}`.slice(0, 70), when } : null;
}

export function ConversationRail() {
  const messages = useAuiState((s) => s.thread.messages);
  const marks = useMemo(() => messages.flatMap((m) => markOf(m as never) ?? []).slice(-MOST), [messages]);
  const rail = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const viewport = rail.current?.closest("[data-noah-thread]")?.querySelector<HTMLElement>("[data-noah-viewport]");
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = viewport.getBoundingClientRect().top + 120;
      let found: string | null = null;
      for (const { id } of marks) {
        const el = viewport.querySelector(`[data-noah-msg="${CSS.escape(id)}"]`);
        if (el && el.getBoundingClientRect().top <= top) found = id;
      }
      setCurrent(found);
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

  if (marks.length < FEWEST) return <nav ref={rail} hidden />;
  const go = (id: string) => {
    rail.current?.closest("[data-noah-thread]")?.querySelector(`[data-noah-msg="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <nav ref={rail} aria-label="Repères de la conversation" className="pointer-events-none absolute top-1/2 right-1 z-10 hidden max-h-[60%] -translate-y-1/2 flex-col items-end md:flex">
      {marks.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => go(m.id)}
          aria-label={`Aller à : ${m.label}`}
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
  );
}
