import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { QuoteContext, useQuoteState } from "@/lib/quotes";
import { ArrowLeft, Bug, MonitorPlay, PanelRight, Plus, MessageCircle, Inbox as InboxIcon, Settings as SettingsIcon, Users, Clock, FolderOpen } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthScreen, TemporaryPassword } from "@/components/AuthScreen";
import { CallScreen, type CallReport } from "@/components/Call";
import { CALL_SLOT } from "@/components/CallStage";
import { Onboarding } from "@/components/Onboarding";
import { ConnectedBanner } from "@/components/ConnectedBanner";
import { DeviceApproval, keepApprovalRequest } from "@/components/DeviceApproval";
import { NewDeviceAlert } from "@/components/NewDeviceAlert";
import { HandoffBanner } from "@/components/Handoff";
import { AgentFace, agentColor } from "@/components/Noah";
import { AgentMenu } from "@/components/AgentOverview";
import { Boundary } from "@/components/Boundary";
import { Inbox } from "@/components/Inbox";
import type { PanelTab } from "@/components/SidePanel";
import { STATE_WORD, Sidebar, StateShape } from "@/components/Sidebar";
import { Thread } from "@/components/Thread";
import type { SettingsTab } from "@/components/Settings";
import { ViewerProvider } from "@/components/Viewer";
import { Button } from "@/components/ui";
import { type Agent, ApiError, canAdmin, canTalk, type Conversation, type InboxItem, currentAuthEpoch, get, type Me, request, send, setClientVersion, type Status, type Usage } from "@/lib/api";
import { WhileBusyContext, AgentContext, HistoryContext } from "@/lib/agentContext";
import { takeAsk } from "@/lib/askAgent";
import { clearShare, pendingShare } from "@/lib/share";
import { appShell, tooOld } from "@/lib/platform";
import { forgetPushSession, reconcilePush } from "@/lib/push";
import { useAgentChat } from "@/lib/useAgentChat";
import { MODE_NAMES, type ModeId, readableModel } from "@/lib/modes";
import { AgentBrain } from "./components/AgentBrain";
import { Dialog, DialogContent } from "./components/ui";
import { cn } from "@/lib/utils";

// Chargés à la première ouverture : le premier écran n'attend que le chat.
const AgentDialog = lazy(() => import("@/components/AgentDialog").then((m) => ({ default: m.AgentDialog })));
const SidePanel = lazy(() => import("@/components/SidePanel").then((m) => ({ default: m.SidePanel })));
const SettingsDialog = lazy(() => import("@/components/Settings").then((m) => ({ default: m.SettingsDialog })));
const Goals = lazy(() => import("@/components/Goals").then((m) => ({ default: m.Goals })));

type Screen = "loading" | "onboarding" | "login" | "password" | "app" | "error" | "pairing" | "linked" | "update";
const WAITING = "noah:appairage";

/** Téléphone qui a scanné le QR code : il attend que l'utilisateur l'accepte sur l'appareil où le code est affiché. */
async function waitForApproval(sondage: string, expire: number): Promise<string> {
  const until = Date.now() + expire * 1000;
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 2000));
    try {
      // 20 s au plus par sondage : une réponse qui ne vient jamais n'empêche pas de revenir vérifier l'échéance.
      const r = (await (await request("/api/pairing/flow/poll", {
        method: "POST", body: JSON.stringify({ sondage }), signal: AbortSignal.timeout(20000),
      })).json()) as { token?: string; compte?: string }; // 202 : en attente
      if (r.token) return r.compte ?? ""; // la session arrive aussi en cookie
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
  const [linkedTo, setLinkedTo] = useState("");
  const [status, setStatus] = useState<Status | null>(null);

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
          if (e instanceof ApiError && e.status === 426) throw e; // app trop ancienne : son écran, plus bas
          setError((e as Error).message);
          return null;
        });
        // QR déjà servi ou expiré : on le dit, au lieu de passer à l'écran de connexion comme si de rien n'était.
        if (!r) return setScreen("pairing");
        waiting = { sondage: r.sondage, verification: r.verification, until: Date.now() + r.expire * 1000 };
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
          // Pas d'entrée directe : la personne voit à quel compte ce navigateur vient d'être relié, et peut en sortir.
          setLinkedTo(await waitForApproval(waiting.sondage, (waiting.until - Date.now()) / 1000));
          return setScreen("linked");
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
      setStatus(status);
      // App trop ancienne pour ce serveur : on le dit, plutôt que des erreurs incompréhensibles plus loin.
      const shell = appShell();
      if (shell) {
        const version = await shell.version().catch(() => "");
        setClientVersion(version);
        if (version && tooOld(version, status.min_client_version)) return setScreen("update");
      }
      if (!status.has_account) return setScreen("onboarding");
      let me: Me;
      try {
        me = await get<Me>("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return setScreen("login");
        throw e;
      }
      if (me.mot_de_passe_a_changer) return setScreen("password");
      // L'assistant de premier lancement configure le serveur : il ne concerne que son propriétaire.
      setScreen(status.onboarded || me.role !== "owner" ? "app" : "onboarding");
    } catch (e) {
      if (e instanceof ApiError && e.status === 426) return setScreen("update"); // minimum relevé pendant le démarrage
      setError((e as Error).message);
      setScreen("error");
    }
  }, []);
  useEffect(() => {
    boot();
  }, [boot]);
  // Serveur coupé au chargement (l'interface vient alors du service worker) : il se retrouve seul à son retour (G3.6).
  useEffect(() => {
    if (screen !== "error") return;
    const again = setInterval(boot, 5000);
    return () => clearInterval(again);
  }, [screen, boot]);
  useEffect(() => {
    let checking = false;
    const out = async () => {
      // Un 401 peut venir d'une requête partie avant une nouvelle connexion : on revérifie la session actuelle avant
      // de déconnecter l'écran et d'oublier l'identité des notifications.
      if (checking) return;
      checking = true;
      const epoch = currentAuthEpoch();
      const r = await fetch("/api/me", { credentials: "same-origin" }).catch(() => null);
      checking = false;
      // Connexion réussie pendant la vérification : ce 401 parle de l'ancienne session, la nouvelle est gardée.
      if (r?.status !== 401 || currentAuthEpoch() !== epoch) return;
      forgetPushSession(); // session refusée (révoquée à distance) : les notifications ne montrent plus leur contenu
      setScreen((s) => (s === "app" || s === "onboarding" ? "login" : s));
    };
    const outdated = () => setScreen("update"); // serveur mis à jour pendant que l'app était ouverte
    const temporary = () => setScreen("password"); // mot de passe réinitialisé par le propriétaire pendant que l'écran était ouvert
    window.addEventListener("noah:unauthorized", out);
    window.addEventListener("noah:outdated", outdated);
    window.addEventListener("noah:mot-de-passe", temporary);
    return () => {
      window.removeEventListener("noah:unauthorized", out);
      window.removeEventListener("noah:outdated", outdated);
      window.removeEventListener("noah:mot-de-passe", temporary);
    };
  }, []);

  if (screen === "loading") return <p className="p-10 text-center text-muted-foreground">Chargement…</p>;
  if (screen === "pairing")
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-4 p-10 text-center">
        {error ? (
          <>
            <p className="text-sm text-danger">{error}</p>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => {
                setError("");
                setScreen("loading");
                boot();
              }}
            >
              Continuer vers Noah
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Sur l'appareil où le code est affiché, accepte ce téléphone et saisis :</p>
            <p className="font-mono text-5xl font-semibold tracking-widest">{verification}</p>
            <p className="text-xs text-muted-foreground">Ce nombre prouve que c'est bien toi qui as scanné le code. Ne le donne à personne. Si tu n'as pas affiché ce code toi-même, ferme cette page : rien ne se passera.</p>
          </>
        )}
      </div>
    );
  if (screen === "linked")
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-4 p-10 text-center">
        <h1 className="text-xl font-semibold">Ce navigateur est relié</h1>
        <p className="text-sm">Il est maintenant connecté au compte <b>{linkedTo}</b>.</p>
        <Button onClick={() => { setScreen("loading"); boot(); }}>Continuer</Button>
        <button
          type="button"
          className="text-sm text-danger underline"
          onClick={() => {
            setScreen("loading");
            send("/api/logout", {}).catch(() => {}).finally(boot);
          }}
        >
          Ce n'est pas mon compte : me déconnecter
        </button>
      </div>
    );
  if (screen === "update")
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-3 p-10 text-center">
        <h1 className="text-xl font-semibold">Mets à jour l'app Noah</h1>
        <p className="text-sm text-muted-foreground">
          Ton serveur Noah a été mis à jour et cette version de l'app est trop ancienne pour lui (il demande une
          version plus récente). Installe la dernière version de l'app, puis rouvre-la : tes agents et tes
          réglages n'ont pas bougé.
        </p>
      </div>
    );
  if (screen === "error")
    return (
      <div className="flex flex-col gap-2 p-10 text-center">
        <p className="text-danger">Impossible de joindre le serveur Noah Agent : {error}</p>
        <p className="text-sm text-muted-foreground">Nouvel essai automatique toutes les 5 secondes…</p>
      </div>
    );
  if (screen === "login") return <AuthScreen onDone={boot} />;
  if (screen === "password")
    return (
      <TemporaryPassword
        onDone={() => { setScreen("loading"); boot(); }}
        onLogout={() => { setScreen("loading"); send("/api/logout", {}).catch(() => {}).finally(boot); }}
      />
    );
  if (screen === "onboarding" && status)
    return (
      <>
        <Onboarding status={status} onDone={() => setScreen("app")} />
        {/* Un appareil qui attend son accord (bureau, téléphone) n'a pas à attendre la fin de l'assistant. */}
        {status.has_account && <div className="mx-auto max-w-4xl px-4 pb-10"><DeviceApproval /></div>}
      </>
    );
  return <Shell onLogout={boot} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  // Abonnement aux notifications renouvelé par le navigateur pendant une indisponibilité : renvoyé au serveur dès
  // l'ouverture de l'app, sans attendre qu'on ouvre les réglages.
  useEffect(() => {
    reconcilePush().catch(() => {});
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    get<Me>("/api/me").then(setMe).catch(() => {});
  }, []);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  // Liste associée à son agent : au retour sur un agent, celle du précédent ne doit pas lui donner une autre conversation.
  const [listed, setListed] = useState<{ agent: string | null; list: Conversation[] | null }>({ agent: null, list: null });
  const conversations = listed.agent === agentId ? listed.list : agentId ? conversationsCache.get(agentId) ?? null : null;
  // Fil ouvert à la place de la conversation principale (null = conversation principale).
  const [threadId, setThreadId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [agentDialog, setAgentDialog] = useState<{ open: boolean; agent: Agent | null }>({ open: false, agent: null });
  const [modelDialog, setModelDialog] = useState(false);
  const [settings, setSettings] = useState<SettingsTab | null>(null);
  const [details, setDetails] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [goals, setGoals] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [report, setReport] = useState<CallReport | null>(null); // rappel pris : lu dans le mode vocal de cet agent
  const reportRead = useCallback(() => setReport(null), []);
  // La conversation de l'appel en cours reste ouverte, cachée, quand on navigue ailleurs dans l'application.
  const [inCall, setInCall] = useState<ChatProps | null>(null);

  const agent = agents.find((a) => a.id === agentId) ?? null;
  // Bouton Retour d'Android : ferme ce qui est ouvert, du plus proche au plus lointain. Les fenêtres se ferment sur Échap.
  useEffect(() => {
    window.noahRetour = () => {
      if (document.querySelector('[role="dialog"]')) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (panel) setPanel(null);
      else if (sidebarOpen) setSidebarOpen(false);
      else if (threadId) setThreadId(null);
      else return false;
      return true;
    };
    return () => {
      delete window.noahRetour;
    };
  }, [panel, sidebarOpen, threadId]);
  // Message envoyé à l'agent depuis Détails : il part dans la conversation principale.
  useEffect(() => {
    const toMain = () => setThreadId(null);
    window.addEventListener("noah:ask", toMain);
    return () => window.removeEventListener("noah:ask", toMain);
  }, []);
  // Ouverte par une notification ou par la bulle Android : /#agent=<id>&conversation=<id>. L'appel a sa propre adresse (Call.tsx).
  useEffect(() => {
    const open = () => {
      const [, agent, conversation] = location.hash.match(/^#agent=([\w-]+)(?:&conversation=([\w-]+))?/) ?? [];
      if (!agent) return;
      history.replaceState(null, "", location.pathname + location.search);
      setAgentId(agent);
      setThreadId(conversation ?? null);
      setSidebarOpen(false);
      setSettings(null); // ce qu'on vient d'ouvrir ne reste pas caché derrière les réglages
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  const main = conversations?.find((c) => c.main) ?? null;
  // La notification désigne la conversation principale : ce n'est pas un fil ouvert, et Retour ne doit pas s'y arrêter.
  useEffect(() => {
    if (threadId && threadId === main?.id) setThreadId(null);
  }, [threadId, main?.id]);
  const thread = conversations?.find((c) => c.id === threadId) ?? null;
  const shown = thread ?? main;
  // L'écran passe derrière : un flux peut rester ouvert longtemps sans lecteur sur un téléphone. Le serveur notifiera la fin de la tâche.
  const shownId = shown?.id;
  useEffect(() => {
    if (!shownId) return;
    const tell = () => {
      const body = new Blob([JSON.stringify({ visible: !document.hidden })], { type: "application/json" });
      navigator.sendBeacon?.(`/api/conversations/${shownId}/regard`, body);
    };
    document.addEventListener("visibilitychange", tell);
    return () => document.removeEventListener("visibilitychange", tell);
  }, [shownId]);
  const liveKey = `${agent?.id}-${threadId ?? "main"}`;

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
    setUsage(await get<Usage>("/api/usage").catch(() => null));
  }, []);
  const refreshConversations = useCallback(async () => {
    if (!agentId) return setListed({ agent: null, list: [] });
    const list = await get<Conversation[]>(`/api/agents/${agentId}/conversations`).catch(() => null);
    if (list) {
      conversationsCache.set(agentId, list);
      setListed((cur) => ({ agent: agentId, list: same(cur.agent === agentId ? cur.list : null, list) }));
    }
  }, [agentId]);

  useEffect(() => {
    refreshAgents();
    refreshModel();
    return every(4000, refreshAgents);
  }, [refreshAgents, refreshModel]);
  useEffect(() => {
    refreshConversations();
    return every(4000, refreshConversations);
  }, [agentId, refreshConversations]);

  const selectAgent = (id: string) => {
    setAgentId(id);
    setThreadId(null);
    setSidebarOpen(false);
  };

  useEffect(() => {
    const answered = () => {
      refreshAgents();
      refreshConversations();
    };
    window.addEventListener("noah:accord-repondu", answered);
    return () => window.removeEventListener("noah:accord-repondu", answered);
  }, [refreshAgents, refreshConversations]);
  useEffect(() => {
    const watch = () => setPanel("computer");
    window.addEventListener("noah:voir-ecran", watch);
    return () => window.removeEventListener("noah:voir-ecran", watch);
  }, []);

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
    // D'abord : si la réponse du serveur se perd après la suppression de la session, le marqueur est déjà effacé.
    await forgetPushSession();
    try {
      await send("/api/logout", {});
    } finally {
      // Et après : un autre onglet a pu réécrire le marqueur pendant l'attente, l'ancienne session étant encore valable.
      await forgetPushSession();
    }
    onLogout();
  };

  const state = shown?.state ?? "idle";
  useEffect(() => {
    const open = () => setModelDialog(true);
    window.addEventListener("noah:choisir-modele", open);
    return () => window.removeEventListener("noah:choisir-modele", open);
  }, []);
  const door = settings ? "Réglages" : sidebarOpen ? "Agents" : panel === "files" ? "Fichiers" : panel === "routines" ? "Tâches" : "Discussion";
  const waiting = agents.reduce((n, a) => n + (a.tasks?.approve ?? 0) + (a.tasks?.choice ?? 0), 0);
  const openFromInbox = (item: InboxItem) => {
    setInbox(false);
    setAgentId(item.agent_id);
    setThreadId(item.main && item.a_moi ? null : item.conversation_id); // la principale d'un autre profil n'est pas la sienne
    setSidebarOpen(false);
    setPanel(null);
  };
  return (
    <ViewerProvider>
      <DeviceApproval />
      <ConnectedBanner />
      <NewDeviceAlert onChangePassword={() => setSettings("security")} />
      <CallScreen
        agents={agents}
        onOpen={(r) => {
          selectAgent(r.agentId);
          setReport(r);
        }}
      />
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
            usage={usage}
            waiting={waiting}
            onInbox={() => setInbox(true)}
            onGoals={() => {
              setGoals(true);
              setSidebarOpen(false);
            }}
            onOpen={(tab) => {
              setPanel(tab);
              setSidebarOpen(false);
            }}
            owner={me?.role === "owner"}
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
            {thread ? (
              <Button variant="ghost" size="icon-sm" onClick={() => setThreadId(null)} aria-label={`Revenir à la conversation avec ${agent?.name}`}>
                <ArrowLeft />
              </Button>
            ) : null}
            {/* Le visage et le nom ouvrent la fiche de l'agent, comme chez Grok Bot et Muse : c'est là qu'on le cherche. */}
            <div
              className={cn("min-w-0 flex-1", agent && !thread && "-my-1 -ml-1 flex cursor-pointer items-center gap-2.5 rounded-xl py-1 pl-1 hover:bg-muted/60")}
              {...(agent && !thread ? { role: "button", tabIndex: 0, "aria-label": `Ouvrir le panneau de ${agent.name}`, onClick: () => setPanel("activity"), onKeyDown: (e: React.KeyboardEvent) => (e.key === "Enter" || e.key === " ") && setPanel("activity") } : {})}
            >
              {agent && !thread && <AgentFace agent={agent} className="size-9 shrink-0" />}
              <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{thread ? thread.title : agent?.name ?? "Aucun agent"}</p>
              <p className="truncate text-xs text-muted-foreground">
                {!agent
                  ? "Crée ton premier agent"
                  : thread
                    ? thread.de
                      ? `Conversation de ${thread.de} · en lecture`
                      : `Fil de ${agent.name}${thread.archived ? " · archivé" : ""}`
                    : agent.step || liveStatus || (agent.online ? "En ligne" : "Sa machine ne répond pas")}
              </p>
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" className="relative md:hidden" onClick={() => setInbox(true)} aria-label={waiting ? `À toi : ${waiting} en attente` : "À toi"} title="À toi">
              <InboxIcon />
              {waiting > 0 && <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[10px] font-semibold text-surface">{waiting}</span>}
            </Button>
            {agent && !thread && <AgentMenu agent={agent} onOpen={setPanel} onEdit={() => setAgentDialog({ open: true, agent })} />}
            {agent && !agent.online && !agent.step && canAdmin(agent) && (
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => send(`/api/agents/${agent.id}/repair`, {}).then(refreshAgents).catch(() => {})}>
                Redémarrer
              </Button>
            )}
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
              className="max-sm:hidden"
            >
              <Bug />
            </Button>
            {agent && (
              <Button variant={panel && panel !== "computer" ? "outline" : "ghost"} size="sm" className="max-sm:hidden" onClick={() => setPanel(panel && panel !== "computer" ? null : "activity")} aria-pressed={!!panel && panel !== "computer"}>
                <PanelRight aria-label="Agent" /><span className="hidden sm:inline">Agent</span>
              </Button>
            )}
            {agent && canAdmin(agent) && (
              <Button variant={panel === "computer" ? "outline" : "default"} size="sm" onClick={() => setPanel(panel === "computer" ? null : "computer")} aria-pressed={panel === "computer"} aria-label="Ordinateur" className="max-sm:bg-transparent max-sm:text-foreground max-sm:shadow-none">
                <MonitorPlay /><span className="hidden sm:inline">Ordinateur</span>
              </Button>
            )}
          </header>
          <div id={CALL_SLOT} />
          {agent && canAdmin(agent) && <HandoffBanner agentId={agent.id} onOpenScreen={() => setPanel("computer")} />}
          <div className="min-h-0 flex-1">
            {inCall && (inCall.chatKey !== liveKey || !conversations) && <div key={inCall.chatKey} hidden><AgentChat {...inCall} /></div>}
            {agent && conversations ? (
              <div key={liveKey} className="h-full">
                <Boundary label="Cette conversation">
                <AgentChat
                  chatKey={liveKey}
                  onCallChange={setInCall}
                  agent={agent}
                  readOnly={!canTalk(agent) || !!shown?.de}
                  main={!threadId}
                  conversationId={shown?.id ?? (inCall?.chatKey === liveKey ? inCall.conversationId : null)}
                  updatedAt={shown?.updated_at}
                  details={details}
                  onConversationCreated={refreshConversations}
                  onRunFinished={onRunFinished}
                  report={!threadId && report?.agentId === agent.id ? report : null}
                  onReportRead={reportRead}
                  onStatus={setLiveStatus}
                />
                </Boundary>
              </div>
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
          {/* Sur un téléphone : les quatre portes, toujours au même endroit. Elles laissent la place au clavier. */}
          <nav aria-label="Navigation" className="grid grid-cols-5 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden [body:has(textarea:focus)_&]:hidden">
            {([
              ["Discussion", MessageCircle, () => { setPanel(null); setSidebarOpen(false); }, 0],
              ["Fichiers", FolderOpen, () => { setSidebarOpen(false); setPanel("files"); }, 0],
              ["Tâches", Clock, () => { setSidebarOpen(false); setPanel("routines"); }, 0],
              ["Agents", Users, () => setSidebarOpen(true), 0],
              ["Réglages", SettingsIcon, () => setSettings("home"), 0],
            ] as const).map(([label, Icon, go, count]) => (
              <button key={label} type="button" onClick={go} aria-current={door === label ? "page" : undefined} className={cn("relative flex cursor-pointer flex-col items-center gap-0.5 py-2 text-[11px] font-medium", door === label ? "text-accent" : "text-muted-foreground")}>
                <Icon className="size-5" />{label}
                {count > 0 && <span className="absolute top-1 left-1/2 ml-1 grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[10px] font-semibold text-surface">{count}</span>}
              </button>
            ))}
          </nav>
        </main>

        {/* Panneau de l'agent */}
        {panel && agent && (
          <Suspense fallback={null}>
          <aside className="fixed inset-y-0 right-0 z-30 min-h-0 w-full max-md:bottom-[calc(54px+env(safe-area-inset-bottom))] border-l border-border bg-surface shadow-2xl sm:w-[min(520px,92vw)] xl:static xl:z-auto xl:w-auto xl:shadow-none">
            <Boundary label="Le panneau de l'agent">
            <SidePanel
              agent={agent}
              onAgentChanged={refreshAgents}
              tab={(panel === "computer" ? canTalk(agent) : panel === "activity" || canAdmin(agent)) ? panel : "activity"}
              onTab={setPanel}
              onClose={() => setPanel(null)}
              onEditAgent={() => setAgentDialog({ open: true, agent })}
              onGoals={() => setGoals(true)}
              refreshKey={refreshKey}
              threads={(conversations ?? []).filter((c) => !c.main)}
              main={main}
              onConversationChanged={refreshConversations}
              threadId={threadId}
              onOpenThread={setThreadId}
              onArchiveThread={async (id, archived) => {
                await send(`/api/conversations/${id}/archive`, { archived });
                if (archived && id === threadId) setThreadId(null);
                refreshConversations();
              }}
              technical={details}
              onTechnical={setDetails}
            />
            </Boundary>
          </aside>
          </Suspense>
        )}

        <Suspense fallback={null}>
        {agent && (
          <Dialog open={modelDialog} onOpenChange={setModelDialog}>
            {modelDialog && (
              <DialogContent title={`Modèle de ${agent.name}`} description={`Aujourd'hui : ${agent.mode ? MODE_NAMES[agent.mode as ModeId] ?? agent.mode : readableModel(agent.model) || "celui de tous tes agents"}. Le changement vaut pour cet agent seulement, tout de suite.`} className="max-w-xl">
                <AgentBrain agentId={agent.id} own={agent.model} mode={agent.mode} reasoning={agent.raisonnement} onChanged={() => { refreshAgents(); setModelDialog(false); }} openKey={1} bare />
              </DialogContent>
            )}
          </Dialog>
        )}
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
        <Inbox open={inbox} agents={agents} onOpenChange={setInbox} onOpenConversation={openFromInbox} />
        {goals && <Goals open={goals} agents={agents} agentId={agentId} onOpenChange={setGoals} />}
        {settings && <SettingsDialog
          open={!!settings}
          tab={settings ?? "brain"}
          owner={me?.role === "owner"}
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

type ChatProps = {
  chatKey: string;
  onCallChange: React.Dispatch<React.SetStateAction<ChatProps | null>>;
  agent: Agent;
  readOnly: boolean;
  main: boolean;
  conversationId: string | null;
  updatedAt?: string;
  details: boolean;
  onConversationCreated: () => void;
  onRunFinished: () => void;
  report: CallReport | null;
  onReportRead: () => void;
  onStatus?: (status: string | null) => void;
};

function AgentChat(props: ChatProps) {
  const quotes = useQuoteState();
  const takeQuotes = quotes.take;
  const self = useRef(props);
  self.current = props;
  // Quand on navigue, l'appel continue avec ces props gardées : elles doivent suivre sa conversation, souvent créée après le début
  // de l'appel. Sinon, sa conversation vide reviendrait : flux coupé, écran effacé.
  const followConversation = useCallback(
    (id: string | null) =>
      self.current.onCallChange((cur) => (cur?.chatKey === self.current.chatKey && cur.conversationId !== id ? { ...cur, conversationId: id } : cur)),
    [],
  );
  useEffect(() => followConversation(props.conversationId), [followConversation, props.conversationId]);
  const { runtime, whileBusy, history, status } = useAgentChat({
    agentId: props.agent.id,
    ...props,
    agentBusy: Boolean(props.agent.tasks.work || props.agent.tasks.approve), // « choice » attend la personne, sans travail en cours
    takeQuotes: useCallback(() => {
      clearShare(); // le partage part avec ce message
      return takeQuotes();
    }, [takeQuotes]),
    onConversationCreated: useCallback((id: string) => {
      followConversation(id); // même si l'appel est déjà caché : la liste affichée est alors celle d'un autre agent
      self.current.onConversationCreated();
    }, [followConversation]),
  });
  useEffect(() => {
    self.current.onStatus?.(status);
  }, [status]);
  const say = useCallback(
    (text: string, clientId?: string) => runtime.thread.append({ role: "user", content: [{ type: "text", text }], metadata: { custom: { clientId } } }),
    [runtime],
  );
  const onCall = useCallback(
    (on: boolean) =>
      self.current.onCallChange((cur) => (on ? self.current : cur?.chatKey === self.current.chatKey ? null : cur)),
    [],
  );
  const { main } = props;
  // Texte ou lien partagé depuis une autre app (PWA sur Android) : cité dans le prochain message.
  const addQuote = quotes.value.add;
  useEffect(() => {
    const text = main && pendingShare();
    if (text) addQuote({ label: "Partagé", text });
  }, [main, addQuote]);
  // Message demandé depuis Détails : la conversation principale l'envoie (après son historique si elle vient d'apparaître).
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
  const { readOnly } = props;
  const color = agentColor(props.agent);
  const { shape, detail } = props.agent;
  const model = props.agent.mode ? MODE_NAMES[props.agent.mode as ModeId] ?? props.agent.mode : readableModel(props.agent.model);
  const context = useMemo(
    () => ({
      say,
      agentId: id,
      agentName: name,
      agentColor: color,
      agentShape: shape ?? "",
      agentDetail: detail ?? "",
      agentModel: model,
      details: props.details,
      conversationId: props.conversationId,
      hint: role ? role.slice(0, 180) : "Pose une question, confie une tâche ou envoie un fichier.",
      readOnly,
      canWatch: canAdmin(props.agent),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [say, id, name, color, shape, detail, model, props.details, role, readOnly, props.conversationId, canAdmin(props.agent)],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WhileBusyContext.Provider value={whileBusy}>
      <HistoryContext.Provider value={history}>
      <AgentContext.Provider value={context}>
        <QuoteContext.Provider value={quotes.value}>
          <Thread report={props.report} onReportRead={props.onReportRead} onCall={onCall} />
        </QuoteContext.Provider>
      </AgentContext.Provider>
      </HistoryContext.Provider>
      </WhileBusyContext.Provider>
    </AssistantRuntimeProvider>
  );
}
