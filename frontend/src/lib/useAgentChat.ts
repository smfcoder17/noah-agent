// État d'une conversation et branchement sur assistant-ui (ExternalStoreRuntime).
// Le serveur envoie ses propres événements SSE ; on les traduit ici en messages et en « parts ».
import {
  type AppendMessage,
  type AttachmentAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChatEvent, get, send, type StoredMessage, streamChat, uploadFile } from "./api";

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
    return { id: `h${i}`, role: "assistant", content: [{ type: "tool-call", toolCallId: `e${i}`, toolName: "error", args: { message: m.text }, result: true }] };
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
        next = [...next, { type: "tool-call", toolCallId: uid("e"), toolName: "error", args: { message: ev.error }, result: true }];
      }
      return { ...msg, content: next, running: false };
    }
    default:
      return msg;
  }
}

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
    let cancelled = false;
    get<StoredMessage[]>(`/api/conversations/${conversationId}/messages`)
      .then((rows) => !cancelled && setMessages(rows.map(fromStored)))
      .catch(() => !cancelled && setMessages([]));
    return () => {
      cancelled = true;
    };
  }, [conversationId, agentId]);

  const running = useRef(false);
  running.current = isRunning;
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
            update((m) => apply(m, ev, runRef.current.runId));
          },
          abort.signal,
        );
      } catch (err) {
        if (!abort.signal.aborted) {
          update((m) => apply(m, { type: "done", status: "failed", error: (err as Error).message }, null));
        }
      } finally {
        update((m) => ({ ...m, content: settle(m.content), running: false }));
        setRunning(false);
        runRef.current = { runId: null, abort: null };
        onRunFinished();
      }
    },
    [agentId, details, onConversationCreated, onRunFinished],
  );

  const onCancel = useCallback(async () => {
    const { runId } = runRef.current;
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
    isRunning,
    onNew,
    onCancel,
    onAddToolResult,
    convertMessage: (m): ThreadMessageLike => ({
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
    }),
    adapters: { attachments },
  });

  return runtime;
}
