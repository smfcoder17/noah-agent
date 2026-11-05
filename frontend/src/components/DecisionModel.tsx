// Réglages > Cerveau : le petit modèle qui décide à la place du cerveau (tri du chat, veilles, routines, mémoire).
// Noah le choisit seul à la pose de la clé, puis chaque semaine ; la personne voit pourquoi et peut en changer.
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";

type Option = { modele: string; nom: string; prix_entree: number | null };
type Candidate = Option & { ms: number | null; ok: boolean; erreur: string };
type DecisionState = {
  modele: string | null;
  nom: string | null;
  secours: boolean | null;
  raison: string | null;
  prix_entree: number | null;
  ms: number | null;
  choisi_par: "auto" | "toi" | null;
  candidats: Candidate[] | null;
  options: Option[] | null;
  cerveau: string;
  en_cours: boolean;
  mesure: boolean;
};

const price = (v: number | null | undefined) =>
  v === null || v === undefined ? null : `${v < 0.1 ? v.toFixed(3).replace(/0$/, "") : v.toFixed(2)} $/M`.replace(".", ",");

/** « X, choisi parce que moins cher, 0,05 $/M, 420 ms » : la raison d'abord, les chiffres ensuite. */
function why(s: DecisionState) {
  const facts = [price(s.prix_entree), s.ms !== null && s.ms !== undefined ? `${s.ms} ms` : null].filter(Boolean);
  if (s.choisi_par === "toi") return [s.raison, ...facts].join(", ");
  if (s.secours || !facts.length) return s.raison;
  return [`choisi parce que ${s.raison}`, ...facts].join(", ");
}

export function DecisionModel() {
  const [state, setState] = useState<DecisionState | null>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => get<DecisionState>("/api/decision").then(setState).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load]);
  // Le premier choix se fait en arrière-plan juste après la pose de la clé.
  useEffect(() => {
    if (!state || (state.mesure && !state.en_cours)) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [state, load]);

  const act = async (path: string, body: object) => {
    setBusy(true);
    setError("");
    try {
      setState(await send<DecisionState>(path, body));
      setChanging(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const list = state.options ?? [];
  const failed = (state.candidats ?? []).filter((c) => !c.ok);
  return (
    <section aria-label="Modèle de décision" className="flex flex-col gap-2 rounded-2xl border border-border p-4 text-sm">
      {state.mesure ? (
        <p>
          <span className="font-semibold">Modèle de décision : </span>
          <span className="font-mono">{state.nom}</span>
          {why(state) && <span className="text-muted-foreground">, {why(state)}.</span>}{" "}
          <button type="button" className="cursor-pointer underline" onClick={() => setChanging(!changing)}>Changer</button>
        </p>
      ) : (
        <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />Noah regarde ce que ta clé offre, ses prix et sa vitesse…</p>
      )}
      <p className="text-xs text-muted-foreground">
        Il trie tes messages, juge les nouveautés des veilles et des routines, relit les notes de mémoire. Le cerveau ne se réveille que pour le vrai travail.
        Ces appels comptent dans ton suivi et ton plafond.
      </p>
      {state.secours && <p className="rounded-xl bg-warn-soft p-3 text-warn">{state.raison}</p>}
      {changing && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Modèle de décision"
            disabled={busy}
            value={state.choisi_par === "toi" ? (state.modele ?? "auto") : "auto"}
            onChange={(e) => act("/api/decision", { modele: e.target.value })}
            className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm"
          >
            <option value="auto">Automatique : Noah choisit chaque semaine</option>
            {list.map((o) => (
              <option key={o.modele} value={o.modele}>{o.nom}{price(o.prix_entree) ? ` · ${price(o.prix_entree)}` : ""}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => act("/api/decision/mesurer", {})}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}Mesurer à nouveau
          </Button>
          {failed.length > 0 && (
            <p className="w-full text-xs text-muted-foreground">
              Écartés au dernier essai : {failed.map((c) => `${c.nom} (${c.erreur.replace(/\.$/, "").toLowerCase()})`).join(", ")}.
            </p>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
