// « Décidé pour toi » (0.4.0, lot L2) : ce que tes agents ont réglé entre eux à ta place, dans Activité. Chaque ligne se corrige ; la
// correction enregistrée devient une règle, et la même question reçoit ensuite cette réponse sans te déranger.
import { useContext, useEffect, useState } from "react";
import { t } from "@/i18n";
import { type Decision, get } from "@/lib/api";
import { useOuverture } from "@/lib/ouverture";
import { SeenActive, seenGeneration } from "@/lib/seen";
import { type ACorriger, CorrigerDialog, DECISION_CORRIGEE } from "./Corriger";

const SHOWN = 5;

export function Decisions({ agentId, refreshKey }: { agentId: string; refreshKey: number }) {
  const active = useContext(SeenActive);
  const revision = useOuverture(agentId)?.revision;
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [corriger, setCorriger] = useState<ACorriger | null>(null);
  const [shown, setShown] = useState(SHOWN);
  useEffect(() => {
    let current = true;
    if (!active) return;
    const generation = seenGeneration();
    get<{ decisions: Decision[] }>("/api/decisions").then((r) => { if (current && generation === seenGeneration()) setDecisions(r.decisions); }).catch(() => {});
    return () => { current = false; };
  }, [active, refreshKey, revision]);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ id: string; correction: string }>).detail; if (d?.id) setCorrections((cur) => ({ ...cur, [d.id]: d.correction })); };
    window.addEventListener(DECISION_CORRIGEE, on);
    return () => window.removeEventListener(DECISION_CORRIGEE, on);
  }, []);
  if (!decisions?.length) return null;
  return (
    <section aria-label={t("Décidé pour toi")} className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("Décidé pour toi")}</h3>
      <div className="list">
        {decisions.slice(0, shown).map((d) => {
          const corrigee = corrections[d.id] ?? (d.corrigee ? d.correction : "");
          return (
            <div key={d.id} className="row flex-wrap" data-decision={d.id}>
              <span className="grow flex min-w-0 flex-col" style={{ minWidth: 200 }}>
                <span className="row-title">{d.titre}</span>
                <span className="row-sub">{corrigee ? t("Corrigé par toi : {texte}", { texte: corrigee }) : t("{qui} a répondu : {reponse}", { qui: d.par, reponse: d.reponse })}</span>
              </span>
              <button type="button" className="btn btn-sm" onClick={() => setCorriger({ id: d.id, question: d.titre, reponse: corrigee || d.reponse, qui: t("{a} a répondu à {de}", { a: d.par, de: d.de_nom }) })}>{t("Corriger")}</button>
            </div>
          );
        })}
      </div>
      {decisions.length > shown && (
        <button type="button" onClick={() => setShown(shown + 10)} className="cursor-pointer self-start rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          {t("… voir {n} de plus", { n: Math.min(10, decisions.length - shown) })}
        </button>
      )}
      <CorrigerDialog cible={corriger} onClose={() => setCorriger(null)} />
    </section>
  );
}
