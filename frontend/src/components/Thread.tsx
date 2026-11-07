// Fil de discussion construit sur les primitives d'assistant-ui.
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown, ArrowUp, Check, ChevronRight, ChevronUp, Copy, FileText, Loader2, Paperclip, Reply, SmilePlus, Square, TriangleAlert, X } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { WhileBusyContext, AgentContext, HistoryContext } from "@/lib/agentContext";
import { MOOD_FACE, moodLabel, moodOf, usePanelEnd, useMood, useWide } from "@/lib/chatMood";
import { type LoginAsked, mediaUrl, rawFileUrl, send, type TraceDetail } from "@/lib/api";
import { linkMessage, plainWidgets } from "@/lib/chatMedia";
import { imageQuote, splitQuotes, useQuotes } from "@/lib/quotes";
import { ConversationRail } from "./ConversationRail";
import { giveFilesEvent } from "./Files";
import { LoginCard, LoginDone, type LoginResult } from "./LoginCard";
import { NoahTile, type NoahHandle } from "./Noah";
import { Recu } from "./Recu";
import { StateShape } from "./Sidebar";
import { cn, dayLabel, messageMoment, safeMedia } from "@/lib/utils";
import { Button } from "./ui";
import { canFrame, useDownload, useViewer } from "./Viewer";
import { AttachPosition } from "./PhoneSettings";
import { DictateButton, useDictation, VoiceMode, VoiceModeButton } from "./Voice";
import { NoahWidget } from "./Widgets";

// Sur téléphone, le focus ouvrirait le clavier à chaque conversation, et par-dessus un appel.
const FINE_POINTER = window.matchMedia("(pointer: fine)").matches;

export { AgentContext };

const PART_EDGE = "\u0000";

/** Le texte des parties d'un message avant et après celle-ci, en une seule chaîne : une sélection d'état se compare par valeur. */
function partsAround(parts: readonly { type: string; text?: string }[], me: { type: string; text?: string }) {
  const at = parts.findIndex((p) => p === me || (p.type === "text" && p.text === me.text));
  const text = (from: number, to: number) => parts.slice(from, to).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("\n");
  return at < 0 ? text(0, parts.length) + PART_EDGE : text(0, at) + PART_EDGE + text(at + 1, parts.length);
}

const widget = { SyntaxHighlighter: NoahWidget, CodeHeader: () => null };
const WIDGET_LANGUAGES = { noah: widget };
const PLUGINS = [remarkGfm];
const SMOOTH = { drainMs: 100, minCommitMs: 50 };

function MarkdownText() {
  const { agentId } = useContext(AgentContext);
  const view = useViewer();
  const download = useDownload();
  const { add: addQuote } = useQuotes();
  // Props stables : sans ça, chaque jeton reçu refait l'analyse Markdown de tous les messages du fil.
  // Une réponse se coupe en parties à chaque outil : la même image ne se montre pas une fois dans chacune. Ces chaînes ne changent
  // pas quand seule la dernière partie grandit : l'analyse des précédentes n'est pas refaite.
  const around = useAuiState((s) => partsAround(s.message.parts, s.part));
  const streaming = useAuiState((s) => s.message.status?.type === "running");
  const preprocess = useCallback(
    (text: string) => {
      const [before, after] = around.split(PART_EDGE);
      return linkMessage(text, { fileUrl: (path) => rawFileUrl(agentId, path), before, after, streaming });
    },
    [agentId, around, streaming],
  );
  const components = useMemo<NonNullable<React.ComponentProps<typeof MarkdownTextPrimitive>["components"]>>(
    () => ({
        a: ({ node: _node, href, children, ...props }) =>
          href?.includes("/files/raw/") ? (
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 py-px align-baseline text-[0.92em] font-medium text-accent hover:underline"
              onClick={() =>
                canFrame(href) ? view({ kind: "file", url: href, title: String(children) }) : download(`${href}?download=1`, String(children))
              }
            >
              <FileText className="size-3.5" />{children}
            </button>
          ) : (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
        img: ({ node: _node, ...props }) => (
          <span className="group/img relative inline-block">
            <img
              {...props}
              src={safeMedia(props.src ? String(props.src) : undefined)}
              loading="lazy"
              className="cursor-zoom-in"
              onClick={() => props.src && view({ kind: "image", src: String(props.src), title: props.alt })}
            />
            {props.src && (
              <Button
                variant="outline"
                size="sm"
                className="absolute top-2 right-2 h-7 bg-surface/90 text-xs opacity-0 pointer-coarse:opacity-100 shadow-sm group-hover/img:opacity-100 focus-visible:opacity-100"
                onClick={() => addQuote(imageQuote(String(props.src), props.alt))}
              >
                <Reply />Répondre à ceci
              </Button>
            )}
          </span>
        ),
    }),
    [view, download, addQuote],
  );
  return (
    <MarkdownTextPrimitive
      className="prose-chat"
      remarkPlugins={PLUGINS}
      componentsByLanguage={WIDGET_LANGUAGES}
      preprocess={preprocess}
      components={components}
      // Révélation douce courte : 250 ms par défaut retardait le texte et ré-analysait le Markdown à chaque image.
      smooth={SMOOTH}
    />
  );
}

// --- Parties « outil » : activité, approbation, erreur, détails techniques -------------

/** La ligne de travail : une seule, remplacée à chaque étape, retirée quand l'agent a fini. */
function Activity({ args }: ToolCallMessagePartProps) {
  const label = String(args.label);
  return (
    <div className="flex items-center gap-2 py-0.5 text-[13px] text-muted-foreground max-md:hidden" aria-live="polite">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
      <span className="truncate">{/[….!?]$/.test(label) ? label : `${label}…`}</span>
    </div>
  );
}

function Approval({ args, result, addResult }: ToolCallMessagePartProps) {
  const { agentId, details } = useContext(AgentContext);
  const [error, setError] = useState("");
  const preview = Array.isArray(args.apercu) ? (args.apercu as string[]) : [];
  const [open, setOpen] = useState(false);
  const answer = async (approve: boolean) => {
    try {
      await send(`/api/agents/${agentId}/runs/${args.run_id}/approval`, {
        request_id: args.request_id,
        generation: args.generation,
        approve,
      });
      addResult(approve ? "approved" : "denied");
      window.dispatchEvent(new Event("noah:accord-repondu"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (result !== undefined) {
    return (
      <p className="my-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        {result === "approved" ? <Check className="size-3.5 text-ok" /> : <X className="size-3.5" />}
        <span className="min-w-0 truncate">{result === "approved" ? "Autorisé" : "Refusé"} · {String(args.action || args.demande || "cette action").replace(/^Ton agent veut /, "")}</span>
      </p>
    );
  }
  return (
    <div className="my-2 flex flex-col gap-3 rounded-xl border border-warn bg-warn-soft p-3.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-warn">À valider</span>
      <p className="text-sm font-medium">{String(args.demande || "Ton agent te demande de valider une action.")}</p>
      {typeof args.pourquoi === "string" && args.pourquoi && <p className="-mt-2 text-[13px] text-muted-foreground">{args.pourquoi}</p>}
      {preview.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {preview.map((line) => <li key={line} className="truncate">« {line} »</li>)}
        </ul>
      )}
      {!details && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="cursor-pointer self-start text-xs font-medium underline underline-offset-2">
          {open ? "Masquer les détails" : "Voir les détails"}
        </button>
      )}
      {(details || open) && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-2 font-mono text-[11.5px] text-muted-foreground">{String(args.summary)}</pre>}
      <div className="flex gap-2">
        <Button variant="warn" size="sm" onClick={() => answer(true)}>Autoriser</Button>
        <Button variant="outline" size="sm" onClick={() => answer(false)}>Refuser</Button>
      </div>
      {args.retenu === true && <p className="-mt-1 text-xs text-muted-foreground">Si tu autorises, les actions de ce genre passeront ensuite sans te demander.</p>}
      {error && <p className="text-sm text-danger">La réponse n'a pas été prise en compte : {error}</p>}
    </div>
  );
}

function LoginPart({ args, result, addResult }: ToolCallMessagePartProps) {
  const { agentId } = useContext(AgentContext);
  const asked = args as unknown as LoginAsked;
  if (result !== undefined) return <LoginDone asked={asked} result={result as LoginResult} />;
  return (
    <LoginCard
      agentId={agentId}
      asked={asked}
      onDone={(done) => {
        addResult(done);
        window.dispatchEvent(new Event("noah:accord-repondu"));
      }}
    />
  );
}

/** Dans la conversation principale : un fil en cours ou fini. Une ligne discrète, qui l'ouvre ; rien pour l'agent. */
function TraceLine({ args }: ToolCallMessagePartProps) {
  const { agentId } = useContext(AgentContext);
  const t = args as unknown as TraceDetail;
  const issue = t.etat === "en_cours" ? "En cours" : `${t.etat === "fini" ? "Fini" : "Pas terminé"}${t.issue ? ` : ${t.issue}` : ""}`;
  return (
    <a
      href={`#agent=${agentId}&conversation=${t.fil}`}
      title="Ouvrir ce fil"
      className="-mx-2 flex w-fit max-w-full items-center gap-2.5 rounded-lg px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <StateShape state={t.etat === "fini" ? "done" : t.etat === "echec" ? "error" : "work"} />
      <span className="min-w-0">
        <span className="block truncate">{t.entete} : {t.consigne}</span>
        <span className="block truncate text-xs">{issue}</span>
      </span>
      <ChevronRight className="size-3.5 shrink-0" />
    </a>
  );
}

/** Une erreur : la phrase d'abord. Les détails à côté, à copier ou à donner à l'agent pour qu'il la diagnostique. */
function ErrorPart({ args }: ToolCallMessagePartProps) {
  const aui = useAui();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const detail = String(args.detail ?? "");
  return (
    <div className="my-1 flex flex-col gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
        <span>{String(args.message)}</span>
      </div>
      {detail && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="ml-6 cursor-pointer self-start text-xs font-medium underline underline-offset-2">
          {open ? "Masquer les détails" : "Voir les détails"}
        </button>
      )}
      {open && (
        <div className="ml-6 flex flex-col gap-2">
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background p-2.5 font-mono text-[11.5px]">{detail}</pre>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(detail).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }, () => {})}
            >
              {copied ? "Copié" : "Copier"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => aui.thread().composer().setText(`Aide-moi à diagnostiquer cette erreur de Noah Agent :\n\n${detail}`)}
            >
              Demander à l'agent
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ args }: ToolCallMessagePartProps) {
  return (
    <pre className="my-1 max-w-full overflow-x-auto rounded-lg border border-dashed border-border bg-surface px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
      {JSON.stringify(args.data, null, 2)}
    </pre>
  );
}

/** Sous une réponse rapide : le tri peut se tromper, un clic la transmet quand même à l'agent. */
function SendAside({ args }: { args: { id: string } }) {
  const busy = useContext(WhileBusyContext);
  const [said, setSaid] = useState("");
  return (
    <div className="not-prose mt-1 text-xs text-muted-foreground">
      {said || (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            setSaid("Envoi…");
            busy.now(args.id).then(
              (type) =>
                setSaid(
                  type === "precision" ? "Transmis à l'agent." : type === "tache" ? "Il a fini : c'est mis à la suite." : type === "incertain" ? "Transmission non confirmée : regarde sa réponse." : "Déjà transmis.",
                ),
              () => setSaid("Pas transmis : le serveur ne répond pas."),
            );
          }}
        >
          Le transmettre aussi à l'agent
        </button>
      )}
    </div>
  );
}

/** Le récit du travail : replié, pour qui veut vérifier. Pendant le travail, sa dernière phrase reste lisible. */
function Steps({ args }: ToolCallMessagePartProps) {
  const steps = (args.steps as string[]) ?? [];
  const running = useAuiState((s) => s.message.status?.type === "running");
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <div className="my-1 flex flex-col gap-1 text-[13px] text-muted-foreground">
      {running && !open && <p className="truncate">{steps[steps.length - 1]}</p>}
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit cursor-pointer items-center gap-1 rounded-md hover:text-foreground">
        <ChevronUp className={cn("size-3.5 transition-transform", !open && "rotate-180")} />
        {steps.length} étape{steps.length > 1 ? "s" : ""}
      </button>
      {open && <ol className="flex list-decimal flex-col gap-1 pl-5">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
    </div>
  );
}

const TOOLS = { by_name: { activity: Activity, approval: Approval, connexion: LoginPart, error: ErrorPart, detail: Detail, steps: Steps, recu: Recu, send_aside: SendAside, trace: TraceLine } };

// --- Messages ------------------------------------------------------------------------

function AttachmentChip() {
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-2.5 pr-1.5 text-[13px]">
      <FileText className="size-3.5 text-muted-foreground" />
      <span className="max-w-48 truncate"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove asChild>
        <button className="rounded-full p-0.5 text-muted-foreground hover:bg-muted" aria-label="Retirer"><X className="size-3.5" /></button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

/** Texte de l'utilisateur : les passages cités en tête s'affichent en citations, au-dessus de sa question. */
function UserText({ text }: TextMessagePartProps) {
  const { quotes, rest } = splitQuotes(text);
  return (
    <>
      {quotes.map((q, i) => (
        <span key={i} className="mb-2 block max-h-28 overflow-hidden border-l-2 border-accent/60 pl-2.5 text-[13px] text-muted-foreground [mask-image:linear-gradient(to_bottom,black_75%,transparent)]">
          {q}
        </span>
      ))}
      {rest}
    </>
  );
}

const dayOf = (d?: Date) => (d ? d.toDateString() : "");

/** Entre deux journées : la date, pour se repérer en remontant. */
function DayDivider() {
  const when = useAuiState((s) => s.message.createdAt);
  const first = useAuiState((s) => dayOf(s.thread.messages[s.message.index - 1]?.createdAt) !== dayOf(s.message.createdAt));
  if (!first || !when) return null;
  return (
    <div className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="first-letter:uppercase">{dayLabel(when)}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

const QUICK_EMOJI = ["👍", "❤️", "👎", "😂", "😮", "😢", "🙏", "🔥", "🎉"];

/** Les réactions d'un message, et de quoi y réagir : visible au survol, toujours là sur un écran tactile. */
function MessageReactions() {
  const id = useAuiState((s) => s.message.id);
  const custom = useAuiState((s) => s.message.metadata?.custom) as { storedId?: number; reactions?: { user?: string; agent?: string; retenu?: string } } | undefined;
  const { react } = useContext(HistoryContext);
  const { readOnly } = useContext(AgentContext);
  const [open, setOpen] = useState(false);
  const mine = custom?.reactions?.user;
  const theirs = custom?.reactions?.agent;
  const stored = custom?.storedId;
  const set = (emoji: string | null) => {
    if (stored) react(id, stored, emoji);
    setOpen(false);
  };
  return (
    <span className="relative flex items-center gap-1">
      {theirs && <span role="img" aria-label={`Réaction de l'agent : ${theirs}`} className="rounded-full border border-border bg-surface px-1.5 text-sm leading-6">{theirs}</span>}
      {custom?.reactions?.retenu && <span title="L'agent l'a retenu pour la suite" className="text-[11px] text-muted-foreground">retenu</span>}
      {mine && (
        <button type="button" onClick={() => set(null)} disabled={readOnly} aria-label={`Retirer ta réaction ${mine}`} className="cursor-pointer rounded-full border border-accent/40 bg-accent-soft px-1.5 text-sm leading-6">{mine}</button>
      )}
      {stored && !readOnly && (
        <Button variant="ghost" size="icon-sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Réagir" className={cn("opacity-0 pointer-coarse:opacity-70 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60", open && "opacity-100")}>
          <SmilePlus />
        </Button>
      )}
      {open && (
        <span role="group" aria-label="Choisir une réaction" className="absolute bottom-full left-0 z-20 mb-1 flex gap-0.5 rounded-full border border-border bg-surface p-1 shadow-md">
          {QUICK_EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => set(e)} aria-label={`Réagir ${e}`} className="grid size-8 cursor-pointer place-items-center rounded-full text-lg hover:bg-muted">{e}</button>
          ))}
        </span>
      )}
    </span>
  );
}

function MessageTime() {
  const when = useAuiState((s) => s.message.createdAt);
  if (!when) return null;
  return <time dateTime={when.toISOString()} title={when.toLocaleString("fr-CA", { dateStyle: "long", timeStyle: "short" })} className="text-[11px] text-muted-foreground tabular-nums">{messageMoment(when)}</time>;
}

/** En haut du fil : les messages plus anciens ne se chargent qu'à la demande, sans faire sauter la lecture. */
function OlderMessages() {
  const { hasOlder, loading, loadOlder } = useContext(HistoryContext);
  const self = useRef<HTMLDivElement>(null);
  if (!hasOlder) return null;
  const load = async () => {
    const viewport = self.current?.closest<HTMLElement>("[data-noah-viewport]");
    const before = viewport ? viewport.scrollHeight - viewport.scrollTop : 0;
    await loadOlder().catch(() => {});
    requestAnimationFrame(() => {
      if (viewport) viewport.scrollTop = viewport.scrollHeight - before;
    });
  };
  return (
    <div ref={self} className="flex justify-center pb-3">
      <Button variant="outline" size="sm" onClick={load} disabled={loading}>
        {loading ? <Loader2 className="animate-spin" /> : <ChevronUp />}Charger les messages précédents
      </Button>
    </div>
  );
}

function UserMessage() {
  const id = useAuiState((s) => s.message.id);
  return (
    <>
    <DayDivider />
    <MessagePrimitive.Root data-noah-msg={id} className="group flex scroll-mt-4 flex-col items-end gap-1.5 py-2">
      <div className="flex flex-wrap justify-end gap-1.5">
        <MessagePrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface px-4 py-2.5 whitespace-pre-wrap shadow-sm ring-1 ring-border">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
      <div className="flex items-center gap-2">
        <MessageReactions />
        <MessageTime />
      </div>
    </MessagePrimitive.Root>
    </>
  );
}

/** Bouton flottant sur un passage sélectionné d'une réponse : il le joint au prochain message. */
function SelectionReply() {
  const { add } = useQuotes();
  const [spot, setSpot] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const update = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      const node = sel?.anchorNode;
      const el = node instanceof Element ? node : node?.parentElement;
      if (!sel || sel.isCollapsed || text.length < 2 || !el?.closest("[data-reply-source]")) return setSpot(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setSpot({ x: Math.min(Math.max(r.left + r.width / 2, 80), window.innerWidth - 80), y: Math.max(r.top - 8, 8), text });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);
  if (!spot) return null;
  return (
    <Button
      size="sm"
      className="fixed z-50 h-8 -translate-x-1/2 -translate-y-full shadow-lg"
      style={{ left: spot.x, top: spot.y }}
      // mousedown sans perdre la sélection avant le clic
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        add({ label: spot.text.slice(0, 80), text: spot.text });
        window.getSelection()?.removeAllRanges();
        setSpot(null);
        document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
      }}
    >
      <Reply />Répondre à ceci
    </Button>
  );
}

/** Passages joints au prochain message, au-dessus de la zone de saisie. */
function QuoteChips() {
  const { quotes, remove } = useQuotes();
  if (!quotes.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {quotes.map((q, i) => (
        <div key={i} className="flex items-center gap-2 rounded-lg border-l-2 border-accent bg-muted/60 py-1 pr-1 pl-2.5 text-[13px]">
          <Reply className="size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.label}</span>
          <button type="button" className="cursor-pointer rounded-full p-0.5 text-muted-foreground hover:bg-muted" onClick={() => remove(i)} aria-label="Retirer la citation">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function AssistantMessage() {
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  const busyActivity = useContext(WhileBusyContext).activity;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const empty = useAuiState((s) => s.message.content.length === 0);
  const isLast = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id);
  const id = useAuiState((s) => s.message.id);
  const isTrace = useAuiState((s) => s.message.content.some((p) => p.type === "tool-call" && p.toolName === "trace"));
  // Seul le dernier message peut vivre : les autres ne recalculent rien.
  const base = useAuiState((s) => (s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id ? moodOf(s.message) : "rest"));
  const mood = useMood(base, isLast, !!busyActivity);
  const label = useAuiState((s) => (isLast ? moodLabel(s.message, mood) : ""));
  const wide = useWide();
  if (isTrace) {
    return (
      <>
      <DayDivider />
      <MessagePrimitive.Root data-noah-msg={id} className="flex min-w-0 scroll-mt-4 flex-col py-1 md:pl-11">
        <MessagePrimitive.Parts components={{ tools: TOOLS }} />
      </MessagePrimitive.Root>
      </>
    );
  }
  // Le travail suivi près de la saisie a son propre visage : un seul bouge à la fois.
  const live = isLast && !busyActivity && mood !== "rest";
  const face = (className: string) => (
    <NoahTile color={agentColor} shape={agentShape} detail={agentDetail} state={live ? MOOD_FACE[mood] : "idle"} still={!isLast || !!busyActivity} className={className} />
  );
  return (
    <>
    <DayDivider />
    <MessagePrimitive.Root data-noah-msg={id} data-reply-source className="group relative flex scroll-mt-4 flex-col gap-1 py-2 md:pl-11">
      {/* Dans la marge, il reste en vue quand une longue réponse défile. */}
      {wide && !(empty && running && busyActivity) && (
        <span className="absolute inset-y-2 left-0">
          <span className="sticky top-2 block">{face(cn("transition-[width,height,margin] duration-200", live ? "-ml-1 size-10" : "size-8"))}</span>
        </span>
      )}
      <div className="max-w-[92%] min-w-0">
        {empty && running ? (
          // Un travail repris (app rouverte) dit déjà ce qu'il fait au-dessus de la saisie : pas deux indicateurs.
          !busyActivity && (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground max-md:hidden">
              <Loader2 className="size-3.5 animate-spin text-accent" /> Réflexion…
            </div>
          )
        ) : (
          <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: TOOLS }} />
        )}
      </div>
      {/* Sur un téléphone, pas de marge : le visage se tient sous le travail, tout près de la saisie, son statut à côté. */}
      {!wide && live && (
        <div className="flex items-center gap-2.5 pt-1 text-[13px] text-muted-foreground" aria-live="polite">
          {face("size-10")}
          <span className="min-w-0 truncate">{label}</span>
        </div>
      )}
      {/* Place réservée : le bouton apparaît au survol sans décaler le texte en dessous. */}
      <div className="flex h-8 items-center gap-2">
        {!running && <MessageTime />}
        {!running && <MessageReactions />}
        {!running && (
          <ActionBarPrimitive.Root
            className={cn(
              "flex gap-1 opacity-0 pointer-coarse:opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100",
              isLast && "opacity-70",
            )}
          >
            <ActionBarPrimitive.Copy asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Copier la réponse">
                <MessagePrimitive.If copied><Check /></MessagePrimitive.If>
                <MessagePrimitive.If copied={false}><Copy /></MessagePrimitive.If>
              </Button>
            </ActionBarPrimitive.Copy>
          </ActionBarPrimitive.Root>
        )}
      </div>
    </MessagePrimitive.Root>
    </>
  );
}

// --- Zone de saisie -----------------------------------------------------------------

function Composer({ onVoiceMode, inCall }: { onVoiceMode: () => void; inCall: boolean }) {
  const dictation = useDictation();
  const running = useAuiState((s) => s.thread.isRunning);
  const dictating = dictation.state !== "idle";
  const busy = useContext(WhileBusyContext);
  const aui = useAui();
  const sendWhileBusy = () => {
    const composer = aui.thread().composer();
    const state = composer.getState();
    const text = state.text.trim();
    if (!text) return;
    const files = state.attachments.map((a) => a.file).filter((f): f is File => !!f);
    void composer.reset();
    busy.send(text, files);
  };
  return (
    <>
    <WhileBusyPanel />
    <ComposerPrimitive.Root className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-surface p-2 shadow-sm focus-within:border-accent">
      <QuoteChips />
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      {/* Sur un téléphone, le texte a toute la largeur et les boutons passent dessous, comme dans les apps de chat. */}
      <div className="flex items-end gap-1.5 max-sm:flex-wrap">
        <ComposerPrimitive.AddAttachment asChild multiple>
          <Button variant="ghost" size="icon" aria-label="Joindre des fichiers" className="text-muted-foreground max-sm:mr-auto">
            <Paperclip />
          </Button>
        </ComposerPrimitive.AddAttachment>
        <AttachPosition />
        <ComposerPrimitive.Input
          data-composer-input
          rows={1}
          autoFocus={FINE_POINTER}
          placeholder={dictating ? "Parle, le texte arrive ici…" : running ? "Précise, pose une question, ou ajoute une demande…" : "Écris à ton agent…"}
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-muted-foreground max-sm:order-first max-sm:basis-full max-sm:px-2 max-sm:text-base"
          onKeyDown={(e) => {
            // Entrée pendant la dictée : on termine la transcription, puis le message part.
            if (dictating && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void dictation.finish(!running);
            } else if (running && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              // Pendant le travail, la saisie reste ouverte : le message est trié, jamais perdu.
              e.preventDefault();
              sendWhileBusy();
            }
          }}
        />
        {!inCall && <DictateButton dictation={dictation} />}
        {!inCall && <VoiceModeButton onClick={onVoiceMode} />}
        <ThreadPrimitive.If running={false}>
          {dictating ? (
            <Button
              type="button"
              size="icon"
              aria-label="Envoyer"
              title="Termine la transcription puis envoie"
              className="rounded-xl"
              disabled={dictation.state === "finishing"}
              onClick={() => void dictation.finish(true)}
            >
              <ArrowUp />
            </Button>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button size="icon" aria-label="Envoyer" className="rounded-xl"><ArrowUp /></Button>
            </ComposerPrimitive.Send>
          )}
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <Button type="button" size="icon" aria-label="Envoyer" title="Il répond tout de suite ; le travail continue" className="rounded-xl" onClick={sendWhileBusy}>
            <ArrowUp />
          </Button>
          <ComposerPrimitive.Cancel asChild>
            <Button size="icon" variant="outline" aria-label="Arrêter" className="rounded-xl"><Square className="fill-current" /></Button>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
    </>
  );
}

/** Au-dessus de la saisie : ce que fait un travail lancé ailleurs, et les demandes qui attendent leur tour. */
function WhileBusyPanel() {
  const busy = useContext(WhileBusyContext);
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  usePanelEnd(!!busy.activity);
  if (!busy.activity && !busy.waiting.length && !busy.sending.length) return null;
  return (
    <div className="mb-2 flex w-full flex-col gap-1 text-xs text-muted-foreground">
      {busy.activity && <div className="flex items-center gap-2.5 px-1 text-[13px]"><NoahTile color={agentColor} shape={agentShape} detail={agentDetail} state="working" className="size-10" /><span className="truncate">{busy.activity}…</span></div>}
      {busy.sending.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
          <span className="shrink-0">{item.late ? "Réception à vérifier" : "Envoi"}</span>
          <span className="min-w-0 flex-1 truncate">{item.text}</span>
          {item.late && (
            <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => busy.giveUp(item.id)}>
              Abandonner
            </button>
          )}
        </div>
      ))}
      {busy.waiting.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1">
          <span className="shrink-0">À la suite</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{item.text}</span>
          {busy.active && (
            <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => void busy.now(item.id).catch(() => {})}>
              Maintenant
            </button>
          )}
          <button type="button" className="shrink-0 underline underline-offset-2 hover:text-foreground" onClick={() => busy.cancel(item.id)}>
            Retirer
          </button>
        </div>
      ))}
    </div>
  );
}

function EmptyNoah() {
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  const face = useRef<NoahHandle>(null);
  // Une conversation vide : l'agent salue d'un petit bond.
  useEffect(() => {
    face.current?.react("greet");
  }, []);
  return <NoahTile handle={face} color={agentColor} shape={agentShape} detail={agentDetail} className="mb-2 size-20" />;
}

export function Thread({ report, onReportRead, onCall }: { report: { id: string; text: string } | null; onReportRead: () => void; onCall: (on: boolean) => void }) {
  const { agentId, agentName, hint, readOnly } = useContext(AgentContext);
  const [voice, setVoice] = useState(false);
  // Des fichiers choisis dans le panneau : joints au prochain message, comme un passage cité.
  const { add: addQuote } = useQuotes();
  const threadRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const give = (e: Event) => {
      const { agentId: to, label, text } = (e as CustomEvent<{ agentId: string; label: string; text: string }>).detail;
      // Un fil caché (un appel en cours ailleurs) reste monté : seul celui qu'on voit reçoit le don.
      if (to !== agentId || !threadRoot.current?.getClientRects().length) return;
      addQuote({ label, text });
      threadRoot.current.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
    };
    window.addEventListener(giveFilesEvent, give);
    return () => window.removeEventListener(giveFilesEvent, give);
  }, [addQuote, agentId]);
  // Pour l'appel : un aperçu intégré compte aussi comme un artefact à ouvrir.
  const link = useCallback(
    (text: string) =>
      plainWidgets(linkMessage(text, { fileUrl: (path) => rawFileUrl(agentId, path) }), (path) => rawFileUrl(agentId, path), (path) => mediaUrl(agentId, path)),
    [agentId],
  );
  // Rappel pris : le mode vocal s'ouvre et lit le compte rendu.
  const reportId = report?.id;
  useEffect(() => {
    if (reportId) setVoice(true);
  }, [reportId]);
  useEffect(() => {
    onCall(voice); // l'application garde cette conversation ouverte tant que l'appel dure
  }, [voice, onCall]);
  return (
    <ThreadPrimitive.Root ref={threadRoot} data-noah-thread className="relative flex h-full min-h-0 flex-col">
      <ConversationRail />
      <SelectionReply />
      <ComposerPrimitive.AttachmentDropzone className="flex min-h-0 flex-1 flex-col data-[dragging=true]:bg-accent-soft/40">
        <ThreadPrimitive.Viewport data-noah-viewport className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 [container-type:inline-size]">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col pt-6">
            <OlderMessages />
            <ThreadPrimitive.Empty>
              <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
                <EmptyNoah />
                <p className="text-xl font-semibold">Que doit faire {agentName} ?</p>
                <p className="text-sm text-muted-foreground">{hint}</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto flex w-full max-w-3xl flex-col items-center gap-2 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            <ThreadPrimitive.ScrollToBottom asChild>
              <Button variant="outline" size="icon-sm" className="rounded-full disabled:invisible" aria-label="Aller en bas">
                <ArrowDown />
              </Button>
            </ThreadPrimitive.ScrollToBottom>
            {readOnly ? (
              <p className="w-full rounded-2xl border border-border bg-surface p-3 text-center text-sm text-muted-foreground">Tu peux lire ici, pas écrire.</p>
            ) : (
              <>
                {voice && <VoiceMode onClose={() => setVoice(false)} report={report} onReportRead={onReportRead} link={link} />}
                <Composer onVoiceMode={() => setVoice(true)} inCall={voice} />
              </>
            )}
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
  );
}
