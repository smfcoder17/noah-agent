import { useVisibleSubscription } from "./events";
// État d'une conversation et branchement sur assistant-ui (ExternalStoreRuntime).
// Le serveur envoie ses propres événements SSE ; on les traduit ici en messages et en « parts ».
import {
  type AppendMessage,
  type AttachmentAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { onForget, SeenActive, seenGeneration } from "./seen";
import { ApiError, type ChatEvent, get, type LoginAsked, send, type Reactions, type Recu, type StoredMessage, request, StreamLost, streamChat, uploadFile } from "./api";
import { accordLabel, refreshAccords, useAccords } from "./events";

type TextPart = { type: "text"; text: string };
type ToolPart = { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown };
type Part = TextPart | ToolPart;
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: Part[];
  attachments?: string[];
  running?: boolean;
  createdAt?: Date;
  storedId?: number;
  reactions?: Reactions;
  /** Détail tel que stocké d'une trace de fil : sa ligne change à la fin du fil, sans changer le nombre de messages. */
  trace?: string;
};

function traceArgs(m: StoredMessage): Record<string, unknown> {
  try {
    return JSON.parse(m.detail ?? "");
  } catch {
    return { consigne: m.text };
  }
}

/** Une trace dont l'issue vient d'être écrite : le même nombre de messages, mais pas le même écran. */
const traceMoved = (rows: StoredMessage[], cur: ChatMessage[]) => rows.some((r, i) => r.role === "trace" && r.detail !== cur[i]?.trace);

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const ATTACHED_RE = /\n\nFichiers joints par l'utilisateur :\n((?:- .+\n?)+)$/;

/** La conversation par tranches : au départ les derniers messages, plus haut sur demande. Une fois lue, une tranche reste à l'écran. */
const PAGE = 60;
const windows = new Map<string, { from: number; more: boolean }>();
const windowUrl = (conv: string) => {
  const open = windows.get(conv);
  return `/api/conversations/${conv}/messages?${open ? `depuis=${open.from}` : `limit=${PAGE}`}`;
};
const anchorOf = (conv: string) => windows.get(conv)?.from;
/** Vrai si cette lecture décrit encore la fenêtre : celle lancée avant de remonter plus haut ne doit rien remplacer. */
function current(conv: string, asked: number | undefined, rows: StoredMessage[]) {
  const open = windows.get(conv);
  if (open && open.from !== asked && rows[0]?.id !== open.from) return false;
  if (!rows.length) windows.delete(conv); // conversation vidée : l'ancre n'existe plus
  else if (!open && rows[0].id !== undefined) windows.set(conv, { from: rows[0].id, more: rows.length >= PAGE });
  return true;
}

// Le serveur écrit en UTC, sans le dire.
const storedDate = (at: string | undefined) => (at ? new Date(`${at.replace(" ", "T")}Z`) : undefined);

function fromStored(stored: StoredMessage, i: number): ChatMessage {
  const m = stored;
  return { ...fromStoredContent(m, m.id ?? i), createdAt: storedDate(m.created_at), storedId: m.id, reactions: m.reactions };
}

function fromStoredContent(m: StoredMessage, i: number): ChatMessage {
  if (m.role === "accord") {
    const accord = traceArgs(m) as { id?: string };
    return { id: accord.id ? `clos-${accord.id}` : `h${i}`, role: "assistant", content: [{ type: "text", text: m.text }] };
  }
  if (m.role === "user") {
    const match = m.text.match(ATTACHED_RE);
    const files = match ? match[1].trim().split("\n").map((l) => l.replace(/^- /, "").split("/").pop()!) : [];
    return { id: `h${i}`, role: "user", content: [{ type: "text", text: match ? m.text.slice(0, match.index) : m.text }], attachments: files };
  }
  if (m.role === "error") {
    return { id: `h${i}`, role: "assistant", content: [{ type: "tool-call", toolCallId: `e${i}`, toolName: "error", args: { message: m.text, detail: m.detail ?? "" }, result: true }] };
  }
  if (m.role === "trace") {
    return { id: `h${i}`, role: "assistant", trace: m.detail ?? "", content: [{ type: "tool-call", toolCallId: `t${i}`, toolName: "trace", args: traceArgs(m), result: true }] };
  }
  const { steps, recu } = stored(m.detail);
  return { id: `h${i}`, role: "assistant", content: [{ type: "text", text: m.text }, ...recuParts(recu), ...(steps.length ? [stepsPart(steps)] : [])] };
}

const stepsPart = (steps: string[]): Part => ({ type: "tool-call", toolCallId: "steps", toolName: "steps", args: { steps } as never, result: true });
const recuParts = (recu?: Recu | null): Part[] => (recu ? [{ type: "tool-call", toolCallId: "recu", toolName: "recu", args: { recu } as never, result: true }] : []);
function stored(detail: unknown): { steps: string[]; recu?: Recu } {
  if (typeof detail !== "string" || !detail.startsWith('{"etapes"')) return { steps: [] };
  try {
    const data = JSON.parse(detail);
    return { steps: data.etapes ?? [], recu: data.recu };
  } catch {
    return { steps: [] };
  }
}
const stepsOf = (parts: Part[]): string[] => {
  const found = parts.find((p) => p.type === "tool-call" && p.toolName === "steps");
  return found ? ((found as unknown as { args: { steps: string[] } }).args.steps ?? []) : [];
};
const withoutSteps = (parts: Part[]) => parts.filter((p) => !(p.type === "tool-call" && p.toolName === "steps"));
const SHOWS_SOMETHING = /```noah|^MEDIA:|\/opt\/data\/workspace\/(?:outputs|apps|captures)\/\S+\.\w/m;

/** Retire la ligne de travail : elle ne sert que pendant que l'agent agit. */
const settle = (parts: Part[]): Part[] => parts.filter((p) => !(p.type === "tool-call" && p.toolName === "activity"));

function apply(msg: ChatMessage, ev: ChatEvent, runId: string | null): ChatMessage {
  const parts = msg.content;
  switch (ev.type) {
    case "message": {
      const last = parts[parts.length - 1];
      if (last?.type === "text") return { ...msg, content: [...parts.slice(0, -1), { type: "text", text: last.text + ev.text }] };
      return { ...msg, content: [...settle(parts), { type: "text", text: ev.text.replace(/^\n+/, "") }] };
    }
    case "etape": {
      // Ce qu'il a écrit avant de lancer un outil est le récit de son travail : il quitte la réponse. Un widget ou une image reste.
      const last = parts[parts.length - 1];
      if (last?.type !== "text" || SHOWS_SOMETHING.test(last.text)) return msg;
      const said = last.text.trim();
      return { ...msg, content: [stepsPart([...stepsOf(parts), ...(said ? [said] : [])]), ...withoutSteps(parts.slice(0, -1))] };
    }
    case "activity": {
      // Une seule ligne de travail, toujours en bas : la nouvelle étape remplace l'ancienne.
      const next: Part[] = [...settle(parts)];
      if (ev.detail) next.push({ type: "tool-call", toolCallId: uid("d"), toolName: "detail", args: { data: ev.detail as never }, result: true });
      next.push({ type: "tool-call", toolCallId: "activity", toolName: "activity", args: { label: ev.label } });
      return { ...msg, content: next };
    }
    case "activity_detail":
    case "raw":
      return {
        ...msg,
        content: [...parts, { type: "tool-call", toolCallId: uid("d"), toolName: "detail", args: { data: ("detail" in ev ? ev.detail : { [ev.kind]: ev.data }) as never }, result: true }],
      };
    case "approval":
      return {
        ...msg,
        content: [
          ...settle(parts),
          {
            type: "tool-call",
            toolCallId: uid("p"),
            toolName: "approval",
            args: { summary: ev.summary, demande: ev.demande, apercu: ev.apercu, request_id: ev.request_id, generation: ev.generation, run_id: runId ?? "" },
          },
        ],
      };
    case "done": {
      // Le serveur donne ce que la conversation garde : l'écran finit dessus, même si des détails ont coupé le texte en morceaux.
      if (ev.status === "completed" && ev.reponse) {
        const others = withoutSteps(settle(parts)).filter((p) => p.type !== "text");
        return { ...msg, content: [...others, { type: "text", text: ev.reponse }, ...recuParts(ev.recu), ...(ev.etapes?.length ? [stepsPart(ev.etapes)] : [])], running: false };
      }
      let next = settle(parts);
      if (!next.some((p) => p.type === "text") && ev.output) next = [...next, { type: "text", text: ev.output }];
      // Les étapes passent sous la réponse. S'il a tout dit avant son dernier outil, sa dernière phrase est la réponse.
      let steps = stepsOf(next);
      next = withoutSteps(next);
      if (ev.status === "completed" && !next.some((p) => p.type === "text") && steps.length) {
        next = [...next, { type: "text", text: steps[steps.length - 1] }];
        steps = steps.slice(0, -1);
      }
      if (steps.length) next = [...next, stepsPart(steps)];
      if (ev.status !== "completed" && ev.error) {
        next = [...next, { type: "tool-call", toolCallId: uid("e"), toolName: "error", args: { message: ev.error, detail: ev.details ?? "" }, result: true }];
      }
      return { ...msg, content: next, running: false };
    }
    default:
      return msg;
  }
}

const messagesCache = new Map<string, ChatMessage[]>();
const CACHED_CONVERSATIONS = 20;
/** Garde les messages d'une conversation pour la rouvrir sans attendre ; au-delà de vingt, la plus ancienne sort. */
function remember(conv: string, messages: ChatMessage[]) {
  messagesCache.delete(conv);
  messagesCache.set(conv, messages);
  while (messagesCache.size > CACHED_CONVERSATIONS) messagesCache.delete(messagesCache.keys().next().value as string);
}

// Une même page demandée par plusieurs effets au même instant (ouverture d'une conversation) : une seule requête part.
const reading = new Map<string, Promise<StoredMessage[]>>();
function readMessages(url: string): Promise<StoredMessage[]> {
  const flying = reading.get(url);
  if (flying) return flying;
  const generation = seenGeneration();
  const asked = get<StoredMessage[]>(url)
    .then((rows) => {
      // Lue pour le compte d'avant : elle ne remplit ni l'écran ni la mémoire du compte suivant.
      if (generation !== seenGeneration()) throw new Error("compte changé");
      return rows;
    })
    .finally(() => {
      if (reading.get(url) === asked) reading.delete(url);
    });
  reading.set(url, asked);
  return asked;
}

/** Changement de compte : rien de ce que le précédent a lu ne reste en mémoire, ni une lecture encore en route. */
export function forgetChat() {
  messagesCache.clear();
  windows.clear();
  reading.clear();
}
onForget(forgetChat);

const waitsApproval = (p: Part) => p.type === "tool-call" && p.toolName === "approval" && p.result === undefined;
/** Les messages à l'écran, sans les demandes d'accord encore ouvertes (elles ont leur carte). Un message qui n'en porte pas
 * garde son identité : assistant-ui ne reconvertit alors, à chaque image du flux, que le message qui change. */
export const visibleMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((m) => (m.content.some(waitsApproval) ? { ...m, content: m.content.filter((p) => !waitsApproval(p)) } : m));

export type WhileBusyApi = {
  active: boolean;
  /** Travail lancé sans ce flux (une demande qui attendait, un autre écran) : sa ligne s'affiche près de la saisie. */
  activity: string | null;
  waiting: { id: string; text: string }[];
  sending: { id: string; text: string; late: boolean }[];
  send: (text: string, files?: File[]) => void;
  /** Rend ce que le serveur a fait : « precision », « tache », « deja » ou « incertain ». */
  now: (id: string) => Promise<string>;
  cancel: (id: string) => void;
  giveUp: (id: string) => void;
};
type Approval = { summary: string; demande?: string; apercu?: string[]; request_id: string; generation: number; run_id: string };
type Now = { occupe: boolean; activite: string | null; run_id: string | null; file: { id: string; text: string }[]; accord: Approval | null; connexion?: LoginAsked | null };
const IDLE: Now = { occupe: false, activite: null, run_id: null, file: [], accord: null };

// Boîte d'envoi : un message reste ici, avec son identifiant, tant que le serveur n'a pas répondu. Une réponse perdue ne fait donc ni
// perte ni doublon : le même envoi repart, y compris après un rechargement, et le serveur le reconnaît.
type Outgoing = { id: string; text: string; agent: string; conv: string | null; files: string[] };
const OUTBOX = "noah-envois";
const readOutbox = (): Outgoing[] => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX) || "[]");
  } catch {
    return [];
  }
};
const writeOutbox = (items: Outgoing[]) => {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(items));
  } catch {
    /* navigation privée : l'envoi reste en mémoire le temps de la page */
  }
};
const delivering = new Set<string>();
const LATE_AFTER = 3;

// Fonction stable : si elle changeait à chaque rendu, assistant-ui viderait son cache et reconvertirait tout le fil
// à chaque image du flux, au lieu du seul message qui change.
const convertMessage = (m: ChatMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: m.content as ThreadMessageLike["content"],
  createdAt: m.createdAt,
  metadata: { custom: { storedId: m.storedId, reactions: m.reactions } },
  status: m.role === "assistant" ? (m.running ? { type: "running" } : { type: "complete", reason: "stop" }) : undefined,
  attachments: (m.attachments ?? []).map((name, i) => ({
    id: `${m.id}-att-${i}`,
    type: "file",
    name,
    status: { type: "complete" },
    content: [],
  })),
});

export function useAgentChat(opts: {
  agentId: string;
  conversationId: string | null;
  details: boolean;
  onConversationCreated: (id: string) => void;
  onRunFinished: () => void;
  /** Dernière mise à jour connue côté serveur : un message arrivé sans nous (routine) déclenche un rechargement. */
  updatedAt?: string;
  /** L'agent travaille quelque part, d'après sa fiche : même lancé sans cet écran (réponse à un appel, routine). */
  agentBusy?: boolean;
  /** Citations à mettre devant le message (vidées à l'envoi). */
  takeQuotes?: () => string;
}) {
  const subscribeUpdates = useVisibleSubscription();
  const active = useContext(SeenActive);
  const { agentId, conversationId, details, onConversationCreated, onRunFinished, updatedAt, agentBusy } = opts;
  const takeQuotes = useRef(opts.takeQuotes);
  takeQuotes.current = opts.takeQuotes;
  // Conversation déjà ouverte : ses messages s'affichent tout de suite, la version du serveur arrive derrière.
  const [messages, setMessages] = useState<ChatMessage[]>(() => (conversationId && messagesCache.get(conversationId)) || []);
  const [isRunning, setRunning] = useState(false);
  const [more, setMore] = useState(false);
  const [liveLabel, setLiveLabel] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const runRef = useRef<{ runId: string | null; abort: AbortController | null }>({ runId: null, abort: null });
  // Conversation créée pendant ce run : on ne recharge pas l'historique par-dessus le flux en cours.
  const ownConversation = useRef<string | null>(null);

  useEffect(() => {
    if (conversationId && conversationId === ownConversation.current) return;
    // L'envoi en cours vient de créer cette conversation, et la liste la montre avant son événement « start » (Hermes lent à
    // démarrer), ou pas encore après : c'est la même, il ne faut surtout pas le couper.
    if (runRef.current.abort && (!conversationId || !ownConversation.current)) {
      if (conversationId) ownConversation.current = conversationId;
      return;
    }
    ownConversation.current = conversationId;
    runRef.current.abort?.abort();
    setRunning(false);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setMessages(messagesCache.get(conversationId) ?? []);
    setMore(windows.get(conversationId)?.more ?? false);
    let cancelled = false;
    const asked = anchorOf(conversationId);
    readMessages(windowUrl(conversationId))
      .then((rows) => {
        if (cancelled) return;
        if (!current(conversationId, asked, rows)) return setMore(windows.get(conversationId)?.more ?? false);
        setMore(windows.get(conversationId)?.more ?? false);
        setMessages(rows.map(fromStored));
      })
      .catch((e) => {
        // Conversation refusée ou disparue : ce que la mémoire en gardait ne reste pas à l'écran.
        if (!(e instanceof ApiError) || (e.status !== 403 && e.status !== 404)) return;
        messagesCache.delete(conversationId);
        windows.delete(conversationId);
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, agentId]);

  const running = useRef(false);
  running.current = isRunning;
  useEffect(() => {
    if (conversationId && !isRunning) remember(conversationId, messages);
  }, [conversationId, isRunning, messages]);
  useEffect(() => {
    if (!conversationId || !updatedAt || running.current) return;
    let cancelled = false;
    const asked = anchorOf(conversationId);
    readMessages(windowUrl(conversationId))
      .then((rows) => {
        if (!current(conversationId, asked, rows)) return;
        if (!cancelled) setMore(windows.get(conversationId)?.more ?? false);
        // Seulement s'il y a du nouveau, pour ne pas redessiner la conversation pour rien.
        if (!cancelled && !running.current) setMessages((cur) => (rows.length > cur.length || (rows.length === cur.length && traceMoved(rows, cur)) ? rows.map(fromStored) : cur));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, updatedAt]);

  /** Après une coupure : interroge le serveur tout de suite puis toutes les 3 s (chaque essai borné à 8 s), et reprend
   * les messages enregistrés de la conversation dès qu'il répond. */
  const resync = useCallback(async (conv: string, gone: AbortSignal) => {
    // 10 minutes au plus : une réponse perdue avec un redémarrage du serveur n'arrivera jamais.
    for (let i = 0; i < 200; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      if (gone.aborted || ownConversation.current !== conv) return;
      try {
        const asked = anchorOf(conv);
        const rows = (await (
          await request(windowUrl(conv), { signal: AbortSignal.timeout(8000) })
        ).json()) as StoredMessage[];
        if (!current(conv, asked, rows)) continue;
        if (ownConversation.current === conv) setMore(windows.get(conv)?.more ?? false);
        if (ownConversation.current === conv && !running.current) setMessages(rows.map(fromStored));
        // Réponse encore en cours côté serveur : on recharge encore jusqu'à la voir arrivée. La trace d'un fil n'en est pas une.
        if (rows.filter((r) => r.role !== "trace").pop()?.role !== "user") return;
      } catch {
        /* serveur toujours absent */
      }
    }
  }, []);

  // --- Pendant le travail : la saisie reste ouverte, et ce qui attend se voit. ---
  const [serverNow, setServerNow] = useState<Now>(IDLE);
  const [login, setLogin] = useState<(LoginAsked & { result?: unknown }) | null>(null);
  const { items: pendingAccords, recent: closedAccords } = useAccords();
  const [sending, setSending] = useState<WhileBusyApi["sending"]>([]);
  const givenUp = useRef(new Set<string>());
  const serverBusy = useRef(false);
  serverBusy.current = serverNow.occupe || serverNow.file.length > 0; // une file non vide : le nouveau message passe derrière
  const serverRun = useRef<string | null>(null);
  serverRun.current = serverNow.run_id;

  const reload = useCallback(async (conv: string) => {
    const asked = anchorOf(conv);
    const rows = await readMessages(windowUrl(conv));
    if (!current(conv, asked, rows)) return;
    if (ownConversation.current === conv) setMore(windows.get(conv)?.more ?? false);
    if (ownConversation.current === conv && !running.current) {
      setMessages((cur) => {
        if (rows.length !== cur.length || traceMoved(rows, cur)) return rows.map(fromStored);
        // Même nombre : on garde l'affichage, en apprenant le numéro des messages écrits ici (pour pouvoir y réagir) et leurs réactions.
        const changed = rows.some((r, i) => r.id !== cur[i].storedId || JSON.stringify(r.reactions ?? null) !== JSON.stringify(cur[i].reactions ?? null));
        return changed ? cur.map((m, i) => ({ ...m, storedId: rows[i].id, reactions: rows[i].reactions })) : cur;
      });
    }
  }, []);

  const refreshNow = useCallback(async () => {
    const conv = ownConversation.current;
    if (!conv) return setServerNow(IDLE);
    const state = await get<Now>(`/api/conversations/${conv}/en-cours`).catch(() => null);
    if (!state || ownConversation.current !== conv) return;
    setServerNow(state);
    if (!running.current) await reload(conv).catch(() => {}); // un travail sans flux ici : ses messages arrivent par là
  }, [reload]);

  useEffect(() => {
    if (!active) return;
    setServerNow(IDLE);
    void refreshNow();
  }, [conversationId, refreshNow, active]);
  // Une relecture finit après le tour : le petit « retenu » arrive sans rafraîchir la page.
  useEffect(() => {
    if (isRunning || !active) return;
    const later = setTimeout(() => !document.hidden && void refreshNow(), 30000);
    return () => clearTimeout(later);
  }, [isRunning, refreshNow, active]);
  const watching = isRunning || serverNow.occupe || serverNow.file.length > 0 || sending.length > 0 || !!agentBusy;
  useEffect(() => {
    if (!watching) return;
    if (!running.current) void refreshNow(); // un travail lancé sans cet écran : son accord s'affiche sans rafraîchir la page
    // Écran caché : personne ne regarde, et le serveur le sait à ce silence (il notifie alors la fin de la tâche).
    return subscribeUpdates(() => { if (!document.hidden) return refreshNow(); });
  }, [watching, refreshNow]);

  const addBeforeRunning = useCallback((news: ChatMessage[]) => {
    setMessages((all) => {
      const i = all.findIndex((m) => m.running);
      return i < 0 ? [...all, ...news] : [...all.slice(0, i), ...news, ...all.slice(i)];
    });
  }, []);

  const deliver = useCallback(
    async (item: Outgoing) => {
      if (delivering.has(item.id)) return;
      delivering.add(item.id);
      setSending((s) => (s.some((x) => x.id === item.id) ? s : [...s, { id: item.id, text: item.text, late: false }]));
      let result: { type: string; reponse?: string } | null = null;
      let refused = "";
      for (let attempt = 0; !result && !refused && !givenUp.current.has(item.id); attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 3000));
        try {
          result = await send<{ type: string; reponse?: string }>("/api/chat/pendant", {
            agent_id: item.agent,
            conversation_id: item.conv,
            client_id: item.id,
            text: item.text,
            attachments: item.files,
          });
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) refused = e.message;
          else if (attempt + 1 >= LATE_AFTER) setSending((s) => s.map((x) => (x.id === item.id ? { ...x, late: true } : x)));
        }
      }
      delivering.delete(item.id);
      writeOutbox(readOutbox().filter((x) => x.id !== item.id));
      setSending((s) => s.filter((x) => x.id !== item.id));
      if (ownConversation.current === item.conv) {
        const user: ChatMessage = { id: uid("u"), role: "user", content: [{ type: "text", text: item.text }] };
        if (refused) {
          addBeforeRunning([
            user,
            { id: uid("r"), role: "assistant", content: [{ type: "tool-call", toolCallId: uid("e"), toolName: "error", args: { message: refused, detail: "" }, result: true }] },
          ]);
        } else if (result && result.type !== "tache") {
          const parts: Part[] = result.reponse ? [{ type: "text", text: result.reponse }] : [];
          if (result.type === "question") parts.push({ type: "tool-call", toolCallId: uid("s"), toolName: "send_aside", args: { id: item.id } });
          addBeforeRunning(parts.length ? [user, { id: uid("r"), role: "assistant", content: parts }] : [user]);
        }
      }
      void refreshNow();
    },
    [addBeforeRunning, refreshNow],
  );

  const sendWhileBusy = useCallback(
    async (text: string, clientId = uid("c"), files: string[] = []) => {
      const item: Outgoing = { id: clientId, text, agent: agentId, conv: ownConversation.current, files };
      writeOutbox([...readOutbox(), item]);
      await deliver(item);
    },
    [agentId, deliver],
  );

  // Ce qui n'avait pas eu de réponse avant un rechargement repart, sous le même identifiant.
  useEffect(() => {
    for (const item of readOutbox()) if (item.agent === agentId && item.conv === conversationId) void deliver(item);
  }, [agentId, conversationId, deliver]);

  const whileBusy = useMemo<WhileBusyApi>(
    () => ({
      active: isRunning || serverNow.occupe,
      activity: !isRunning && serverNow.occupe && !serverNow.accord ? serverNow.activite || "Travaille sur ta demande" : null,
      waiting: serverNow.file,
      sending,
      send: (text, files = []) =>
        void (async () => {
          const full = (takeQuotes.current?.() ?? "") + text;
          let paths: string[] = [];
          try {
            paths = await Promise.all(files.map((f) => uploadFile(agentId, f)));
          } catch (e) {
            addBeforeRunning([
              { id: uid("r"), role: "assistant", content: [{ type: "tool-call", toolCallId: uid("e"), toolName: "error", args: { message: `Les fichiers joints ne sont pas partis : ${(e as Error).message}`, detail: "" }, result: true }] },
            ]);
            return;
          }
          await sendWhileBusy(full, undefined, paths);
        })(),
      now: async (id) => {
        const { type } = await send<{ type: string }>(`/api/chat/file/${id}/maintenant`, {});
        void refreshNow();
        return type;
      },
      cancel: (id) => void request(`/api/chat/file/${id}`, { method: "DELETE" }).catch(() => {}).then(refreshNow),
      giveUp: (id) => {
        givenUp.current.add(id);
        writeOutbox(readOutbox().filter((x) => x.id !== id));
        setSending((s) => s.filter((x) => x.id !== id));
      },
    }),
    [agentId, isRunning, serverNow, sending, sendWhileBusy, refreshNow, addBeforeRunning],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const typed = message.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      const attachments = (message.attachments ?? []).map((a) => a.id).filter((id) => id.startsWith("/opt/data/"));
      if (!typed) return;
      const text = (takeQuotes.current?.() ?? "") + typed;
      const clientId = message.metadata?.custom?.clientId as string | undefined; // l'appel renvoie un tour sous le même identifiant
      if (running.current || serverBusy.current) return sendWhileBusy(text, clientId, attachments); // un message demandé par l'interface en plein travail
      const userMsg: ChatMessage = {
        id: uid("u"),
        role: "user",
        content: [{ type: "text", text }],
        attachments: attachments.map((p) => p.split("/").pop()!),
        createdAt: new Date(),
      };
      const reply: ChatMessage = { id: uid("r"), role: "assistant", content: [], running: true, createdAt: new Date() };
      setMessages((m) => [...m, userMsg, reply]);
      setRunning(true);
      const abort = new AbortController();
      runRef.current = { runId: null, abort };
      const update = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((all) => all.map((m) => (m.id === reply.id ? fn(m) : m)));
      // Les jetons arrivent plus vite que l'écran ne se redessine : on les applique une fois par image.
      let pending: ChatEvent[] = [];
      let frame = 0;
      const flush = () => {
        frame = 0;
        const evs = pending;
        pending = [];
        if (evs.length) update((m) => evs.reduce((acc, ev) => apply(acc, ev, runRef.current.runId), m));
      };
      const queue = (ev: ChatEvent) => {
        if (ev.type === "reaction") {
          setMessages((cur) => cur.map((m) => (m.id === userMsg.id ? { ...m, reactions: { ...m.reactions, agent: ev.emoji } } : m)));
          return;
        }
        if (ev.type === "activity") setLiveLabel(ev.label);
        if (ev.type === "done") setLiveLabel(null);
        pending.push(ev);
        if (ev.type === "done") {
          cancelAnimationFrame(frame);
          flush();
        } else if (!frame) frame = requestAnimationFrame(flush);
      };
      try {
        await streamChat(
          { agent_id: agentId, text, conversation_id: ownConversation.current, attachments, details, client_id: clientId },
          (ev) => {
            if (ev.type === "start") {
              runRef.current.runId = ev.run_id;
              if (ev.conversation_id !== ownConversation.current) {
                ownConversation.current = ev.conversation_id;
                onConversationCreated(ev.conversation_id);
              }
              return;
            }
            if (ev.type === "deja") throw new StreamLost(); // retransmission d'un tour déjà reçu : sa réponse se recharge, comme après une coupure
            queue(ev);
          },
          abort.signal,
        );
      } catch (err) {
        if (!abort.signal.aborted) {
          // Réseau coupé (serveur redémarré, téléphone hors ligne) : l'agent continue côté serveur, on le dit, puis
          // on recharge la conversation dès que le serveur répond de nouveau.
          const lost = err instanceof TypeError || err instanceof StreamLost;
          const error = lost ? "Connexion au serveur perdue. La réponse s'affichera dès son retour." : (err as Error).message;
          update((m) => apply(m, { type: "done", status: "failed", error }, null));
          const conv = ownConversation.current;
          if (lost && conv) void resync(conv, abort.signal);
        }
      } finally {
        cancelAnimationFrame(frame);
        flush();
        update((m) => ({ ...m, content: settle(m.content), running: false }));
        setRunning(false);
        runRef.current = { runId: null, abort: null };
        onRunFinished();
        void refreshNow(); // ce qui attendait part maintenant
      }
    },
    [agentId, details, onConversationCreated, onRunFinished, resync, sendWhileBusy, refreshNow],
  );

  const onCancel = useCallback(async () => {
    const runId = runRef.current.runId ?? serverRun.current;
    if (runId) await send(`/api/agents/${agentId}/runs/${runId}/stop`, {}).catch(() => {});
  }, [agentId]);

  // Les approbations renvoient leur réponse ici, une fois transmise à l'agent.
  const onAddToolResult = useCallback((o: { messageId: string; toolCallId: string; result: unknown }) => {
    if (o.messageId.startsWith("connexion-")) {
      setLogin((cur) => (cur ? { ...cur, result: o.result } : cur));
      return;
    }
    if (o.messageId.startsWith("accord-")) {
      void refreshAccords();
      return;
    }
    setMessages((all) =>
      all.map((m) =>
        m.id !== o.messageId
          ? m
          : { ...m, content: m.content.map((p) => (p.type === "tool-call" && p.toolCallId === o.toolCallId ? { ...p, result: o.result } : p)) },
      ),
    );
  }, []);

  // Pièce jointe : envoyée à la machine de l'agent au moment de l'envoi du message ; son id devient son chemin.
  const attachments = useMemo<AttachmentAdapter>(
    () => ({
      accept: "*",
      async add({ file }) {
        return {
          id: uid("f"),
          type: file.type.startsWith("image/") ? "image" : "file",
          name: file.name,
          contentType: file.type,
          file,
          status: { type: "requires-action", reason: "composer-send" },
        };
      },
      async remove() {},
      async send(attachment, options) {
        const path = await uploadFile(agentId, attachment.file, options?.signal);
        return { ...attachment, id: path, status: { type: "complete" }, content: [] };
      },
    }),
    [agentId],
  );

  // Un accord demandé par un travail que cet écran ne suit pas : il s'affiche quand même, et se donne de la même façon.
  // Encore à répondre dans le fil (flux perdu, historique en retard) : pas de seconde carte pour ce même accord. Une carte déjà
  // répondue ne masque jamais une nouvelle demande : la personne resterait sans bouton.
  useEffect(() => {
    if (!active) return;
    const resyncAll = (event: Event) => {
      const tasks = (event as CustomEvent<Promise<unknown>[]>).detail;
      const conv = ownConversation.current;
      tasks.push(refreshNow());
      if (!conv) return;
      const asked = anchorOf(conv);
      tasks.push(readMessages(windowUrl(conv)).then((rows) => {
        if (!current(conv, asked, rows)) return;
        // Réponse en cours d'écriture : elle n'est pas encore enregistrée, la relecture l'effacerait. Elle se relit à la fin du tour.
        if (ownConversation.current === conv && !running.current) setMessages(rows.map(fromStored));
      }));
    };
    window.addEventListener("noah:resync", resyncAll);
    return () => window.removeEventListener("noah:resync", resyncAll);
  }, [refreshNow, active]);
  const askedLogin = serverNow.connexion ?? null;
  const askedLoginId = askedLogin?.id;
  useEffect(() => {
    setLogin((cur) => (askedLogin ? (cur?.id === askedLogin.id ? cur : askedLogin) : cur?.result ? cur : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- la même demande revient à chaque relevé : seul son identifiant compte
  }, [askedLoginId]);
  // Répondue : la ligne reste lisible jusqu'au message suivant.
  useEffect(() => setLogin((cur) => (cur?.result ? null : cur)), [messages.length]);
  useEffect(() => {
    const answered = (e: Event) => {
      const { id, result } = (e as CustomEvent<{ id: string; result: string }>).detail;
      setLogin((cur) => (cur?.id === id ? { ...cur, result } : cur));
    };
    window.addEventListener("noah:connexion-repondue", answered);
    return () => window.removeEventListener("noah:connexion-repondue", answered);
  }, []);
  const shown = useMemo<ChatMessage[]>(() => {
    const base = visibleMessages(messages);
    const storedClosed = new Set(messages.map((m) => m.id));
    for (const closed of closedAccords.filter((a) => a.conv_id === conversationId)) {
      const label = accordLabel(closed);
      if (label && !storedClosed.has("clos-" + closed.id)) base.push({ id: "clos-" + closed.id, role: "assistant", content: [{ type: "text", text: label }] });
    }
    for (const pending of pendingAccords.filter((a) => a.conv_id === conversationId)) {
      base.push({ id: "accord-" + pending.id, role: "assistant", content: [{ type: "tool-call", toolCallId: "a-" + pending.id, toolName: "approval", args: { ...pending } }] });
    }
    if (!login) return base;
    const { result, ...asked } = login;
    return [...base, { id: `connexion-${login.id}`, role: "assistant", content: [{ type: "tool-call", toolCallId: `c-${login.id}`, toolName: "connexion", args: asked, ...(result ? { result } : {}) }] }];
  }, [messages, pendingAccords, closedAccords, conversationId, login]);

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: shown,
    isRunning: isRunning || serverNow.occupe,
    onNew,
    onCancel,
    onAddToolResult,
    convertMessage,
    adapters: { attachments },
  });

  const history = useMemo(
    () => ({
      hasOlder: more,
      loading: loadingOlder,
      loadOlder: async () => {
        const conv = ownConversation.current;
        const open = conv ? windows.get(conv) : undefined;
        if (!conv || !open) return;
        setLoadingOlder(true);
        try {
          const rows = await get<StoredMessage[]>(`/api/conversations/${conv}/messages?avant=${open.from}&limit=${PAGE}`);
          if (ownConversation.current !== conv) return;
          const next = { from: rows[0]?.id ?? open.from, more: rows.length >= PAGE };
          windows.set(conv, next);
          setMore(next.more);
          setMessages((cur) => [...rows.map(fromStored), ...cur]);
        } finally {
          setLoadingOlder(false);
        }
      },
      react: (id: string, stored: number, emoji: string | null) => {
        const conv = ownConversation.current;
        if (!conv) return;
        setMessages((cur) => cur.map((m) => (m.id === id ? { ...m, reactions: { ...m.reactions, user: emoji ?? undefined } } : m)));
        void send<{ question?: boolean }>(`/api/conversations/${conv}/messages/${stored}/reaction`, { emoji }, "PUT")
          .then((r) => (r?.question ? refreshNow() : undefined)) // 👎 : sa question arrive tout de suite dans le fil
          .catch(() => {});
      },
    }),
    [more, loadingOlder, refreshNow],
  );

  // En deux mots, ce que fait l'agent : affiché près de son nom, sur le web, le bureau et le téléphone.
  const status = serverNow.accord ? null : isRunning ? liveLabel : serverNow.occupe ? serverNow.activite : null;

  return { runtime, whileBusy, history, status };
}
