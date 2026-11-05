// État d'une conversation et branchement sur assistant-ui (ExternalStoreRuntime).
// Le serveur envoie ses propres événements SSE ; on les traduit ici en messages et en « parts ».
import {
  type AppendMessage,
  type AttachmentAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChatEvent, get, send, type StoredMessage, request, StreamLost, streamChat, uploadFile } from "./api";

type TextPart = { type: "text"; text: string };
type ToolPart = { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown };
type Part = TextPart | ToolPart;
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: Part[];
  attachments?: string[];
  running?: boolean;
};

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const ATTACHED_RE = /\n\nFichiers joints par l'utilisateur :\n((?:- .+\n?)+)$/;

function fromStored(m: StoredMessage, i: number): ChatMessage {
  if (m.role === "user") {
    const match = m.text.match(ATTACHED_RE);
    const files = match ? match[1].trim().split("\n").map((l) => l.replace(/^- /, "").split("/").pop()!) : [];
    return { id: `h${i}`, role: "user", content: [{ type: "text", text: match ? m.text.slice(0, match.index) : m.text }], attachments: files };
  }
  if (m.role === "error") {
    return { id: `h${i}`, role: "assistant", content: [{ type: "tool-call", toolCallId: `e${i}`, toolName: "error", args: { message: m.text, detail: m.detail ?? "" }, result: true }] };
  }
  return { id: `h${i}`, role: "assistant", content: [{ type: "text", text: m.text }] };
}

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
            args: { summary: ev.summary, request_id: ev.request_id, generation: ev.generation, run_id: runId ?? "" },
          },
        ],
      };
    case "done": {
      let next = settle(parts);
      if (!next.some((p) => p.type === "text") && ev.output) next = [...next, { type: "text", text: ev.output }];
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

export type WhileBusyApi = {
  active: boolean;
  /** Travail lancé sans ce flux (une demande qui attendait, un autre écran) : sa ligne s'affiche près de la saisie. */
  activity: string | null;
  waiting: { id: string; text: string }[];
  sending: string[];
  send: (text: string) => void;
  now: (id: string) => void;
  cancel: (id: string) => void;
};
type Now = { occupe: boolean; activite: string | null; run_id: string | null; file: { id: string; text: string }[] };
const IDLE: Now = { occupe: false, activite: null, run_id: null, file: [] };

// Fonction stable : si elle changeait à chaque rendu, assistant-ui viderait son cache et reconvertirait tout le fil
// à chaque image du flux, au lieu du seul message qui change.
const convertMessage = (m: ChatMessage): ThreadMessageLike => ({
  id: m.id,
  role: m.role,
  content: m.content as ThreadMessageLike["content"],
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
  /** Citations à mettre devant le message (vidées à l'envoi). */
  takeQuotes?: () => string;
}) {
  const { agentId, conversationId, details, onConversationCreated, onRunFinished, updatedAt } = opts;
  const takeQuotes = useRef(opts.takeQuotes);
  takeQuotes.current = opts.takeQuotes;
  // Conversation déjà ouverte : ses messages s'affichent tout de suite, la version du serveur arrive derrière.
  const [messages, setMessages] = useState<ChatMessage[]>(() => (conversationId && messagesCache.get(conversationId)) || []);
  const [isRunning, setRunning] = useState(false);
  const runRef = useRef<{ runId: string | null; abort: AbortController | null }>({ runId: null, abort: null });
  // Conversation créée pendant ce run : on ne recharge pas l'historique par-dessus le flux en cours.
  const ownConversation = useRef<string | null>(null);

  useEffect(() => {
    if (conversationId && conversationId === ownConversation.current) return;
    ownConversation.current = conversationId;
    runRef.current.abort?.abort();
    setRunning(false);
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setMessages(messagesCache.get(conversationId) ?? []);
    let cancelled = false;
    get<StoredMessage[]>(`/api/conversations/${conversationId}/messages`)
      .then((rows) => !cancelled && setMessages(rows.map(fromStored)))
      .catch(() => !cancelled && setMessages((cur) => (cur.length ? cur : [])));
    return () => {
      cancelled = true;
    };
  }, [conversationId, agentId]);

  const running = useRef(false);
  running.current = isRunning;
  useEffect(() => {
    if (conversationId && !isRunning) messagesCache.set(conversationId, messages);
  }, [conversationId, isRunning, messages]);
  useEffect(() => {
    if (!conversationId || !updatedAt || running.current) return;
    let cancelled = false;
    get<StoredMessage[]>(`/api/conversations/${conversationId}/messages`)
      .then((rows) => {
        // Seulement s'il y a du nouveau, pour ne pas redessiner la conversation pour rien.
        if (!cancelled && !running.current) setMessages((cur) => (rows.length > cur.length ? rows.map(fromStored) : cur));
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
        const rows = (await (
          await request(`/api/conversations/${conv}/messages`, { signal: AbortSignal.timeout(8000) })
        ).json()) as StoredMessage[];
        if (ownConversation.current === conv && !running.current) setMessages(rows.map(fromStored));
        // Réponse encore en cours côté serveur : on recharge encore jusqu'à la voir arrivée.
        if (rows[rows.length - 1]?.role !== "user") return;
      } catch {
        /* serveur toujours absent */
      }
    }
  }, []);

  // --- Pendant le travail : la saisie reste ouverte, et ce qui attend se voit. ---
  const [serverNow, setServerNow] = useState<Now>(IDLE);
  const [sending, setSending] = useState<string[]>([]);
  const serverBusy = useRef(false);
  serverBusy.current = serverNow.occupe;
  const serverRun = useRef<string | null>(null);
  serverRun.current = serverNow.run_id;

  const reload = useCallback(async (conv: string) => {
    const rows = await get<StoredMessage[]>(`/api/conversations/${conv}/messages`);
    if (ownConversation.current === conv && !running.current) setMessages((cur) => (rows.length !== cur.length ? rows.map(fromStored) : cur));
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
    setServerNow(IDLE);
    void refreshNow();
  }, [conversationId, refreshNow]);
  const watching = isRunning || serverNow.occupe || serverNow.file.length > 0 || sending.length > 0;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void refreshNow(), 3000);
    return () => clearInterval(timer);
  }, [watching, refreshNow]);

  const addBeforeRunning = useCallback((news: ChatMessage[]) => {
    setMessages((all) => {
      const i = all.findIndex((m) => m.running);
      return i < 0 ? [...all, ...news] : [...all.slice(0, i), ...news, ...all.slice(i)];
    });
  }, []);

  const sendWhileBusy = useCallback(
    async (text: string) => {
      const clientId = uid("c");
      setSending((s) => [...s, text]);
      let result: { type: string; reponse?: string } | null = null;
      // Même identifiant à chaque essai : le serveur n'en fera qu'une demande.
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1500));
        result = await send<{ type: string; reponse?: string }>("/api/chat/pendant", {
          agent_id: agentId,
          conversation_id: ownConversation.current,
          client_id: clientId,
          text,
        }).catch(() => null);
      }
      setSending((s) => s.filter((t) => t !== text));
      const user: ChatMessage = { id: uid("u"), role: "user", content: [{ type: "text", text }] };
      if (!result) {
        addBeforeRunning([
          user,
          { id: uid("r"), role: "assistant", content: [{ type: "tool-call", toolCallId: uid("e"), toolName: "error", args: { message: "Ce message n'est pas parti : le serveur ne répond pas. Renvoie-le dans un instant.", detail: "" }, result: true }] },
        ]);
      } else if (result.type !== "tache") {
        const parts: Part[] = result.reponse ? [{ type: "text", text: result.reponse }] : [];
        if (result.type === "question") parts.push({ type: "tool-call", toolCallId: uid("s"), toolName: "send_aside", args: { id: clientId } });
        addBeforeRunning(parts.length ? [user, { id: uid("r"), role: "assistant", content: parts }] : [user]);
      }
      void refreshNow();
    },
    [agentId, addBeforeRunning, refreshNow],
  );

  const whileBusy = useMemo<WhileBusyApi>(
    () => ({
      active: isRunning || serverNow.occupe,
      activity: !isRunning && serverNow.occupe ? serverNow.activite || "Travaille sur ta demande" : null,
      waiting: serverNow.file,
      sending,
      send: (text) => void sendWhileBusy(text),
      now: (id) => void send(`/api/chat/file/${id}/maintenant`, {}).catch(() => {}).then(refreshNow),
      cancel: (id) => void request(`/api/chat/file/${id}`, { method: "DELETE" }).catch(() => {}).then(refreshNow),
    }),
    [isRunning, serverNow, sending, sendWhileBusy, refreshNow],
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
      if (running.current || serverBusy.current) return sendWhileBusy(text); // un message demandé par l'interface en plein travail
      const userMsg: ChatMessage = {
        id: uid("u"),
        role: "user",
        content: [{ type: "text", text }],
        attachments: attachments.map((p) => p.split("/").pop()!),
      };
      const reply: ChatMessage = { id: uid("r"), role: "assistant", content: [], running: true };
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
        pending.push(ev);
        if (ev.type === "done") {
          cancelAnimationFrame(frame);
          flush();
        } else if (!frame) frame = requestAnimationFrame(flush);
      };
      try {
        await streamChat(
          { agent_id: agentId, text, conversation_id: ownConversation.current, attachments, details },
          (ev) => {
            if (ev.type === "start") {
              runRef.current.runId = ev.run_id;
              if (ev.conversation_id !== ownConversation.current) {
                ownConversation.current = ev.conversation_id;
                onConversationCreated(ev.conversation_id);
              }
              return;
            }
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

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning: isRunning || serverNow.occupe,
    onNew,
    onCancel,
    onAddToolResult,
    convertMessage,
    adapters: { attachments },
  });

  return { runtime, whileBusy };
}
