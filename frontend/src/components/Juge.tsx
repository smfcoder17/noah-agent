// Le juge des actions : qui regarde ce que l'agent veut faire, combien ça coûte, et ce que ça a donné ce mois-ci.
import { useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { ErrorText } from "./ui";
import { t, tr } from "@/i18n";

type Judge = { actif: boolean; modele: string; nom: string; cout_mois: number; appels: number; refus: number; accords: number; pannes: number; tris: number; signales: number; mode?: "agir" | "auto" | "prudent"; seconds_avis?: number; autonomes?: number };

export function JudgeSetting() {
  const [judge, setJudge] = useState<Judge | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get<Judge>("/api/juge").then(setJudge).catch(() => {}); // réservé au propriétaire : sinon, rien à montrer ici
  }, []);
  if (!judge) return null;
  const change = async (choice: { actif?: boolean; mode?: "agir" | "auto" | "prudent" }) => {
    setError("");
    try {
      setJudge(await send<Judge>("/api/juge", choice));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section aria-label={t("Juge des actions")} className="flex flex-col gap-2 rounded-xl border border-border p-4 text-sm">
      <label className="flex cursor-pointer items-start gap-2 font-medium">
        <input type="checkbox" className="mt-1" checked={judge.actif} onChange={(e) => change({ actif: e.target.checked })} />
        {t("Juge des actions")}
      </label>
      <p className="text-muted-foreground">
        {t("Avant qu'un agent agisse dehors, un modèle à part regarde tes derniers messages et l'action, sans rien de ce que l'agent a lu : une page piégée ne l'atteint pas.")}{" "}
        {t("Il laisse passer, te demande ton accord ou refuse. Quand il hésite, le cerveau de l'agent donne un second avis avant de te déranger. Si aucun ne répond, c'est toi qui décides, et rien ne passe en silence.")}
      </p>
      {judge.actif && (
        <fieldset className="flex flex-col gap-1">
          <legend className="font-medium">{t("Autonomie")}</legend>
          <label className="flex cursor-pointer items-start gap-2">
            <input type="radio" name="juge-mode" className="mt-1" checked={(judge.mode ?? "auto") === "agir"} onChange={() => change({ mode: "agir" })} />
            <span>{tr("{nom} : pilote automatique. L'agent fait tout, commandes et clics compris, et te dira ce qu'il a fait après. Seuls les refus nets (effacement de masse, secrets, protections) l'arrêtent : aucune carte n'apparaît.", { nom: <b>{t("Agir")}</b> })}</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input type="radio" name="juge-mode" className="mt-1" checked={(judge.mode ?? "auto") === "auto"} onChange={() => change({ mode: "auto" })} />
            <span>{tr("{nom} : l'agent avance seul, routines comprises. Il ne te demande que ce qui sort vraiment : envoi, publication, paiement, effacement définitif, clic sans but visible, ou action qu'il ne sait pas classer. Tout ce qui reste sur sa machine passe sans toi.", { nom: <b>{t("Auto")}</b> })}</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input type="radio" name="juge-mode" className="mt-1" checked={judge.mode === "prudent"} onChange={() => change({ mode: "prudent" })} />
            <span>{tr("{nom} : une action que le juge ne relie pas à ta demande t'est montrée, même si elle reste sur sa machine.", { nom: <b>{t("Prudent")}</b> })}</span>
          </label>
        </fieldset>
      )}
      <p className="text-muted-foreground">
        {t("Il réduit le risque, il ne le supprime pas : relis ce que tu autorises. Coupé, les refus nets restent (effacement de masse, secrets, protections de l'agent). Aucun agent ne peut le couper.")}
      </p>
      <p className="text-xs text-muted-foreground">
        {[
          t("Modèle : {nom}", { nom: judge.nom || t("aucun pour l'instant") }),
          t("ce mois-ci : {cout} $", { cout: judge.cout_mois.toFixed(4) }),
          t("{n} avis", { n: judge.appels }),
          t("{n} refus", { n: judge.refus }),
          t("{n} accords demandés", { n: judge.accords }),
          judge.seconds_avis ? t("{n} seconds avis", { n: judge.seconds_avis }) : "",
          judge.autonomes ? t("{n} passées en auto", { n: judge.autonomes }) : "",
          judge.pannes > 0 ? t("{n} sans réponse", { n: judge.pannes }) : "",
          t("{n} lectures triées", { n: judge.tris }),
          t("{n} contenus signalés", { n: judge.signales }),
        ].filter(Boolean).join(" · ")}
      </p>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
