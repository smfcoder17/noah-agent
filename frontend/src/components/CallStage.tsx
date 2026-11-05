// L'appel en cours, vu de partout dans l'application : une barre qu'on garde en naviguant, ou la vue d'appel, avec le visage de
// l'agent, ce qu'il fait en ce moment et ce qu'il produit. Hors de l'application, Android la réduit en fenêtre flottante.
import { ChevronDown, FileText, Maximize2, Mic, MicOff, MonitorPlay, PhoneOff, Square } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentContext } from "@/lib/agentContext";
import { cn, safeMedia } from "@/lib/utils";
import { NoahTile } from "./Noah";
import { Button } from "./ui";
import { canFrame, useViewer } from "./Viewer";

export const CALL_SLOT = "noah-call-slot";
const PIP_WIDTH = 300; // plus étroit qu'aucun téléphone : c'est la fenêtre flottante
const IMAGE = /\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i;

export type Artefact = { kind: "image" | "file"; url: string; title: string };
type Message = { role: string; content: readonly { type: string; text?: string; toolName?: string; args?: { label?: string } }[] };

/** Ces adresses viennent du texte du modèle : une carte ne s'ouvre que sur du http(s), et un fichier que sur l'API de Noah. */
function usable(url: string, kind: Artefact["kind"]) {
  try {
    const u = new URL(url, location.href);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return kind === "image" ? !!safeMedia(url) : u.origin === location.origin && /^\/api\/agents\/[^/]+\/files\/raw\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** Ce que l'agent a produit dans ces messages, le plus récent en dernier. `link` rend cliquables les chemins de fichiers. */
export function artefactsOf(messages: readonly Message[], link: (text: string) => string): Artefact[] {
  const found = new Map<string, Artefact>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) {
      if (p.type !== "text" || !p.text) continue;
      for (const [, bang, title, url] of link(p.text).matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
        const kind = bang || IMAGE.test(url) ? "image" : "file";
        if (usable(url, kind)) found.set(url, { kind, url, title: title || (kind === "image" ? "Image" : "Fichier") });
      }
    }
  }
  return [...found.values()];
}

/** Le travail en cours : Hermes ne garde qu'une ligne à la fois, l'appel se souvient des précédentes. */
function useSteps(messages: readonly Message[]) {
  const [steps, setSteps] = useState<string[]>([]);
  const last = messages[messages.length - 1];
  const label = last?.role === "assistant"
    ? [...last.content].reverse().find((p) => p.type === "tool-call" && p.toolName === "activity")?.args?.label
    : undefined;
  useEffect(() => {
    if (label) setSteps((all) => (all[all.length - 1] === label ? all : [...all, label].slice(-6)));
  }, [label]);
  return { steps, now: label };
}

function useFloating() {
  const [small, setSmall] = useState(() => window.innerWidth < PIP_WIDTH);
  useEffect(() => {
    const check = () => setSmall(window.innerWidth < PIP_WIDTH);
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return small;
}

function Face({ speaking, className }: { speaking: boolean; className: string }) {
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  return (
    <span className={cn("relative grid shrink-0 place-items-center", speaking && "noah-call-waves")}>
      {speaking && [0, 1, 2].map((i) => <span key={i} aria-hidden="true" className="noah-call-wave" style={{ animationDelay: `${i * 0.8}s`, background: agentColor }} />)}
      <NoahTile color={agentColor} shape={agentShape} detail={agentDetail} state={speaking ? "speaking" : "idle"} className={cn("relative", className)} />
    </span>
  );
}

function ArtefactCard({ item, large }: { item: Artefact; large?: boolean }) {
  const view = useViewer();
  const open = () => {
    if (item.kind === "image") view({ kind: "image", src: item.url, title: item.title });
    else if (canFrame(item.url)) view({ kind: "file", url: item.url, title: item.title });
    else window.open(`${item.url}?download=1`, "_self");
  };
  return (
    <button type="button" onClick={open} aria-label={`Ouvrir ${item.title}`} className={cn("group overflow-hidden rounded-xl border border-border bg-surface text-left shadow-sm", large ? "w-full" : "w-28 shrink-0")}>
      {item.kind === "image" ? (
        <img src={safeMedia(item.url)} alt={item.title} className={cn("w-full bg-muted object-contain", large ? "max-h-[38vh]" : "h-20 object-cover")} />
      ) : (
        <span className={cn("grid w-full place-items-center bg-muted text-muted-foreground", large ? "h-32" : "h-20")}><FileText className="size-7" /></span>
      )}
      <span className="block truncate px-2 py-1 text-xs font-medium">{item.title}</span>
    </button>
  );
}

export function CallStage(props: {
  phase: string;
  status: string;
  hint: string;
  seconds: number;
  busy: boolean;
  needsYou: boolean;
  muted: boolean;
  level: React.ReactNode;
  messages: readonly Message[];
  link: (text: string) => string;
  extra: React.ReactNode;
  onMute: () => void;
  onInterrupt: () => void;
  onHangUp: () => void;
}) {
  const { phase, status, hint, seconds, busy, needsYou, muted, level, messages, link, extra, onMute, onInterrupt, onHangUp } = props;
  const { agentName, canWatch } = useContext(AgentContext);
  const [big, setBig] = useState(true);
  const floating = useFloating();
  const from = useRef(messages.length); // seulement ce qui arrive pendant cet appel
  const during = useMemo(() => messages.slice(from.current), [messages]);
  const { steps, now } = useSteps(during);
  const artefacts = useMemo(() => artefactsOf(during, link), [during, link]);
  const latest = artefacts[artefacts.length - 1];
  const speaking = phase === "speaking";
  const minutes = Math.floor(seconds / 60);
  const time = `${minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}` : minutes}:${String(seconds % 60).padStart(2, "0")}`;

  // L'accord se donne sur sa carte, dans la conversation : la vue d'appel s'écarte pour la montrer.
  useEffect(() => {
    if (needsYou) setBig(false);
  }, [needsYou]);

  const interrupt = speaking && (
    <Button variant="outline" onClick={onInterrupt}><Square className="fill-current" />Interrompre</Button>
  );
  const mute = (
    <button type="button" onClick={onMute} aria-pressed={muted} aria-label={muted ? "Rétablir le micro" : "Couper le micro"} title={muted ? "Rétablir le micro" : "Couper le micro"}
      className={cn("flex size-12 items-center justify-center rounded-full border border-border", muted ? "bg-foreground text-background" : "bg-surface")}>
      {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
    </button>
  );
  const hangUp = (
    <button type="button" onClick={onHangUp} aria-label="Raccrocher" title="Raccrocher" className="flex size-12 items-center justify-center rounded-full bg-danger text-white">
      <PhoneOff className="size-5" />
    </button>
  );

  let view: React.ReactNode;
  if (floating) {
    view = (
      <div role="region" aria-label="Appel vocal" className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-2 bg-background">
        <Face speaking={speaking} className="size-20" />
        <p className="text-xs tabular-nums text-muted-foreground">{time}</p>
      </div>
    );
  } else if (big) {
    view = (
      <div role="region" aria-label="Appel vocal" className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-background pt-[max(12px,env(safe-area-inset-top))] pb-[max(16px,env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2 px-3">
          <Button variant="ghost" size="icon-sm" onClick={() => setBig(false)} aria-label="Réduire l'appel"><ChevronDown /></Button>
          <p className="min-w-0 flex-1 truncate text-center text-sm font-medium">{agentName} · <span className="tabular-nums">{time}</span></p>
          <span className="size-8" />
        </div>
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-4 md:flex-row md:items-stretch">
          <div className="flex flex-col items-center justify-center gap-4 text-center md:flex-1">
            <div className="py-12"><Face speaking={speaking} className={latest ? "size-24" : "size-36"} /></div>
            <p className={cn("text-lg font-semibold", phase === "error" && "text-warn")} aria-live="polite">{status}</p>
            <p className="line-clamp-2 max-w-md text-sm text-muted-foreground">{hint}</p>
            {phase !== "error" && !speaking && <span className="text-accent">{level}</span>}
          </div>
          {(steps.length > 0 || latest) && (
            <div className="flex min-w-0 flex-col gap-3 md:w-[46%]">
              {latest && <ArtefactCard item={latest} large />}
              {artefacts.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {artefacts.slice(0, -1).reverse().map((a) => <ArtefactCard key={a.url} item={a} />)}
                </div>
              )}
              {steps.length > 0 && (
                <section aria-label="Ce que fait l'agent" className="rounded-xl border border-border bg-surface p-3">
                  <p className="mb-1 text-xs text-muted-foreground">{busy ? "En ce moment" : "Pendant l'appel"}</p>
                  <ol className="flex flex-col gap-1 text-sm">
                    {steps.map((s, i) => <li key={`${i}-${s}`} className={cn("truncate", s === now && busy ? "font-medium" : "text-muted-foreground")}>{s}</li>)}
                  </ol>
                </section>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 px-4">
          {interrupt}
          {extra}
          {canWatch && <Button variant="outline" onClick={() => { setBig(false); window.dispatchEvent(new Event("noah:voir-ecran")); }}><MonitorPlay />Voir son écran</Button>}
          {mute}
          {hangUp}
        </div>
      </div>
    );
  } else {
    view = (
      <div role="region" aria-label="Appel vocal" className="flex items-center gap-3 border-b border-accent/40 bg-accent-soft/40 px-3 py-2">
        <button type="button" onClick={() => setBig(true)} aria-label="Agrandir l'appel" className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <Face speaking={speaking} className="size-10" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs tabular-nums text-muted-foreground">En appel avec {agentName} · {time}</span>
            <span className={cn("block truncate text-sm font-semibold", phase === "error" && "text-warn")} aria-live="polite">{status}</span>
            <span className="block truncate text-xs text-muted-foreground">{now && busy ? now : hint}</span>
          </span>
          <Maximize2 className="size-4 shrink-0 text-muted-foreground" />
        </button>
        <span className="hidden items-center gap-2 sm:flex">
          {latest && <ArtefactCard item={latest} />}
          {interrupt}
          {extra}
        </span>
        {mute}
        {hangUp}
      </div>
    );
  }
  const slot = document.getElementById(CALL_SLOT);
  return slot ? createPortal(view, slot) : view;
}
