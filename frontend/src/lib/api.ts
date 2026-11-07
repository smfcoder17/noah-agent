import { forgetSeen } from "./seen";
// Client de l'API Noah Agent (même origine, session par cookie).

export class ApiError extends Error {
  status: number;
  /** 428 : un code vient de partir par courriel, il faut le saisir. */
  courriel: boolean;
  constructor(message: string, status: number, courriel = false) {
    super(message);
    this.status = status;
    this.courriel = courriel;
  }
}

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "";

// Avance à chaque connexion réussie, dans n'importe quel onglet (localStorage partagé) : un 401 d'une requête partie
// avant (ancienne session) est reconnu comme tel, même si la nouvelle connexion a eu lieu dans un autre onglet.
let authEpoch = 0; // repli si localStorage est indisponible
export const currentAuthEpoch = () => {
  try {
    return `${localStorage.getItem("noah-auth-epoch") || "0"}.${authEpoch}`;
  } catch {
    return `0.${authEpoch}`;
  }
};
function bumpAuthEpoch() {
  authEpoch++;
  try {
    localStorage.setItem("noah-auth-epoch", String(Number(localStorage.getItem("noah-auth-epoch") || 0) + 1));
  } catch {
    /* indisponible : seul cet onglet le sait */
  }
}

// Version de l'app (bureau, téléphone) qui affiche cette interface : annoncée à chaque appel, pour que le serveur
// réponde 426 à une app devenue trop ancienne pendant qu'elle est ouverte (G5.6). Vide dans un navigateur.
let clientVersion = "";
export const setClientVersion = (v: string) => {
  clientVersion = v;
};

// App Android : la fenêtre n'a qu'une session courte, rouverte avec le jeton d'appareil que l'app garde chiffré. Un 401 n'y
// veut donc rien dire tant que l'app n'a pas essayé : rien de plus qu'une session expirée pendant l'absence, le plus souvent.
// Une demande à la fois : toutes les requêtes refusées en même temps attendent la même réponse.
let renewing: Promise<string> | null = null;
function renewWindow(): Promise<string> | null {
  const app = window.Capacitor?.Plugins?.NoahShell;
  if (!app?.renewSession) return null;
  renewing ??= app.renewSession()
    .then((r) => (r as { etat: string }).etat)
    .catch(() => "injoignable")
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  if (/^\/api\/(logout|login|setup)/.test(path)) forgetSeen(); // un autre compte ne voit pas, même un instant, l'écran du précédent
  const call = () => fetch(path, {
    ...init,
    credentials: "same-origin",
    // Fuseau de l'utilisateur : le serveur (souvent un VPS en UTC) installe les mises à jour pendant sa nuit à lui.
    headers: {
      "Content-Type": "application/json",
      "X-Noah-Timezone": ZONE,
      ...(clientVersion ? { "X-Noah-Version": clientVersion } : {}),
      ...(init.headers || {}),
    },
  });
  let res = await call();
  const guarded = !/^\/api\/(login|setup|pairing|status)/.test(path);
  if (res.status === 401 && guarded) {
    const state = await renewWindow();
    if (state === "ok") res = await call();
    // Serveur injoignable pendant l'échange : l'appareil n'est peut-être pas refusé, surtout ne pas le déconnecter.
    else if (state && state !== "refuse") throw new ApiError("Le serveur ne répond pas.", 503);
  }
  if (res.status === 426) window.dispatchEvent(new Event("noah:outdated"));
  // 200 seulement : un sondage en attente (202) n'a créé aucune session.
  if (res.status === 200 && /^\/api\/(login|setup\/account|pairing\/flow\/poll)/.test(path)) bumpAuthEpoch();
  // Session révoquée ou expirée pendant l'usage : l'interface revient à l'écran de connexion (ou de reliaison).
  if (res.status === 401 && guarded) window.dispatchEvent(new Event("noah:unauthorized"));
  // Mot de passe temporaire : rien d'autre ne répond tant qu'il n'est pas remplacé.
  if (res.status === 403 && res.headers.get("x-noah-mot-de-passe")) window.dispatchEvent(new Event("noah:mot-de-passe"));
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    let courriel = false;
    try {
      const body = await res.json();
      const detail = body.detail;
      courriel = body.courriel_requis === true;
      if (Array.isArray(detail)) {
        const field = detail[0]?.loc?.[detail[0].loc.length - 1];
        message = typeof field === "string" ? `Vérifie le champ « ${field} ».` : "Vérifie les champs du formulaire.";
      } else message = detail || message;
    } catch {
      /* corps non JSON */
    }
    throw new ApiError(message, res.status, courriel);
  }
  return res;
}

export const get = async <T,>(path: string): Promise<T> => (await request(path)).json();
export const send = async <T,>(path: string, body: unknown, method = "POST"): Promise<T> =>
  (await request(path, { method, body: JSON.stringify(body) })).json();
export const del = async (path: string) => request(path, { method: "DELETE" });

// --- Types renvoyés par le serveur ----------------------------------------------------

export type Status = {
  has_account: boolean;
  model_configured: boolean;
  setup_code?: boolean;
  onboarded?: boolean;
  api?: number;
  /** Plus ancienne version des apps (bureau, téléphone) que ce serveur sert encore. */
  min_client_version?: string;
};
export type Provider = { id: string; label: string; needs_key: boolean; default_model: string; own_url?: boolean };
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
export type CurrentModel = { provider: string; model: string; has_key: boolean; base_url?: string | null } | null;
export type TaskState = "work" | "approve" | "choice" | "done" | "error" | "idle";
/** Compte connecté : le rôle cache ce qui n'est pas permis, le serveur reste la seule protection. */
export type Me = { id: number; username: string; role: "owner" | "member"; mot_de_passe_a_changer?: boolean };
export type AgentRight = "lecture" | "usage" | "admin" | "proprietaire";
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
  /** Forme du visage et détail distinctif ; vides : le visage d'origine. */
  shape?: string;
  detail?: string;
  pinned: boolean;
  /** Cerveau propre à cet agent ; absent : celui de tous. */
  model?: string | null;
  /** Mode propre à cet agent (fast, gratuit…) ; vide : le réglage de tous. */
  mode?: string | null;
  raisonnement?: string | null;
  /** Ce que ce compte a le droit d'en faire. */
  droit: AgentRight;
  /** Partagé avec d'autres, ou par quelqu'un d'autre. */
  partage: boolean;
  partage_par?: string | null;
};
export const canAdmin = (a: Agent) => a.droit === "admin" || a.droit === "proprietaire";
export const canTalk = (a: Agent) => a.droit !== "lecture";
/** main : la conversation unique avec l'agent ; les autres sont des fils (origin "agent" s'il les a ouverts). */
/** Rappel vocal d'un agent : il sonne, puis il est pris, refusé ou manqué. */
export type VoiceCall = {
  id: string;
  agent_id: string;
  agent: string;
  conversation_id: string;
  texte: string;
  etat: "sonne" | "repondu" | "refuse" | "manque";
  expire_a: number;
  /** Le visage de l'agent, tel qu'il est au moment de l'appel. */
  couleur?: string;
  forme?: string;
  detail?: string;
};
export type Conversation = {
  id: string;
  title: string;
  updated_at: string;
  state: TaskState;
  /** Travaille vraiment, ou attend la personne. Décidé par le serveur : une demande finie sur un choix n'attend plus rien. */
  en_cours: boolean;
  main: boolean;
  archived: boolean;
  origin: "user" | "agent";
  /** L'auteur l'a rendue lisible par ceux qui ont accès à l'agent. */
  partagee: boolean;
  /** Auteur, si ce n'est pas ce compte : elle se lit, elle ne s'écrit pas. */
  de: string | null;
};
export type Reactions = { user?: string; agent?: string };
/** `trace` : une ligne pour la personne dans la conversation principale, qui ouvre un fil. Son détail : voir TraceDetail. */
export type StoredMessage = { reactions?: Reactions; id?: number; role: "user" | "agent" | "error" | "trace"; text: string; detail?: string | null; created_at: string };
export type TraceDetail = { fil: string; entete: string; consigne: string; etat: "en_cours" | "fini" | "echec"; issue: string };
export type AgentUsage = {
  agent_id: string;
  name: string;
  cost: number;
  tokens: number;
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
};
/** L'agent a besoin d'une connexion : ce que la carte montre vient de la vraie page, jamais d'un texte de l'agent. */
export type LoginAsked = { id: string; type: "connexion" | "code"; site: string; origine: string; chiffre: boolean; identifiant_requis: boolean };
export type InboxItem = { agent_id: string; agent: string; conversation_id: string; titre: string; main: boolean; a_moi: boolean; etat: "approve" | "choice"; demande: string; pourquoi?: string; apercu: string[]; request_id?: string; generation?: number; run_id?: string; connexion?: LoginAsked | null };
export type Usage = {
  month_cost: number;
  budget: number | null;
  non_suivi?: boolean; // des appels sans prix connu ce mois-ci : le plafond ne les compte pas
  agents: AgentUsage[];
  daily?: number | null; // plafond par agent et par jour
  today?: Record<string, { depense: number; plafond: number | null }>;
  days?: { agent_id: string; day: string; cost: number; tokens: number; calls: number }[]; // 14 derniers jours
  tasks?: TaskUsage[]; // ce mois-ci, la plus coûteuse d'abord
  profil?: { depense: number; plafond: number | null }; // ce que paie ce compte et son plafond du mois
};
/** Dépense d'une tâche (conversation) ; conversation_id null = travail de fond (tâches planifiées, surveillance). */
export type TaskUsage = {
  agent_id: string;
  conversation_id: string | null;
  title: string;
  main: boolean;
  cost: number;
  tokens: number;
  calls: number;
};
export type WorkspaceFile = { path: string; size: number; modified: number };

// Événements du chat, déjà traduits par le serveur.
export type ChatEvent =
  | { type: "start"; conversation_id: string; run_id: string }
  | { type: "deja" }
  | { type: "message"; text: string }
  | { type: "etape" }
  | { type: "reaction"; emoji: string }
  | { type: "activity"; label: string; detail?: unknown }
  | { type: "activity_detail"; detail: unknown }
  | { type: "raw"; kind: string; data: unknown }
  | { type: "approval"; request_id: string; generation: number; summary: string; demande?: string; apercu?: string[] }
  | { type: "done"; status: string; output?: string; error?: string; details?: string; reponse?: string; etapes?: string[]; recu?: Recu | null };

/** Ce que l'agent a écrit, comparé à ce que ses outils ont fait (server/noah/recu.py). */
export type Recu = {
  prouve?: { dit: string; par: string }[];
  sans_trace?: string[];
  echec?: { dit: string; par: string }[];
  incertain?: { dit: string; par: string }[];
  non_dit?: string[];
  fait?: string[];
};

export type VoiceReady = { dictation: string | null; call: string | null };

/** Pourquoi la voix ne peut pas marcher, à dire avant d'ouvrir le micro. Serveur injoignable : le micro s'ouvre, le son attendra. */
export const voiceRefusal = (kind: keyof VoiceReady): Promise<string | null> =>
  get<VoiceReady>("/api/voice/ready").then((r) => r[kind], () => null);

/** Envoie un message et appelle `onEvent` pour chaque événement du flux SSE. */
export async function streamChat(
  body: { agent_id: string; text: string; conversation_id: string | null; attachments: string[]; details: boolean; client_id?: string },
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
) {
  // Réponse du serveur attendue 30 s au plus : une connexion muette avant même les en-têtes est aussi une coupure.
  const headers = new AbortController();
  const late = setTimeout(() => headers.abort(), HEADERS_MS);
  const stop = () => headers.abort();
  signal?.addEventListener("abort", stop);
  let res: Response;
  try {
    res = await request("/api/chat", { method: "POST", body: JSON.stringify(body), signal: headers.signal });
  } catch (err) {
    if (headers.signal.aborted && !signal?.aborted) throw new StreamLost();
    throw err;
  } finally {
    clearTimeout(late);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  for (;;) {
    // Le serveur envoie un signe de vie toutes les 10 s : rien pendant 20 s, la connexion est morte sans le dire
    // (réseau mobile, VPS coupé net). On lâche la lecture pour que l'app reprenne la conversation à son retour.
    let silent: ReturnType<typeof setTimeout> | undefined;
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        silent = setTimeout(() => reject(new StreamLost()), SILENCE_MS);
      }),
    ])
      .catch((err) => {
        void reader.cancel().catch(() => {});
        throw err;
      })
      .finally(() => clearTimeout(silent));
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!chunk.startsWith("data:")) continue; // signe de vie
      const ev = JSON.parse(chunk.slice(5)) as ChatEvent;
      if (ev.type === "done") finished = true;
      onEvent(ev);
    }
  }
  // Flux fermé sans événement de fin : coupure (serveur redémarré, proxy), pas une réponse terminée.
  if (!finished) throw new StreamLost();
}

const SILENCE_MS = 20_000; // deux signes de vie manqués (HEARTBEAT = 10 s côté serveur)
const HEADERS_MS = 30_000;

/** Connexion perdue pendant une réponse : l'agent continue côté serveur, l'app reprendra la conversation. */
export class StreamLost extends Error {
  constructor() {
    super("Connexion au serveur perdue.");
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
/** Lien d'une page montrée dans son bac à sable : elle y charge ses images et ses données, sans cookie. */
const PREVIEW_REUSE_MS = 60 * 60 * 1000;
const PREVIEW_RENEW_MS = 110 * 60 * 1000; // le serveur l'accepte 2 h
const previewLinks = new Map<string, { link: Promise<string>; at: number }>();
const previewKey = (agentId: string, path: string) => `${currentAuthEpoch()}|${agentId}|${path}`; // jamais le lien de la personne connectée avant
export const previewUrl = (agentId: string, path: string): Promise<string> => {
  const key = previewKey(agentId, path);
  const known = previewLinks.get(key);
  if (known && Date.now() - known.at < PREVIEW_REUSE_MS) return known.link;
  const link = send<{ url: string }>(`/api/agents/${agentId}/apercu`, { path }).then((r) => r.url);
  link.catch(() => previewLinks.delete(key));
  previewLinks.set(key, { link, at: Date.now() });
  return link;
};
/** Dans combien de temps redemander le lien rendu par previewUrl, juste avant qu'il ne serve plus. */
export const previewRenewIn = (agentId: string, path: string): number =>
  Math.max(60_000, (previewLinks.get(previewKey(agentId, path))?.at ?? 0) + PREVIEW_RENEW_MS - Date.now());

export const rawFileUrl = (agentId: string, path: string) =>
  `/api/agents/${agentId}/files/raw/${path.replace(/^\/opt\/data\/workspace\//, "").split("/").map(encodeURIComponent).join("/")}`;

// --- Objectifs et « de lui-même » (server/noah/proactif.py) ---------------------------

export type Goal = { id: string; texte: string; agent_id: string | null; etat: "actif" | "fait"; cree: number; fait_a: number | null };
export type ProactiveMode = "coupe" | "signaler" | "agir";
export type ProactiveState = {
  mode: ProactiveMode;
  choisi: boolean;
  minutes: number;
  modifiable: boolean;
  sources: string[];
  objectifs: number;
  dernier_passage: number | null;
  erreur: string | null;
  passages: number;
  signalements: number;
  tours_du_jour: number;
  tours_max: number;
  en_cours: boolean;
  cout: number;
};
