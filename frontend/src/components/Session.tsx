// Barre de session : d'un coup d'œil, ce que l'agent fait en ce moment (travaux, processus, routines, demandes, tâches
// confiées) et ses derniers fichiers. Un clic ouvre le fil ou l'aperçu, dans le panneau.
import { Clock, FileText, Laptop, Loader2, MessageSquare, Send, Terminal } from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import { get, type WorkspaceFile } from "@/lib/api";
import { SeenActive } from "@/lib/seen";
import { useAgentData } from "@/lib/useAgentData";
import { messageMoment } from "@/lib/utils";
import { type DelegatedTask, delegatedState, minutes } from "./DelegatedTasks";
import { FilePreview } from "./FilePreview";
import { t } from "@/i18n";

export type AgentSession = {
  travaux: { id: string; titre: string; origine: string; main: boolean; etat: "work" | "approve"; activite: string | null }[];
  processus: { id: string; titre: string; debut: number; conversation_id: string }[];
  demandes: { id: string; agent: string; titre: string; debut: number }[];
  confiees: DelegatedTask[];
  routines: { id: string; titre: string; depuis: string | null }[];
};

/** Relevé toutes les deux secondes : une tâche lancée s'affiche en moins de trois, et part à sa fin. */
export const SESSION_POLL = 2000;
const RECENT = 6;

type Row = { key: string; icon: React.ReactNode; title: string; detail: string; tone?: string; onOpen?: () => void };

function since(at: number | null | undefined, now: number) {
  return at ? t("depuis {duree}", { duree: minutes(Math.max(0, Math.round(now / 1000 - at))) }) : "";
}

export function Session({ agentId, withFiles, refreshKey, onOpenThread }: { agentId: string; withFiles: boolean; refreshKey: number; onOpenThread: (id: string | null) => void }) {
  const active = useContext(SeenActive);
  const [data, setData] = useState<{ agent: string; session: AgentSession } | null>(null);
  const [error, setError] = useState("");
  // L'aperçu appartient à l'agent pour qui il a été ouvert : un autre agent ne l'hérite pas (relecture 0.3.0, partie 1 n°1).
  const [previewed, setPreviewed] = useState<{ agent: string; path: string; size: number } | null>(null);
  const preview = previewed?.agent === agentId ? previewed : null;
  const setPreview = (f: { path: string; size: number } | null) => setPreviewed(f && { ...f, agent: agentId });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => {
      if (document.hidden) return;
      get<AgentSession>(`/api/agents/${agentId}/session`)
        .then((s) => { if (live) { setData({ agent: agentId, session: s }); setError(""); setNow(Date.now()); } })
        .catch((e) => { if (live) setError((e as Error).message); });
    };
    read();
    const timer = setInterval(read, SESSION_POLL);
    return () => { live = false; clearInterval(timer); };
  }, [agentId, active]);
  const session = data?.agent === agentId ? data.session : null;

  const rows = useMemo<Row[]>(() => {
    if (!session) return [];
    const out: Row[] = [];
    for (const w of session.travaux) out.push({
      key: `w${w.id}`, icon: <MessageSquare size={16} aria-hidden />, title: w.main ? t("Conversation principale") : w.titre,
      detail: w.etat === "approve" ? t("Attend ton accord") : w.activite || t("Travaille"), tone: w.etat === "approve" ? "text-warn" : "text-accent",
      onOpen: () => onOpenThread(w.main ? null : w.id),
    });
    for (const p of session.processus) out.push({
      key: `p${p.id}`, icon: <Terminal size={16} aria-hidden />, title: p.titre,
      detail: [t("Processus en arrière-plan"), since(p.debut, now)].filter(Boolean).join(" · "), onOpen: () => onOpenThread(p.conversation_id),
    });
    for (const r of session.routines) out.push({ key: `r${r.id}`, icon: <Clock size={16} aria-hidden />, title: r.titre, detail: t("Routine en cours") });
    for (const d of session.demandes) out.push({
      key: `d${d.id}`, icon: <Send size={16} aria-hidden />, title: d.titre, detail: [t("Demande à {agent}", { agent: d.agent }), since(d.debut, now)].filter(Boolean).join(" · "),
    });
    for (const c of session.confiees) out.push({
      key: `c${c.id}`, icon: <Laptop size={16} aria-hidden />, title: t("Tâche confiée à Claude Code sur {appareil}", { appareil: c.appareil }),
      detail: `${c.dossier} · ${delegatedState(c)}`, tone: c.etat === "en_cours" ? "text-accent" : c.etat === "fini" ? "text-ok" : "text-danger",
    });
    return out;
  }, [session, now, onOpenThread]);


  if (preview) return <FilePreview agentId={agentId} path={preview.path} size={preview.size} backLabel={t("Retour à la session")} onBack={() => setPreview(null)} />;
  const running = rows.length;
  return (
    <div className="session-bar flex flex-col gap-4">
      <section aria-labelledby="session-now" className="flex flex-col gap-1.5">
        <h3 id="session-now" className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("En cours")}{session && <span className="tabular-nums" aria-label={t("{n} en cours", { n: running })}>{running}</span>}
        </h3>
        {!session && !error && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />{t("Chargement…")}</p>}
        {error && !session && <p role="alert" className="text-sm text-danger">{error}</p>}
        {session && !running && <p className="text-sm text-muted-foreground">{t("Rien en cours. Ce que l'agent lance en arrière-plan s'affichera ici.")}</p>}
        <ul className="flex flex-col gap-1" aria-live="polite">
          {rows.map((r) => {
            const body = <><span className="session-icon">{r.icon}</span><span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-sm font-medium">{r.title}</span><span className={`truncate text-xs ${r.tone ?? "text-muted-foreground"}`}>{r.detail}</span></span></>;
            return <li key={r.key} data-session={r.key[0]}>{r.onOpen ? <button type="button" className="session-row" onClick={r.onOpen}>{body}</button> : <div className="session-row">{body}</div>}</li>;
          })}
        </ul>
      </section>
      {withFiles && <RecentFiles agentId={agentId} refreshKey={refreshKey} onPreview={setPreview} />}
    </div>
  );
}

/** Les derniers fichiers créés ou reçus : un clic les ouvre en aperçu, sans quitter la session. */
function RecentFiles({ agentId, refreshKey, onPreview }: { agentId: string; refreshKey: number; onPreview: (f: { path: string; size: number }) => void }) {
  const { data: files } = useAgentData<WorkspaceFile[]>(`/api/agents/${agentId}/files`, { freshOnReload: false, refreshKey });
  const recent = useMemo(() => (files ? [...files].sort((a, b) => b.modified - a.modified).slice(0, RECENT) : []), [files]);
  return (
    <section aria-labelledby="session-files" className="flex flex-col gap-1.5">
      <h3 id="session-files" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Derniers fichiers")}</h3>
      {files && !recent.length && <p className="text-sm text-muted-foreground">{t("Aucun fichier pour l'instant.")}</p>}
      <ul className="flex flex-col gap-1">
        {recent.map((f) => (
          <li key={f.path}>
            <button type="button" className="session-row" onClick={() => onPreview({ path: f.path, size: f.size })} title={f.path}>
              <span className="session-icon"><FileText size={16} aria-hidden /></span>
              <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-sm font-medium">{f.path.split("/").pop()}</span><span className="truncate text-xs text-muted-foreground">{messageMoment(new Date(f.modified * 1000))} · {f.path.split("/").slice(0, -1).join("/") || "/"}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
