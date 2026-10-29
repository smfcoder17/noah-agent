import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { Bug, LogOut, Menu, MessageSquarePlus, MonitorPlay, Plus, Settings2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentDialog } from "@/components/AgentDialog";
import { AuthScreen } from "@/components/AuthScreen";
import { ModelPicker } from "@/components/ModelPicker";
import { type PanelTab, SidePanel } from "@/components/SidePanel";
import { AgentContext, Thread } from "@/components/Thread";
import { Button, Dialog, DialogContent } from "@/components/ui";
import { type Agent, ApiError, type Conversation, type CurrentModel, del, get, send, type Status, type Usage } from "@/lib/api";
import { useAgentChat } from "@/lib/useAgentChat";
import { cn, money } from "@/lib/utils";

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
  if (screen === "error") return <p className="p-10 text-center text-danger">Impossible de joindre le serveur Apollo : {error}</p>;
  if (screen === "setup" || screen === "login") return <AuthScreen mode={screen} onDone={boot} />;
  if (screen === "model")
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-1 text-2xl font-semibold">Le cerveau de tes agents</h1>
        <p className="mb-6 text-sm text-muted-foreground">La clé reste chiffrée sur cette machine. Les agents ne la voient jamais : ils passent par Apollo.</p>
        <ModelPicker first onDone={() => setScreen("app")} />
      </div>
    );
  return <Shell onLogout={boot} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [model, setModel] = useState<CurrentModel>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [agentDialog, setAgentDialog] = useState<{ open: boolean; agent: Agent | null }>({ open: false, agent: null });
  const [modelOpen, setModelOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const agent = agents.find((a) => a.id === agentId) ?? null;

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
    setConversations(await get<Conversation[]>(`/api/agents/${agentId}/conversations`).catch(() => []));
  }, [agentId]);

  useEffect(() => {
    refreshAgents();
    refreshModel();
    const t = setInterval(refreshAgents, 4000);
    return () => clearInterval(t);
  }, [refreshAgents, refreshModel]);
  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  const selectAgent = (id: string) => {
    setAgentId(id);
    setConversationId(null);
    setSidebarOpen(false);
  };

  const onRunFinished = useCallback(() => {
    refreshConversations();
    refreshModel();
    setRefreshKey((k) => k + 1);
  }, [refreshConversations, refreshModel]);

  const logout = async () => {
    await send("/api/logout", {});
    onLogout();
  };

  return (
    // Le panneau devient une colonne seulement sur grand écran ; en dessous il glisse par-dessus le chat.
    <div className={cn("grid h-full md:grid-cols-[272px_minmax(0,1fr)]", panel && "xl:grid-cols-[272px_minmax(0,1fr)_minmax(400px,40%)]")}>
      {/* Colonne de gauche : agents et conversations */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[min(300px,85vw)] -translate-x-full flex-col gap-5 border-r border-border bg-sidebar p-3 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))] transition-transform md:static md:w-auto md:translate-x-0",
          sidebarOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <img src="/assets/icon.svg" alt="" className="size-7" />
            <strong className="text-lg tracking-tight">Apollo</strong>
          </div>
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setSidebarOpen(false)} aria-label="Fermer le menu"><X /></Button>
        </div>

        <section className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</span>
            <Button variant="ghost" size="icon-sm" onClick={() => setAgentDialog({ open: true, agent: null })} aria-label="Nouvel agent"><Plus /></Button>
          </div>
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => selectAgent(a.id)}
              aria-current={a.id === agentId}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface",
                a.id === agentId && "bg-surface shadow-sm ring-1 ring-border",
              )}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{a.name.slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
              <span className={cn("size-2 shrink-0 rounded-full", a.online ? "bg-ok" : a.step ? "animate-pulse bg-warn" : "bg-muted-foreground")} />
            </button>
          ))}
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversations</span>
            <Button variant="ghost" size="icon-sm" onClick={() => { setConversationId(null); setSidebarOpen(false); }} aria-label="Nouvelle conversation"><MessageSquarePlus /></Button>
          </div>
          <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
            {conversations.map((c) => (
              <div key={c.id} className={cn("group flex items-center rounded-lg hover:bg-surface", c.id === conversationId && "bg-surface ring-1 ring-border")}>
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer truncate px-2 py-1.5 text-left text-sm"
                  onClick={() => { setConversationId(c.id); setSidebarOpen(false); }}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  aria-label="Supprimer la conversation"
                  className="mr-1 hidden cursor-pointer rounded p-1 text-muted-foreground hover:text-danger group-hover:block"
                  onClick={async () => {
                    await del(`/api/conversations/${c.id}`);
                    if (c.id === conversationId) setConversationId(null);
                    refreshConversations();
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <button type="button" onClick={() => setModelOpen(true)} className="flex cursor-pointer flex-col rounded-lg px-2 py-1.5 text-left hover:bg-surface">
            <span className="text-xs text-muted-foreground">Modèle et budget</span>
            <span className="truncate font-mono text-[13px]">{model?.model ?? "aucun"}</span>
            {usage && (
              <span className="text-xs text-muted-foreground">
                Ce mois-ci : {money(usage.month_cost)} ${usage.budget != null ? ` sur ${money(usage.budget)} $` : ""}
              </span>
            )}
          </button>
          <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={logout}><LogOut />Se déconnecter</Button>
        </div>
      </aside>
      {sidebarOpen && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Conversation */}
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 pt-[max(10px,env(safe-area-inset-top))]">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setSidebarOpen(true)} aria-label="Ouvrir le menu"><Menu /></Button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{agent?.name ?? "Aucun agent"}</p>
            <p className="text-xs text-muted-foreground">{agent ? agent.step || (agent.online ? "En ligne" : "Hors ligne") : "Crée ton premier agent avec +"}</p>
          </div>
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
            <Button variant="ghost" size="icon-sm" onClick={() => setPanel(panel === "details" ? null : "details")} aria-label="Réglages et détails de l'agent">
              <Settings2 />
            </Button>
          )}
          {agent && (
            <Button variant={panel === "computer" ? "outline" : "default"} size="sm" onClick={() => setPanel(panel ? null : "computer")} aria-pressed={!!panel}>
              <MonitorPlay />Ordinateur
            </Button>
          )}
        </header>
        <div className="min-h-0 flex-1">
          {agent ? (
            <AgentChat
              key={agent.id}
              agent={agent}
              conversationId={conversationId}
              details={details}
              onConversationCreated={setConversationId}
              onRunFinished={onRunFinished}
            />
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
      <Dialog open={modelOpen} onOpenChange={setModelOpen}>
        {modelOpen && (
          <DialogContent
            title="Le cerveau de tes agents"
            description="La clé reste chiffrée sur cette machine. Les agents ne la voient jamais : ils passent par Apollo."
            className="max-w-4xl"
          >
            <ModelPicker
              onCancel={() => setModelOpen(false)}
              onDone={() => {
                setModelOpen(false);
                refreshModel();
                refreshAgents();
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function AgentChat(props: {
  agent: Agent;
  conversationId: string | null;
  details: boolean;
  onConversationCreated: (id: string) => void;
  onRunFinished: () => void;
}) {
  const runtime = useAgentChat({ agentId: props.agent.id, ...props });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider
        value={{
          agentId: props.agent.id,
          agentName: props.agent.name,
          hint: props.agent.role ? props.agent.role.slice(0, 180) : "Pose une question, confie une tâche ou envoie un fichier.",
        }}
      >
        <Thread />
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}
