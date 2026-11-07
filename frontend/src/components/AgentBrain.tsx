// Cerveau propre à un agent, dans Détails : par défaut celui de tous ; sinon un mode (celui des Réglages) ou n'importe quel modèle du
// fournisseur, et son niveau de raisonnement. Le fournisseur et la clé restent ceux des Réglages.
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { type CurrentModel, get, send } from "@/lib/api";
import { MODE_NAMES, type ModeId, type ModesState, readableModel, REASONING } from "@/lib/modes";
import { ModelSearch } from "./Modes";
import { Button, ErrorText } from "./ui";

const AGENT_MODES: ModeId[] = ["fast", "balanced", "smart", "gratuit", "custom"];

export function AgentBrain({ agentId, own, mode, reasoning, onChanged, openKey = 0, bare = false }: { agentId: string; own: string | null | undefined; mode?: string | null; reasoning?: string | null; onChanged: () => void; openKey?: number; bare?: boolean }) {
  const [base, setBase] = useState<CurrentModel>(null);
  const [state, setState] = useState<ModesState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get<CurrentModel>("/api/model").then(setBase).catch(() => {});
  }, []);
  useEffect(() => {
    if (openKey) setOpen(true); // la carte « Modèle » du résumé ouvre directement le choix
  }, [openKey]);
  useEffect(() => {
    if (open && !state) get<ModesState>("/api/modes/cerveau").then(setState).catch((e) => setError((e as Error).message));
  }, [open, state]);

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
    if (await change(body)) setOpen(false);
  };

  const usable = (id: ModeId) => {
    if (!state) return false;
    if (id === "gratuit") return state.gratuit.length > 0;
    if (id === "custom") return state.custom.length > 0;
    return !!state.modes.find((m) => m.id === id)?.modele;
  };
  const current = own || base?.model || "—";
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className={bare ? "hidden" : "flex items-center gap-2"}>
        <span className="text-muted-foreground">Modèle :</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={current}>{mode ? MODE_NAMES[mode as ModeId] ?? mode : readableModel(current)}</span>
        {!own && !mode && base && <span className="text-xs text-muted-foreground">(celui de tous)</span>}
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Fermer" : "Changer"}</Button>
      </div>
      {open && (
        <div className={bare ? "flex flex-col gap-2" : "flex flex-col gap-2 rounded-lg border border-border p-2.5"}>
          {!bare && <p className="text-xs text-muted-foreground">Pour cet agent seulement. C'est immédiat : ses conversations restent.</p>}
          <div className="flex flex-wrap gap-1.5">
            <Button variant={!own && !mode ? "default" : "outline"} size="sm" disabled={busy} onClick={() => pick({ model: null })}>Celui de tous</Button>
            {AGENT_MODES.map((id) => (
              <Button key={id} variant={mode === id ? "default" : "outline"} size="sm" disabled={busy || !usable(id)} onClick={() => pick({ mode: id })}>{MODE_NAMES[id]}</Button>
            ))}
          </div>
          <ModelSearch level="cerveau" selected={!mode ? own : null} onPick={(m) => pick({ model: m.id })} />
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            Réflexion
            <select
              value={reasoning ?? ""}
              disabled={busy}
              onChange={(e) => change({ raisonnement: e.target.value || null })}
              className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm text-foreground"
            >
              <option value="">Par défaut</option>
              {REASONING.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          {busy && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Un instant…</p>}
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}
