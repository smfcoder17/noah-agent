import { Approvals } from "./mobile/Approvals";
import { subscribeUpdates } from "@/lib/events";
// Panneau de l'agent : ce qu'il fait, à quoi il a accès, son ordinateur, ses routines, sa mémoire.
import { Archive, ArchiveRestore, Brain, ChevronDown, ChevronRight, Clock, ExternalLink, FolderOpen, Hand, History, Loader2, LogIn, Monitor, MonitorPlay, Pencil, Plug, Power, RefreshCw, Sparkles, Sunrise, Users, X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, type Agent, canAdmin, canTalk, type Conversation, get, request, send, type Usage } from "@/lib/api";
import { peekScreenUrl, refuseScreenUrl, screenControl, screenUrl, screenViewOnly, watchScreenConnection } from "@/lib/screenCache";
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
import { langue, locale, t, tr } from "@/i18n";

/** Dates et nombres : le français garde la forme canadienne d'origine, les autres langues suivent leur usage. */
const FORMAT = langue() === "fr" ? "fr-CA" : locale();

export type PanelTab = "activity" | "files" | "connections" | "competences" | "computer" | "routines" | "memory";

/** Première visite seulement : ensuite le contenu reste monté, mais ses lectures suivent sa visibilité. */
function KeptTab({ value, shown, className, children }: { value: string; shown: boolean; className: string; children: React.ReactNode }) {
  const parentVisible = useContext(SeenActive);
  const active = parentVisible && shown;
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return (
    <TabsContent value={value} forceMount className={cn(className, !active && "hidden")}>
      <SeenActive.Provider value={active}>{(visited || active) && <Boundary label={t("Cet onglet")}>{children}</Boundary>}</SeenActive.Provider>
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
      <div data-shell-tabs className="flex items-center justify-between gap-2">
        <TabsList className="max-w-full overflow-x-auto max-sm:grid max-sm:flex-1 max-sm:auto-cols-fr max-sm:grid-flow-col max-sm:overflow-visible max-sm:[&>button]:flex max-sm:[&>button]:flex-col max-sm:[&>button]:items-center max-sm:[&>button]:gap-0.5 max-sm:[&>button]:px-0.5 max-sm:[&>button]:text-[10.5px] [&_svg]:size-4 sm:[&_svg]:hidden">
          {([
            ["activity", t("Activité"), History, true],
            ["files", t("Fichiers"), FolderOpen, canTalk(agent)],
            ["routines", t("Routines"), Clock, admin],
            ["connections", t("Connexions"), Plug, admin],
            ["competences", t("Compétences"), Sparkles, admin],
            ["computer", t("Ordinateur"), Monitor, canTalk(agent)],
            ["memory", t("Mémoire"), Brain, admin],
          ] as const).filter((t) => t[3]).map(([value, label, Icon]) => (
            <TabsTrigger key={value} value={value} aria-label={label} className={value === "competences" || value === "memory" ? "max-sm:hidden!" : undefined}><Icon aria-hidden /><span className="max-sm:max-w-full max-sm:truncate">{label}</span></TabsTrigger>
          ))}
        </TabsList>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("Fermer le panneau")}><X /></Button>
      </div>
      <Boundary key={agent.id} label={t("Le panneau de l'agent")}>
      <KeptTab value="activity" shown={tab === "activity"} className="min-h-0 flex-1 overflow-y-auto">
        <Approvals agentId={agent.id} />
        <ActivityLog agentId={agent.id} refreshKey={refreshKey} onOpen={(id, isMain) => { onOpenThread(isMain && id === main?.id ? null : id); onClose(); }} />
        <details className="mt-2"><summary className="text-sm text-muted-foreground cursor-pointer">{t("Fils et réglages")}</summary><Details agent={agent} onEdit={onEditAgent} refreshKey={refreshKey} onAgentChanged={onAgentChanged} onTab={onTab} onGoals={onGoals}>
          <Threads threads={threads} threadId={threadId} onOpen={onOpenThread} onArchive={onArchiveThread} />
          {agent.partage && main && <ConversationVisibility conversation={main} onChanged={onConversationChanged} />}
          <label className="flex items-center justify-between gap-3 py-1 text-sm sm:hidden">
            {t("Afficher les détails techniques")}
            <input type="checkbox" checked={technical} onChange={(e) => onTechnical(e.target.checked)} className="size-5 accent-[var(--accent)]" />
          </label>
        </Details></details>
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
        <TabsList className="max-w-full self-start overflow-x-auto order-last">
          <TabsTrigger value="screen">{t("Écran")}</TabsTrigger>
          <TabsTrigger value="files">{t("Fichiers")}</TabsTrigger>
          <TabsTrigger value="folders">{t("Dossiers")}</TabsTrigger>
          <TabsTrigger value="software">{t("Logiciels")}</TabsTrigger>
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
  fait: [t("Fait"), "text-ok"], a_verifier: [t("À vérifier"), "text-warn"], erreur: [t("A échoué"), "text-danger"], arrete: [t("Arrêté"), "text-muted-foreground"], autorise: [t("Autorisé"), "text-ok"], refuse: [t("Refusé"), "text-muted-foreground"],
};

/** Le temps se resserre en s'éloignant : aujourd'hui, hier, les jours de la semaine, puis des périodes de plus en plus larges. */
function activityPeriod(at: Date, now = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86400000);
  if (days <= 0) return t("Aujourd'hui");
  if (days === 1) return t("Hier");
  if (days < 7) {
    const label = at.toLocaleDateString(FORMAT, { weekday: "long", day: "numeric", month: "long" });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  if (days < 14) return t("La semaine dernière");
  const months = (now.getFullYear() - at.getFullYear()) * 12 + now.getMonth() - at.getMonth();
  if (months === 0) return t("Plus tôt ce mois-ci");
  if (months === 1) return t("Le mois dernier");
  const month = at.toLocaleDateString(FORMAT, { month: "long", year: "numeric" });
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
            <span className="min-w-0 truncate">{r.titre.replace(/^Ton juge a refusé : /, t("Bloqué : ")).replace(/^Ton juge demande ton accord : .*/, t("Accord demandé"))}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{new Date(r.at * 1000).toLocaleTimeString(FORMAT, { hour: "2-digit", minute: "2-digit" })}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground"><span className={cn("font-medium", LOG_WORD[r.etat][1])}>{LOG_WORD[r.etat][0]}</span>{r.resultat ? ` · ${r.resultat}` : ""}</span>
        </button>
      ))}
      {open && rows.length > shown && (
        <button type="button" onClick={() => setShown(shown + 10)} className="cursor-pointer self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          {t("… voir {n} de plus", { n: Math.min(10, rows.length - shown) })}
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
    <section aria-label={t("Activité")} className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Ce qu'il a fait")}</h3>
      {!rows.length && <p className="text-sm text-muted-foreground">{t("Rien pour l'instant. Ses tâches et les accords que tu donnes s'afficheront ici.")}</p>}
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
      {t("Rendre ma conversation lisible par ceux qui ont accès à cet agent")}
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
          <p className="text-sm text-muted-foreground">{agent.step || (agent.online ? t("En ligne") : t("Hors ligne"))}</p>
          {agent.partage_par && <p className="text-xs text-muted-foreground">{t("Partagé par {nom} · droit : {droit}", { nom: agent.partage_par, droit: agent.droit })}</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canAdmin(agent) && <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={t("Personnaliser (nom, couleur, rôle)")} title={t("Personnaliser (nom, couleur, rôle)")}><Pencil /></Button>}
          {agent.droit === "proprietaire" && <Button variant="outline" size="sm" onClick={() => setSharing(true)}><Users />{t("Partager")}</Button>}
        </div>
      </div>
      <ShareDialog agent={agent} open={sharing} onOpenChange={setSharing} onChanged={onAgentChanged} />
      {/* Ce qu'il fait et ce qu'il a fait d'abord, comme le fil de Grok Bot ; la fiche (rôle, modèle, connexions…) ensuite. */}
      {children}
      <AgentOverview agent={agent} refreshKey={refreshKey} spent={t("{montant} $", { montant: money(mine?.cost ?? 0) })} onTab={onTab} onEdit={onEdit} onGoals={onGoals}
        onBrain={() => { setBrainOpen((n) => n + 1); setTimeout(() => brainBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}
        onSpending={() => { setSpendingOpen(true); setTimeout(() => spendingBox.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }} />
      {/* La dépense et le modèle s'ouvrent depuis leur tuile : l'onglet reste léger. */}
      {spendingOpen && <div ref={spendingBox}>
      <Section defaultOpen title={t("Dépense")} count={t("{montant} $ ce mois-ci", { montant: money(mine?.cost ?? 0) })}>
      <div className="grid grid-cols-2 gap-2">
        <Stat label={t("Coût ce mois-ci")} value={t("{montant} $", { montant: money(mine?.cost ?? 0) })} />
        <Stat label={t("Appels au modèle")} value={mine?.calls ?? 0} />
        <Stat label={t("Jetons")} value={(mine?.tokens ?? 0).toLocaleString(FORMAT)} />
        <Stat label={t("Lus depuis le cache")} value={t("{n} %", { n: cacheRate })} />
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
    return { key, label: d.toLocaleDateString(FORMAT, { weekday: "short", day: "numeric" }), cost: byDay.get(key)?.cost ?? 0, tokens: byDay.get(key)?.tokens ?? 0 };
  });
  const top = Math.max(...days.map((d) => d.cost), 0.0001);
  const tasks = (usage.tasks ?? []).filter((t) => t.agent_id === agentId).slice(0, 5);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("14 derniers jours")}
        <span className="normal-case tracking-normal">
          {tr("Aujourd'hui : {montant}", { montant: <b className="font-mono text-foreground">{t("{montant} $", { montant: money(today?.depense ?? 0) })}</b> })}
          {today?.plafond != null && ` / ${t("{montant} $", { montant: money(today.plafond) })}`}
        </span>
      </h3>
      <div className="flex h-12 items-end gap-0.5" role="img" aria-label={t("Dépense des 14 derniers jours")}>
        {days.map((d) => (
          <div
            key={d.key}
            title={t("{jour} : {montant} $ · {n} jetons", { jour: d.label, montant: money(d.cost), n: d.tokens.toLocaleString(FORMAT) })}
            className={cn("flex-1 rounded-sm", d.cost ? "bg-foreground/70" : "bg-muted")}
            style={{ height: `${Math.max(6, (d.cost / top) * 100)}%` }}
          />
        ))}
      </div>
      {tasks.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm">
          {tasks.map((task) => (
            <li key={task.conversation_id ?? "fond"} className="flex items-baseline justify-between gap-2">
              <span className="truncate">{task.main ? t("Conversation principale") : task.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground" title={t("{n} appels au modèle", { n: task.calls })}>
                {t("{n} k jetons · {montant} $", { n: Math.round(task.tokens / 1000).toLocaleString(FORMAT), montant: money(task.cost) })}
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
  const row = (c: Conversation) => (
    <div key={c.id} className={cn("group flex items-center gap-1 rounded-lg hover:bg-muted", c.id === threadId && "bg-muted")}>
      <button
        type="button"
        onClick={() => onOpen(c.id === threadId ? null : c.id)}
        aria-current={c.id === threadId ? "page" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 px-2.5 py-1.5 text-left"
      >
        <span className="truncate text-sm">{c.title}</span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            c.state === "approve" || c.state === "choice" ? "font-medium text-warn" : "text-muted-foreground",
          )}
        >
          <StateShape state={c.state} />
          {STATE_WORD[c.state] || t("à l'arrêt")}
          {c.de ? <span className="text-muted-foreground"> · {t("conversation de {nom}", { nom: c.de })}</span>
            : c.origin === "agent" && <span className="text-muted-foreground"> · {t("ouvert par l'agent")}</span>}
        </span>
      </button>
      {!c.de && <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 pointer-coarse:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => onArchive(c.id, !c.archived)}
        aria-label={c.archived ? t("Désarchiver « {titre} »", { titre: c.title }) : t("Archiver « {titre} »", { titre: c.title })}
        title={c.archived ? t("Désarchiver") : t("Archiver")}
      >
        {c.archived ? <ArchiveRestore /> : <Archive />}
      </Button>}
    </div>
  );
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-baseline justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("Travaux en cours")} <span className="normal-case tracking-normal">{running.length || ""}</span>
      </h3>
      {running.length ? (
        running.map(row)
      ) : (
        <p className="text-sm text-muted-foreground">{t("Rien en cours.")}</p>
      )}
      <FoldedThreads label={t("Terminés")} threads={finished} threadId={threadId} row={row} />
      <FoldedThreads label={t("Archivés")} threads={archived} threadId={threadId} row={row} />
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
      <Button variant="ghost" onClick={() => { setOpen(true); setResult(null); }}><LogIn />{t("Importer une session")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent title={t("Importer une session")} description={t("Pour les sites qui bloquent la connexion depuis un navigateur automatisé (X, Google, banques).")}>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
              <li>{t("Dans ton navigateur habituel, connecte-toi au site.")}</li>
              <li>{t("Avec l'extension Cookie-Editor, ouvre-la sur ce site puis Export → JSON.")}</li>
              <li>{t("Colle le résultat ici (ou choisis un fichier cookies.txt).")}</li>
            </ol>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              // i18n-ignore : exemple de code, le même dans toutes les langues
              placeholder='[{"name": "auth_token", "domain": ".x.com", …}]'
              className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
              aria-label={t("Cookies exportés")}
            />
            <input
              type="file"
              accept=".json,.txt"
              aria-label={t("Fichier de cookies")}
              className="text-sm"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
              }}
            />
            <p className="text-xs text-muted-foreground">{t("Ces cookies valent un mot de passe : ils restent sur ta machine, dans le navigateur de cet agent.")}</p>
            {error && <p className="text-sm text-danger">{error}</p>}
            {result && <p className="text-sm text-ok">{t("{n} cookies importés : {sites}. Demande à l'agent d'ouvrir le site.", { n: result.count, sites: result.sites.join(", ") })}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>{t("Fermer")}</Button>
              <Button onClick={submit} disabled={busy || text.trim().length < 2}>{busy ? <Loader2 className="animate-spin" /> : <LogIn />}{t("Importer")}</Button>
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
  const [reconnecting, setReconnecting] = useState(true); // jusqu'à ce que noVNC dise qu'il est connecté (watchScreenConnection)
  const [failures, setFailures] = useState(0);
  const failed = useRef(0);
  const [retry, setRetry] = useState(0);
  const [fixing, setFixing] = useState<"wake" | "restart" | null>(null);
  const [fixError, setFixError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const pageFailed = useRef(false);
  const pageReloads = useRef(0);
  const clipboard = useRef<(() => void) | undefined>(undefined);
  const connection = useRef<(() => void) | undefined>(undefined);
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
      connection.current?.();
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
        if (s.etat === "injoignable") throw new Error(t("Écran injoignable"));
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
          if (pageReloads.current >= 3) throw new Error(t("Écran injoignable"));
        }
        // L'état de la connexion noVNC vient de watchScreenConnection, posé au chargement de l'iframe : un relevé ici
        // le figeait jusqu'au relevé suivant, et cachait un écran déjà reconnecté.
        failed.current = 0;
        setFailures(0);
      } catch {
        if (cancelled) return;
        failed.current += 1;
        if (pageReloads.current >= 3) failed.current = Math.max(2, failed.current);
        setFailures(failed.current);
      }
      reading = false;
      if (!cancelled && failed.current) timer = setTimeout(poll, Math.min(12000, 3000 * 2 ** Math.min(2, failed.current - 1)));
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
        {url && <iframe ref={frame} src={url} title={t("Écran de l'agent")} className={cn("absolute inset-0 size-full border-0", overlay && "hidden")} onLoad={(e) => {
          clipboard.current?.();
          const loaded = e.currentTarget;
          pageFailed.current = !screenViewOnly(loaded, !wantedControl.current || !control);
          if (!pageFailed.current) pageReloads.current = 0;
          connection.current?.();
          connection.current = !pageFailed.current && loaded.contentDocument
            ? watchScreenConnection(loaded.contentDocument, (connected) => { if (mounted.current) setReconnecting(!connected); })
            : undefined;
          clipboard.current = !pageFailed.current && wantedControl.current && control ? wireClipboard(loaded, agentId, setFixError) : undefined;
        }} />}
        {overlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[#e6ebf0]">
            {fixing ? <Loader2 className="size-8 animate-spin opacity-70" /> : <MonitorPlay className="size-8 opacity-60" />}
            <strong>
              {fixing === "wake" ? t("Réveil du navigateur…")
                : fixing === "restart" ? t("Redémarrage du navigateur…")
                : unreachable ? t("Écran injoignable")
                : status?.etat === "aucune_page" ? t("Aucune page ouverte")
                : status?.etat === "veille" ? t("Le navigateur est en veille")
                : t("Connexion à l'écran…")}
            </strong>
            {!fixing && (
              <div className="flex flex-wrap justify-center gap-2">
                {unreachable ? <Button onClick={() => setRetry((n) => n + 1)}><RefreshCw />{t("Réessayer")}</Button>
                  : status?.etat === "veille" ? <Button onClick={() => fix("wake")}><Sunrise />{t("Le réveiller")}</Button>
                  : status?.etat === "aucune_page" && <Button onClick={() => fix("wake")}><Sunrise />{t("Ouvrir une page")}</Button>}
              </div>
            )}
            {fixError && <span className="max-w-xs text-sm text-[#fbbf8a]">{fixError}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant={control ? "warn" : "default"} onClick={() => changeControl(!control)} disabled={modeBusy || (!control && !ready)}>
          <Hand />{control ? t("Rendre la main à l'agent") : t("Prendre le contrôle")}
        </Button>
        <Button variant="outline" onClick={() => { setReconnecting(true); frame.current?.contentWindow?.location.reload(); setRetry((n) => n + 1); }}><RefreshCw />{t("Rafraîchir l'écran")}</Button>
        {(status?.awake || unreachable) && <Button variant="ghost" onClick={() => fix("restart")} disabled={!!fixing}><Power />{t("Redémarrer le navigateur")}</Button>}
        {url && ready && <Button variant="ghost" asChild><a href={url} target="_blank" rel="noopener"><ExternalLink />{t("Plein écran")}</a></Button>}
        <CookieImport agentId={agentId} />
      </div>
      {!overlay && fixError && <p className="text-sm text-danger">{fixError}</p>}
      <p className="text-xs text-muted-foreground">
        {control
          ? t("Tu as la main : clique et tape directement dans l'écran. Ctrl+V y colle ton presse-papiers, Ctrl+C copie la sélection chez toi. Quand tu as fini, rends la main.")
          : t("Lecture seule : l'agent garde la main. Prends le contrôle pour te connecter à un site ou résoudre un CAPTCHA, puis dis-lui de continuer.")}
      </p>
    </>
  );
}
