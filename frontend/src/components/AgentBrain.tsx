// Cerveau propre à un agent, dans Détails : par défaut celui de tous ; sinon un niveau (rapide, équilibré, le plus
// fort) ou n'importe quel modèle du fournisseur. Le fournisseur et la clé restent ceux des Réglages.
import { Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type Catalog, type CurrentModel, get, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button, ErrorText, Input } from "./ui";

const TIERS = [
  { id: "fast", name: "Rapide" },
  { id: "balanced", name: "Équilibré" },
  { id: "smart", name: "Le plus fort" },
];

export function AgentBrain({ agentId, own, onChanged }: { agentId: string; own: string | null | undefined; onChanged: () => void }) {
  const [base, setBase] = useState<CurrentModel>(null);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    get<CurrentModel>("/api/model").then(setBase).catch(() => {});
  }, []);
  useEffect(() => {
    if (open && base && !catalog) send<Catalog>("/api/models", { provider: base.provider }).then(setCatalog).catch((e) => setError(e.message));
  }, [open, base, catalog]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && catalog ? catalog.models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)).slice(0, 30) : [];
  }, [catalog, query]);

  const pick = async (model: string | null) => {
    setBusy(true);
    setError("");
    try {
      await send(`/api/agents/${agentId}/model`, { model }, "PUT");
      setOpen(false);
      setQuery("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const current = own || base?.model || "—";
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">Cerveau :</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={current}>{current}</span>
        {!own && base && <span className="text-xs text-muted-foreground">(celui de tous)</span>}
        <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Fermer" : "Changer"}</Button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
          <p className="text-xs text-muted-foreground">
            Un cerveau pour cet agent seulement. Il redémarre avec, ses conversations restent.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button variant={!own ? "default" : "outline"} size="sm" disabled={busy} onClick={() => pick(null)}>Celui de tous</Button>
            {catalog &&
              TIERS.map((t) => {
                const models = catalog.groups.find((g) => g.id === t.id)?.models ?? [];
                const m = t.id === "smart" ? models[0] : [...models].sort((a, b) => b.created - a.created)[0];
                return m ? (
                  <Button key={t.id} variant={own === m.id ? "default" : "outline"} size="sm" disabled={busy} title={m.id} onClick={() => pick(m.id)}>
                    {t.name}
                  </Button>
                ) : null;
              })}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-8" placeholder="Chercher un modèle précis…" aria-label="Chercher un modèle" />
          </div>
          {!catalog && !error && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Catalogue…</p>}
          {results.length > 0 && (
            <ul className="flex max-h-56 flex-col overflow-y-auto">
              {results.map((m) => (
                <li key={m.id}>
                  <button type="button" disabled={busy} onClick={() => pick(m.id)}
                    className={cn("w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[13px] hover:bg-muted", own === m.id && "bg-muted")}>
                    {m.id}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {busy && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />L'agent redémarre avec ce cerveau…</p>}
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}
