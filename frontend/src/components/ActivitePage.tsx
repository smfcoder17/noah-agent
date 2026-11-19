// Activité en page entière (0.4.0, prototype « Fil calme », écran `activite`) : tout ce que font tes agents, tous confondus. Les tâches
// (qui l'a confiée à qui, où elle en est), les routines (un voyant, ce qui est passé depuis ta dernière visite, un bilan par routine) et
// ce que tes agents ont décidé à ta place. Elle s'ouvre dans la zone de travail comme « Pour toi », depuis la barre de gauche.
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { get, send } from "@/lib/api";
import { useOuverture, type TacheDuFil } from "@/lib/ouverture";
import { Bilan, type Routine, Voyant } from "./ActiviteRoutines";
import { Decisions } from "./Decisions";
import { StateShape } from "./Sidebar";
import { duree, travailleur } from "./thread/TacheLigne";

type Donnees = { taches: TacheDuFil[]; routines: Routine[]; non_vues: number };
const AGENT = (r: Routine) => r.agent?.id ?? "";

/** Le sous-titre d'une tâche : « Noah l'a confiée à Léa · terminée en 4 min » ; une tâche que l'agent s'est donnée dit seulement qui la fait. */
function sousTitre(x: TacheDuFil): string {
  const qui = travailleur(x, "");
  const de = x.demandeur?.nom;
  return [de && de !== qui ? t("{de} l'a confiée à {a}", { de, a: qui }) : qui, duree(x)].filter(Boolean).join(" · ");
}

export function ActivitePage({ agentId, onOpenTache, onOpenAgent }: {
  /** L'agent affiché derrière la page : sa lecture de l'ouverture dit quand tout est à relire. */
  agentId: string | null;
  /** Une tâche : le fil de son agent, la tâche ouverte. */
  onOpenTache: (agentId: string, conversationId: string) => void;
  /** « Amener dans le fil » : le fil de cet agent. */
  onOpenAgent: (agentId: string) => void;
}) {
  const [data, setData] = useState<Donnees | null>(null);
  const [erreur, setErreur] = useState(false);
  const [routine, setRoutine] = useState<{ agentId: string; id: string } | null>(null);
  const revision = useOuverture(agentId ?? "")?.revision;
  const vues = useRef(new Set<string>());
  const lire = useCallback(() => {
    setErreur(false);
    get<Donnees>("/api/activite").then(setData).catch(() => setErreur(true));
  }, []);
  useEffect(() => { lire(); }, [lire, revision]);
  /** Ces passages sont lus : le voyant de la barre s'éteint. Une fois par agent. */
  const marquer = (agent: string) => {
    if (!agent || vues.current.has(agent)) return;
    vues.current.add(agent);
    send(`/api/agents/${agent}/routines-vues`, {}).catch(() => vues.current.delete(agent));
  };
  const aMarquer = useRef<Routine[]>([]);
  aMarquer.current = (data?.routines ?? []).filter((r) => r.vient);
  useEffect(() => () => { aMarquer.current.forEach((r) => marquer(AGENT(r))); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- à la sortie de la page : tout ce qui y était nouveau est vu
  useEffect(() => { haut.current?.scrollTo?.({ top: 0 }); }, [routine]);
  const haut = useRef<HTMLDivElement>(null);

  const ouverte = routine ? data?.routines.find((r) => r.id === routine.id && AGENT(r) === routine.agentId) : null;
  const vide = data && !data.taches.length && !data.routines.length;
  let corps: React.ReactNode;
  if (erreur && !data) {
    corps = (
      <div className="empty" role="alert">
        <h2>{t("Ça n'a pas chargé")}</h2>
        <p className="soft">{t("Noah n'a pas pu lire cette page. Tes données ne sont pas touchées.")}</p>
        <button type="button" className="btn" onClick={lire}>{t("Réessayer")}</button>
      </div>
    );
  } else if (!data) {
    corps = <div className="stack g16" aria-busy="true" aria-label={t("Chargement")}><div className="skel" style={{ height: 18, width: "92%" }} /><div className="skel" style={{ height: 44 }} /><div className="skel" style={{ height: 18, width: "64%" }} /><div className="skel" style={{ height: 44 }} /></div>;
  } else if (ouverte) {
    corps = <Bilan agentId={routine!.agentId} routine={ouverte} onBack={() => setRoutine(null)} onBrought={() => onOpenAgent(routine!.agentId)} />;
  } else {
    corps = (
      <div className="stack g32">
        <h2 className="title">{t("Activité")}</h2>
        {vide && <div className="empty"><h2>{t("Rien pour l'instant")}</h2><p className="soft">{t("Les tâches confiées, les routines et ce que tes agents décident à ta place apparaîtront ici.")}</p></div>}
        {data.taches.length > 0 && (
          <section className="stack g8" aria-label={t("Tâches")} data-activite-taches>
            <h2 className="h2">{t("Tâches")}</h2>
            <div className="list">
              {data.taches.map((x) => (
                <button key={x.id} type="button" className="row text-left" data-tache={x.id} data-etat={x.etat} onClick={() => onOpenTache(x.agent.id, x.conversation_id)}>
                  <span className="task-state">{x.etat === "fini" ? <Check className="size-[18px] text-ok" aria-hidden /> : <StateShape state={x.etat === "attend" ? "approve" : x.etat === "echec" ? "error" : "work"} />}</span>
                  <span className="grow stack min-w-0"><span className="row-title">{x.titre}</span><span className="row-sub">{sousTitre(x)}</span></span>
                  <ChevronRight className="chev" aria-hidden />
                </button>
              ))}
            </div>
          </section>
        )}
        {data.routines.length > 0 && (
          <section className="stack g8" aria-label={t("Routines")} data-routines-activite>
            <div className="line g8">
              <h2 className="h2">{t("Routines")}</h2>
              {data.non_vues > 0 && <><span className="dot glow" data-voyant role="img" aria-label={t("Des routines viennent de passer")} /><span className="small soft text-[13px] text-muted-foreground">{t("{n} passées depuis ta dernière visite", { n: data.non_vues })}</span></>}
            </div>
            <div className="list">
              {data.routines.map((r) => (
                <button key={`${AGENT(r)}-${r.id}`} type="button" className="row text-left" data-routine={r.id} onClick={() => { setRoutine({ agentId: AGENT(r), id: r.id }); marquer(AGENT(r)); }}>
                  {r.vient ? <Voyant /> : <span className="dot" aria-hidden />}
                  <span className="grow stack min-w-0">
                    <span className="row-title">{r.nom}</span>
                    <span className="row-sub">{[r.agent?.nom, r.quand, r.bilan].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="task-meta">{t("{n} passages", { n: r.passages })}</span>
                  <ChevronRight className="chev" aria-hidden />
                </button>
              ))}
            </div>
          </section>
        )}
        <Decisions agentId={agentId ?? ""} refreshKey={0} />
      </div>
    );
  }
  return (
    <main className="chat-pane" aria-label={t("Activité")}>
      <header className="head"><div className="head-title flex min-w-0 grow items-center gap-2"><h1 className="cut">{ouverte ? t("Routine") : t("Activité")}</h1></div></header>
      <div ref={haut} className="min-h-0 flex-1 overflow-y-auto">
        <div className="col narrow stack g16">
          {corps}
          {data && erreur && <p role="alert" className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline size-4" aria-hidden />{t("Ça n'a pas chargé")}</p>}
        </div>
      </div>
    </main>
  );
}
