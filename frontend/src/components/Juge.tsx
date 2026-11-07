// Le juge des actions : qui regarde ce que l'agent veut faire, combien ça coûte, et ce que ça a donné ce mois-ci.
import { useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { ErrorText } from "./ui";

type Judge = { actif: boolean; modele: string; nom: string; cout_mois: number; appels: number; refus: number; accords: number; pannes: number; tris: number; signales: number };

export function JudgeSetting() {
  const [judge, setJudge] = useState<Judge | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get<Judge>("/api/juge").then(setJudge).catch(() => {}); // réservé au propriétaire : sinon, rien à montrer ici
  }, []);
  if (!judge) return null;
  const change = async (actif: boolean) => {
    setError("");
    try {
      setJudge(await send<Judge>("/api/juge", { actif }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section aria-label="Juge des actions" className="flex flex-col gap-2 rounded-xl border border-border p-4 text-sm">
      <label className="flex cursor-pointer items-start gap-2 font-medium">
        <input type="checkbox" className="mt-1" checked={judge.actif} onChange={(e) => change(e.target.checked)} />
        Juge des actions
      </label>
      <p className="text-muted-foreground">
        Avant qu'un agent agisse dehors, un modèle à part regarde tes derniers messages et l'action, sans rien de ce que l'agent a lu : une page piégée ne l'atteint pas.
        Il laisse passer, te demande ton accord ou refuse. S'il ne répond pas, c'est toi qui décides, et rien ne passe en silence.
      </p>
      <p className="text-muted-foreground">
        Il réduit le risque, il ne le supprime pas : relis ce que tu autorises. Coupé, les refus nets restent (effacement de masse, secrets, protections de l'agent). Aucun agent ne peut le couper.
      </p>
      <p className="text-xs text-muted-foreground">
        Modèle : {judge.nom || "aucun pour l'instant"} · ce mois-ci : {judge.cout_mois.toFixed(4)} $ · {judge.appels} avis · {judge.refus} refus · {judge.accords} accords demandés
        {judge.pannes > 0 ? ` · ${judge.pannes} sans réponse` : ""} · {judge.tris} lectures triées · {judge.signales} contenus signalés
      </p>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
