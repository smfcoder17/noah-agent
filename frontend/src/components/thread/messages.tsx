import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActionBarPrimitive, AttachmentPrimitive, MessagePrimitive, type TextMessagePartProps, useAui, useAuiState } from "@assistant-ui/react";
import { Check, ChevronUp, Copy, FileText, Loader2, Pencil, Reply, SmilePlus, X } from "lucide-react";
import { SensitiveText } from "../SensitiveText";
import { WhileBusyContext, AgentContext, HistoryContext } from "@/lib/agentContext";
import { MOOD_FACE, moodLabel, moodOf, useMood, useWide } from "@/lib/chatMood";
import { splitQuotes, useQuotes } from "@/lib/quotes";
import { NoahTile } from "../Noah";
import { ReportAnswer } from "../ReportAnswer";
import { cn, dayLabel, messageMoment } from "@/lib/utils";
import { Button } from "../ui";
import { readableModel } from "@/lib/modes";
import { langue, locale, t } from "@/i18n";
import { MarkdownText } from "./Markdown";
import { LiveStatus, TOOLS } from "./parts";

// --- Messages ------------------------------------------------------------------------

export function AttachmentChip() {
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-2.5 pr-1.5 text-[13px]">
      <FileText className="size-3.5 text-muted-foreground" />
      <span className="max-w-48 truncate"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove asChild>
        <button className="rounded-full p-0.5 text-muted-foreground hover:bg-muted" aria-label={t("Retirer")}><X className="size-3.5" /></button>
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
          <SensitiveText text={q} />
        </span>
      ))}
      <SensitiveText text={rest} />
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

type ModelMark = { model: string; before: string | null };
const modelOfMessage = (m: { metadata?: { custom?: Record<string, unknown> } } | undefined): string =>
  typeof m?.metadata?.custom?.model === "string" ? (m.metadata.custom.model as string) : "";

/**
 * Le modèle de cette réponse, et celui de la réponse de l'agent qui la précède (null : aucune, c'est le début du fil lu).
 * Une chaîne, pas un objet, pour que le sélecteur ne redessine rien tant qu'elle ne change pas.
 */
function useModelMark(): ModelMark | null {
  const key = useAuiState((s) => {
    const model = modelOfMessage(s.message);
    if (!model) return "";
    for (let i = s.message.index - 1; i >= 0; i--) {
      const before = modelOfMessage(s.thread.messages[i]);
      if (before) return JSON.stringify({ model, before });
    }
    return JSON.stringify({ model, before: null });
  });
  return useMemo(() => (key ? (JSON.parse(key) as ModelMark) : null), [key]);
}

/**
 * Entre deux réponses écrites par des modèles différents, une ligne fine : « Passage à … ». Au début du fil, « Modèle : … ».
 * Comme le séparateur système de T3 Code : une règle et un libellé discret, sans carte ni bouton. Le nom complet au survol.
 */
function ModelDivider() {
  const mark = useModelMark();
  if (!mark || mark.before === mark.model) return null;
  const name = readableModel(mark.model);
  return (
    <div data-model-divider className="my-1 flex items-center gap-3 text-[11px] text-muted-foreground/80" title={mark.model}>
      <span className="h-px flex-1 bg-border/70" />
      <span className="max-w-[70%] truncate">{mark.before === null ? t("Modèle : {nom}", { nom: name }) : t("Passage à {nom}", { nom: name })}</span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

/** Dans la rangée d'actions d'une réponse : le modèle qui l'a écrite, visible au survol comme Copier et Signaler. */
function MessageModel() {
  const mark = useModelMark();
  if (!mark) return null;
  return (
    <span data-message-model title={mark.model} aria-label={t("Écrit par {nom}", { nom: readableModel(mark.model) })}
      className="max-w-40 truncate px-1 text-[11px] leading-8 text-muted-foreground max-sm:max-w-28">
      {readableModel(mark.model)}
    </span>
  );
}

const QUICK_EMOJI =["👍", "❤️", "👎", "😂", "😮", "😢", "🙏", "🔥", "🎉"];

/** Les réactions d'un message, et de quoi y réagir : visible au survol, toujours là sur un écran tactile. */
function MessageReactions() {
  const id = useAuiState((s) => s.message.id);
  // Une chaîne, pas l'objet : celui-ci est neuf à chaque conversion, et redessinerait les réactions de tout le fil.
  const customKey = useAuiState((s) => JSON.stringify(s.message.metadata?.custom ?? null));
  const custom = useMemo(() => JSON.parse(customKey) as { storedId?: number; reactions?: { user?: string; agent?: string; retenu?: string } } | null, [customKey]);
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
      {theirs && <span role="img" aria-label={t("Réaction de l'agent : {emoji}", { emoji: theirs })} className="rounded-full border border-border bg-surface px-1.5 text-sm leading-6">{theirs}</span>}
      {custom?.reactions?.retenu && <span title={t("L'agent l'a retenu pour la suite")} className="text-[11px] text-muted-foreground">{t("retenu")}</span>}
      {mine && (
        <button type="button" onClick={() => set(null)} disabled={readOnly} aria-label={t("Retirer ta réaction {emoji}", { emoji: mine })} className="cible-tactile cursor-pointer rounded-full border border-accent/40 bg-accent-soft px-1.5 text-sm leading-6">{mine}</button>
      )}
      {stored && !readOnly && (
        <Button variant="ghost" size="icon-sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("Réagir")} className={cn("cible-tactile opacity-0 pointer-coarse:opacity-70 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-60", open && "opacity-100")}>
          <SmilePlus />
        </Button>
      )}
      {open && (
        <span role="group" aria-label={t("Choisir une réaction")} className="absolute bottom-full left-0 z-20 mb-1 flex gap-0.5 rounded-full border border-border bg-surface p-1 shadow-md">
          {QUICK_EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => set(e)} aria-label={t("Réagir {emoji}", { emoji: e })} className="cible-tactile grid size-8 cursor-pointer place-items-center rounded-full text-lg hover:bg-muted">{e}</button>
          ))}
        </span>
      )}
    </span>
  );
}

function MessageTime() {
  const when = useAuiState((s) => s.message.createdAt);
  if (!when) return null;
  return <time dateTime={when.toISOString()} title={when.toLocaleString(langue() === "fr" ? "fr-CA" : locale(), { dateStyle: "long", timeStyle: "short" })} className="text-[11px] text-muted-foreground tabular-nums">{messageMoment(when)}</time>;
}

/** En haut du fil : les messages plus anciens ne se chargent qu'à la demande, sans faire sauter la lecture. */
export function OlderMessages() {
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
        {loading ? <Loader2 className="animate-spin" /> : <ChevronUp />}{t("Charger les messages précédents")}
      </Button>
    </div>
  );
}

export const UserMessage = memo(function UserMessage() {
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
        <ActionBarPrimitive.Root className="flex gap-1 opacity-0 pointer-coarse:opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <ActionBarPrimitive.Copy asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("Copier mon message")} className="cible-tactile">
              <MessagePrimitive.If copied><Check /></MessagePrimitive.If>
              <MessagePrimitive.If copied={false}><Copy /></MessagePrimitive.If>
            </Button>
          </ActionBarPrimitive.Copy>
          <TakeBack />
        </ActionBarPrimitive.Root>
        <MessageReactions />
        <MessageTime />
      </div>
    </MessagePrimitive.Root>
    </>
  );
});

/** Reprendre un de mes messages : il revient dans la saisie, à modifier avant de le renvoyer. Rien ne part seul. */
function TakeBack() {
  const aui = useAui();
  const { readOnly } = useContext(AgentContext);
  const text = useAuiState((s) => s.message.content.map((p) => (p.type === "text" ? p.text : "")).join("").trim());
  if (readOnly || !text) return null;
  return (
    <Button variant="ghost" size="icon-sm" aria-label={t("Reprendre ce message")} title={t("Reprendre ce message")} className="cible-tactile"
      onClick={() => {
        aui.thread().composer().setText(text);
        document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
      }}>
      <Pencil />
    </Button>
  );
}

export function useSentHistory() {
  const sent = useAuiState((s) => s.thread.messages.filter((m) => m.role === "user").map((m) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("").trim()).filter(Boolean).join("\u0000"));
  return useMemo(() => (sent ? sent.split("\u0000") : []), [sent]);
}

/** Bouton flottant sur un passage sélectionné d'une réponse : il le joint au prochain message. */
export function SelectionReply() {
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
      <Reply />{t("Répondre à ceci")}
    </Button>
  );
}

/** Passages joints au prochain message, au-dessus de la zone de saisie. */
export function QuoteChips() {
  const { quotes, remove } = useQuotes();
  if (!quotes.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {quotes.map((q, i) => (
        <div key={i} className="flex items-center gap-2 rounded-lg border-l-2 border-accent bg-muted/60 py-1 pr-1 pl-2.5 text-[13px]">
          <Reply className="size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{q.label}</span>
          <button type="button" className="cursor-pointer rounded-full p-0.5 text-muted-foreground hover:bg-muted" onClick={() => remove(i)} aria-label={t("Retirer la citation")}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Le texte d'une réponse tel qu'il est affiché : une donnée masquée reste masquée dans un signalement. */
function answerText(id: string): string {
  const el = document.querySelector<HTMLElement>(`[data-noah-msg="${id.replace(/["\\]/g, "\\$&")}"] [data-noah-answer]`);
  return (el?.innerText || el?.textContent || "").trim();
}

export const AssistantMessage = memo(function AssistantMessage() {
  const { agentColor, agentShape, agentDetail } = useContext(AgentContext);
  const busyActivity = useContext(WhileBusyContext).activity;
  const running = useAuiState((s) => s.message.status?.type === "running");
  const empty = useAuiState((s) => s.message.content.length === 0);
  const isLast = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id);
  const [copyWarning, setCopyWarning] = useState(false);
  const id = useAuiState((s) => s.message.id);
  const isTrace = useAuiState((s) => s.message.content.some((p) => p.type === "tool-call" && (p.toolName === "trace" || p.toolName === "tache")));
  // Seul le dernier message peut vivre : les autres ne recalculent rien.
  const base = useAuiState((s) => (s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id ? moodOf(s.message) : "rest"));
  const mood = useMood(base, isLast, !!busyActivity);
  const label = useAuiState((s) => (isLast ? moodLabel(s.message, mood) : ""));
  const wide = useWide();
  if (isTrace) {
    return (
      <>
      <DayDivider />
      <MessagePrimitive.Root data-noah-msg={id} className="flex min-w-0 scroll-mt-4 flex-col py-1">
        <MessagePrimitive.Parts components={{ tools: TOOLS }} />
      </MessagePrimitive.Root>
      </>
    );
  }
  // Une seule mascotte dans toute la conversation : sous le travail en cours, jamais à côté des réponses finies.
  const live = isLast && !busyActivity && mood !== "rest";
  return (
    <>
    <DayDivider />
    <ModelDivider />
    <MessagePrimitive.Root data-noah-msg={id} data-reply-source className="group relative flex scroll-mt-4 flex-col gap-1 py-2">
      {!(empty && running) && (
        <div data-noah-answer className="max-w-[92%] min-w-0">
          <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: TOOLS }} />
        </div>
      )}
      {live && (
        <LiveStatus face={<NoahTile color={agentColor} shape={agentShape} detail={agentDetail} state={MOOD_FACE[mood]} className={wide ? "size-12" : "size-11"} />} label={label} working={mood === "think" || mood === "work"} />
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
              <Button variant="ghost" size="icon-sm" aria-label={t("Copier la réponse")} className="cible-tactile" onClickCapture={(e) => { if (e.currentTarget.closest("[data-noah-msg]")?.querySelector(".sensitive-token:not(.shown)")) { e.preventDefault(); e.stopPropagation(); setCopyWarning(true); } else setCopyWarning(false); }}>
                <MessagePrimitive.If copied><Check /></MessagePrimitive.If>
                <MessagePrimitive.If copied={false}><Copy /></MessagePrimitive.If>
              </Button>
            </ActionBarPrimitive.Copy>
            <ReportAnswer readText={() => answerText(id)} />
            <MessageModel />
            {copyWarning && <span role="status" className="text-xs text-muted-foreground">{t("Révèle les données avant de copier.")}</span>}
          </ActionBarPrimitive.Root>
        )}
      </div>
    </MessagePrimitive.Root>
    </>
  );
});
