// Cerveau propre à un agent : Auto (le niveau suit chaque demande), un mode, le réglage de tous ses agents, ou un modèle précis,
// et son niveau de réflexion. Les trois niveaux d'Auto sont ceux des modes Rapide, Équilibré et Le plus fort, pour tous les agents.
import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type CurrentModel, get, send } from "@/lib/api";
import { MODE_NAMES, type ModeId, type ModesState, modeName, readableModel, REASONING, type TierId } from "@/lib/modes";
import { cn } from "@/lib/utils";
import { ModelSearch } from "./Modes";
import { Button, ErrorText } from "./ui";

const OTHER_MODES: ModeId[] = ["fast", "balanced", "smart", "gratuit", "custom"];
const AUTO_LEVELS: [TierId, string][] = [["fast", "Simple"], ["balanced", "Moyen"], ["smart", "Complexe"]];

export function AgentBrain({ agentId, own, mode, reasoning, onChanged, openKey = 0, bare = false }: { agentId: string; own: string | null | undefined; mode?: string | null; reasoning?: string | null; onChanged: () => void; openKey?: number; bare?: boolean }) {
  const [base, setBase] = useState<CurrentModel>(null);
  const [state, setState] = useState<ModesState | null>(null);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState<TierId | "precis" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get<CurrentModel>("/api/model").then(setBase).catch(() => {});
  }, []);
  useEffect(() => {
    if (openKey) setOpen(true); // la carte « Modèle » du résumé ouvre directement le choix
  }, [openKey]);
  useEffect(() => {
    if ((open || bare) && !state) get<ModesState>("/api/modes/cerveau").then(setState).catch((e) => setError((e as Error).message));
  }, [open, bare, state]);

  const change = async (body: object) => {
    setBusy(true);
    setError("");
    try {
      await send(`/api/agents/${agentId}/model`, body, "PUT");
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const pick = async (body: object) => {
    if (await change(body)) {
      setChoosing(null);
      if (!bare) setOpen(false);
    }
  };
  /** Le modèle d'un niveau, pour tous les agents (Réglages > Modèles et budget, mêmes données). */
  const setTier = async (tier: TierId, modele: string, fournisseur: string) => {
    setBusy(true);
    setError("");
    try {
      setState(await send<ModesState>("/api/modes/cerveau", { mode: tier, modele, fournisseur }, "PUT"));
      setChoosing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tierModel = (id: TierId) => state?.modes.find((m) => m.id === id)?.modele ?? null;
  const usable = (id: ModeId | "auto") => {
    if (!state) return false;
    if (id === "auto") return AUTO_LEVELS.some(([t]) => tierModel(t));
    if (id === "gratuit") return state.gratuit.length > 0;
    if (id === "custom") return state.custom.length > 0;
    return !!tierModel(id);
  };
  const current = own || base?.model || "—";
  const chosen = mode || (own ? "precis" : "tous");

  const Row = ({ id, name, under, onPick, disabled }: { id: string; name: string; under?: React.ReactNode; onPick: () => void; disabled?: boolean }) => (
    <button type="button" role="radio" aria-checked={chosen === id} disabled={busy || disabled} onClick={onPick}
      className={cn("flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50", chosen === id && "bg-accent-soft/40")}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{name}</span>
        {under && <span className="block truncate text-xs text-muted-foreground">{under}</span>}
      </span>
      {chosen === id && <Check className="size-4 shrink-0 text-accent" />}
    </button>
  );

  const panel = (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Modèle de l'agent" className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        <div>
          <Row id="auto" name="Auto" under="Le bon modèle pour chaque demande" onPick={() => pick({ mode: "auto" })} disabled={!usable("auto")} />
          {state && (
            <ul className="flex flex-col gap-1 px-3 pb-3">
              {AUTO_LEVELS.map(([tier, label]) => (
                <li key={tier} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
                    <span className="min-w-0 flex-1 truncate font-medium" title={tierModel(tier)?.nom}>{tierModel(tier) ? readableModel(tierModel(tier)!.modele) : "—"}</span>
                    <button type="button" className="cursor-pointer text-accent hover:underline" onClick={() => setChoosing(choosing === tier ? null : tier)}>
                      {choosing === tier ? "Fermer" : "Changer"}
                    </button>
                  </div>
                  {choosing === tier && <ModelSearch level="cerveau" selected={tierModel(tier)?.modele} onPick={(m) => setTier(tier, m.id, m.fournisseur)} />}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Row id="tous" name="Comme tous mes agents" under={readableModel(base?.model || "")} onPick={() => pick({ model: null })} />
        {OTHER_MODES.map((id) => <Row key={id} id={id} name={MODE_NAMES[id]} onPick={() => pick({ mode: id })} disabled={!usable(id)} />)}
        <Row id="precis" name="Un modèle précis" under={own && !mode ? readableModel(own) : undefined} onPick={() => setChoosing(choosing === "precis" ? null : "precis")} />
      </div>
      {choosing === "precis" && <ModelSearch level="cerveau" selected={!mode ? own || base?.model : null} onPick={(m) => pick({ model: m.id })} />}
      <label className="flex items-center gap-2 text-sm">
        <span className="shrink-0">Réflexion</span>
        <select value={reasoning ?? ""} disabled={busy} onChange={(e) => change({ raisonnement: e.target.value || null })}
          className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm text-foreground">
          <option value="">Par défaut</option>
          {REASONING.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      {busy && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Un instant…</p>}
      <ErrorText>{error}</ErrorText>
    </div>
  );

  if (bare) return panel;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Modèle :</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={current}>{mode ? modeName(mode) : readableModel(current)}</span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Fermer" : "Changer"}</Button>
      </div>
      {open && panel}
    </div>
  );
}
