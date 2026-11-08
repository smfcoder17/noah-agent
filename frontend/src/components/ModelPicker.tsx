// Choix du cerveau : fournisseur (replié une fois la clé enregistrée), puis un niveau ou un modèle précis, puis le budget.
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Catalog, type CurrentModel, get, type Provider, send, type Usage } from "@/lib/api";
import { TIERS } from "@/lib/modes";
import { cn, money } from "@/lib/utils";
import { costLabel, ModelRow, ModeRows, shortName } from "./Modes";
import { ProviderLogo } from "./ProviderLogo";
import { Button, ErrorText, Input, Label } from "./ui";

const HINTS: Record<string, string> = {
  openrouter: "Des centaines de modèles, une seule clé",
  anthropic: "Claude, directement",
  openai: "GPT, directement",
  gemini: "Gemini, directement",
  ollama: "Modèles locaux et cloud",
};

/** Le modèle proposé pour un niveau. « Le plus fort » : le modèle phare du premier grand labo (ordre du catalogue).
 * Les autres : le plus récent de la gamme, pour ne pas proposer une génération dépassée. */
const tierModel = (catalog: Catalog, tier: string) => {
  const models = catalog.groups.find((g) => g.id === tier)?.models ?? [];
  return tier === "smart" ? models[0] : [...models].sort((a, b) => b.created - a.created)[0];
};

export function ModelPicker({ first, onDone, onCancel }: { first?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [current, setCurrent] = useState<CurrentModel>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [budget, setBudget] = useState("");
  const [daily, setDaily] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"tier" | "precise">("tier");
  const [onlyVision, setOnlyVision] = useState(false);
  const [onlyFree, setOnlyFree] = useState(false);
  const [changingProvider, setChangingProvider] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, c, u] = await Promise.all([
        get<Provider[]>("/api/providers"),
        // Aussi pendant l'assistant : revenir changer de modèle après un essai raté garde les budgets déjà posés.
        get<CurrentModel>("/api/model"),
        get<Usage>("/api/usage"),
      ]);
      setProviders(p);
      setCurrent(c);
      setUsage(u);
      setBudget(u?.budget != null ? String(u.budget) : "");
      setDaily(u?.daily != null ? String(u.daily) : "");
      // Premier lancement : aucun fournisseur choisi d'avance (l'utilisateur choisit où partent ses données).
      setProvider(p.find((x) => x.id === c?.provider) || (first ? null : p[0]));
      setBaseUrl(c?.base_url || "");
      if (c?.model) setPicked({ id: c.model, name: c.model });
    })().catch((e) => setError(e.message));
  }, [first]);

  const load = useCallback(async (p: Provider, key: string, url = "") => {
    setLoading(true);
    setError("");
    try {
      setCatalog(await send<Catalog>("/api/models", { provider: p.id, api_key: key || null, base_url: url || null }));
    } catch (e) {
      setCatalog(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Un service à adresse attend qu'on l'ait saisie, sauf Ollama sur cette machine et une adresse déjà enregistrée.
    if (provider && provider.id !== "custom") load(provider, "");
    else if (provider && current?.provider === "custom") load(provider, "");
    else setCatalog(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      await send("/api/budget", { monthly: budget === "" ? null : Number(budget), daily: daily === "" ? null : Number(daily) });
      await send("/api/model", { provider: provider.id, api_key: apiKey || null, model: picked.id, base_url: provider.own_url ? baseUrl || null : null });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const keySaved = current?.provider === provider?.id && current?.has_key;
  // Fournisseur déjà en service : une rangée par mode, réglable. Sinon (premier choix, autre fournisseur), les niveaux proposés.
  const rows = !first && !!keySaved && !changingProvider;
  const onModeChanged = useCallback((model: string) => setPicked({ id: model, name: model }), []);
  // Le modèle actuel n'est pas un niveau proposé : on ouvre directement la liste précise.
  useEffect(() => {
    if (!rows && catalog && picked && !TIERS.some((t) => tierModel(catalog, t.id)?.id === picked.id)) setMode("precise");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);
  const tiers = TIERS.map((t) => ({ ...t, model: catalog ? tierModel(catalog, t.id) : undefined })).filter((t) => t.model);
  const pickedTier = tiers.find((t) => t.model!.id === picked?.id)?.id;
  const precise = mode === "precise" || !tiers.length;
  const list = useMemo(() => {
    if (!catalog) return [];
    let ms = results ?? catalog.groups.flatMap((g) => g.models).filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
    if (onlyVision) ms = ms.filter((m) => m.vision);
    if (onlyFree) ms = ms.filter((m) => m.free);
    return ms.slice(0, 60);
  }, [catalog, results, onlyVision, onlyFree]);

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Fournisseur : replié une fois la clé enregistrée */}
      {keySaved && !changingProvider ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm">
          <span className="flex-1"><strong>{provider?.label}</strong> <span className="text-muted-foreground">· clé enregistrée et chiffrée</span></span>
          <Button variant="outline" size="sm" onClick={() => setChangingProvider(true)}>Changer</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
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
                  provider?.id === p.id && "border-accent bg-accent-soft ring-1 ring-accent",
                )}
              >
                <span className="text-sm font-semibold">{p.label}</span>
                <span className="text-xs text-muted-foreground">{HINTS[p.id]}</span>
              </button>
            ))}
          </div>
          {provider && provider.id !== "openrouter" && (
            <p className="text-xs text-muted-foreground">
              Voix et images : clé OpenRouter dans Réglages &gt; Voix.
            </p>
          )}
          {provider?.own_url && (
            <div className="flex flex-col gap-2">
              <Label>
                Adresse {provider.id === "ollama" ? "(vide : Ollama sur cette machine)" : "de l'API, finie par /v1"}
                <Input
                  type="url"
                  autoComplete="off"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={provider.id === "ollama" ? "http://mon-serveur:11434/v1" : "http://mon-serveur:8000/v1"}
                />
              </Label>
              <Label>
                Clé API (facultative)
                <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </Label>
              <Button variant="outline" onClick={() => provider && load(provider, apiKey, baseUrl)}>Afficher les modèles</Button>
            </div>
          )}
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
        </div>
      )}

      {/* 2. Comment choisir : un niveau, ou un modèle précis */}
      {loading && <p className="text-sm text-muted-foreground">Chargement des modèles…</p>}
      {!loading && catalog && !catalog.models.length && (
        <p className="text-sm text-muted-foreground">
          {catalog.needs_key ? "Colle ta clé API puis « Afficher les modèles »." : "Aucun modèle disponible."}
        </p>
      )}
      {!loading && catalog && catalog.models.length > 0 && (
        <>
          {tiers.length > 0 && (
            <div role="radiogroup" aria-label="Comment choisir" className="flex gap-1 rounded-xl bg-muted p-1">
              {(["tier", "precise"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "h-9 flex-1 cursor-pointer rounded-lg text-sm font-medium text-muted-foreground",
                    mode === m && "bg-accent-soft text-accent ring-2 ring-accent",
                  )}
                >
                  {m === "tier" ? "Un mode" : "Un modèle précis"}
                </button>
              ))}
            </div>
          )}

          {rows && !precise ? (
            <ModeRows level="cerveau" onChanged={onModeChanged} />
          ) : !precise ? (
            <div role="radiogroup" aria-label="Niveau" className="grid gap-2.5 sm:grid-cols-3">
              {tiers.map((t) => {
                const on = pickedTier === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPicked({ id: t.model!.id, name: t.model!.name })}
                    className={cn(
                      "flex cursor-pointer flex-col items-start gap-2 rounded-2xl border bg-background p-4 text-left",
                      on ? "border-2 border-accent bg-accent-soft/50 p-[15px]" : "border-muted-foreground/40 hover:border-muted-foreground",
                    )}
                  >
                    <span className="text-[15px] font-semibold">{t.name}</span>
                    <span className="min-h-9 text-[13px] leading-snug text-muted-foreground">{t.desc}</span>
                    <span className="text-xs">{t.speed}</span>
                    <span className="text-xs font-medium tabular-nums">{costLabel(t.model!)}</span>
                    <span className="flex w-full items-center gap-1.5 truncate text-xs text-muted-foreground"><ProviderLogo modelId={t.model!.id} className="size-5" />{shortName(t.model!.name)}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  className="pl-9"
                  placeholder={`Rechercher parmi ${catalog.models.length} modèles (claude, gemini, deepseek…)`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Rechercher un modèle"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["Voit les images", onlyVision, setOnlyVision],
                    ["Gratuits", onlyFree, setOnlyFree],
                  ] as const
                ).map(([label, on, set]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set(!on)}
                    className={cn(
                      "h-8 cursor-pointer rounded-full border px-3 text-xs font-medium",
                      on ? "border-2 border-accent bg-accent-soft px-[11px] text-accent" : "border-muted-foreground/50 text-muted-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
                <span className="ml-auto self-center text-xs text-muted-foreground">{results ? `${results.length} résultats` : "Cherche pour tout voir"}</span>
              </div>
              <div role="radiogroup" aria-label="Modèles" className="flex max-h-80 flex-col overflow-y-auto">
                {list.map((m) => (
                  <ModelRow key={m.id} m={m} selected={picked?.id === m.id} onPick={() => setPicked({ id: m.id, name: m.name })} />
                ))}
                {!list.length && <p className="p-3 text-sm text-muted-foreground">Aucun modèle ne correspond.</p>}
              </div>
            </div>
          )}
        </>
      )}

      {/* 3. Budget : une règle ferme */}
      <fieldset className="flex flex-col gap-2 rounded-2xl border border-border p-4">
        <legend className="px-1.5 text-sm font-semibold">Budget</legend>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Plafond
            <Input type="number" min={0} step={1} placeholder="Illimité" className="w-28" value={budget} onChange={(e) => setBudget(e.target.value)} />
            $ par mois
          </label>
          {usage && <span className="text-muted-foreground">Dépensé ce mois-ci : <span className="font-mono text-foreground">{money(usage.month_cost)} $</span></span>}
        </div>
        {usage?.non_suivi && <p className="text-xs text-warn">Certains appels n'ont pas de prix connu ce mois-ci : ce plafond ne les compte pas. Surveille aussi ta dépense chez le fournisseur.</p>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            Par agent
            <Input type="number" min={0} step={0.5} placeholder="Illimité" className="w-28" value={daily} onChange={(e) => setDaily(e.target.value)} />
            $ par jour
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Au plafond, les agents s'arrêtent et te demandent.
        </p>
      </fieldset>

      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">Pour tous les agents.</span>
        {onCancel && <Button variant="outline" onClick={onCancel}>Annuler</Button>}
        <Button onClick={save} disabled={saving || !picked}>
          {saving
            ? first
              ? "Création de ton premier agent…"
              : "Application aux agents…"
            : !picked
              ? "Choisis un modèle"
              : rows && !precise
                ? "Enregistrer le budget"
                : `Utiliser ${pickedTier ? TIERS.find((t) => t.id === pickedTier)!.name : shortName(picked.name)}`}
        </Button>
      </div>
    </div>
  );
}
