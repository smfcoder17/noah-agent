// Modèles et budget : une rangée par mode, le modèle qu'il utilise, un bouton pour changer. Gratuit prend ce que tes clés offrent de moins
// cher ; Custom est ta liste, dans ton ordre. Le suivant prend le relais si l'un est épuisé ou en panne.
import { ArrowDown, ArrowUp, Check, Eye, GripVertical, Loader2, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { get, type Model, send } from "@/lib/api";
import { type Level, type ListedModel, type ModeId, type ModeLink, type ModesState, TIERS, readableModel } from "@/lib/modes";
import { cn, contextSize, money } from "@/lib/utils";
import { ProviderLogo } from "./ProviderLogo";
import { Button, ErrorText, Input } from "./ui";

type Priced = { free?: boolean; price_in?: number | null; price_out?: number | null; prix?: string | null };

// Coût d'une tâche type : ~20 000 jetons lus, ~2 000 écrits.
export const taskCost = (m: Priced) =>
  m.free ? 0 : m.price_in == null ? null : (m.price_in * 20000 + (m.price_out ?? m.price_in) * 2000) / 1e6;
export const costLabel = (m: Priced) => {
  if (m.prix) return m.prix;
  const c = taskCost(m);
  if (c === 0) return "Gratuit";
  if (c == null) return "Prix inconnu";
  return c < 0.01 ? "moins d'1 centime par tâche" : `≈ ${money(c)} $ par tâche`;
};
export const shortName = (name: string) => readableModel(name.replace(/^[^:]+:\s*/, ""));

export function ModelRow({ m, selected, onPick }: { m: Pick<Model, "id" | "name" | "vision" | "context"> & Priced; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      title={m.context ? `Peut lire ${contextSize(m.context)} à la fois` : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted",
        selected && "bg-accent-soft ring-2 ring-accent hover:bg-accent-soft",
      )}
    >
      <ProviderLogo modelId={m.id} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{shortName(m.name)}</span>
        {m.id.includes("/") && <span className="truncate text-xs text-muted-foreground" title={m.id}>{readableModel(m.id.split("/")[0]).replace(/^./, (c) => c.toUpperCase())}</span>}
      </span>
      {selected && <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-surface">Utilisé</span>}
      {m.vision && <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-label="Voit les images" />}
      <span className="w-24 shrink-0 text-right text-xs tabular-nums sm:w-36">{costLabel(m).replace(/ par tâche$/, "").replace(/^moins d.1 centime$/, "< 1 centime")}</span>
    </button>
  );
}

/** Un groupe = un fournisseur, dans l'ordre servi par /api/modes/…/modeles. Le libellé vient du serveur ; à défaut, il se devine. */
function groupByBrand(models: ListedModel[], brands: { id: string; label: string }[]) {
  const byBrand = new Map<string, ListedModel[]>();
  for (const m of models) {
    const got = byBrand.get(m.fournisseur) ?? [];
    got.push(m);
    byBrand.set(m.fournisseur, got);
  }
  return [...byBrand.entries()].map(([id, got]) => ({
    key: id,
    label: (brands.find((b) => b.id === id)?.label) || readableModel(id).replace(/^./, (c) => c.toUpperCase()),
    models: got,
  }));
}

/** Tout ce que les clés de la personne permettent à ce niveau : une recherche, un filtre par fournisseur, des groupes.
 * Un même identifiant proposé par deux fournisseurs (Ollama et OpenRouter…) reste deux choix distincts. */
export function ModelSearch({ level, selected, onPick }: { level: Level; selected?: string | null; onPick: (m: ListedModel) => void }) {
  const [models, setModels] = useState<ListedModel[] | null>(null);
  const [brands, setBrands] = useState<{ id: string; label: string }[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [brand, setBrand] = useState<string | null>(null);
  useEffect(() => {
    get<{ modeles: ListedModel[]; fournisseurs?: { id: string; label: string }[] }>(`/api/modes/${level}/modeles`)
      .then((r) => { setModels(r.modeles); setBrands(r.fournisseurs ?? []); })
      .catch((e) => setError((e as Error).message));
  }, [level]);
  const counts = useMemo(() => {
    const got = new Map<string, string>();
    for (const b of brands) got.set(b.id, b.label);
    const rows = new Map<string, { label: string; n: number }>();
    for (const m of models ?? []) {
      const known = rows.get(m.fournisseur);
      rows.set(m.fournisseur, { label: got.get(m.fournisseur) || known?.label || readableModel(m.fournisseur).replace(/^./, (c) => c.toUpperCase()),
                               n: (known?.n ?? 0) + 1 });
    }
    for (const b of brands) if (!rows.has(b.id)) rows.set(b.id, { label: b.label, n: 0 });
    return [...rows.entries()].map(([id, row]) => ({ id, ...row })).sort((a, b) => a.label.localeCompare(b.label, "fr") || a.id.localeCompare(b.id));
  }, [models, brands]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    let all = models ?? [];
    if (brand) all = all.filter((m) => m.fournisseur === brand);
    if (q) all = all.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q));
    const ranked = [...all].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || b.created - a.created);
    return groupByBrand(ranked, brands);
  }, [models, query, brand, selected, brands]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!models) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Lecture des modèles…</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" className="h-9 pl-9" placeholder="Rechercher un modèle" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un modèle" />
      </div>
      {brands.length > 1 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Fournisseurs">
          <button
            type="button"
            aria-pressed={!brand}
            onClick={() => setBrand(null)}
            className={cn(
              "h-7 cursor-pointer rounded-full border px-2.5 text-xs font-medium",
              !brand ? "border-accent bg-accent-soft text-accent" : "border-muted-foreground/50 text-muted-foreground",
            )}
          >
            Tous<span className="ml-1 font-normal text-muted-foreground tabular-nums">{models.length}</span>
          </button>
          {counts.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={brand === b.id}
              onClick={() => { setBrand(brand === b.id ? null : b.id); setQuery(""); }}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1.5 rounded-full border py-0 pr-2.5 pl-1 text-xs font-medium",
                brand === b.id ? "border-accent bg-accent-soft text-accent" : "border-muted-foreground/50 text-muted-foreground",
              )}
            >
              <ProviderLogo lab={b.id} className="size-5 rounded-full" />
              {b.label}
              <span className="font-normal text-muted-foreground tabular-nums">{b.n}</span>
            </button>
          ))}
        </div>
      )}
      <p className="flex justify-end px-2.5 text-[11px] text-muted-foreground">Prix d'une tâche type</p>
      <div role="radiogroup" aria-label="Modèles" className="flex max-h-64 flex-col overflow-y-auto max-md:max-h-[55dvh]">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            {brands.length > 1 && (
              <h4 className="flex items-center justify-between border-b border-border/60 px-2.5 py-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                <span className="min-w-0 flex-1 truncate font-semibold">{g.label}</span>
                <span className="tabular-nums">{g.models.length}</span>
              </h4>
            )}
            {g.models.map((m) => <ModelRow key={`${m.fournisseur}:${m.id}`} m={m} selected={selected === m.id} onPick={() => onPick(m)} />)}
          </section>
        ))}
        {!groups.some((g) => g.models.length) && <p className="p-3 text-sm text-muted-foreground">Aucun modèle ne correspond.</p>}
      </div>
    </div>
  );
}

function Picked({ link }: { link: ModeLink | null | undefined }) {
  if (!link) return <span className="text-xs text-muted-foreground">Aucun modèle pour ce mode avec tes clés.</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ProviderLogo modelId={link.modele} className="size-5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{shortName(link.nom)}</span>
        <span className="truncate tabular-nums">{costLabel(link)}</span>
      </span>
    </span>
  );
}

/** La liste de Custom : glisser-déposer, ou les flèches au clavier et au doigt. Le premier est la priorité. */
export function ChainEditor({ level, initial, onSave, busy }: { level: Level; initial: ModeLink[]; onSave: (chain: ModeLink[]) => void; busy: boolean }) {
  const [chain, setChain] = useState(initial);
  const [dragging, setDragging] = useState<number | null>(null);
  const [adding, setAdding] = useState(!initial.length);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= chain.length || from === to) return;
    const next = [...chain];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setChain(next);
  };
  const add = (m: ListedModel) => {
    if (!chain.some((l) => l.modele === m.id && l.fournisseur === m.fournisseur)) {
      setChain([...chain, { modele: m.id, fournisseur: m.fournisseur, nom: m.name, price_in: m.price_in, price_out: m.price_out, free: m.free, prix: m.prix }]);
    }
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-2">
      {chain.length > 0 && (
        <ol className="flex flex-col gap-1">
          {chain.map((link, i) => (
            <li
              key={`${link.fournisseur}:${link.modele}`}
              draggable
              onDragStart={() => setDragging(i)}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) {
                  move(dragging, i);
                  setDragging(i);
                }
              }}
              onDragEnd={() => setDragging(null)}
              className={cn("flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5", dragging === i && "border-accent bg-accent-soft")}
            >
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
              <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <span className="min-w-0 flex-1"><Picked link={link} /></span>
              <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" disabled={i === 0} aria-label={`Monter ${shortName(link.nom)}`} onClick={() => move(i, i - 1)}><ArrowUp /></Button>
              <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" disabled={i === chain.length - 1} aria-label={`Descendre ${shortName(link.nom)}`} onClick={() => move(i, i + 1)}><ArrowDown /></Button>
              <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" aria-label={`Retirer ${shortName(link.nom)}`} onClick={() => setChain(chain.filter((_, k) => k !== i))}><X /></Button>
            </li>
          ))}
        </ol>
      )}
      {adding ? <ModelSearch level={level} onPick={add} /> : <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />Ajouter un modèle</Button>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={busy || !chain.length} onClick={() => onSave(chain)}>{busy && <Loader2 className="animate-spin" />}Utiliser cette liste</Button>
      </div>
    </div>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span className={cn("mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border", on ? "border-accent bg-accent text-accent-foreground" : "border-muted-foreground/50")}>
      {on && <Check className="size-3" />}
    </span>
  );
}

const ROW = "flex flex-col gap-2 rounded-xl border bg-background p-3";

export function ModeRows({ level, onChanged }: { level: Level; onChanged?: (inService: string) => void }) {
  const [state, setState] = useState<ModesState | null>(null);
  const [open, setOpen] = useState<ModeId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    get<ModesState>(`/api/modes/${level}`).then(setState).catch((e) => setError((e as Error).message));
  }, [level]);

  const change = useCallback(async (body: object) => {
    setBusy(true);
    setError("");
    try {
      const next = await send<ModesState>(`/api/modes/${level}`, body, "PUT");
      setState(next);
      setOpen(null);
      onChanged?.(next.en_service);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [level, onChanged]);

  if (!state) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture des modes…</p>;
  const brain = level === "cerveau";
  const row = (id: ModeId, name: string, desc: string, under: React.ReactNode, usable: boolean, changeLabel: string, panel: React.ReactNode) => {
    const on = state.actif === id;
    return (
      <div key={id} className={cn(ROW, on ? "border-2 border-accent bg-accent-soft/40 p-[11px]" : "border-border")}>
        <div className="flex items-start gap-2.5">
          <button
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy || !usable}
            onClick={() => change({ actif: id })}
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left disabled:cursor-not-allowed"
          >
            <Radio on={on} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-semibold">{name}</span>
              <span className="text-[13px] leading-snug text-muted-foreground">{desc}</span>
              {under}
            </span>
          </button>
          <Button type="button" variant="outline" size="sm" className="shrink-0" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
            {open === id ? "Fermer" : changeLabel}
          </Button>
        </div>
        {open === id && panel}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Mode">
      {TIERS.map((t) => {
        const mode = state.modes.find((m) => m.id === t.id);
        return row(t.id, t.name, brain ? t.desc : t.descMedia, <Picked link={mode?.modele} />, !!mode?.modele, "Changer", (
          <div className="flex flex-col gap-2 border-t border-border pt-2">
            <ModelSearch level={level} selected={mode?.modele?.modele} onPick={(m) => change({ mode: t.id, modele: m.id, fournisseur: m.fournisseur })} />
            {mode?.personnalise && <Button type="button" variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => change({ mode: t.id, modele: null })}>Revenir au choix de Noah</Button>}
          </div>
        ));
      })}
      {row("gratuit", "Gratuit", "Les modèles gratuits, à tour de rôle.",
        state.gratuit.length ? <span className="truncate text-xs text-muted-foreground">{state.gratuit.slice(0, 3).map((l) => shortName(l.nom)).join(", ")}{state.gratuit.length > 3 ? `, et ${state.gratuit.length - 3} autres` : ""}</span> : <Picked link={null} />,
        state.gratuit.length > 0, "Voir", (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <ol className="flex flex-col gap-1">{state.gratuit.map((l, i) => <li key={`${l.fournisseur}:${l.modele}`} className="flex items-center gap-2"><span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span><span className="min-w-0 flex-1"><Picked link={l} /></span></li>)}</ol>
            <p className="text-xs text-muted-foreground">Certains gardent tes messages : rien de confidentiel.</p>
          </div>
        ))}
      {row("custom", "Ma liste", "Ta liste, dans ton ordre.",
        state.custom.length ? <span className="truncate text-xs text-muted-foreground">{state.custom.map((l) => shortName(l.nom)).join(" → ")}</span> : <span className="text-xs text-muted-foreground">Aucun modèle pour l'instant.</span>,
        state.custom.length > 0, "Composer", (
          <div className="border-t border-border pt-2">
            <ChainEditor level={level} initial={state.custom} busy={busy} onSave={(chain) => change({ chaine: chain.map((l) => ({ modele: l.modele, fournisseur: l.fournisseur })), actif: "custom" })} />
          </div>
        ))}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
