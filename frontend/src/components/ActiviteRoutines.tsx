// Les routines dans Activité (0.4.0, X6) : leurs passages ne s'écrivent plus dans le fil. Un voyant dit ce qui est passé depuis ta dernière
// visite ; un clic ouvre le bilan et les rendus, un clic de plus le détail d'un passage, et « Amener dans le fil » le pose dans la conversation.
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { get, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

export type Routine = { agent?: { id: string; nom: string | null }; id: string; nom: string; quand: string; en_pause: boolean; supprimee: boolean; passages: number; echecs: number; vient: boolean; dernier_a: number | null; bilan: string; dernier_etat: string };
type Passage = { id: number; routine_id: string; nom: string; etat: "ok" | "err"; passe_a: number; duree: number; resume: string; amene: boolean };
type Detail = Passage & { rendu: string; erreur: string };

const PAGE = 50;
export const quand = (s: number) => new Date(s * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const Voyant = () => <span data-voyant className="size-2 shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" aria-hidden />;

export function Bilan({ agentId, routine, onBack, onBrought }: { agentId: string; routine: Routine; onBack: () => void; onBrought: () => void }) {
  const base = `/api/agents/${agentId}`;
  const [passages, setPassages] = useState<Passage[]>([]);
  const [plus, setPlus] = useState(false);
  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [ouvert, setOuvert] = useState<number | null>(null);
  const [brought, setBrought] = useState<Record<number, boolean>>({});
  const haut = useRef<HTMLElement>(null);
  useEffect(() => { haut.current?.scrollIntoView?.({ block: "start" }); }, []); // le bilan s ouvre en haut du panneau, pas au milieu des tâches
  const charger = (avant?: number) => {
    setLoading(true);
    get<{ passages: Passage[]; plus: boolean }>(`${base}/routines-passages?routine=${encodeURIComponent(routine.id)}&limite=${PAGE}${avant ? `&avant=${avant}` : ""}`)
      .then((r) => { setPassages((p) => (avant ? [...p, ...r.passages] : r.passages)); setPlus(r.plus); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { charger(); }, [routine.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ouvrir = (p: Passage) => {
    setOuvert(ouvert === p.id ? null : p.id);
    if (!details[p.id]) get<Detail>(`${base}/routines-passages/${p.id}`).then((d) => setDetails((cur) => ({ ...cur, [p.id]: d }))).catch(() => {});
  };
  const amener = async (p: Passage) => {
    await send(`${base}/routines-passages/${p.id}/amener`, {});
    setBrought((b) => ({ ...b, [p.id]: true }));
    onBrought();
  };
  return (
    <section ref={haut} aria-label={routine.nom} className="stack g24 scroll-mt-2" data-routine-bilan={routine.id}>
      <div className="stack g8">
        <div><button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0 }} onClick={onBack}><ChevronLeft className="size-4" aria-hidden />{t("Activité")}</button></div>
        <h1 className="title">{routine.nom}</h1>
        <p className="soft">{[routine.agent?.nom, routine.quand, t("{n} passages", { n: routine.passages }), routine.echecs ? t("{n} échecs", { n: routine.echecs }) : ""].filter(Boolean).join(" · ")}</p>
      </div>
      <section className="stack g8"><h2 className="h2">{t("Bilan")}</h2><p>{routine.bilan || t("Pas encore passée.")}</p></section>
      <section className="stack g8">
      <h2 className="h2">{t("Passages")}</h2>
      <div className="list">
        {passages.map((p) => {
          const d = details[p.id];
          return (
            <div key={p.id} data-passage={p.id} className="flex flex-col">
              <button type="button" className="row text-left" aria-expanded={ouvert === p.id} onClick={() => ouvrir(p)}>
                <span className="grow flex min-w-0 flex-col">
                  <span className={cn("row-title truncate", p.etat === "err" && "text-destructive")}>{p.resume || t("Passage")}</span>
                  <span className="row-sub">{quand(p.passe_a)}{p.etat === "err" ? ` · ${t("a échoué")}` : ""}</span>
                </span>
                <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", ouvert === p.id && "rotate-90")} aria-hidden />
              </button>
              {ouvert === p.id && (
                <div className="flex flex-col gap-2 px-3 pb-3">
                  <div className="text-sm whitespace-pre-wrap">{d ? (d.etat === "ok" ? d.rendu : d.erreur || d.resume) : <Loader2 className="size-4 animate-spin" aria-label={t("Chargement")} />}</div>
                  <Button size="sm" variant="outline" className="w-fit" disabled={brought[p.id] || p.amene} onClick={() => amener(p)}>{brought[p.id] || p.amene ? t("Déjà dans le fil") : t("Amener dans le fil")}</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {loading && <Loader2 className="size-4 animate-spin" aria-label={t("Chargement")} />}
      {plus && !loading && <Button size="sm" variant="ghost" className="w-fit" onClick={() => charger(passages[passages.length - 1]?.id)}>{t("Voir plus")}</Button>}
      </section>
    </section>
  );
}
