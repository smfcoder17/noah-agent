import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { QuoteContext, useQuoteState } from "@/lib/quotes";
import { ArrowLeft, Bug, Menu, MonitorPlay, PanelRight, Plus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AuthScreen } from "@/components/AuthScreen";
import { DeviceApproval, keepApprovalRequest } from "@/components/DeviceApproval";
import { HandoffBanner } from "@/components/Handoff";
import { NoahTile, agentColor } from "@/components/Noah";
import type { PanelTab } from "@/components/SidePanel";
import { STATE_WORD, Sidebar, StateShape } from "@/components/Sidebar";
import { Thread } from "@/components/Thread";
import type { SettingsTab } from "@/components/Settings";
import { ViewerProvider } from "@/components/Viewer";
import { Button } from "@/components/ui";
import { type Agent, ApiError, type Conversation, type CurrentModel, get, send, type Status, type Usage } from "@/lib/api";
import { AgentContext } from "@/lib/agentContext";
import { takeAsk } from "@/lib/askAgent";
import { forgetPushSession, reconcilePush } from "@/lib/push";
import { useAgentChat } from "@/lib/useAgentChat";
import { cn } from "@/lib/utils";

// Chargés à la première ouverture : le premier écran n'attend que le chat.
const AgentDialog = lazy(() => import("@/components/AgentDialog").then((m) => ({ default: m.AgentDialog })));
const ModelPicker = lazy(() => import("@/components/ModelPicker").then((m) => ({ default: m.ModelPicker })));
const SidePanel = lazy(() => import("@/components/SidePanel").then((m) => ({ default: m.SidePanel })));
const SettingsDialog = lazy(() => import("@/components/Settings").then((m) => ({ default: m.SettingsDialog })));

type Screen = "loading" | "setup" | "login" | "model" | "app" | "error" | "pairing";
const WAITING = "noah:appairage";

/** Téléphone qui a scanné le QR code : il attend que l'utilisateur l'accepte sur l'appareil où le code est affiché. */
async function waitForApproval(sondage: string, expire: number) {
  const until = Date.now() + expire * 1000;
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 2000));
    try {
      const r = await send<{ token?: string }>("/api/pairing/flow/poll", { sondage }); // 202 : en attente
      if (r.token) return; // la session arrive aussi en cookie
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) throw new Error("Demande refusée ou expirée. Scanne un nouveau code.");
    }
  }
  throw new Error("Demande expirée. Scanne un nouveau code.");
}

/** Garde l'ancien objet si les données n'ont pas changé : rien ne se redessine pour rien toutes les 4 s. */
function same<T>(cur: T, next: T): T {
  return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
}

/** Relève périodique, en pause quand la fenêtre est cachée, relancée dès qu'elle revient. */
function every(ms: number, fn: () => void) {
  const t = setInterval(() => !document.hidden && fn(), ms);
  const onShow = () => !document.hidden && fn();
  document.addEventListener("visibilitychange", onShow);
  return () => {
    clearInterval(t);
    document.removeEventListener("visibilitychange", onShow);
  };
}

const conversationsCache = new Map<string, Conversation[]>();

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [error, setError] = useState("");
  const [verification, setVerification] = useState("");

  const boot = useCallback(async () => {
    try {
      // Téléphone qui vient de scanner le QR code de Réglages > Téléphone : il se connecte, puis l'adresse est nettoyée.
      // Le code est dans le fragment (#), jamais envoyé au serveur ni écrit dans ses journaux.
      // La demande en attente survit à un rechargement de la page (le QR code, lui, a déjà servi).
      type Waiting = { sondage: string; verification: string; until: number };
      const code = location.hash.match(/appairage=([\w-]+)/)?.[1];
      let waiting: Waiting | null = null;
      try {
        waiting = JSON.parse(sessionStorage.getItem(WAITING) ?? "null");
      } catch {
        waiting = null;
      }
      if (code) {
        history.replaceState(null, "", location.pathname);
        const r = await send<{ sondage: string; verification: string; expire: number }>("/api/pairing/claim", { code }).catch((e) => {
          setError((e as Error).message);
          return null;
        });
        if (r) waiting = { sondage: r.sondage, verification: r.verification, until: Date.now() + r.expire * 1000 };
      }
      if (waiting && waiting.until > Date.now()) {
        try {
          sessionStorage.setItem(WAITING, JSON.stringify(waiting));
        } catch {
          /* stockage bloqué : l'attente ne survivra pas à un rechargement */
        }
        setVerification(waiting.verification);
        setScreen("pairing");
        try {
          await waitForApproval(waiting.sondage, (waiting.until - Date.now()) / 1000);
        } catch (e) {
          setError((e as Error).message);
          return;
        } finally {
          try {
            sessionStorage.removeItem(WAITING);
          } catch {
            /* rien à nettoyer */
          }
        }
      }
      keepApprovalRequest();
      const status = await get<Status>("/api/status");
      if (!status.has_account) return setScreen("setup");
      try {
        await get("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return setScreen("login");
        throw e;
      }
      setScreen(status.model_configured ? "app" : "model");
    } catch (e) {
      setError((e as Error).message);
      setScreen("error");
    }
  }, []);
  useEffect(() => {
    boot();
  }, [boot]);
  useEffect(() => {
    const out = () => {
      forgetPushSession(); // session refusée (révoquée à distance) : les notifications ne montrent plus leur contenu
      setScreen((s) => (s === "app" || s === "model" ? "login" : s));
    };
    window.addEventListener("noah:unauthorized", out);
    return () => window.removeEventListener("noah:unauthorized", out);
  }, []);

  if (screen === "loading") return <p className="p-10 text-center text-muted-foreground">Chargement…</p>;
  if (screen === "pairing")
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-4 p-10 text-center">
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Sur l'appareil où le code est affiché, accepte ce téléphone et saisis :</p>
            <p className="font-mono text-5xl font-semibold tracking-widest">{verification}</p>
            <p className="text-xs text-muted-foreground">Ce nombre prouve que c'est bien toi qui as scanné le code.</p>
          </>
        )}
      </div>
    );
  if (screen === "error") return <p className="p-10 text-center text-danger">Impossible de joindre le serveur Noah Agent : {error}</p>;
  if (screen === "setup" || screen === "login") return <AuthScreen mode={screen} onDone={boot} />;
  if (screen === "model")
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-1 text-2xl font-semibold">Le cerveau de tes agents</h1>
        <p className="mb-6 text-sm text-muted-foreground">La clé reste chiffrée sur cette machine. Les agents ne la voient jamais : ils passent par Noah Agent.</p>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Chargement…</p>}>
          <ModelPicker first onDone={() => setScreen("app")} />
        </Suspense>
      </div>
    );
  return <Shell onLogout={boot} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  // Abonnement aux notifications renouvelé par le navigateur pendant une indisponibilité : renvoyé au serveur dès
  // l'ouverture de l'app, sans attendre qu'on ouvre les réglages.
  useEffect(() => {
    reconcilePush().catch(() => {});
  }, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  // Fil ouvert à la place de la conversation principale (null = conversation principale).
  const [threadId, setThreadId] = useState<string | null>(null);
  const [model, setModel] = useState<CurrentModel>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [agentDialog, setAgentDialog] = useState<{ open: boolean; agent: Agent | null }>({ open: false, agent: null });
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [details, setDetails] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const agent = agents.find((a) => a.id === agentId) ?? null;
  // Message envoyé à l'agent depuis Détails : il part dans la conversation principale.
  useEffect(() => {
    const toMain = () => setThreadId(null);
    window.addEventListener("noah:ask", toMain);
    return () => window.removeEventListener("noah:ask", toMain);
  }, []);
  const main = conversations?.find((c) => c.main) ?? null;
  const thread = conversations?.find((c) => c.id === threadId) ?? null;
  const shown = thread ?? main;

  const refreshAgents = useCallback(async () => {
    try {
      const list = await get<Agent[]>("/api/agents");
      setAgents((cur) => same(cur, list));
      setAgentId((cur) => (cur && list.some((a) => a.id === cur) ? cur : list[0]?.id ?? null));
    } catch {
      /* le serveur redémarre : on réessaie au prochain tour */
    }
  }, []);
  const refreshModel = useCallback(async () => {
    const [m, u] = await Promise.all([get<CurrentModel>("/api/model"), get<Usage>("/api/usage")]).catch(() => [null, null]);
    setModel(m as CurrentModel);
    setUsage(u as Usage | null);
  }, []);
  const refreshConversations = useCallback(async () => {
    if (!agentId) return setConversations([]);
    const list = await get<Conversation[]>(`/api/agents/${agentId}/conversations`).catch(() => null);
    if (list) {
      conversationsCache.set(agentId, list);
      setConversations((cur) => same(cur, list));
    }
  }, [agentId]);

  useEffect(() => {
    refreshAgents();
    refreshModel();
    return every(4000, refreshAgents);
  }, [refreshAgents, refreshModel]);
  useEffect(() => {
    // Liste déjà vue : affichée tout de suite, rafraîchie derrière (pas d'écran « Chargement… »).
    setConversations(agentId ? conversationsCache.get(agentId) ?? null : null);
    refreshConversations();
    return every(4000, refreshConversations);
  }, [agentId, refreshConversations]);

  const selectAgent = (id: string) => {
    setAgentId(id);
    setThreadId(null);
    setSidebarOpen(false);
  };

  const onRunFinished = useCallback(() => {
    refreshConversations();
    refreshModel();
    setRefreshKey((k) => k + 1);
  }, [refreshConversations, refreshModel]);

  const pin = async (a: Agent, pinned: boolean) => {
    await send(`/api/agents/${a.id}/look`, { pinned }, "PATCH");
    refreshAgents();
  };

  const logout = async () => {
    await send("/api/logout", {});
    await forgetPushSession();
    onLogout();
  };

  const state = shown?.state ?? "idle";
  return (
    <ViewerProvider>
      <DeviceApproval />
      {/* Le panneau devient une colonne seulement sur grand écran ; en dessous il glisse par-dessus le chat. */}
      <div className={cn("grid h-full md:grid-cols-[264px_minmax(0,1fr)]", panel && "xl:grid-cols-[264px_minmax(0,1fr)_minmax(400px,40%)]")}>
        {/* Colonne de gauche : les agents, rien d'autre */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-30 flex w-[min(300px,85vw)] -translate-x-full flex-col gap-4 border-r border-border bg-sidebar p-3 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))] transition-transform md:static md:w-auto md:translate-x-0",
            sidebarOpen && "translate-x-0",
          )}
        >
          <Sidebar
            agents={agents}
            agentId={agentId}
            model={model}
            usage={usage}
            onClose={() => setSidebarOpen(false)}
            onSelectAgent={selectAgent}
            onPin={pin}
            onCustomize={(a) => setAgentDialog({ open: true, agent: a })}
            onNewAgent={() => setAgentDialog({ open: true, agent: null })}
            onSettings={setSettings}
            onLogout={logout}
          />
        </aside>
        {sidebarOpen && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />}

        {/* Conversation avec l'agent (ou l'un de ses fils) */}
        <main className="flex min-h-0 min-w-0 flex-col">
          <header className="flex items-center gap-2.5 border-b border-border px-3 py-2 pt-[max(8px,env(safe-area-inset-top))]">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Ouvrir le menu"><Menu /></Button>
            {thread ? (
              <Button variant="ghost" size="icon-sm" onClick={() => setThreadId(null)} aria-label={`Revenir à la conversation avec ${agent?.name}`}>
                <ArrowLeft />
              </Button>
            ) : (
              agent && <NoahTile color={agentColor(agent)} className="size-9" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{thread ? thread.title : agent?.name ?? "Aucun agent"}</p>
              <p className="truncate text-xs text-muted-foreground">
                {!agent
                  ? "Crée ton premier agent"
                  : thread
                    ? `Fil de ${agent.name}${thread.archived ? " · archivé" : ""}`
                    : agent.step || (agent.online ? "En ligne" : "Hors ligne")}
              </p>
            </div>
            {STATE_WORD[state] && state !== "done" && (
              <span
                role="status"
                className={cn(
                  "hidden h-7 shrink-0 items-center gap-2 rounded-full px-3 text-xs font-semibold sm:inline-flex",
                  state === "approve" || state === "choice" ? "bg-warn-soft text-warn" : state === "work" ? "bg-accent-soft text-accent" : "bg-muted text-muted-foreground",
                )}
              >
                <StateShape state={state} />
                {STATE_WORD[state].replace(/^./, (c) => c.toUpperCase())}
              </span>
            )}
            <Button
              variant={details ? "outline" : "ghost"}
              size="icon-sm"
              onClick={() => setDetails(!details)}
              aria-pressed={details}
              title="Afficher les détails techniques (appels d'outils)"
              aria-label="Détails techniques"
            >
              <Bug />
            </Button>
            {agent && (
              <Button variant={panel && panel !== "computer" ? "outline" : "ghost"} size="sm" onClick={() => setPanel(panel && panel !== "computer" ? null : "details")} aria-pressed={!!panel && panel !== "computer"}>
                <PanelRight /><span className="hidden sm:inline">Détails</span>
              </Button>
            )}
            {agent && (
              <Button variant={panel === "computer" ? "outline" : "default"} size="sm" onClick={() => setPanel(panel === "computer" ? null : "computer")} aria-pressed={panel === "computer"}>
                <MonitorPlay /><span className="hidden sm:inline">Ordinateur</span>
              </Button>
            )}
          </header>
          {agent && <HandoffBanner agentId={agent.id} onOpenScreen={() => setPanel("computer")} />}
          <div className="min-h-0 flex-1">
            {agent && conversations ? (
              <AgentChat
                key={`${agent.id}-${threadId ?? "main"}`}
                agent={agent}
                main={!threadId}
                conversationId={shown?.id ?? null}
                updatedAt={shown?.updated_at}
                details={details}
                onConversationCreated={refreshConversations}
                onRunFinished={onRunFinished}
              />
            ) : agent ? (
              <p className="p-10 text-center text-sm text-muted-foreground">Chargement de la conversation…</p>
            ) : (
              <div className="grid h-full place-items-center p-6 text-center text-muted-foreground">
                <div className="flex flex-col items-center gap-3">
                  <p>Aucun agent pour l'instant.</p>
                  <Button onClick={() => setAgentDialog({ open: true, agent: null })}><Plus />Créer un agent</Button>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* Panneau Détails / Fichiers / Ordinateur */}
        {panel && agent && (
          <Suspense fallback={null}>
          <aside className="fixed inset-y-0 right-0 z-30 min-h-0 w-full border-l border-border bg-surface shadow-2xl sm:w-[min(520px,92vw)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
            <SidePanel
              agent={agent}
              onAgentChanged={refreshAgents}
              tab={panel}
              onTab={setPanel}
              onClose={() => setPanel(null)}
              onEditAgent={() => setAgentDialog({ open: true, agent })}
              refreshKey={refreshKey}
              threads={(conversations ?? []).filter((c) => !c.main)}
              threadId={threadId}
              onOpenThread={setThreadId}
              onArchiveThread={async (id, archived) => {
                await send(`/api/conversations/${id}/archive`, { archived });
                if (archived && id === threadId) setThreadId(null);
                refreshConversations();
              }}
            />
          </aside>
          </Suspense>
        )}

        <Suspense fallback={null}>
        {agentDialog.open && <AgentDialog
          open={agentDialog.open}
          agent={agentDialog.agent}
          onOpenChange={(open) => setAgentDialog((d) => ({ ...d, open }))}
          onSaved={(id) => {
            setAgentDialog({ open: false, agent: null });
            refreshAgents().then(() => selectAgent(id));
          }}
          onDeleted={() => {
            setAgentDialog({ open: false, agent: null });
            setAgentId(null);
            setPanel(null);
            refreshAgents();
          }}
        />}
        {settings && <SettingsDialog
          open={!!settings}
          tab={settings ?? "brain"}
          onTab={setSettings}
          onOpenChange={(o) => !o && setSettings(null)}
          onBrainSaved={() => {
            setSettings(null);
            refreshModel();
            refreshAgents();
          }}
        />}
        </Suspense>
      </div>
    </ViewerProvider>
  );
}

function AgentChat(props: {
  agent: Agent;
  main: boolean;
  conversationId: string | null;
  updatedAt?: string;
  details: boolean;
  onConversationCreated: () => void;
  onRunFinished: () => void;
}) {
  const quotes = useQuoteState();
  const runtime = useAgentChat({ agentId: props.agent.id, ...props, takeQuotes: quotes.take });
  const say = useCallback(
    (text: string) => runtime.thread.append({ role: "user", content: [{ type: "text", text }] }),
    [runtime],
  );
  // Message demandé depuis Détails : la conversation principale l'envoie (après son historique si elle vient d'apparaître).
  const { main } = props;
  useEffect(() => {
    if (!main) return;
    const send = () => {
      const text = takeAsk();
      if (text) say(text);
    };
    const first = setTimeout(send, 900);
    window.addEventListener("noah:ask", send);
    return () => {
      clearTimeout(first);
      window.removeEventListener("noah:ask", send);
    };
  }, [main, say]);
  // Valeur stable : tous les messages du fil lisent ce contexte, un objet neuf les redessinerait à chaque jeton.
  const { id, name, role } = props.agent;
  const color = agentColor(props.agent);
  const context = useMemo(
    () => ({
      say,
      agentId: id,
      agentName: name,
      agentColor: color,
      hint: role ? role.slice(0, 180) : "Pose une question, confie une tâche ou envoie un fichier.",
    }),
    [say, id, name, color, role],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={context}>
        <QuoteContext.Provider value={quotes.value}>
          <Thread />
        </QuoteContext.Provider>
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}
