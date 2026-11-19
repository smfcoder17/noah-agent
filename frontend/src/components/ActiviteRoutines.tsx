// Les routines dans Activité (0.4.0, X6) : leurs passages ne s'écrivent plus dans le fil. Un voyant dit ce qui est passé depuis ta dernière
// visite ; un clic ouvre le bilan et les rendus, un clic de plus le détail d'un passage, et « Amener dans le fil » le pose dans la conversation.
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { get, send } from "@/lib/api";
import { SeenActive, seenGeneration } from "@/lib/seen";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

type Routine = { id: string; nom: string; quand: string; en_pause: boolean; supprimee: boolean; passages: number; echecs: number; vient: boolean; dernier_a: number | null; bilan: string; dernier_etat: string };
type Passage = { id: number; routine_id: string; nom: string; etat: "ok" | "err"; passe_a: number; duree: number; resume: string; amene: boolean };
type Detail = Passage & { rendu: string; erreur: string };

const PAGE = 50;
const quand = (s: number) => new Date(s * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const Voyant = () => <span data-voyant className="size-2 shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" aria-hidden />;

export function ActiviteRoutines({ agentId, refreshKey, onBrought }: { agentId: string; refreshKey: number; onBrought: () => void }) {
  const active = useContext(SeenActive);
  const base = `/api/agents/${agentId}`;
  const [data, setData] = useState<{ agent: string; routines: Routine[]; non_vues: number } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    if (!active) return;
    const generation = seenGeneration();
    get<{ routines: Routine[]; non_vues: number }>(`${base}/routines-activite`)
      .then((r) => { if (current && generation === seenGeneration()) setData({ agent: agentId, ...r }); })
      .catch(() => {});
    return () => { current = false; };
  }, [active, base, agentId, refreshKey]);
  const mine = data?.agent === agentId ? data : null;
  if (!mine?.routines.length) return null;
  const routine = mine.routines.find((r) => r.id === open);
  const voir = (r: Routine) => {
    setOpen(r.id);
    if (mine.non_vues) send<{ non_vues: number }>(`${base}/routines-vues`, {}).then((v) => setData((d) => (d ? { ...d, non_vues: v.non_vues } : d))).catch(() => {});
  };
  if (routine) return <Bilan agentId={agentId} routine={routine} onBack={() => setOpen(null)} onBrought={onBrought} />;
  return (
    <section aria-label={t("Routines")} className="flex flex-col gap-1.5" data-routines-activite>
      <h3 className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("Routines")}
        {mine.non_vues > 0 && <Voyant />}
      </h3>
      {mine.non_vues > 0 && <p className="text-sm text-muted-foreground">{t("{n} passées depuis ta dernière visite", { n: mine.non_vues })}</p>}
      <div className="list">
        {mine.routines.map((r) => (
          <button key={r.id} type="button" className="row text-left" data-routine={r.id} onClick={() => voir(r)}>
            <span className="grow flex min-w-0 flex-col">
              <span className="row-title flex items-center gap-2 truncate">
                {r.vient && <Voyant />}
                {r.nom}
              </span>
              <span className="row-sub truncate">{[r.quand, r.bilan].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{t("{n} passages", { n: r.passages })}</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </button>
        ))}
      </div>
    </section>
  );
}

function Bilan({ agentId, routine, onBack, onBrought }: { agentId: string; routine: Routine; onBack: () => void; onBrought: () => void }) {
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
    <section ref={haut} aria-label={routine.nom} className="flex scroll-mt-2 flex-col gap-2" data-routine-bilan={routine.id}>
      <button type="button" className="flex w-fit items-center gap-1 text-sm text-muted-foreground" onClick={onBack}><ChevronLeft className="size-4" aria-hidden />{t("Activité")}</button>
      <h3 className="text-base font-semibold">{routine.nom}</h3>
      <p className="text-xs text-muted-foreground">{[routine.quand, t("{n} passages", { n: routine.passages }), routine.echecs ? t("{n} échecs", { n: routine.echecs }) : ""].filter(Boolean).join(" · ")}</p>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Bilan")}</h4>
      <p className="text-sm">{routine.bilan || t("Pas encore passée.")}</p>
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Passages")}</h4>
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
  );
}
