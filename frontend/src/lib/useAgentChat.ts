// État d'une conversation et branchement sur assistant-ui (ExternalStoreRuntime).
// Le serveur envoie ses propres événements SSE ; on les traduit ici en messages et en « parts ».
import {
  type AppendMessage,
  type AttachmentAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ChatEvent, get, send, type StoredMessage, request, StreamLost, streamChat, uploadFile } from "./api";

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
            args: { summary: ev.summary, demande: ev.demande, apercu: ev.apercu, request_id: ev.request_id, generation: ev.generation, run_id: runId ?? "" },
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
  sending: { id: string; text: string; late: boolean }[];
  send: (text: string, files?: File[]) => void;
  /** Rend ce que le serveur a fait : « precision », « tache », « deja » ou « incertain ». */
  now: (id: string) => Promise<string>;
  cancel: (id: string) => void;
  giveUp: (id: string) => void;
};
type Approval = { summary: string; demande?: string; apercu?: string[]; request_id: string; generation: number; run_id: string };
type Now = { occupe: boolean; activite: string | null; run_id: string | null; file: { id: string; text: string }[]; accord: Approval | null };
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
  const { agentId, conversationId, details, onConversationCreated, onRunFinished, updatedAt, agentBusy } = opts;
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
  const [sending, setSending] = useState<WhileBusyApi["sending"]>([]);
  const givenUp = useRef(new Set<string>());
  const serverBusy = useRef(false);
  serverBusy.current = serverNow.occupe || serverNow.file.length > 0; // une file non vide : le nouveau message passe derrière
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
  const watching = isRunning || serverNow.occupe || serverNow.file.length > 0 || sending.length > 0 || !!agentBusy;
  useEffect(() => {
    if (!watching) return;
    if (!running.current) void refreshNow(); // un travail lancé sans cet écran : son accord s'affiche sans rafraîchir la page
    // Écran caché : personne ne regarde, et le serveur le sait à ce silence (il notifie alors la fin de la tâche).
    const timer = setInterval(() => !document.hidden && void refreshNow(), 3000);
    return () => clearInterval(timer);
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
      activity: !isRunning && serverNow.occupe ? serverNow.activite || "Travaille sur ta demande" : null,
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
    if (o.messageId.startsWith("accord-")) return setServerNow((s) => ({ ...s, accord: null }));
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
  // Déjà dans le fil (flux perdu, historique en retard) : pas de seconde carte pour le même accord.
  const asked = serverNow.accord;
  const pendingApproval =
    !isRunning && asked && !messages.some((m) => m.content.some((p) => p.type === "tool-call" && p.toolName === "approval" && (p.args as { request_id?: string }).request_id === asked.request_id))
      ? asked
      : null;
  const shown = useMemo<ChatMessage[]>(
    () =>
      pendingApproval
        ? [
            ...messages,
            {
              id: `accord-${pendingApproval.request_id}`,
              role: "assistant",
              content: [{ type: "tool-call", toolCallId: `a-${pendingApproval.request_id}`, toolName: "approval", args: { ...pendingApproval } }],
            },
          ]
        : messages,
    [messages, pendingApproval],
  );

  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: shown,
    isRunning: isRunning || serverNow.occupe,
    onNew,
    onCancel,
    onAddToolResult,
    convertMessage,
    adapters: { attachments },
  });

  return { runtime, whileBusy };
}
