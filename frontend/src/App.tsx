import { SensitiveProvider } from "@/components/SensitiveText";
import { Shell as LayoutShell } from "@/components/Shell";
import { ChatPane, retourAu } from "@/components/ChatPane";
import { etatPastille, travailleur } from "@/components/thread/TacheLigne";
import { etatMot } from "@/components/Sidebar";
import { KeepAlive } from "@/components/KeepAlive";
import { BottomTabs } from "@/components/mobile/BottomTabs";
import { MobileHeader } from "@/components/mobile/MobileHeader";
import { Drawer } from "@/components/mobile/Drawer";
import { useNavPrefs, type NavTab } from "@/lib/navPrefs";
import { PANEL_NAMES, useWide, workTabsFor } from "@/lib/workPanel";
import { WorkBar, WorkMenu } from "@/components/WorkBar";
import { WorkPanel } from "@/components/WorkPanel";
import { type Page, agentRepris, finirReprise, noterAgent, repriseEnCours, useNavigation } from "@/lib/navigation";
import { subscribeUpdates, useAccords } from "@/lib/events";
import { useNoahRetour } from "@/lib/useNoahRetour";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { QuoteContext, useQuoteState } from "@/lib/quotes";
import { Plus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthScreen, TemporaryPassword } from "@/components/AuthScreen";
import { CallScreen, type CallReport } from "@/components/Call";
import { CALL_SLOT } from "@/components/CallStage";
import { ConnectedBanner } from "@/components/ConnectedBanner";
import { DeviceApproval, keepApprovalRequest } from "@/components/DeviceApproval";
const NewDeviceAlert = lazy(() => import("@/components/NewDeviceAlert").then((m) => ({ default: m.NewDeviceAlert })));
import { HandoffBanner } from "@/components/Handoff";
import { DelegatedTasks } from "@/components/DelegatedTasks";
import { agentColor } from "@/components/Noah";
import { Boundary } from "@/components/Boundary";
import { usePropositionCount } from "@/lib/propositions";
import type { PanelTab } from "@/components/SidePanel";
import { SideRail } from "@/components/desktop/SideRail";
import { Thread } from "@/components/Thread";
import type { SettingsTab } from "@/components/Settings";
import { ViewerProvider } from "@/components/Viewer";
import { Button } from "@/components/ui";
import { type Agent, ApiError, canAdmin, canTalk, type Conversation, type InboxItem, currentAuthEpoch, get, type Me, request, send, setClientVersion, type Status } from "@/lib/api";
import { WhileBusyContext, AgentContext, HistoryContext } from "@/lib/agentContext";
import { takeAsk } from "@/lib/askAgent";
import { clearShare, pendingShare } from "@/lib/share";
import { appShell, tooOld } from "@/lib/platform";
import { forgetPushSession, reconcilePush } from "@/lib/push";
import { useAgentChat } from "@/lib/useAgentChat";
import { BRAIN_CHANGED, brainLabel, modeName, readableModel } from "@/lib/modes";

import { AppUpdate } from "./components/AppUpdate";
// Chargé à part : le bandeau « Noah a été mis à jour » n'est pas utile au premier écran (budget B2).
const InterfaceMiseAJour = lazy(() => import("./components/InterfaceMiseAJour").then((m) => ({ default: m.InterfaceMiseAJour })));
import { Dialog, DialogContent } from "./components/ui";
import { listenFileMenus } from "@/lib/desktop";
import { useOuvertureAffichee, verifier } from "@/lib/ouverture";
import { loadPresets } from "@/lib/presets";
import { OssatureFil } from "@/components/thread/panneaux";
import { t, tr } from "@/i18n";

// Chargés à la première ouverture : le premier écran n'attend que le chat. L'assistant de première installation ne sert qu'une fois.
const Onboarding = lazy(() => import("@/components/Onboarding").then((m) => ({ default: m.Onboarding })));
const AgentBrain = lazy(() => import("@/components/AgentBrain").then((m) => ({ default: m.AgentBrain })));
const AgentDialog = lazy(() => import("@/components/AgentDialog").then((m) => ({ default: m.AgentDialog })));
const CustomizeTabs = lazy(() => import("@/components/mobile/CustomizeTabs").then((m) => ({ default: m.CustomizeTabs })));
const AgentPage = lazy(() => import("@/components/mobile/AgentPage").then((m) => ({ default: m.AgentPage })));
const Inbox = lazy(() => import("@/components/Inbox").then((m) => ({ default: m.Inbox })));
const QuestionCard = lazy(() => import("@/components/QuestionCard").then((m) => ({ default: m.QuestionCard })));
const SidePanel = lazy(() => import("@/components/SidePanel").then((m) => ({ default: m.SidePanel })));
const RecherchePage = lazy(() => import("@/components/RecherchePage").then((m) => ({ default: m.RecherchePage })));
const ActivitePage = lazy(() => import("@/components/ActivitePage").then((m) => ({ default: m.ActivitePage })));
// Le bloc « Étapes » : seule une tâche ouverte le charge (budget B2).
const EtapesTache = lazy(() => import("@/components/thread/Etapes").then((m) => ({ default: m.EtapesTache })));
const SettingsPage = lazy(() => import("@/components/Settings").then((m) => ({ default: m.SettingsPage })));
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
      if (e instanceof ApiError && e.status === 410) throw new Error(t("Demande refusée ou expirée. Scanne un nouveau code."));
    }
  }
  throw new Error(t("Demande expirée. Scanne un nouveau code."));
}

/** Garde l'ancien objet si les données n'ont pas changé : rien ne se redessine pour rien toutes les 4 s. */
function same<T>(cur: T, next: T): T {
  return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [error, setError] = useState("");
  const [verification, setVerification] = useState("");
  const [linkedTo, setLinkedTo] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [me, setMe] = useState<Me | null>(null);

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
        setMe(null);
        if (e instanceof ApiError && e.status === 401) return setScreen("login");
        throw e;
      }
      setMe(me); // lu une fois ici : l'écran principal ne le redemande pas
      if (me.mot_de_passe_a_changer) return setScreen("password");
      // L'assistant de premier lancement configure le serveur : il ne concerne que son propriétaire.
      setScreen(status.onboarded || me.role !== "owner" ? "app" : "onboarding");
    } catch (e) {
      if (e instanceof ApiError && e.status === 426) return setScreen("update"); // minimum relevé pendant le démarrage
      setError((e as Error).message);
      setScreen("error");
    }
  }, []);
  useEffect(() => listenFileMenus(), []);
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

  if (screen === "loading") return <p role="status" className="p-10 text-center text-muted-foreground">{t("Chargement…")}</p>;
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
              {t("Continuer vers Noah")}
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("Sur l'appareil où le code est affiché, accepte ce téléphone et saisis :")}</p>
            <p className="font-mono text-5xl font-semibold tracking-widest">{verification}</p>
            <p className="text-xs text-muted-foreground">{t("Ce nombre prouve que c'est bien toi qui as scanné le code. Ne le donne à personne. Si tu n'as pas affiché ce code toi-même, ferme cette page : rien ne se passera.")}</p>
          </>
        )}
      </div>
    );
  if (screen === "linked")
    return (
      <div className="mx-auto flex max-w-sm flex-col items-center gap-4 p-10 text-center">
        <h1 className="text-xl font-semibold">{t("Ce navigateur est relié")}</h1>
        <p className="text-sm">{tr("Il est maintenant connecté au compte {compte}.", { compte: <b>{linkedTo}</b> })}</p>
        <Button onClick={() => { setScreen("loading"); boot(); }}>{t("Continuer")}</Button>
        <button
          type="button"
          className="text-sm text-danger underline"
          onClick={() => {
            setScreen("loading");
            send("/api/logout", {}).catch(() => {}).finally(boot);
          }}
        >
          {t("Ce n'est pas mon compte : me déconnecter")}
        </button>
      </div>
    );
  if (screen === "update")
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-3 p-10 text-center">
        <h1 className="text-xl font-semibold">{t("Mets à jour l'app Noah")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Ton serveur Noah a été mis à jour et cette version de l'app est trop ancienne pour lui (il demande une version plus récente). Installe la dernière version de l'app, puis rouvre-la : tes agents et tes réglages n'ont pas bougé.")}
        </p>
      </div>
    );
  if (screen === "error")
    return (
      <div className="flex flex-col gap-2 p-10 text-center">
        <p role="status" className="text-danger">{t("Noah ne répond pas. Vérifie ta connexion.")}</p>
        <p className="text-sm text-muted-foreground">{t("Nouvel essai dans quelques secondes…")}</p>
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
        <Suspense fallback={null}><Onboarding status={status} onDone={() => setScreen("app")} /></Suspense>
        {/* Un appareil qui attend son accord (bureau, téléphone) n'a pas à attendre la fin de l'assistant. */}
        {status.has_account && <div className="mx-auto max-w-4xl px-4 pb-10"><DeviceApproval /></div>}
      </>
    );
  return <><Shell onLogout={boot} known={me} /><Suspense fallback={null}><InterfaceMiseAJour /></Suspense></>;
}

function Shell({ onLogout, known }: { onLogout: () => void; known: Me | null }) {
  // Abonnement aux notifications renouvelé par le navigateur pendant une indisponibilité : renvoyé au serveur dès
  // l'ouverture de l'app, sans attendre qu'on ouvre les réglages.
  useEffect(() => {
    reconcilePush().catch(() => {});
  }, []);
  // Les modèles d'agent (demandes à toucher de l'écran vide) : lus une fois au montage, avec le reste, plutôt qu'à l'ouverture du premier
  // agent vide, où ils feraient une requête de plus à un changement d'agent.
  useEffect(() => {
    loadPresets().catch(() => {});
  }, []);
  // Le démarrage a déjà lu le compte : on ne le redemande que s'il manque (fin de l'assistant de premier lancement).
  const [me, setMe] = useState<Me | null>(known);
  useEffect(() => {
    if (known) return setMe(known);
    get<Me>("/api/me").then(setMe).catch(() => {});
  }, [known]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState<string | null>(agentRepris);
  noterAgent(agentId);
  // L'ouverture de l'agent affiché (lib/ouverture.ts) : une requête rend la liste des conversations, le fil, ce que l'agent fait, l'appel,
  // les tâches confiées et les routines. Ce qui est gardé en mémoire se montre tout de suite ; la lecture part derrière. Associée à son
  // agent : au retour sur un agent, la liste du précédent ne lui donne pas une autre conversation.
  const ouverture = useOuvertureAffichee(agentId);
  const conversations: Conversation[] | null = ouverture?.conversations ?? null;
  // Fil ouvert à la place de la conversation principale (null = conversation principale).
  const navigation = useNavigation();
  const { tabs, save: saveTabs, error: tabsError } = useNavPrefs();
  const latest = <K extends (typeof navigation.stack)[number]["kind"]>(kind: K) => [...navigation.stack].reverse().find((r): r is Extract<(typeof navigation.stack)[number], { kind: K }> => r.kind === kind);
  const currentTab = latest("tab")?.tab ?? "chat";
  const threadId = latest("thread")?.id ?? null;
  const setThreadId = (id: string | null) => navigation.dispatch(id ? { type: "push", route: { kind: "thread", id } } : { type: "close", kind: "thread" });
  const goTab = useCallback((tab: NavTab) => navigation.dispatch({ type: "reset", route: { kind: "tab", tab } }), [navigation.dispatch]);
  const sidebarOpen = !!latest("drawer");
  const setSidebarOpen = (open: boolean) => navigation.dispatch(open ? { type: "push", route: { kind: "drawer" } } : { type: "close", kind: "drawer" });
  const panel = latest("panel")?.tab ?? (currentTab === "chat" ? null : currentTab === "tasks" ? "routines" : currentTab);
  const setPanel = (tab: PanelTab | null) => { if (tab) navigation.dispatch({ type: "push", route: { kind: "panel", tab } }); else { navigation.dispatch({ type: "close", kind: "panel" }); if (currentTab !== "chat") goTab("chat"); } };
  const keptPanel = useRef<PanelTab>("activity");
  if (panel) keptPanel.current = panel;
  // Ordinateur : le panneau s'ouvre à côté de la conversation et peut s'étendre sur toute la page ; téléphone : feuille plein écran.
  const wide = useWide();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (!panel) setExpanded(false); }, [panel]);
  /** L'icône du panneau : elle le ferme, ou le rouvre là où on l'avait laissé. */
  const togglePanelOpen = () => setPanel(panel ? null : keptPanel.current);
  /** L'onglet marqué dans la barre du bas et le tiroir : la session n'y a pas d'onglet, la discussion reste marquée. */
  const navActive: NavTab = panel === "routines" ? "tasks" : panel === "session" || !panel ? "chat" : panel;
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [agentDialog, setAgentDialog] = useState<{ open: boolean; agent: Agent | null }>({ open: false, agent: null });
  const [modelDialog, setModelDialog] = useState(false);
  const settings = latest("settings")?.tab ?? null;
  const setSettings = (tab: SettingsTab | null) => navigation.dispatch(tab ? { type: "push", route: { kind: "settings", tab } } : { type: "close", kind: "settings" });
  const [details, setDetails] = useState(false);
  // « Pour toi », « Activité » et « Rechercher » sont des pages de la zone de travail, comme Réglages : une seule à la fois (lib/navigation.ts).
  const page = latest("page")?.page ?? null;
  const inbox = page === "inbox", activite = page === "activite", recherche = page === "recherche";
  const openPage = (p: Page) => navigation.dispatch({ type: "push", route: { kind: "page", page: p } });
  const closePage = () => navigation.dispatch({ type: "close", kind: "page" });
  const [goals, setGoals] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [report, setReport] = useState<CallReport | null>(null); // rappel pris : lu dans le mode vocal de cet agent
  const reportRead = useCallback(() => setReport(null), []);
  // La conversation de l'appel en cours reste ouverte, cachée, quand on navigue ailleurs dans l'application.
  const [inCall, setInCall] = useState<ChatProps | null>(null);

  const propositions = usePropositionCount(agents.length > 0);
  // Le même nombre que la page « Pour toi » : ses lignes (propositions, questions, choix, connexions, appels) et les accords, aucun autre compte.
  const { items: accordsEnAttente } = useAccords();
  const waiting = propositions + accordsEnAttente.length;
  const agent = agents.find((a) => a.id === agentId) ?? null;
  // Le panneau de l'agent se charge d'avance, une fois l'écran calme. Ses onglets lisent la machine de l'agent à leur ouverture : ils ne
  // sont plus lus d'avance à chaque changement d'agent (routines, veilles, connexions : trois requêtes de plus à chaque ouverture).
  const prefetchFor = agent && canAdmin(agent) ? agent.id : null;
  useEffect(() => {
    if (!prefetchFor) return;
    const timer = setTimeout(() => { import("@/components/SidePanel").catch(() => {}); }, 1500);
    return () => clearTimeout(timer);
  }, [prefetchFor]);
  useNoahRetour(navigation.stack.length, navigation.dispatch, currentTab, goTab);
  // Ctrl K (⌘ K) : la recherche, comme le montre la barre de gauche.
  const openSearch = useRef(() => {});
  openSearch.current = () => openPage("recherche");
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch.current(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  // Message envoyé à l'agent depuis Détails : il part dans la conversation principale.
  useEffect(() => {
    const toMain = (e: Event) => { const target = (e as CustomEvent<{ agentId?: string }>).detail?.agentId; if (target) setAgentId(target); goTab("chat"); setThreadId(null); };
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
  // Une tâche ouverte (0.4.0) : sa conversation n'est plus dans la liste, la tâche en est la lecture. Sans elle (une page ancienne du fil,
  // un lien de notification), la conversation s'ouvre quand même : le serveur la rend par son identifiant.
  const tacheOuverte = threadId ? ouverture?.fil?.taches.find((x) => x.conversation_id === threadId) ?? null : null;
  const thread: Conversation | null = threadId && conversations
    ? conversations.find((c) => c.id === threadId)
      ?? { id: threadId, title: tacheOuverte?.titre ?? "", updated_at: ouverture?.fil?.updated_at ?? "", state: "idle", en_cours: false, main: false, archived: false, origin: "agent", partagee: false, de: null }
    : null;
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
  // Relit l'ouverture de l'agent affiché : la liste des conversations, avec tout ce qui vient avec. Les événements la relisent aussi,
  // par l'abonné du magasin ; ceci sert aux gestes qui savent qu'elle vient de changer (discussion créée, tour fini, accord répondu).
  const refreshConversations = useCallback(async () => {
    if (agentId) await verifier(agentId, { apres: true });
  }, [agentId]);

  useEffect(() => {
    refreshAgents();
    return subscribeUpdates(refreshAgents);
  }, [refreshAgents]);
  // Un changement de cerveau, de tous ou d'un agent : l'étiquette sous la saisie relit le serveur, sans recharger la page.
  useEffect(() => {
    const changed = () => { void refreshAgents(); };
    window.addEventListener(BRAIN_CHANGED, changed);
    return () => window.removeEventListener(BRAIN_CHANGED, changed);
  }, [refreshAgents]);

  const selectAgent = (id: string) => {
    goTab("chat");
    setAgentId(id);
    setThreadId(null);
    setSidebarOpen(false);
  };

  /** Menu d'un agent de la barre : sa page, ou sa fenêtre de personnalisation, sans quitter ce qu'on lit si c'est un autre agent. */
  const openAgentPage = (id: string) => { if (id !== agentId) selectAgent(id); navigation.dispatch({ type: "push", route: { kind: "agent" } }); };
  const customizeAgent = (id: string) => { const target = agents.find((a) => a.id === id); if (target) setAgentDialog({ open: true, agent: target }); };

  useEffect(() => {
    const answered = () => {
      refreshAgents();
      refreshConversations();
    };
    window.addEventListener("noah:accord-repondu", answered);
    return () => window.removeEventListener("noah:accord-repondu", answered);
  }, [refreshAgents, refreshConversations]);
  useEffect(() => {
    const resync = (event: Event) => {
      (event as CustomEvent<Promise<unknown>[]>).detail.push(refreshAgents(), refreshConversations());
    };
    window.addEventListener("noah:resync", resync);
    return () => window.removeEventListener("noah:resync", resync);
  }, [refreshAgents, refreshConversations]);
  useEffect(() => {
    const watch = () => setPanel("computer");
    window.addEventListener("noah:voir-ecran", watch);
    return () => window.removeEventListener("noah:voir-ecran", watch);
  }, []);

  const onRunFinished = useCallback(() => {
    refreshConversations();
    setRefreshKey((k) => k + 1);
  }, [refreshConversations]);

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

  useEffect(() => {
    const open = () => setModelDialog(true);
    const tab = (e: Event) => { setSidebarOpen(false); setPanel((e as CustomEvent<PanelTab>).detail); };
    window.addEventListener("noah:choisir-modele", open);
    window.addEventListener("noah:ouvrir-panneau", tab);
    return () => { window.removeEventListener("noah:choisir-modele", open); window.removeEventListener("noah:ouvrir-panneau", tab); };
  }, []);
  const reprendre = useRef(repriseEnCours()); // page rechargée après une mise à jour : on garde l'écran repris jusqu'à ce que l'agent soit là
  useEffect(() => {
    if (reprendre.current) { if (agent?.id) { reprendre.current = false; finirReprise(); } return; }
    closePage(); setSettings(null);
  }, [agent?.id, threadId, panel, navActive]); // une page se ferme quand on ouvre un autre agent, une tâche ou un onglet
  const openInbox = () => openPage("inbox");
  const openActivite = () => openPage("activite");
  const openRecherche = () => { setSidebarOpen(false); openPage("recherche"); };
  const openFromActivite = (agent: string, conversation: string | null) => { closePage(); setAgentId(agent); setThreadId(conversation); setSidebarOpen(false); setPanel(null); };
  const openFromInbox = (item: InboxItem) => {
    closePage();
    setAgentId(item.agent_id);
    setThreadId(item.main && item.a_moi ? null : item.conversation_id); // la principale d'un autre profil n'est pas la sienne
    setSidebarOpen(false);
    setPanel(null);
  };
  return (
    <SensitiveProvider><ViewerProvider>
      <DeviceApproval />
      <ConnectedBanner />
      <Suspense fallback={null}><NewDeviceAlert onChangePassword={() => setSettings("security")} /></Suspense>
      <CallScreen
        agents={agents}
        onOpen={(r) => {
          selectAgent(r.agentId);
          setReport(r);
        }}
      />
      <LayoutShell>
        <SideRail waiting={waiting} onInbox={openInbox} onActivity={openActivite} activityDot={(ouverture?.routines.non_vues ?? 0) > 0} me={me} onLogout={logout} agent={agent} agents={agents} tabs={tabs} active={navActive} onTab={goTab} onAgent={() => navigation.dispatch({ type: "push", route: { kind: "agent" } })} onPickAgent={selectAgent} onSearch={openRecherche} onSettings={() => setSettings("home")} onGoals={() => setGoals(true)} onNewAgent={() => setAgentDialog({ open: true, agent: null })} onAgentPage={openAgentPage} onCustomize={customizeAgent} />
        <div className="work-area">
        <div className="work-main">
          <MobileHeader titre={inbox ? t("Pour toi") : activite ? t("Activité") : recherche ? t("Rechercher") : settings ? t("Réglages") : undefined} agent={agent} status={agent?.step || liveStatus || (agent?.online ? t("En ligne") : t("Hors ligne"))} onMenu={() => setSidebarOpen(true)} onAgent={() => navigation.dispatch({ type: "push", route: { kind: "agent" } })}
            menu={<WorkMenu agent={agent} active={panel} onOpen={togglePanelOpen} waiting={waiting} onInbox={openInbox} />} />
          {inbox && <div className="flex min-h-0 flex-1 flex-col"><Suspense fallback={null}><Inbox open page agents={agents} onOpenChange={(o) => { if (!o) closePage(); }} onOpenConversation={openFromInbox} onOpenAgent={selectAgent} /></Suspense></div>}
          {settings && <div className="flex min-h-0 flex-1 flex-col"><Suspense fallback={null}><SettingsPage tab={settings} owner={me?.role === "owner"} agents={agents} onTab={setSettings} onClose={() => setSettings(null)} onBrainSaved={() => { setSettings(null); refreshAgents(); }} /></Suspense></div>}
          {recherche && <div className="flex min-h-0 flex-1 flex-col"><Suspense fallback={null}><RecherchePage agents={agents}
            onOpenFil={(id, conversation) => { closePage(); setAgentId(id); setThreadId(conversation); setPanel(null); }}
            onOpenTache={openFromActivite}
            onOpenFichier={(id) => { closePage(); setAgentId(id); setThreadId(null); }} /></Suspense></div>}
          {activite && <div className="flex min-h-0 flex-1 flex-col"><Suspense fallback={null}><ActivitePage agentId={agentId} onOpenTache={openFromActivite} onOpenAgent={(id) => openFromActivite(id, null)} /></Suspense></div>}
          <KeepAlive active={!inbox && !activite && !recherche && !settings && (!panel || (wide && !expanded))} className="min-h-0 flex-1">
          <ChatPane onMenu={() => setSidebarOpen(true)}
            title={thread?.title || agent?.name || "Noah"}
            entete={agent ? { role: agent.role, ...etatMot(agent) } : null}
            tache={threadId && agent ? {
              titre: tacheOuverte?.titre || thread?.title || t("Tâche"),
              sous: tacheOuverte?.demandeur?.nom ? t("Confiée par {de} à {a}", { de: tacheOuverte.demandeur.nom, a: travailleur(tacheOuverte, agent.name) }) : t("Tâche de {nom}", { nom: agent.name }),
              etat: tacheOuverte ? etatPastille(tacheOuverte.etat).texte : "",
              genre: tacheOuverte ? etatPastille(tacheOuverte.etat).genre : "",
              retour: retourAu(agent.name),
              onRetour: () => setThreadId(null),
            } : null}
            onAgent={() => navigation.dispatch({ type: "push", route: { kind: "agent" } })} actions={<WorkBar agent={agent} active={panel} onOpen={togglePanelOpen} onSearch={() => openPage("recherche")} />}>
          <AppUpdate /><div id={CALL_SLOT} />
          {agent && canAdmin(agent) && <HandoffBanner agentId={agent.id} onOpenScreen={() => setPanel("computer")} />}
          {agent && canAdmin(agent) && <DelegatedTasks agentId={agent.id} />}
          <div className="min-h-0 flex-1">
            {inCall && (inCall.chatKey !== liveKey || !conversations) && <div key={inCall.chatKey} hidden><AgentChat {...inCall} /></div>}
            {agent && conversations ? (
              <div key={liveKey} className="h-full">
                <Boundary label={t("Cette conversation")}>
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
                  tache={threadId ? (tacheOuverte ? travailleur(tacheOuverte, agent.name) : agent.name) : null}
                  etapes={threadId && tacheOuverte?.etapes?.length ? <Suspense fallback={null}><EtapesTache etapes={tacheOuverte.etapes} etat={tacheOuverte.etat} /></Suspense> : null}
                  carte={threadId && tacheOuverte?.question ? <Suspense fallback={null}><QuestionCard key={tacheOuverte.question.id} q={tacheOuverte.question} onTache={() => setThreadId(tacheOuverte.conversation_id)} /></Suspense> : null}
                />
                </Boundary>
              </div>
            ) : agent ? (
              <div className="flex h-full flex-col px-4 pt-6"><div className="mx-auto flex w-full max-w-3xl flex-1 flex-col"><OssatureFil /></div></div>
            ) : (
              <div className="grid h-full place-items-center p-6 text-center text-muted-foreground">
                <div className="flex flex-col items-center gap-3">
                  <p>{t("Aucun agent pour l'instant.")}</p>
                  <Button onClick={() => setAgentDialog({ open: true, agent: null })}><Plus />{t("Créer un agent")}</Button>
                </div>
              </div>
            )}
          </div>

          </ChatPane></KeepAlive>
          <BottomTabs tabs={tabs} active={navActive} onSelect={goTab} onCustomize={() => navigation.dispatch({ type: "push", route: { kind: "customize" } })} />
        </div>
          {agent && <KeepAlive active={!!panel} className="contents">
            <WorkPanel open={!!panel} tab={panel ?? keptPanel.current} title={PANEL_NAMES[panel ?? keptPanel.current]} tabs={[...workTabsFor(agent), ...(canAdmin(agent) ? [{ tab: "connections" as const, label: PANEL_NAMES.connections }] : [])]} onTab={setPanel} details={details} onDetails={setDetails} expanded={expanded} onExpand={setExpanded} onClose={() => setPanel(null)}>
            <Suspense fallback={<p role="status">{t("Chargement…")}</p>}><Boundary label={t("Le panneau de l'agent")}>
            <SidePanel
              agent={agent}
              onAgentChanged={refreshAgents}
              tab={((panel ?? keptPanel.current) === "computer" ? canTalk(agent) : (panel ?? keptPanel.current) === "activity" || canAdmin(agent)) ? (panel ?? keptPanel.current) : "activity"}
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
            </Boundary></Suspense>
            </WorkPanel>
          </KeepAlive>}
        </div>
        {sidebarOpen && <Drawer waiting={waiting} onSearch={openRecherche} onInbox={() => { setSidebarOpen(false); openInbox(); }} onActivity={() => { setSidebarOpen(false); openActivite(); }} activityDot={(ouverture?.routines.non_vues ?? 0) > 0} me={me} agents={agents} agentId={agentId} tabs={tabs} active={navActive} onAgent={selectAgent} onAgentPage={openAgentPage} onCustomizeAgent={customizeAgent} onTab={goTab} onNewAgent={() => { setSidebarOpen(false); setAgentDialog({ open: true, agent: null }); }} onCustomize={() => { setSidebarOpen(false); navigation.dispatch({ type: "push", route: { kind: "customize" } }); }} onSettings={() => { setSidebarOpen(false); setSettings("home"); }} onGoals={() => { setSidebarOpen(false); setGoals(true); }} onClose={() => setSidebarOpen(false)} onLogout={logout} />}
        <Suspense fallback={null}>
        {latest("customize") && <CustomizeTabs tabs={tabs} save={saveTabs} error={tabsError} onClose={() => navigation.dispatch({ type: "close", kind: "customize" })} />}
        {latest("agent") && agent && <AgentPage agent={agent} onClose={() => navigation.dispatch({ type: "close", kind: "agent" })} onPanel={(tab) => { navigation.dispatch({ type: "close", kind: "agent" }); setPanel(tab); }} onBrain={() => setModelDialog(true)} onEdit={() => setAgentDialog({ open: true, agent })} onNotifications={() => setSettings("notifications")} onAutonomy={() => setSettings("team")} />}
        </Suspense>
        <Suspense fallback={null}>
        {agent && (
          <Dialog open={modelDialog} onOpenChange={setModelDialog}>
            {modelDialog && (
              <DialogContent title={t("Modèle de {nom}", { nom: agent.name })} description={t("Ton choix vaut pour cet agent seulement, tout de suite. Ses conversations restent.")} className="max-w-xl">
                <AgentBrain agentId={agent.id} own={agent.model} ownExact={agent.model_exact} mode={agent.mode} reasoning={agent.raisonnement} onChanged={() => { refreshAgents(); }} openKey={1} bare precise />
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
        {goals && <Goals open={goals} agents={agents} agentId={agentId} onOpenChange={setGoals} />}
        </Suspense>
      </LayoutShell>
    </ViewerProvider></SensitiveProvider>
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
  /** Celui qui travaille dans la tâche ouverte ; absent : le fil. */
  tache: string | null;
  /** La carte de la question en attente de cette tâche : elle se pose dans le fil, après la consigne. */
  carte?: React.ReactNode;
  /** Le bloc « Étapes » de cette tâche, posé après la consigne. */
  etapes?: React.ReactNode;
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
    if (text) addQuote({ label: t("Partagé"), text });
  }, [main, addQuote]);
  // Message demandé depuis Détails : la conversation principale l'envoie (après son historique si elle vient d'apparaître).
  useEffect(() => {
    if (!main) return;
    const send = () => {
      const text = takeAsk(props.agent.id);
      if (text) say(text);
    };
    const first = setTimeout(send, 900);
    window.addEventListener("noah:ask", send);
    return () => {
      clearTimeout(first);
      window.removeEventListener("noah:ask", send);
    };
  }, [main, say, props.agent.id]);
  // Valeur stable : tous les messages du fil lisent ce contexte, un objet neuf les redessinerait à chaque jeton.
  const { id, name } = props.agent;
  const { readOnly } = props;
  const color = agentColor(props.agent);
  const { shape, detail } = props.agent;
  const model = props.agent.cerveau ? brainLabel(props.agent.cerveau) : props.agent.mode ? modeName(props.agent.mode) : readableModel(props.agent.model);
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
      // Le rôle est une consigne écrite pour l'agent, pas pour la personne : l'écran vide montre des demandes à toucher.
      hint: t("Pose une question, confie une tâche ou envoie un fichier."),
      readOnly,
      canWatch: canAdmin(props.agent),
      tache: props.tache,
      carte: props.carte,
      etapes: props.etapes,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [say, id, name, color, shape, detail, model, props.details, readOnly, props.conversationId, canAdmin(props.agent), props.tache, props.carte, props.etapes],
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
