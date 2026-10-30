import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { ArrowLeft, Bug, Menu, MonitorPlay, PanelRight, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentDialog } from "@/components/AgentDialog";
import { AuthScreen } from "@/components/AuthScreen";
import { ModelPicker } from "@/components/ModelPicker";
import { NoahTile, agentColor } from "@/components/Noah";
import { type PanelTab, SidePanel } from "@/components/SidePanel";
import { STATE_WORD, Sidebar, StateShape } from "@/components/Sidebar";
import { Thread } from "@/components/Thread";
import { SettingsDialog, type SettingsTab } from "@/components/Settings";
import { ViewerProvider } from "@/components/Viewer";
import { Button } from "@/components/ui";
import { type Agent, ApiError, type Conversation, type CurrentModel, get, send, type Status, type Usage } from "@/lib/api";
import { AgentContext } from "@/lib/agentContext";
import { useAgentChat } from "@/lib/useAgentChat";
import { cn } from "@/lib/utils";

type Screen = "loading" | "setup" | "login" | "model" | "app" | "error";

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [error, setError] = useState("");

  const boot = useCallback(async () => {
    try {
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

  if (screen === "loading") return <p className="p-10 text-center text-muted-foreground">Chargement…</p>;
  if (screen === "error") return <p className="p-10 text-center text-danger">Impossible de joindre le serveur Noah Agent : {error}</p>;
  if (screen === "setup" || screen === "login") return <AuthScreen mode={screen} onDone={boot} />;
  if (screen === "model")
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-1 text-2xl font-semibold">Le cerveau de tes agents</h1>
        <p className="mb-6 text-sm text-muted-foreground">La clé reste chiffrée sur cette machine. Les agents ne la voient jamais : ils passent par Noah Agent.</p>
        <ModelPicker first onDone={() => setScreen("app")} />
      </div>
    );
  return <Shell onLogout={boot} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
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
  const main = conversations?.find((c) => c.main) ?? null;
  const thread = conversations?.find((c) => c.id === threadId) ?? null;
  const shown = thread ?? main;

  const refreshAgents = useCallback(async () => {
    try {
      const list = await get<Agent[]>("/api/agents");
      setAgents(list);
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
    if (list) setConversations(list);
  }, [agentId]);

  useEffect(() => {
    refreshAgents();
    refreshModel();
    const t = setInterval(refreshAgents, 4000);
    return () => clearInterval(t);
  }, [refreshAgents, refreshModel]);
  useEffect(() => {
    setConversations(null);
    refreshConversations();
    const t = setInterval(refreshConversations, 4000);
    return () => clearInterval(t);
  }, [refreshConversations]);

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
    onLogout();
  };

  const state = shown?.state ?? "idle";
  return (
    <ViewerProvider>
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
          <div className="min-h-0 flex-1">
            {agent && conversations ? (
              <AgentChat
                key={`${agent.id}-${threadId ?? "main"}`}
                agent={agent}
                conversationId={shown?.id ?? null}
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
          <aside className="fixed inset-y-0 right-0 z-30 min-h-0 w-full border-l border-border bg-surface shadow-2xl sm:w-[min(520px,92vw)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
            <SidePanel
              agent={agent}
              model={model?.model ?? ""}
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
        )}

        <AgentDialog
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
        />
        <SettingsDialog
          open={!!settings}
          tab={settings ?? "brain"}
          onTab={setSettings}
          onOpenChange={(o) => !o && setSettings(null)}
          onBrainSaved={() => {
            setSettings(null);
            refreshModel();
            refreshAgents();
          }}
        />
      </div>
    </ViewerProvider>
  );
}

function AgentChat(props: {
  agent: Agent;
  conversationId: string | null;
  details: boolean;
  onConversationCreated: () => void;
  onRunFinished: () => void;
}) {
  const runtime = useAgentChat({ agentId: props.agent.id, ...props });
  const say = useCallback(
    (text: string) => runtime.thread.append({ role: "user", content: [{ type: "text", text }] }),
    [runtime],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider
        value={{
          say,
          agentId: props.agent.id,
          agentName: props.agent.name,
          agentColor: agentColor(props.agent),
          hint: props.agent.role ? props.agent.role.slice(0, 180) : "Pose une question, confie une tâche ou envoie un fichier.",
        }}
      >
        <Thread />
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}
