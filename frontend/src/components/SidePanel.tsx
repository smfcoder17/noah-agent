import { subscribeUpdates } from "@/lib/events";
// Panneau de l'agent : ce qu'il fait, à quoi il a accès, son ordinateur, ses routines, sa mémoire.
import { Archive, ArchiveRestore, Brain, ChevronDown, ChevronRight, Clock, ExternalLink, FolderOpen, Hand, History, Loader2, LogIn, Monitor, MonitorPlay, Pencil, Plug, Power, RefreshCw, Sparkles, Sunrise, Users, X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, type Agent, canAdmin, canTalk, type Conversation, get, request, send, type Usage } from "@/lib/api";
import { peekScreenUrl, refuseScreenUrl, screenControl, screenUrl, screenViewOnly } from "@/lib/screenCache";
import { SEEN, SeenActive, seenGeneration } from "@/lib/seen";
import { wireClipboard } from "@/lib/vncClipboard";
import { cn, money } from "@/lib/utils";
import { AgentAppearance } from "./AgentAppearance";
import { AgentBrain } from "./AgentBrain";
import { AgentOverview } from "./AgentOverview";
import { Competences } from "./Competences";
import { Connections, Folders, Memory, Routines, Section, Software, Watches } from "./AgentPowers";
import { Boundary } from "./Boundary";
import { Proactive } from "./Proactive";
import { Files } from "./Files";
import { AgentFace } from "./Noah";
import { ShareDialog } from "./Sharing";
import { STATE_WORD, StateShape } from "./Sidebar";
import { Button, Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";

export type PanelTab = "activity" | "files" | "connections" | "competences" | "computer" | "routines" | "memory";

/** Première visite seulement : ensuite le contenu reste monté, mais ses lectures suivent sa visibilité. */
function KeptTab({ value, shown, className, children }: { value: string; shown: boolean; className: string; children: React.ReactNode }) {
  const parentVisible = useContext(SeenActive);
  const active = parentVisible && shown;
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return (
    <TabsContent value={value} forceMount className={cn(className, !active && "hidden")}>
      <SeenActive.Provider value={active}>{(visited || active) && <Boundary label="Cet onglet">{children}</Boundary>}</SeenActive.Provider>
    </TabsContent>
  );
}

export function SidePanel({
  agent,
  onAgentChanged,
  tab,
  onTab,
  onClose,
  onEditAgent,
  onGoals,
  refreshKey,
  threads,
  main,
  onConversationChanged,
  threadId,
  onOpenThread,
  onArchiveThread,
  technical,
  onTechnical,
}: {
  agent: Agent;
  /** Après un changement de cerveau : la liste des agents est relue. */
  onAgentChanged: () => void;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onEditAgent: () => void;
  /** Ouvre les objectifs de la personne. */
  onGoals?: () => void;
  refreshKey: number;
  threads: Conversation[];
  /** La conversation principale de ce compte avec l'agent. */
  main: Conversation | null;
  onConversationChanged: () => void;
  threadId: string | null;
  onOpenThread: (id: string | null) => void;
  onArchiveThread: (id: string, archived: boolean) => void;
  /** Détails techniques du fil. Sur un téléphone, ce réglage vit ici plutôt que dans l'en-tête. */
  technical: boolean;
  onTechnical: (on: boolean) => void;
}) {
  const admin = canAdmin(agent);
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as PanelTab)} className="flex h-full min-h-0 flex-col gap-3 p-3 pt-[max(12px,env(safe-area-inset-top))]">
      <div className="flex items-center justify-between gap-2">
        <TabsList className="max-w-full overflow-x-auto max-sm:grid max-sm:flex-1 max-sm:auto-cols-fr max-sm:grid-flow-col max-sm:overflow-visible max-sm:[&>button]:flex max-sm:[&>button]:flex-col max-sm:[&>button]:items-center max-sm:[&>button]:gap-0.5 max-sm:[&>button]:px-0.5 max-sm:[&>button]:text-[10.5px] [&_svg]:size-4 sm:[&_svg]:hidden">
          {([
            ["activity", "Activité", History, true],
            ["files", "Fichiers", FolderOpen, canTalk(agent)],
            ["routines", "Routines", Clock, admin],
            ["connections", "Connexions", Plug, admin],
            ["competences", "Compétences", Sparkles, admin],
            ["computer", "Ordinateur", Monitor, canTalk(agent)],
            ["memory", "Mémoire", Brain, admin],
          ] as const).filter((t) => t[3]).map(([value, label, Icon]) => (
            <TabsTrigger key={value} value={value} aria-label={label} className={value === "competences" || value === "memory" ? "max-sm:hidden!" : undefined}><Icon aria-hidden /><span className="max-sm:max-w-full max-sm:truncate">{label}</span></TabsTrigger>
          ))}
        </TabsList>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer le panneau"><X /></Button>
      </div>
      <Boundary key={agent.id} label="Le panneau de l'agent">
      <KeptTab value="activity" shown={tab === "activity"} className="min-h-0 flex-1 overflow-y-auto">
        <Details agent={agent} onEdit={onEditAgent} refreshKey={refreshKey} onAgentChanged={onAgentChanged} onTab={onTab} onGoals={onGoals}>
          <Threads threads={threads} threadId={threadId} onOpen={onOpenThread} onArchive={onArchiveThread} />
          {agent.partage && main && <ConversationVisibility conversation={main} onChanged={onConversationChanged} />}
          <ActivityLog agentId={agent.id} refreshKey={refreshKey} onOpen={(id, isMain) => onOpenThread(isMain && id === main?.id ? null : id)} />
          <label className="flex items-center justify-between gap-3 py-1 text-sm sm:hidden">
            Afficher les détails techniques
            <input type="checkbox" checked={technical} onChange={(e) => onTechnical(e.target.checked)} className="size-5 accent-[var(--accent)]" />
          </label>
        </Details>
      </KeptTab>
      <KeptTab value="files" shown={tab === "files"} className="min-h-0 flex-1 overflow-y-auto">
        <Files key={agent.id} agentId={agent.id} refreshKey={refreshKey} canDelete={admin} onGiven={() => window.matchMedia("(max-width: 767px)").matches && onClose()} />
      </KeptTab>
      <KeptTab value="connections" shown={tab === "connections"} className="min-h-0 flex-1 overflow-y-auto px-1">
        {admin && <Connections agentId={agent.id} shared={agent.partage || !!agent.partage_par} owner={agent.droit === "proprietaire"} />}
      </KeptTab>
      <KeptTab value="competences" shown={tab === "competences"} className="min-h-0 flex-1 overflow-y-auto px-1">
        {admin && <Competences key={agent.id} agentId={agent.id} />}
      </KeptTab>
      <KeptTab value="computer" shown={tab === "computer"} className="flex min-h-0 flex-1 flex-col">
        <ComputerTab agent={agent} admin={admin} refreshKey={refreshKey} onClose={onClose} />
      </KeptTab>
      <KeptTab value="routines" shown={tab === "routines"} className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        {admin && <><Proactive agentId={agent.id} /><Routines agentId={agent.id} /><Watches agentId={agent.id} /></>}
      </KeptTab>
      <KeptTab value="memory" shown={tab === "memory"} className="min-h-0 flex-1 overflow-y-auto px-1">
        {admin && <Memory agentId={agent.id} />}
      </KeptTab>
      </Boundary>
    </Tabs>
  );
}

/** L'ordinateur de l'agent : son écran, ses fichiers, les dossiers qu'il peut toucher, ses logiciels. */
function ComputerTab({ agent, admin, refreshKey, onClose }: { agent: Agent; admin: boolean; refreshKey: number; onClose: () => void }) {
  // Le choix reste en passant d'un agent à l'autre ; sans les droits d'administration, seuls les fichiers.
  const [chosen, setPart] = useState("screen");
  const part = admin ? chosen : "files";
  return (
    <Tabs value={part} onValueChange={setPart} className="flex min-h-0 flex-1 flex-col gap-3">
      {admin && (
        <TabsList className="max-w-full self-start overflow-x-auto">
          <TabsTrigger value="screen">Écran</TabsTrigger>
          <TabsTrigger value="files">Fichiers</TabsTrigger>
          <TabsTrigger value="folders">Dossiers</TabsTrigger>
          <TabsTrigger value="software">Logiciels</TabsTrigger>
        </TabsList>
      )}
      <KeptTab value="screen" shown={part === "screen"} className="flex min-h-0 flex-1 flex-col gap-3">{admin && <Computer key={agent.id} agentId={agent.id} />}</KeptTab>
      <KeptTab value="files" shown={part === "files"} className="min-h-0 flex-1 overflow-y-auto">
        <Files key={agent.id} agentId={agent.id} refreshKey={refreshKey} canDelete={admin} onGiven={() => window.matchMedia("(max-width: 767px)").matches && onClose()} />
      </KeptTab>
      <KeptTab value="folders" shown={part === "folders"} className="min-h-0 flex-1 overflow-y-auto px-1">{admin && <Folders agentId={agent.id} />}</KeptTab>
      <KeptTab value="software" shown={part === "software"} className="min-h-0 flex-1 overflow-y-auto px-1">{admin && <Software agentId={agent.id} />}</KeptTab>
    </Tabs>
  );
}

type LogRow = { kind: "tache" | "accord" | "juge"; titre: string; resultat: string; etat: "fait" | "a_verifier" | "erreur" | "arrete" | "autorise" | "refuse"; at: number; conversation_id: string; main: boolean };
const LOG_WORD: Record<LogRow["etat"], [string, string]> = {
  fait: ["Fait", "text-ok"], a_verifier: ["À vérifier", "text-warn"], erreur: ["A échoué", "text-danger"], arrete: ["Arrêté", "text-muted-foreground"], autorise: ["Autorisé", "text-ok"], refuse: ["Refusé", "text-muted-foreground"],
};

/** Le temps se resserre en s'éloignant : aujourd'hui, hier, les jours de la semaine, puis des périodes de plus en plus larges. */
function activityPeriod(at: Date, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86400000);
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return "Hier";
  if (days < 7) {
    const label = at.toLocaleDateString("fr-CA", { weekday: "long", day: "numeric", month: "long" });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (days < 14) return "La semaine dernière";
  const months = (now.getFullYear() - at.getFullYear()) * 12 + now.getMonth() - at.getMonth();
  if (months === 0) return "Plus tôt ce mois-ci";
  if (months === 1) return "Le mois dernier";
  const month = at.toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
  return month.charAt(0).toUpperCase() + month.slice(1);
}

const LOG_FIRST = 5;

/** Une période : repliée sauf la plus récente, et jamais plus de quelques lignes d'un coup. */
function ActivityPeriod({ label, rows, first, onOpen }: { label: string; rows: LogRow[]; first: boolean; onOpen: (conversation: string, main: boolean) => void }) {
  const [open, setOpen] = useState(first);
  const [shown, setShown] = useState(LOG_FIRST);
  return (
    <div className="flex flex-col gap-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1.5 rounded-lg py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 tabular-nums">{rows.length}</span>
      </button>
      {open && rows.slice(0, shown).map((r, i) => (
        <button key={i} type="button" onClick={() => onOpen(r.conversation_id, r.main)} className="flex cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted">
          <span className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{r.titre.replace(/^Ton juge a refusé : /, "Bloqué : ").replace(/^Ton juge demande ton accord : .*/, "Accord demandé")}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{new Date(r.at * 1000).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" })}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground"><span className={cn("font-medium", LOG_WORD[r.etat][1])}>{LOG_WORD[r.etat][0]}</span>{r.resultat ? ` · ${r.resultat}` : ""}</span>
        </button>
      ))}
      {open && rows.length > shown && (
        <button type="button" onClick={() => setShown(shown + 10)} className="cursor-pointer self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          … voir {Math.min(10, rows.length - shown)} de plus
        </button>
      )}
    </div>
  );
}

/** Un aperçu de ce que l'agent a fait dernièrement, pas une archive : plus ancien, il le retrouve quand on le lui demande. */
function ActivityLog({ agentId, refreshKey, onOpen }: { agentId: string; refreshKey: number; onOpen: (conversation: string, main: boolean) => void }) {
  const active = useContext(SeenActive);
  const path = `/api/agents/${agentId}/activite`;
  const [log, setLog] = useState<{ agent: string; rows: LogRow[] } | null>(() => SEEN.has(path) ? { agent: agentId, rows: SEEN.get(path) as LogRow[] } : null);
  const rows = log?.agent === agentId ? log.rows : null; // jamais le journal d'un autre agent, même le temps de charger
  useEffect(() => {
    let current = true; // la réponse tardive d'un autre agent n'écrase pas celle-ci
    if (!active) return;
    const generation = seenGeneration();
    get<LogRow[]>(path)
      .then((r) => {
        if (!current || generation !== seenGeneration()) return;
        SEEN.set(path, r);
        setLog({ agent: agentId, rows: r });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [agentId, path, refreshKey, active]);
  if (!rows) return null;
  const periods = new Map<string, LogRow[]>();
  for (const r of rows) {
    const label = activityPeriod(new Date(r.at * 1000));
    periods.set(label, [...(periods.get(label) ?? []), r]);
  }
  return (
    <section aria-label="Activité" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Ce qu'il a fait</h3>
      {!rows.length && <p className="text-sm text-muted-foreground">Rien pour l'instant. Ses tâches et les accords que tu donnes s'afficheront ici.</p>}
      {[...periods].map(([label, list], i) => <ActivityPeriod key={label} label={label} rows={list} first={i === 0} onOpen={onOpen} />)}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col rounded-xl bg-muted px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <b className="text-lg tabular-nums">{value}</b>
    </div>
  );
}

/** Sur un agent partagé, rien n'est lisible par les autres tant que l'auteur ne le décide pas. */
function ConversationVisibility({ conversation, onChanged }: { conversation: Conversation; onChanged: () => void }) {
  const toggle = async (partagee: boolean) => {
    await send(`/api/conversations/${conversation.id}/partage`, { partagee }).catch(() => {});
    onChanged();
  };
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-muted px-3 py-2.5 text-sm">
      <input type="checkbox" className="mt-1" checked={conversation.partagee} onChange={(e) => toggle(e.target.checked)} />
      Rendre ma conversation lisible par ceux qui ont accès à cet agent
    </label>
  );
}

function Details({ agent, onEdit, refreshKey, onAgentChanged, onTab, onGoals, children }: { agent: Agent; onEdit: () => void; refreshKey: number; onAgentChanged: () => void; onTab: (t: PanelTab) => void; onGoals?: () => void; children: React.ReactNode }) {
  const active = useContext(SeenActive);
  const [sharing, setSharing] = useState(false);
  const [spendingOpen, setSpendingOpen] = useState(false);
  const brainBox = useRef<HTMLDivElement>(null);
  const [brainOpen, setBrainOpen] = useState(0);
  useEffect(() => {
    const open = () => { setBrainOpen((n) => n + 1); setTimeout(() => brainBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
    window.addEventListener("noah:ouvrir-modele", open);
    return () => window.removeEventListener("noah:ouvrir-modele", open);
  }, []);
  const spendingBox = useRef<HTMLDivElement>(null);
  const [usage, setUsage] = useState<Usage | null>(() => (SEEN.get("/api/usage") as Usage) ?? null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const generation = seenGeneration();
    get<Usage>("/api/usage").then((r) => {
      if (!current || generation !== seenGeneration()) return;
      SEEN.set("/api/usage", r);
      setUsage(r);
    }).catch(() => {});
    return () => { current = false; };
  }, [agent.id, refreshKey, active]);
  const mine = usage?.agents.find((u) => u.agent_id === agent.id);
  const cacheRate = mine?.prompt_tokens ? Math.round((100 * mine.cached_tokens) / mine.prompt_tokens) : 0;
  return (
    <div className="flex flex-col gap-4 px-1">
      <div className="flex items-center gap-3">
        <AgentFace agent={agent} className="size-14" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{agent.name}</p>
          <p className="text-sm text-muted-foreground">{agent.step || (agent.online ? "En ligne" : "Hors ligne")}</p>
          {agent.partage_par && <p className="text-xs text-muted-foreground">Partagé par {agent.partage_par} · droit : {agent.droit}</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canAdmin(agent) && <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Personnaliser (nom, couleur, rôle)" title="Personnaliser (nom, couleur, rôle)"><Pencil /></Button>}
          {agent.droit === "proprietaire" && <Button variant="outline" size="sm" onClick={() => setSharing(true)}><Users />Partager</Button>}
        </div>
      </div>
      <ShareDialog agent={agent} open={sharing} onOpenChange={setSharing} onChanged={onAgentChanged} />
      {/* Ce qu'il fait et ce qu'il a fait d'abord, comme le fil de Grok Bot ; la fiche (rôle, modèle, connexions…) ensuite. */}
      {children}
      <AgentOverview agent={agent} refreshKey={refreshKey} spent={`${money(mine?.cost ?? 0)} $`} onTab={onTab} onEdit={onEdit} onGoals={onGoals}
        onBrain={() => { setBrainOpen((n) => n + 1); setTimeout(() => brainBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}
        onSpending={() => { setSpendingOpen(true); setTimeout(() => spendingBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }} />
      {/* La dépense et le modèle s'ouvrent depuis leur tuile : l'onglet reste léger. */}
      {spendingOpen && <div ref={spendingBox}>
      <Section defaultOpen title="Dépense" count={`${money(mine?.cost ?? 0)} $ ce mois-ci`}>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Coût ce mois-ci" value={`${money(mine?.cost ?? 0)} $`} />
        <Stat label="Appels au modèle" value={mine?.calls ?? 0} />
        <Stat label="Jetons" value={(mine?.tokens ?? 0).toLocaleString("fr-CA")} />
        <Stat label="Lus depuis le cache" value={`${cacheRate} %`} />
      </div>
      {usage && <Spending usage={usage} agentId={agent.id} />}
      </Section>
      </div>}
      {canAdmin(agent) && brainOpen > 0 && <div ref={brainBox}><AgentBrain key={`cerveau-${agent.id}`} agentId={agent.id} own={agent.model} mode={agent.mode} reasoning={agent.raisonnement} onChanged={onAgentChanged} openKey={brainOpen} /></div>}
      {canAdmin(agent) && <AgentAppearance key={`visage-${agent.id}`} agent={agent} onChanged={onAgentChanged} />}
    </div>
  );
}

/** Où part l'argent de cet agent : aujourd'hui, les 14 derniers jours, et ses tâches les plus coûteuses du mois. */
function Spending({ usage, agentId }: { usage: Usage; agentId: string }) {
  const today = usage.today?.[agentId];
  const byDay = new Map((usage.days ?? []).filter((d) => d.agent_id === agentId).map((d) => [d.day, d]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 13 + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { key, label: d.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric" }), cost: byDay.get(key)?.cost ?? 0, tokens: byDay.get(key)?.tokens ?? 0 };
  });
  const top = Math.max(...days.map((d) => d.cost), 0.0001);
  const tasks = (usage.tasks ?? []).filter((t) => t.agent_id === agentId).slice(0, 5);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        14 derniers jours
        <span className="normal-case tracking-normal">
          Aujourd'hui : <b className="font-mono text-foreground">{money(today?.depense ?? 0)} $</b>
          {today?.plafond != null && ` / ${money(today.plafond)} $`}
        </span>
      </h3>
      <div className="flex h-12 items-end gap-0.5" role="img" aria-label="Dépense des 14 derniers jours">
        {days.map((d) => (
          <div
            key={d.key}
            title={`${d.label} : ${money(d.cost)} $ · ${d.tokens.toLocaleString("fr-CA")} jetons`}
            className={cn("flex-1 rounded-sm", d.cost ? "bg-foreground/70" : "bg-muted")}
            style={{ height: `${Math.max(6, (d.cost / top) * 100)}%` }}
          />
        ))}
      </div>
      {tasks.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm">
          {tasks.map((t) => (
            <li key={t.conversation_id ?? "fond"} className="flex items-baseline justify-between gap-2">
              <span className="truncate">{t.main ? "Conversation principale" : t.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground" title={`${t.calls} appels au modèle`}>
                {Math.round(t.tokens / 1000).toLocaleString("fr-CA")} k jetons · {money(t.cost)} $
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Un groupe de fils replié ; il s'ouvre seul s'il contient celui qu'on regarde. */
function FoldedThreads({ label, threads, threadId, row }: { label: string; threads: Conversation[]; threadId: string | null; row: (t: Conversation) => React.ReactNode }) {
  const [asked, setAsked] = useState<boolean | null>(null);
  const open = asked ?? threads.some((t) => t.id === threadId);
  if (!threads.length) return null;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setAsked(!open)}
        className="mt-1 flex cursor-pointer items-center gap-1.5 self-start rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        {label} ({threads.length})
      </button>
      {open && <div className="flex flex-col gap-0.5 opacity-80">{threads.map(row)}</div>}
    </>
  );
}

/** Fils de l'agent. En cours : ce qui travaille vraiment, ou attend la personne. Le reste se replie : les finis, puis les archivés. */
function Threads({
  threads,
  threadId,
  onOpen,
  onArchive,
}: {
  threads: Conversation[];
  threadId: string | null;
  onOpen: (id: string | null) => void;
  onArchive: (id: string, archived: boolean) => void;
}) {
  const running = threads.filter((t) => !t.archived && t.en_cours);
  const finished = threads.filter((t) => !t.archived && !t.en_cours);
  const archived = threads.filter((t) => t.archived);
  const row = (t: Conversation) => (
    <div key={t.id} className={cn("group flex items-center gap-1 rounded-lg hover:bg-muted", t.id === threadId && "bg-muted")}>
      <button
        type="button"
        onClick={() => onOpen(t.id === threadId ? null : t.id)}
        aria-current={t.id === threadId ? "page" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-2.5 py-1.5 text-left"
      >
        <span className="truncate text-sm">{t.title}</span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            t.state === "approve" || t.state === "choice" ? "font-medium text-warn" : "text-muted-foreground",
          )}
        >
          <StateShape state={t.state} />
          {STATE_WORD[t.state] || "à l'arrêt"}
          {t.de ? <span className="text-muted-foreground"> · conversation de {t.de}</span>
            : t.origin === "agent" && <span className="text-muted-foreground"> · ouvert par l'agent</span>}
        </span>
      </button>
      {!t.de && <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 pointer-coarse:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => onArchive(t.id, !t.archived)}
        aria-label={t.archived ? `Désarchiver « ${t.title} »` : `Archiver « ${t.title} »`}
        title={t.archived ? "Désarchiver" : "Archiver"}
      >
        {t.archived ? <ArchiveRestore /> : <Archive />}
      </Button>}
    </div>
  );
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-baseline justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Travaux en cours <span className="normal-case tracking-normal">{running.length || ""}</span>
      </h3>
      {running.length ? (
        running.map(row)
      ) : (
        <p className="text-sm text-muted-foreground">Rien en cours.</p>
      )}
      <FoldedThreads label="Terminés" threads={finished} threadId={threadId} row={row} />
      <FoldedThreads label="Archivés" threads={archived} threadId={threadId} row={row} />
    </section>
  );
}

type ScreenStatus = { etat: "pret" | "veille" | "aucune_page" | "injoignable"; awake: boolean; reachable: boolean; running: boolean; tabs: number };

/** Reprendre une session ouverte dans le navigateur habituel : X, Google et les banques bloquent souvent
 * la connexion depuis un navigateur automatisé, mais acceptent une session déjà ouverte. */
function CookieImport({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ count: number; sites: string[] } | null>(null);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      setResult(await send(`/api/agents/${agentId}/browser/cookies`, { cookies: text }));
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="ghost" onClick={() => { setOpen(true); setResult(null); }}><LogIn />Importer une session</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title="Importer une session" description="Pour les sites qui bloquent la connexion depuis un navigateur automatisé (X, Google, banques).">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              <li>Dans ton navigateur habituel, connecte-toi au site.</li>
              <li>Avec l'extension Cookie-Editor, ouvre-la sur ce site puis Export → JSON.</li>
              <li>Colle le résultat ici (ou choisis un fichier cookies.txt).</li>
            </ol>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder='[{"name": "auth_token", "domain": ".x.com", …}]'
              className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
              aria-label="Cookies exportés"
            />
            <input
              type="file"
              accept=".json,.txt"
              aria-label="Fichier de cookies"
              className="text-sm"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
              }}
            />
            <p className="text-xs text-muted-foreground">Ces cookies valent un mot de passe : ils restent sur ta machine, dans le navigateur de cet agent.</p>
            {error && <p className="text-sm text-danger">{error}</p>}
            {result && <p className="text-sm text-ok">{result.count} cookies importés : {result.sites.join(", ")}. Demande à l'agent d'ouvrir le site.</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Fermer</Button>
              <Button onClick={submit} disabled={busy || text.trim().length < 2}>{busy ? <Loader2 className="animate-spin" /> : <LogIn />}Importer</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function Computer({ agentId }: { agentId: string }) {
  const active = useContext(SeenActive);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const visible = active && pageVisible;
  const [control, setControl] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [url, setUrl] = useState(() => peekScreenUrl(agentId) ?? "");
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [failures, setFailures] = useState(0);
  const failed = useRef(0);
  const [retry, setRetry] = useState(0);
  const [fixing, setFixing] = useState<"wake" | "restart" | null>(null);
  const [fixError, setFixError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const pageFailed = useRef(false);
  const pageReloads = useRef(0);
  const clipboard = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(true);
  const wantedControl = useRef(false);
  const mayHoldControl = useRef(false);
  const modeQueue = useRef(Promise.resolve());
  const backgroundSince = useRef<number | null>(null);

  const changeControl = useCallback((next: boolean) => {
    wantedControl.current = next;
    if (next) mayHoldControl.current = true;
    else {
      clipboard.current?.();
      clipboard.current = undefined;
      screenViewOnly(frame.current, true);
      setControl(false);
    }
    setModeBusy(true);
    // Une restitution attend une prise en main encore en route : une réponse tardive ne reprend jamais la main.
    const task = modeQueue.current.then(() => screenControl(agentId, next)).then(() => {
      if (!next) mayHoldControl.current = false;
      if (!mounted.current || wantedControl.current !== next) return;
      setControl(next);
      screenViewOnly(frame.current, !next);
      if (next && frame.current) {
        clipboard.current?.();
        clipboard.current = wireClipboard(frame.current, agentId, setFixError);
      }
    });
    modeQueue.current = task.catch(async (e) => {
      if (!mounted.current) return;
      setFixError((e as Error).message);
      if (next && wantedControl.current === next) {
        wantedControl.current = false;
        setControl(false);
        screenViewOnly(frame.current, true);
        // La réponse a pu se perdre après l'activation du mode privé : on rend la main aussi dans ce cas.
        await screenControl(agentId, false).then(() => { mayHoldControl.current = false; }).catch(() => {});
      }
    }).finally(() => { if (mounted.current) setModeBusy(false); });
  }, [agentId]);

  useEffect(() => {
    mounted.current = true;
    const visibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      wantedControl.current = false;
      clipboard.current?.();
      document.removeEventListener("visibilitychange", visibility);
      // G7.7 : fermeture du panneau ou changement d'agent, y compris pendant une prise en main en route.
      if (mayHoldControl.current) void modeQueue.current.then(() => screenControl(agentId, false)).catch(() => {});
    };
  }, [agentId]);

  useEffect(() => {
    const release = () => { if (mayHoldControl.current) changeControl(false); };
    if (visible) {
      // Les chronomètres peuvent être suspendus sur téléphone : vérifier aussi au retour.
      if (backgroundSince.current !== null && Date.now() - backgroundSince.current >= 60_000) release();
      backgroundSince.current = null;
      return;
    }
    backgroundSince.current ??= Date.now();
    const timer = setTimeout(release, Math.max(0, 60_000 - (Date.now() - backgroundSince.current)));
    return () => clearTimeout(timer);
  }, [visible, changeControl]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let reading = false;
    const stop = subscribeUpdates(() => { if (!cancelled) return poll(); });
    const poll = async () => {
      if (reading || cancelled) return;
      clearTimeout(timer);
      reading = true;
      try {
        const [s, link] = await Promise.all([
          request(`/api/agents/${agentId}/screen-status`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json() as Promise<ScreenStatus>),
          screenUrl(agentId),
        ]);
        if (cancelled) return;
        setUrl(link); // une erreur passagère ne retire jamais l'URL ni l'iframe
        if (s.etat === "injoignable") throw new Error("Écran injoignable");
        setStatus(s);
        // En veille, noVNC peut garder une page d'erreur du conteneur arrêté : attendre le réveil avant de la sonder.
        if (s.etat === "pret" && pageFailed.current) {
          // Un onLoad ne distingue pas une page noVNC d'un refus HTTP. Seul un refus explicite oublie le lien.
          try {
            await request(link.split("#")[0], { signal: AbortSignal.timeout(8000) });
          } catch (e) {
            if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
              if (mayHoldControl.current) changeControl(false);
              refuseScreenUrl(agentId);
            }
            throw e;
          }
          if (cancelled) return;
          if (frame.current) {
            if (frame.current.getAttribute("src") !== link) frame.current.src = link;
            else frame.current.contentWindow?.location.reload();
            pageReloads.current += 1;
          }
          setReconnecting(true);
          // Un 200 peut encore servir une page d'erreur : borner les essais rapides tant que noVNC ne revient pas.
          if (pageReloads.current >= 3) throw new Error("Écran injoignable");
        } else if (s.etat === "pret") {
          const doc = frame.current?.contentDocument;
          // noVNC se reconnecte lui-même : ce délai local n'est pas un échec des sondes serveur/lien.
          setReconnecting(!!doc?.getElementById("noVNC_setting_view_only") && !doc.documentElement.classList.contains("noVNC_connected"));
        }
        failed.current = 0;
        setFailures(0);
      } catch {
        if (cancelled) return;
        failed.current += 1;
        if (pageReloads.current >= 3) failed.current = Math.max(2, failed.current);
        setFailures(failed.current);
      }
      reading = false;
      if (!cancelled) timer = setTimeout(poll, 60000);
    };
    void poll();
    return () => { cancelled = true; stop(); clearTimeout(timer); };
  }, [agentId, visible, retry, changeControl]);

  const fix = async (how: "wake" | "restart") => {
    setFixing(how);
    setFixError("");
    try {
      const s = await send<{ ecran_actif: boolean; conseil: string }>(`/api/agents/${agentId}/browser/${how}`, {});
      if (!mounted.current) return;
      if (!s.ecran_actif) setFixError(s.conseil);
    } catch (e) {
      if (mounted.current) setFixError((e as Error).message);
    } finally {
      if (mounted.current) { setFixing(null); setRetry((n) => n + 1); }
    }
  };

  const unreachable = failures >= 2;
  const ready = status?.etat === "pret" && !unreachable && !reconnecting && !!url;
  const overlay = !ready || !!fixing;
  return (
    <>
      <div className={cn("relative min-h-64 flex-1 overflow-hidden rounded-xl border border-border bg-[#0b0f14]", control && ready && "ring-3 ring-warn")}>
        {url && <iframe ref={frame} src={url} title="Écran de l'agent" className={cn("absolute inset-0 size-full border-0", overlay && "hidden")} onLoad={(e) => {
          clipboard.current?.();
          const loaded = e.currentTarget;
          pageFailed.current = !screenViewOnly(loaded, !wantedControl.current || !control);
          if (!pageFailed.current) pageReloads.current = 0;
          clipboard.current = !pageFailed.current && wantedControl.current && control ? wireClipboard(loaded, agentId, setFixError) : undefined;
        }} />}
        {overlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[#e6ebf0]">
            {fixing ? <Loader2 className="size-8 animate-spin opacity-70" /> : <MonitorPlay className="size-8 opacity-60" />}
            <strong>
              {fixing === "wake" ? "Réveil du navigateur…"
                : fixing === "restart" ? "Redémarrage du navigateur…"
                : unreachable ? "Écran injoignable"
                : status?.etat === "aucune_page" ? "Aucune page ouverte"
                : status?.etat === "veille" ? "Le navigateur est en veille"
                : "Connexion à l'écran…"}
            </strong>
            {!fixing && (
              <div className="flex flex-wrap justify-center gap-2">
                {unreachable ? <Button onClick={() => setRetry((n) => n + 1)}><RefreshCw />Réessayer</Button>
                  : status?.etat === "veille" ? <Button onClick={() => fix("wake")}><Sunrise />Le réveiller</Button>
                  : status?.etat === "aucune_page" && <Button onClick={() => fix("wake")}><Sunrise />Ouvrir une page</Button>}
              </div>
            )}
            {fixError && <span className="max-w-xs text-sm text-[#fbbf8a]">{fixError}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant={control ? "warn" : "default"} onClick={() => changeControl(!control)} disabled={modeBusy || (!control && !ready)}>
          <Hand />{control ? "Rendre la main à l'agent" : "Prendre le contrôle"}
        </Button>
        <Button variant="outline" onClick={() => { frame.current?.contentWindow?.location.reload(); setRetry((n) => n + 1); }}><RefreshCw />Rafraîchir l'écran</Button>
        {(status?.awake || unreachable) && <Button variant="ghost" onClick={() => fix("restart")} disabled={!!fixing}><Power />Redémarrer le navigateur</Button>}
        {url && ready && <Button variant="ghost" asChild><a href={url} target="_blank" rel="noopener"><ExternalLink />Plein écran</a></Button>}
        <CookieImport agentId={agentId} />
      </div>
      {!overlay && fixError && <p className="text-sm text-danger">{fixError}</p>}
      <p className="text-xs text-muted-foreground">
        {control
          ? "Tu as la main : clique et tape directement dans l'écran. Ctrl+V y colle ton presse-papiers, Ctrl+C copie la sélection chez toi. Quand tu as fini, rends la main."
          : "Lecture seule : l'agent garde la main. Prends le contrôle pour te connecter à un site ou résoudre un CAPTCHA, puis dis-lui de continuer."}
      </p>
    </>
  );
}
