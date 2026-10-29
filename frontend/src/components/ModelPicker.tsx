// Choix du fournisseur et du modèle : groupes recommandés, recherche dans tout le catalogue, budget.
import { Eye, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Catalog, type CurrentModel, get, type Model, type Provider, send, type Usage } from "@/lib/api";
import { cn, contextSize, money } from "@/lib/utils";
import { Button, ErrorText, Input, Label } from "./ui";

const HINTS: Record<string, string> = {
  openrouter: "Des centaines de modèles, une seule clé",
  anthropic: "Claude, directement",
  openai: "GPT, directement",
  gemini: "Gemini, directement",
  ollama: "Modèles locaux et cloud",
};

function ModelCard({ m, selected, onPick }: { m: Model; selected: boolean; onPick: () => void }) {
  const price = m.free ? "Gratuit" : m.price_in == null ? "Prix inconnu" : `${money(m.price_in)} $ · ${money(m.price_out)} $ / M`;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1 rounded-xl border bg-background p-3 text-left transition-colors hover:border-muted-foreground",
        selected && "border-accent bg-accent-soft hover:border-accent",
      )}
    >
      <span className="truncate text-sm font-semibold">{m.name.replace(/^[^:]+:\s*/, "")}</span>
      <code className="truncate font-mono text-[11px] text-muted-foreground">{m.id}</code>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
        <span>{price}</span>
        {m.context ? <span>{contextSize(m.context)}</span> : null}
        {m.size ? <span>{m.size}</span> : null}
        {m.vision && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px"><Eye className="size-3" />Images</span>
        )}
      </span>
    </button>
  );
}

export function ModelPicker({ first, onDone, onCancel }: { first?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [current, setCurrent] = useState<CurrentModel>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [budget, setBudget] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, c, u] = await Promise.all([
        get<Provider[]>("/api/providers"),
        first ? Promise.resolve(null) : get<CurrentModel>("/api/model"),
        first ? Promise.resolve(null) : get<Usage>("/api/usage"),
      ]);
      setProviders(p);
      setCurrent(c);
      setUsage(u);
      setBudget(u?.budget != null ? String(u.budget) : "");
      setProvider(p.find((x) => x.id === c?.provider) || p[0]);
      if (c) setPicked({ id: c.model, name: c.model });
    })().catch((e) => setError(e.message));
  }, [first]);

  const load = useCallback(async (p: Provider, key: string) => {
    setLoading(true);
    setError("");
    try {
      setCatalog(await send<Catalog>("/api/models", { provider: p.id, api_key: key || null }));
    } catch (e) {
      setCatalog(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (provider) load(provider, "");
  }, [provider, load]);

  const choose = (p: Provider) => {
    setQuery("");
    setApiKey("");
    if (p.id !== current?.provider) setPicked(null);
    setProvider(p);
  };

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!catalog || !q) return null;
    return catalog.models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)).slice(0, 60);
  }, [catalog, query]);

  const save = async () => {
    if (!provider || !picked) return setError("Choisis un modèle dans la liste.");
    setSaving(true);
    setError("");
    try {
      await send("/api/budget", { monthly: budget === "" ? null : Number(budget) });
      await send("/api/model", { provider: provider.id, api_key: apiKey || null, model: picked.id });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const keySaved = current?.provider === provider?.id && current?.has_key;

  return (
    <div className="flex flex-col gap-5">
      <div role="radiogroup" aria-label="Fournisseur" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
        {providers.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={provider?.id === p.id}
            onClick={() => choose(p)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-xl border bg-background px-3 py-2.5 text-left",
              provider?.id === p.id && "border-accent bg-accent-soft",
            )}
          >
            <span className="text-sm font-semibold">{p.label}</span>
            <span className="text-xs text-muted-foreground">{HINTS[p.id]}</span>
          </button>
        ))}
      </div>

      {provider?.needs_key && (
        <div className="flex items-end gap-2">
          <Label className="flex-1">
            Clé API
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keySaved ? "Clé enregistrée (laisser vide pour la garder)" : "Colle ta clé ici"}
            />
          </Label>
          <Button variant="outline" onClick={() => provider && load(provider, apiKey)}>Afficher les modèles</Button>
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          className="pl-9"
          placeholder="Rechercher un modèle (claude, gemini, deepseek…)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Rechercher un modèle"
        />
      </div>

      <div className="flex min-h-32 flex-col gap-5">
        {loading && <p className="text-sm text-muted-foreground">Chargement des modèles…</p>}
        {!loading && catalog && !catalog.models.length && (
          <p className="text-sm text-muted-foreground">
            {catalog.needs_key ? "Colle ta clé API puis « Afficher les modèles »." : "Aucun modèle disponible."}
          </p>
        )}
        {!loading &&
          catalog &&
          (results ? [{ id: "r", title: "Résultats", hint: results.length ? "" : "Aucun résultat.", models: results }] : catalog.groups).map((g) => (
            <section key={g.id} className="flex flex-col gap-2">
              <div>
                <h3 className="text-sm font-semibold">{g.title}</h3>
                {g.hint && <p className="text-xs text-muted-foreground">{g.hint}</p>}
              </div>
              <div role="radiogroup" className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
                {g.models.map((m) => (
                  <ModelCard key={m.id} m={m} selected={picked?.id === m.id} onPick={() => setPicked({ id: m.id, name: m.name })} />
                ))}
              </div>
            </section>
          ))}
        {!loading && catalog && !results && catalog.models.length > 0 && (
          <p className="text-xs text-muted-foreground">{catalog.models.length} modèles disponibles : la recherche les couvre tous.</p>
        )}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-muted-foreground">Modèle choisi</span>
          <strong className="truncate text-sm">{picked ? picked.id : "aucun"}</strong>
          {usage && (
            <span className="text-xs text-muted-foreground">Dépensé ce mois-ci : {money(usage.month_cost)} $</span>
          )}
        </div>
        <Label className="w-40">
          Budget mensuel ($)
          <Input type="number" min={0} step={1} placeholder="Illimité" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="outline" onClick={onCancel}>Annuler</Button>}
        <Button onClick={save} disabled={saving || !picked}>
          {saving ? (first ? "Création de ton premier agent…" : "Application aux agents…") : "Enregistrer"}
        </Button>
      </div>
    </div>
  );
}
