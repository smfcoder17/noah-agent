// Réglages > Modèles et budget > Cerveau : le modèle qui décide à la place du cerveau (veilles, routines, mémoire, choix du modèle d'une image).
// Les vrais modèles de décision (Jev, Clef…) ne rédigent rien et coûtent presque rien ; un petit modèle garde ce qui s'écrit.
// Noah choisit seul à la pose de la clé, puis chaque semaine ; la personne voit pourquoi et peut en changer.
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { Button, ErrorText, Input, Label } from "./ui";

type Option = { modele: string; nom: string; prix_entree: number | null };
type Candidate = Option & { ms: number | null; ok: boolean; erreur: string };
type TypedOption = Option & { id: string; service: string };
type DecisionState = {
  modele: string | null;
  nom: string | null;
  secours: boolean | null;
  raison: string | null;
  prix_entree: number | null;
  ms: number | null;
  choisi_par: "auto" | "toi" | null;
  candidats: Candidate[] | null;
  cerveau: string;
  en_cours: boolean;
  mesure: boolean;
  type: (TypedOption & { ms: number | null; choisi_par: "auto" | "toi" }) | null;
  decisions: TypedOption[];
  ecartes: Candidate[];
  aucun: boolean;
  petits: Option[];
  cles: { openrouter: boolean; typesafe: boolean; openai: boolean };
};

const price = (v: number | null | undefined) =>
  v === null || v === undefined ? null : `${v === 0 ? "0" : v < 0.1 ? v.toFixed(3).replace(/0$/, "") : v.toFixed(2)} $/M`.replace(".", ",");

const WHERE: Record<string, string> = { openrouter: "OpenRouter", typesafe: "TypeSafe", openai: "OpenAI" };

/** « X, choisi parce que moins cher, 0,05 $/M, 420 ms » : la raison d'abord, les chiffres ensuite. */
function why(s: DecisionState) {
  const facts = [price(s.prix_entree), s.ms !== null && s.ms !== undefined ? `${s.ms} ms` : null].filter(Boolean);
  if (s.choisi_par === "toi") return [s.raison, ...facts].join(", ");
  if (s.secours || !facts.length) return s.raison;
  return [`choisi parce que ${s.raison}`, ...facts].join(", ");
}

function typedWhy(t: NonNullable<DecisionState["type"]>) {
  const facts = [`par ${WHERE[t.service] ?? t.service}`];
  return [t.choisi_par === "toi" ? "choisi par toi" : "choisi parce qu'il est le moins cher à répondre juste", ...facts].join(", ");
}

export function DecisionModel() {
  const [state, setState] = useState<DecisionState | null>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
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

  const act = async (path: string, body: object, keepOpen = false) => {
    setBusy(true);
    setError("");
    try {
      setState(await send<DecisionState>(path, body));
      if (!keepOpen) setChanging(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveKey = async (value: string) => {
    if (await act("/api/decision/cle", { cle: value }, true)) setKey("");
  };

  if (!state) return null;
  const failed = [...(state.ecartes ?? []), ...(state.candidats ?? []).filter((c) => !c.ok)];
  const chosen = state.type?.choisi_par === "toi" ? state.type.id : state.choisi_par === "toi" && state.aucun ? (state.modele ?? "auto") : "auto";
  const small = state.petits.some((o) => o.modele === state.modele) || state.choisi_par !== "toi" || !state.modele ? state.petits : [{ modele: state.modele, nom: state.nom ?? state.modele, prix_entree: state.prix_entree }, ...state.petits];
  const noKey = !state.cles.openrouter && !state.cles.typesafe && !state.cles.openai;
  return (
    <section aria-label="Modèle de décision" className="flex flex-col gap-2 rounded-2xl border border-border p-4 text-sm">
      {!state.mesure ? (
        <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" />Noah regarde ce que ta clé offre, ses prix et sa vitesse…</p>
      ) : state.type ? (
        <p>
          <span className="font-semibold">Modèle de décision : </span>
          <span className="font-mono">{state.type.nom}</span>
          <span className="text-muted-foreground">, {typedWhy(state.type)}.</span>{" "}
          <button type="button" className="cursor-pointer underline" onClick={() => setChanging(!changing)}>Changer</button>
        </p>
      ) : (
        <p>
          <span className="font-semibold">Modèle de décision : </span>
          <span className="font-mono">{state.nom}</span>
          {why(state) && <span className="text-muted-foreground">, {why(state)}.</span>}{" "}
          <button type="button" className="cursor-pointer underline" onClick={() => setChanging(!changing)}>Changer</button>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Il juge les nouveautés des veilles et des routines, relit les notes de mémoire, choisit le modèle d'une image. Le cerveau ne se réveille que pour le vrai travail.
        Ces appels comptent dans ton suivi et ton plafond.{state.type && state.nom ? ` Ce qui demande d'écrire (résumés, titres) reste à ${state.nom}.` : ""}
      </p>
      {!state.type && state.secours && <p className="rounded-xl bg-warn-soft p-3 text-warn">{state.raison}</p>}
      {changing && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Modèle de décision"
              disabled={busy}
              value={chosen}
              onChange={(e) => act("/api/decision", { modele: e.target.value })}
              className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm"
            >
              <option value="auto">Automatique : Noah choisit chaque semaine</option>
              {state.decisions.length > 0 && (
                <optgroup label="Modèles de décision (presque gratuits, ne rédigent rien)">
                  {state.decisions.map((o) => <option key={o.id} value={o.id}>{o.nom}{price(o.prix_entree) ? ` · ${price(o.prix_entree)}` : ""}</option>)}
                </optgroup>
              )}
              {small.length > 0 && (
                <optgroup label="Petits modèles (savent aussi écrire, plus chers)">
                  {small.map((o) => <option key={o.modele} value={o.modele}>{o.nom}{price(o.prix_entree) ? ` · ${price(o.prix_entree)}` : ""}</option>)}
                </optgroup>
              )}
            </select>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => act("/api/decision/mesurer", {})}>
              {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}Mesurer à nouveau
            </Button>
          </div>
          {noKey && <p className="text-xs text-muted-foreground">Une clé OpenRouter (Réglages &gt; Voix) ouvre Jev et Clef sans rien d'autre. Sinon, une clé TypeSafe ci-dessous.</p>}
          <div className="flex flex-wrap items-end gap-2">
            <Label className="min-w-0 flex-1">
              Clé TypeSafe pour Jev (facultative)
              <Input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={state.cles.typesafe ? "Clé enregistrée (colle une autre clé pour la remplacer)" : "Inutile si tu as une clé OpenRouter"}
              />
            </Label>
            <Button variant="outline" size="sm" disabled={busy || !key.trim()} onClick={() => saveKey(key)}>Vérifier et enregistrer</Button>
            {state.cles.typesafe && <Button variant="ghost" size="sm" disabled={busy} onClick={() => saveKey("")}>Retirer</Button>}
          </div>
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
