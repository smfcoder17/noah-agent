// Panneau de droite : Détails de l'agent, ses Fichiers, et son Ordinateur (écran du navigateur en direct).
import { Archive, ArchiveRestore, ChevronDown, Download, ExternalLink, Eye, Hand, Loader2, LogIn, MonitorPlay, Power, RefreshCw, Sunrise, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Agent, canAdmin, canTalk, type Conversation, get, mediaUrl, rawFileUrl, send, type Usage, type WorkspaceFile } from "@/lib/api";
import { wireClipboard } from "@/lib/vncClipboard";
import { cn, fileSize, money } from "@/lib/utils";
import { AgentBrain } from "./AgentBrain";
import { Connections, Folders, Memory, Routines, Software, Watches } from "./AgentPowers";
import { NoahTile, agentColor } from "./Noah";
import { ShareDialog } from "./Sharing";
import { STATE_WORD, StateShape } from "./Sidebar";
import { Button, Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";

export type PanelTab = "details" | "files" | "computer";

export function SidePanel({
  agent,
  onAgentChanged,
  tab,
  onTab,
  onClose,
  onEditAgent,
  refreshKey,
  threads,
  main,
  onConversationChanged,
  threadId,
  onOpenThread,
  onArchiveThread,
}: {
  agent: Agent;
  /** Après un changement de cerveau : la liste des agents est relue. */
  onAgentChanged: () => void;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onEditAgent: () => void;
  refreshKey: number;
  threads: Conversation[];
  /** La conversation principale de ce compte avec l'agent. */
  main: Conversation | null;
  onConversationChanged: () => void;
  threadId: string | null;
  onOpenThread: (id: string | null) => void;
  onArchiveThread: (id: string, archived: boolean) => void;
}) {
  const admin = canAdmin(agent);
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as PanelTab)} className="flex h-full min-h-0 flex-col gap-3 p-3 pt-[max(12px,env(safe-area-inset-top))]">
      <div className="flex items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="details">Détails</TabsTrigger>
          {canTalk(agent) && <TabsTrigger value="files">Fichiers</TabsTrigger>}
          {admin && <TabsTrigger value="computer">Ordinateur</TabsTrigger>}
        </TabsList>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer le panneau"><X /></Button>
      </div>
      <TabsContent value="details" className="min-h-0 flex-1 overflow-y-auto">
        <Details agent={agent} onEdit={onEditAgent} refreshKey={refreshKey} onAgentChanged={onAgentChanged}>
          <Threads threads={threads} threadId={threadId} onOpen={onOpenThread} onArchive={onArchiveThread} />
          {agent.partage && main && <ConversationVisibility conversation={main} onChanged={onConversationChanged} />}
          {admin && (
            <>
              <Routines agentId={agent.id} />
              <Watches agentId={agent.id} />
              <Memory agentId={agent.id} />
              <Connections agentId={agent.id} shared={agent.partage || !!agent.partage_par} />
              <Folders agentId={agent.id} />
              <Software agentId={agent.id} />
            </>
          )}
        </Details>
      </TabsContent>
      <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto">
        <Files agentId={agent.id} refreshKey={refreshKey} />
      </TabsContent>
      <TabsContent value="computer" className="flex min-h-0 flex-1 flex-col gap-3">
        {tab === "computer" && <Computer agentId={agent.id} />}
      </TabsContent>
    </Tabs>
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

function Details({ agent, onEdit, refreshKey, onAgentChanged, children }: { agent: Agent; onEdit: () => void; refreshKey: number; onAgentChanged: () => void; children: React.ReactNode }) {
  const [sharing, setSharing] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    get<Usage>("/api/usage").then(setUsage).catch(() => {});
  }, [agent.id, refreshKey]);
  const mine = usage?.agents.find((u) => u.agent_id === agent.id);
  const cacheRate = mine?.prompt_tokens ? Math.round((100 * mine.cached_tokens) / mine.prompt_tokens) : 0;
  return (
    <div className="flex flex-col gap-4 px-1">
      <div className="flex items-center gap-3">
        <NoahTile color={agentColor(agent)} className="size-14" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{agent.name}</p>
          <p className="text-sm text-muted-foreground">{agent.step || (agent.online ? "En ligne" : "Hors ligne")}</p>
          {agent.partage_par && <p className="text-xs text-muted-foreground">Partagé par {agent.partage_par} · droit : {agent.droit}</p>}
        </div>
        {agent.droit === "proprietaire" && (
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => setSharing(true)}><Users />Partager</Button>
        )}
      </div>
      <ShareDialog agent={agent} open={sharing} onOpenChange={setSharing} onChanged={onAgentChanged} />
      {children}
      {canAdmin(agent) && <AgentBrain key={agent.id} agentId={agent.id} own={agent.model} onChanged={onAgentChanged} />}
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Coût ce mois-ci" value={`${money(mine?.cost ?? 0)} $`} />
        <Stat label="Appels au modèle" value={mine?.calls ?? 0} />
        <Stat label="Jetons" value={(mine?.tokens ?? 0).toLocaleString("fr-CA")} />
        <Stat label="Lus depuis le cache" value={`${cacheRate} %`} />
      </div>
      {usage && <Spending usage={usage} agentId={agent.id} />}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rôle</span>
        <p className="text-sm whitespace-pre-wrap">{agent.role || "Aucun rôle précis."}</p>
      </div>
      {canAdmin(agent) && <Button variant="outline" onClick={onEdit}>Personnaliser (nom, couleur, rôle)</Button>}
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
        Dépense
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

/** Fils de l'agent : travaux parallèles qu'il a ouverts. Les vieux et les archivés restent repliés. */
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
  const [showArchived, setShowArchived] = useState(false);
  const active = threads.filter((t) => !t.archived);
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
          {STATE_WORD[t.state] || "en pause"}
          {t.de ? <span className="text-muted-foreground"> · conversation de {t.de}</span>
            : t.origin === "agent" && <span className="text-muted-foreground"> · ouvert par l'agent</span>}
        </span>
      </button>
      {!t.de && <Button
        variant="ghost"
        size="icon-sm"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
        Fils de travail <span className="normal-case tracking-normal">{active.length || ""}</span>
      </h3>
      {active.length ? (
        active.map(row)
      ) : (
        <p className="text-sm text-muted-foreground">Aucun fil en cours. L'agent en ouvre un quand il mène un travail en parallèle.</p>
      )}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
            className="mt-1 flex cursor-pointer items-center gap-1.5 self-start rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", !showArchived && "-rotate-90")} />
            Archivés ({archived.length})
          </button>
          {showArchived && <div className="flex flex-col gap-0.5 opacity-80">{archived.map(row)}</div>}
        </>
      )}
    </section>
  );
}

const GROUPS: [string, string][] = [
  ["outputs/", "Livrables"],
  ["apps/", "Applications"],
  ["captures/", "Captures"],
  ["uploads/", "Envoyés par toi"],
  ["", "Autres fichiers"],
];

function Files({ agentId, refreshKey }: { agentId: string; refreshKey: number }) {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);

  const load = useCallback(() => {
    get<WorkspaceFile[]>(`/api/agents/${agentId}/files`)
      .then((f) => { setFiles(f); setError(""); })
      .catch((e) => setError(e.message));
  }, [agentId]);
  useEffect(load, [load, refreshKey]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!files) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (!files.length) return <p className="text-sm text-muted-foreground">Aucun fichier pour l'instant. Ce que l'agent crée et ce que tu lui envoies apparaîtra ici.</p>;

  const used = new Set<string>();
  const sections = GROUPS.map(([prefix, title]) => {
    const group = files.filter((f) => !used.has(f.path) && f.path.startsWith(prefix));
    group.forEach((f) => used.add(f.path));
    // Une application = un dossier : on montre son index.html.
    const items = prefix === "apps/" ? group.filter((f) => /^apps\/[^/]+\/index\.html$/.test(f.path)) : group;
    return { prefix, title, items };
  }).filter((s) => s.items.length);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw />Actualiser</Button>
      </div>
      {sections.map((s) => (
        <section key={s.title} className="flex flex-col gap-1">
          <h3 className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{s.title}</h3>
          {s.items.slice(0, 100).map((f) => {
            const isApp = s.prefix === "apps/";
            const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.path);
            const canPreview = isApp || isImage || /\.(html?|pdf|txt|md|csv|json|svg)$/i.test(f.path);
            const name = isApp ? f.path.split("/")[1] : f.path.replace(/^(outputs|uploads|captures)\//, "");
            const raw = rawFileUrl(agentId, f.path);
            return (
              <div key={f.path} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted">
                {isImage && (
                  <img src={mediaUrl(agentId, `/opt/data/workspace/${f.path}`)} alt="" loading="lazy" className="size-9 rounded-md border border-border object-cover" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm" title={f.path}>{name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{fileSize(f.size)}</span>
                {canPreview && (
                  <Button variant="outline" size="sm" onClick={() => setPreview({ title: name, url: raw })}>
                    <Eye />{isApp ? "Ouvrir" : "Aperçu"}
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" asChild>
                  <a href={`${raw}?download=1`} aria-label={`Télécharger ${name}`}><Download /></a>
                </Button>
              </div>
            );
          })}
        </section>
      ))}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        {preview && (
          <DialogContent title={preview.title} className="h-[min(85dvh,860px)] max-w-5xl p-4">
            <div className="flex justify-end">
              <Button variant="outline" size="sm" asChild>
                <a href={preview.url} target="_blank" rel="noopener"><ExternalLink />Ouvrir dans un onglet</a>
              </Button>
            </div>
            <iframe
              src={preview.url}
              title={preview.title}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              className="min-h-0 flex-1 rounded-lg border border-border bg-white"
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

type ScreenStatus = { awake: boolean; reachable: boolean; running: boolean; tabs: number };

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
  const [control, setControl] = useState(false);
  const [url, setUrl] = useState("");
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [fixing, setFixing] = useState<"wake" | "restart" | null>(null);
  const [fixError, setFixError] = useState("");

  const poll = useCallback(
    () =>
      get<ScreenStatus>(`/api/agents/${agentId}/screen-status`)
        .then(setStatus)
        .catch(() => setStatus({ awake: false, reachable: false, running: false, tabs: 0 })),
    [agentId],
  );
  useEffect(() => {
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  useEffect(() => {
    let cancelled = false;
    get<{ url: string }>(`/api/agents/${agentId}/screen-url?view_only=${control ? 0 : 1}`)
      .then((r) => !cancelled && setUrl(r.url))
      .catch(() => !cancelled && setUrl(""));
    return () => {
      cancelled = true;
      // Panneau fermé ou agent changé pendant la prise de contrôle : le serveur rend les captures à l'agent.
      if (control) void get(`/api/agents/${agentId}/screen-url?view_only=1`).catch(() => {});
    };
  }, [agentId, control, nonce]);

  const fix = async (how: "wake" | "restart") => {
    setFixing(how);
    setFixError("");
    try {
      const s = await send<{ ecran_actif: boolean; conseil: string }>(`/api/agents/${agentId}/browser/${how}`, {});
      if (!s.ecran_actif) setFixError(s.conseil);
      setNonce((n) => n + 1);
    } catch (e) {
      setFixError((e as Error).message);
    } finally {
      setFixing(null);
      poll();
    }
  };

  // Sans page ouverte, l’écran est noir : on le traite comme en veille.
  const awake = !!status?.awake;
  const visible = awake && (status?.tabs ?? 0) > 0;
  return (
    <>
      <div className={cn("relative min-h-64 flex-1 overflow-hidden rounded-xl border border-border bg-[#0b0f14]", control && awake && "ring-3 ring-warn")}>
        {url && visible && !fixing ? (
          <iframe key={`${url}-${nonce}`} src={url} title="Écran de l'agent" className="absolute inset-0 size-full border-0" onLoad={(e) => wireClipboard(e.currentTarget, agentId, setFixError)} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[#e6ebf0]">
            {fixing ? <Loader2 className="size-8 animate-spin opacity-70" /> : <MonitorPlay className="size-8 opacity-60" />}
            <strong>
              {fixing === "wake"
                ? "Réveil du navigateur…"
                : fixing === "restart"
                  ? "Redémarrage du navigateur…"
                  : status === null
                    ? "Connexion à l'écran…"
                    : !status.reachable
                      ? "Le navigateur ne répond pas"
                      : awake
                        ? "Aucune page ouverte"
                        : "Le navigateur est en veille"}
            </strong>
            {!fixing && status && (
              <>
                <span className="max-w-xs text-sm opacity-70">
                  {status.reachable
                    ? "Il s'éteint après un moment sans activité et se rallume dès que l'agent navigue."
                    : "Son conteneur est arrêté ou planté. Un redémarrage garde tes sessions connectées."}
                </span>
                <div className="flex flex-wrap justify-center gap-2">
                  {status.reachable && (
                    <Button onClick={() => fix("wake")}><Sunrise />{awake ? "Ouvrir une page" : "Réveiller"}</Button>
                  )}
                  <Button variant={status.reachable ? "outline" : "default"} className={status.reachable ? "border-white/30 bg-transparent text-white hover:bg-white/10" : ""} onClick={() => fix("restart")}>
                    <Power />Redémarrer
                  </Button>
                </div>
              </>
            )}
            {fixError && <span className="max-w-xs text-sm text-[#fbbf8a]">{fixError}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant={control ? "warn" : "default"} onClick={() => setControl(!control)} disabled={!visible}>
          <Hand />{control ? "Rendre la main à l'agent" : "Prendre le contrôle"}
        </Button>
        <Button variant="outline" onClick={() => setNonce((n) => n + 1)}><RefreshCw />Rafraîchir l'écran</Button>
        {awake && (
          <Button variant="ghost" onClick={() => fix("restart")} disabled={!!fixing}><Power />Redémarrer le navigateur</Button>
        )}
        {url && visible && (
          <Button variant="ghost" asChild>
            <a href={url} target="_blank" rel="noopener"><ExternalLink />Plein écran</a>
          </Button>
        )}
        <CookieImport agentId={agentId} />
      </div>
      <p className="text-xs text-muted-foreground">
        {control
          ? "Tu as la main : clique et tape directement dans l'écran. Ctrl+V y colle ton presse-papiers, Ctrl+C copie la sélection chez toi. Quand tu as fini, rends la main."
          : "Lecture seule : l'agent garde la main. Prends le contrôle pour te connecter à un site ou résoudre un CAPTCHA, puis dis-lui de continuer."}
      </p>
    </>
  );
}
