import { Check } from "lucide-react";
import type { TacheDuFil } from "@/lib/ouverture";
import { StateShape } from "../Sidebar";
import { t } from "@/i18n";

/**
 * Le bloc « Étapes » d'une tâche ouverte (prototype « Fil calme ») : une ligne par étape, tirée des vrais messages du sous-fil par le serveur.
 * Les étapes faites ont une coche verte ; la dernière porte la pastille d'état de la tâche tant qu'elle n'est pas terminée. Une tâche sans
 * étapes n'a pas de bloc : rien n'est inventé.
 */
export function EtapesTache({ etapes, etat }: { etapes: string[]; etat: TacheDuFil["etat"] }) {
  if (!etapes.length) return null;
  return (
    <section className="list" aria-label={t("Étapes")} data-etapes>
      <div className="list-head">{t("Étapes")}</div>
      {etapes.map((e, i) => {
        const derniere = i === etapes.length - 1 && etat !== "fini";
        return (
          <div key={i} className="row" style={{ minHeight: 44 }} data-etape={derniere ? "etat" : "faite"}>
            <span className="task-state">{derniere ? <StateShape state={etat === "attend" ? "approve" : etat === "echec" ? "error" : "work"} /> : <Check className="size-[18px] text-ok" aria-hidden />}</span>
            <span className="grow">{e}</span>
          </div>
        );
      })}
    </section>
  );
}
