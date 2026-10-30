// Client de l'API Noah Agent (même origine, session par cookie).

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const detail = (await res.json()).detail;
      message = Array.isArray(detail) ? "Vérifie les champs du formulaire." : detail || message;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

export const get = async <T,>(path: string): Promise<T> => (await request(path)).json();
export const send = async <T,>(path: string, body: unknown, method = "POST"): Promise<T> =>
  (await request(path, { method, body: JSON.stringify(body) })).json();
export const del = async (path: string) => request(path, { method: "DELETE" });

// --- Types renvoyés par le serveur ----------------------------------------------------

export type Status = { has_account: boolean; model_configured: boolean };
export type Provider = { id: string; label: string; needs_key: boolean; default_model: string };
export type Model = {
  id: string;
  name: string;
  lab: string;
  created: number;
  context: number;
  price_in: number | null;
  price_out: number | null;
  vision: boolean;
  free: boolean;
  size?: string;
};
export type ModelGroup = { id: string; title: string; hint: string; models: Model[] };
export type Catalog = { needs_key: boolean; groups: ModelGroup[]; models: Model[] };
export type CurrentModel = { provider: string; model: string; has_key: boolean } | null;
export type TaskState = "work" | "approve" | "choice" | "done" | "error" | "idle";
export type Agent = {
  id: string;
  name: string;
  role: string;
  online: boolean;
  step: string | null;
  tasks: Partial<Record<"work" | "approve" | "choice", number>>;
  /** État de la conversation principale. */
  state: TaskState;
  color: string;
  pinned: boolean;
  /** Cerveau propre à cet agent ; absent : celui de tous. */
  model?: string | null;
};
/** main : la conversation unique avec l'agent ; les autres sont des fils (origin "agent" s'il les a ouverts). */
export type Conversation = {
  id: string;
  title: string;
  updated_at: string;
  state: TaskState;
  main: boolean;
  archived: boolean;
  origin: "user" | "agent";
};
export type StoredMessage = { role: "user" | "agent" | "error"; text: string; created_at: string };
export type AgentUsage = {
  agent_id: string;
  name: string;
  cost: number;
  tokens: number;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
};
export type Usage = { month_cost: number; budget: number | null; agents: AgentUsage[] };
export type WorkspaceFile = { path: string; size: number; modified: number };

// Événements du chat, déjà traduits par le serveur.
export type ChatEvent =
  | { type: "start"; conversation_id: string; run_id: string }
  | { type: "message"; text: string }
  | { type: "activity"; label: string; detail?: unknown }
  | { type: "activity_detail"; detail: unknown }
  | { type: "raw"; kind: string; data: unknown }
  | { type: "approval"; request_id: string; generation: number; summary: string }
  | { type: "done"; status: string; output?: string; error?: string };

/** Envoie un message et appelle `onEvent` pour chaque événement du flux SSE. */
export async function streamChat(
  body: { agent_id: string; text: string; conversation_id: string | null; attachments: string[]; details: boolean },
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
) {
  const res = await request("/api/chat", { method: "POST", body: JSON.stringify(body), signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (chunk.startsWith("data:")) onEvent(JSON.parse(chunk.slice(5)));
    }
  }
}

export async function uploadFile(agentId: string, file: File, signal?: AbortSignal): Promise<string> {
  const res = await request(`/api/agents/${agentId}/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": "application/octet-stream" },
    signal,
  });
  return (await res.json()).path;
}

export const mediaUrl = (agentId: string, path: string) =>
  `/api/agents/${agentId}/media?path=${encodeURIComponent(path)}`;

/** Fichier de l'espace de travail ; accepte un chemin relatif ou complet (/opt/data/workspace/...). */
export const rawFileUrl = (agentId: string, path: string) =>
  `/api/agents/${agentId}/files/raw/${path.replace(/^\/opt\/data\/workspace\//, "").split("/").map(encodeURIComponent).join("/")}`;
