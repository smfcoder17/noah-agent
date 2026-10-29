// Panneau de droite : Détails de l'agent, ses Fichiers, et son Ordinateur (écran du navigateur en direct).
import { Download, ExternalLink, Eye, Hand, MonitorPlay, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Agent, get, mediaUrl, rawFileUrl, type Usage, type WorkspaceFile } from "@/lib/api";
import { cn, fileSize, money } from "@/lib/utils";
import { Button, Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";

export type PanelTab = "details" | "files" | "computer";

export function SidePanel({
  agent,
  model,
  tab,
  onTab,
  onClose,
  onEditAgent,
  refreshKey,
}: {
  agent: Agent;
  model: string;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
  onEditAgent: () => void;
  refreshKey: number;
}) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as PanelTab)} className="flex h-full min-h-0 flex-col gap-3 p-3 pt-[max(12px,env(safe-area-inset-top))]">
      <div className="flex items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="details">Détails</TabsTrigger>
          <TabsTrigger value="files">Fichiers</TabsTrigger>
          <TabsTrigger value="computer">Ordinateur</TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer le panneau"><X /></Button>
      </div>
      <TabsContent value="details" className="min-h-0 flex-1 overflow-y-auto">
        <Details agent={agent} model={model} onEdit={onEditAgent} refreshKey={refreshKey} />
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

function Details({ agent, model, onEdit, refreshKey }: { agent: Agent; model: string; onEdit: () => void; refreshKey: number }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    get<Usage>("/api/usage").then(setUsage).catch(() => {});
  }, [agent.id, refreshKey]);
  const mine = usage?.agents.find((u) => u.agent_id === agent.id);
  const cacheRate = mine?.prompt_tokens ? Math.round((100 * mine.cached_tokens) / mine.prompt_tokens) : 0;
  return (
    <div className="flex flex-col gap-4 px-1">
      <div className="flex items-center gap-3">
        <div className="grid size-12 place-items-center rounded-full bg-accent text-lg font-semibold text-accent-foreground">
          {agent.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold">{agent.name}</p>
          <p className="text-sm text-muted-foreground">{agent.step || (agent.online ? "En ligne" : "Hors ligne")}</p>
        </div>
      </div>
      <div className="text-sm"><span className="text-muted-foreground">Modèle : </span><span className="font-mono text-[13px]">{model || "—"}</span></div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Coût ce mois-ci" value={`${money(mine?.cost ?? 0)} $`} />
        <Stat label="Appels au modèle" value={mine?.calls ?? 0} />
        <Stat label="Jetons" value={(mine?.tokens ?? 0).toLocaleString("fr-CA")} />
        <Stat label="Lus depuis le cache" value={`${cacheRate} %`} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rôle</span>
        <p className="text-sm whitespace-pre-wrap">{agent.role || "Aucun rôle précis."}</p>
      </div>
      <Button variant="outline" onClick={onEdit}>Modifier le nom et le rôle</Button>
    </div>
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

function Computer({ agentId }: { agentId: string }) {
  const [control, setControl] = useState(false);
  const [url, setUrl] = useState("");
  const [nonce, setNonce] = useState(0);
  const [awake, setAwake] = useState<boolean | null>(null);

  // L'écran n'existe que quand le navigateur tourne : il s'éteint après quelques minutes sans activité.
  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      get<{ awake: boolean }>(`/api/agents/${agentId}/screen-status`)
        .then((s) => !cancelled && setAwake(s.awake))
        .catch(() => !cancelled && setAwake(false));
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    get<{ url: string }>(`/api/agents/${agentId}/screen-url?view_only=${control ? 0 : 1}`)
      .then((r) => !cancelled && setUrl(r.url))
      .catch(() => !cancelled && setUrl(""));
    return () => {
      cancelled = true;
    };
  }, [agentId, control, nonce]);

  return (
    <>
      <div className={cn("relative min-h-64 flex-1 overflow-hidden rounded-xl border border-border bg-[#0b0f14]", control && awake && "ring-3 ring-warn")}>
        {url && awake ? (
          <iframe key={`${url}-${nonce}`} src={url} title="Écran de l'agent" className="absolute inset-0 size-full border-0" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-[#e6ebf0]">
            <MonitorPlay className="size-8 opacity-60" />
            <strong>{awake === null ? "Connexion à l'écran…" : "L'ordinateur est en veille"}</strong>
            {awake === false && (
              <span className="max-w-xs text-sm opacity-70">
                Le navigateur s'allume dès que l'agent en a besoin. Demande-lui d'ouvrir une page pour le voir ici.
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant={control ? "warn" : "default"} onClick={() => setControl(!control)}>
          <Hand />{control ? "Rendre la main à l'agent" : "Prendre le contrôle"}
        </Button>
        <Button variant="outline" onClick={() => setNonce((n) => n + 1)}><RefreshCw />Rafraîchir</Button>
        {url && (
          <Button variant="outline" asChild>
            <a href={url} target="_blank" rel="noopener"><ExternalLink />Plein écran</a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {control
          ? "Tu as la main : clique et tape directement dans l'écran. Quand tu as fini, rends la main et dis à l'agent de continuer."
          : "Lecture seule : l'agent garde la main. Prends le contrôle pour te connecter à un site ou résoudre un CAPTCHA, puis dis-lui de continuer."}
      </p>
    </>
  );
}
