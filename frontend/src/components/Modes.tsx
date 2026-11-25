// Modèles et budget : une rangée par mode, le modèle qu'il utilise, un bouton pour changer. Gratuit prend ce que tes clés offrent de moins
// cher ; Custom est ta liste, dans ton ordre. Le suivant prend le relais si l'un est épuisé ou en panne.
import { ArrowDown, ArrowUp, Check, ChevronDown, Eye, GripVertical, Loader2, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get, type Model, send } from "@/lib/api";
import { type Level, type ListedModel, type ModeId, type ModeLink, type ModesState, TIERS, readableModel } from "@/lib/modes";
import { cn, contextSize, money } from "@/lib/utils";
import { ProviderLogo, labName, labOf } from "./ProviderLogo";
import { Button, ErrorText, Input } from "./ui";
import { locale, t, tServeur } from "@/i18n";

type Priced = { free?: boolean; price_in?: number | null; price_out?: number | null; prix?: string | null; abonnement?: boolean };

// Coût d'une tâche type : ~20 000 jetons lus, ~2 000 écrits.
export const taskCost = (m: Priced) =>
  m.free ? 0 : m.price_in == null ? null : (m.price_in * 20000 + (m.price_out ?? m.price_in) * 2000) / 1e6;
/** `short` : sans « par tâche », pour la colonne étroite d'une liste. */
export const costLabel = (m: Priced, short = false) => {
  if (m.abonnement) return t("Compris dans l'abonnement"); // 0 $ connu, jamais « prix inconnu »
  if (m.prix) return short ? m.prix.replace(/ par tâche$/, "") : m.prix; // i18n-ignore : libellé de prix venu du serveur
  const c = taskCost(m);
  if (c === 0) return t("Gratuit");
  if (c == null) return t("Prix inconnu");
  if (c < 0.01) return short ? t("< 1 centime") : t("moins d'1 centime par tâche");
  return short ? t("≈ {prix} $", { prix: money(c) }) : t("≈ {prix} $ par tâche", { prix: money(c) });
};
// « Anthropic: Claude Sonnet » perd son labo ; « glm-5.3:cloud » (étiquette Ollama, sans espace) garde son nom.
export const shortName = (name: string) => readableModel(name.replace(/^[^:]+:\s+/, ""));

/** `via` : chez quel fournisseur on l'obtient, quand plusieurs sont branchés (le même modèle peut venir de deux). */
export function ModelRow({ m, selected, onPick, via, className }: { m: Pick<Model, "id" | "name" | "vision" | "context"> & Priced & { lab?: string }; selected: boolean; onPick: () => void; via?: string; className?: string }) {
  const sub = [m.id.includes("/") ? labName(labOf(m.id)) : "", via].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      title={m.context ? t("Peut lire {taille} à la fois", { taille: contextSize(m.context) }) : undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted",
        selected && "bg-accent-soft ring-2 ring-accent hover:bg-accent-soft",
        className,
      )}
    >
      <ProviderLogo modelId={m.id} lab={m.id.includes("/") ? undefined : m.lab} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{shortName(m.name)}</span>
        {sub && <span className="truncate text-xs text-muted-foreground" title={m.id}>{sub}</span>}
      </span>
      {selected && <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-surface">{t("Utilisé")}</span>}
      {m.vision && <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("Voit les images")} />}
      <span className="w-24 shrink-0 text-right text-xs tabular-nums sm:w-36">{costLabel(m, true)}</span>
    </button>
  );
}

/** L'entreprise qui a fait le modèle : le préfixe de son identifiant (« meta/llama-4 »), sinon son labo, sinon son fournisseur. */
const companyOf = (m: ListedModel) => (m.id.includes("/") ? labOf(m.id) : (m.lab || m.fournisseur).toLowerCase());

// Rendu fenêtré : 656 modèles se lisent en quelques rangées dans le DOM. Hauteurs fixes, donc positions calculées sans rien mesurer.
const HEAD_H = 28, ROW_H = 56, OVERSCAN_PX = 280;
type Item = { kind: "head"; key: string; label: string; lab: string; n: number } | { kind: "model"; key: string; m: ListedModel };

/** Modèles groupés par entreprise : celle du modèle en service d'abord, puis par nom ; dans un groupe, le modèle en service puis les plus récents. */
function groupByCompany(models: ListedModel[], selected: string | null | undefined): Item[] {
  // « meta » et « meta-llama » sont la même entreprise à l'écran : le groupe se tient par son nom affiché.
  const byCompany = new Map<string, { lab: string; got: ListedModel[] }>();
  for (const m of models) {
    const lab = companyOf(m);
    const group = byCompany.get(labName(lab)) ?? { lab, got: [] };
    group.got.push(m);
    byCompany.set(labName(lab), group);
  }
  const has = (got: ListedModel[]) => got.some((m) => m.id === selected);
  const groups = [...byCompany.entries()].sort(([a, ga], [b, gb]) => Number(has(gb.got)) - Number(has(ga.got)) || a.localeCompare(b, locale()));
  return groups.flatMap(([label, { lab, got }]) => {
    const ranked = [...got].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || b.created - a.created);
    return [{ kind: "head" as const, key: `h:${label}`, label, lab, n: got.length },
      ...ranked.map((m) => ({ kind: "model" as const, key: `${m.fournisseur}:${m.id}`, m }))];
  });
}

/** Les positions et la hauteur totale d'une liste de rangées de hauteurs fixes. */
function layout(items: Item[]) {
  const tops: number[] = [];
  let y = 0;
  for (const it of items) { tops.push(y); y += it.kind === "head" ? HEAD_H : ROW_H; }
  return { tops, total: y };
}

/** Hauteur de la liste : 256 px sur ordinateur, 55 % de l'écran sur téléphone. */
const listHeight = () => (window.innerWidth < 768 ? Math.round(window.innerHeight * 0.55) : 256);

/** Tout ce que les clés de la personne permettent à ce niveau : la recherche en haut, les fournisseurs à cocher (plusieurs), puis les modèles
 * groupés par entreprise, rendus à la fenêtre. Un même identifiant proposé par deux fournisseurs (Ollama et OpenRouter…) reste deux choix. */
export function ModelSearch({ level, selected, onPick, autoFocus }: { level: Level; selected?: string | null; onPick: (m: ListedModel) => void; autoFocus?: boolean }) {
  const [models, setModels] = useState<ListedModel[] | null>(null);
  const [brands, setBrands] = useState<{ id: string; label: string }[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [chooser, setChooser] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [view, setView] = useState(listHeight);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const resize = () => setView(listHeight());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    get<{ modeles: ListedModel[]; fournisseurs?: { id: string; label: string }[] }>(`/api/modes/${level}/modeles`)
      .then((r) => { setModels(r.modeles); setBrands(r.fournisseurs ?? []); })
      .catch((e) => setError((e as Error).message));
  }, [level]);
  const counts = useMemo(() => {
    const got = new Map<string, string>();
    for (const b of brands) got.set(b.id, tServeur(b.label)); // libellés écrits par le serveur, en français
    const rows = new Map<string, { label: string; n: number }>();
    for (const m of models ?? []) {
      const known = rows.get(m.fournisseur);
      rows.set(m.fournisseur, { label: got.get(m.fournisseur) || known?.label || readableModel(m.fournisseur).replace(/^./, (c) => c.toUpperCase()),
                               n: (known?.n ?? 0) + 1 });
    }
    for (const b of brands) if (!rows.has(b.id)) rows.set(b.id, { label: tServeur(b.label), n: 0 });
    return [...rows.entries()].map(([id, row]) => ({ id, ...row })).sort((a, b) => a.label.localeCompare(b.label, locale()) || a.id.localeCompare(b.id));
  }, [models, brands]);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    let all = models ?? [];
    if (picked.size) all = all.filter((m) => picked.has(m.fournisseur));
    if (q) all = all.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q));
    return groupByCompany(all, selected);
  }, [models, query, picked, selected]);
  const { tops, total } = useMemo(() => layout(items), [items]);
  // Un filtre change : la liste repart du haut.
  useEffect(() => { if (box.current) box.current.scrollTop = 0; setScroll(0); }, [query, picked]);
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!models) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t("Lecture des modèles…")}</p>;
  const many = brands.length > 1;
  const labels = new Map(counts.map((b) => [b.id, b.label]));
  const toggle = (id: string) => setPicked((cur) => { const next = new Set(cur); if (!next.delete(id)) next.add(id); return next; });
  const summary = picked.size === 0 ? t("Tous les fournisseurs") : picked.size === 1 ? labels.get([...picked][0]) ?? [...picked][0] : t("{n} fournisseurs", { n: picked.size });
  // Rangées visibles : de la première qui touche le haut de la fenêtre à la dernière qui touche le bas, avec une marge.
  const from = Math.max(0, scroll - OVERSCAN_PX), to = scroll + view + OVERSCAN_PX;
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid] + (items[mid].kind === "head" ? HEAD_H : ROW_H) <= from) lo = mid + 1; else hi = mid; }
  const shown: number[] = [];
  for (let i = lo; i < items.length && tops[i] <= to; i++) shown.push(i);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" autoFocus={autoFocus} className="h-9 pl-9" placeholder={t("Rechercher un modèle")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("Rechercher un modèle")} />
      </div>
      {many && (
        <div className="flex flex-col gap-1">
          <button type="button" aria-expanded={chooser} aria-haspopup="true" onClick={() => setChooser(!chooser)}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 text-left text-sm hover:border-muted-foreground/60">
            <span className="min-w-0 flex-1 truncate">{summary}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{models.length}</span>
            <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", chooser && "rotate-180")} />
          </button>
          {chooser && (
            <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-background p-1" role="group" aria-label={t("Fournisseurs")}>
              {counts.map((b) => (
                <label key={b.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted">
                  <input type="checkbox" className="size-4 shrink-0 accent-accent" checked={picked.has(b.id)} onChange={() => toggle(b.id)} aria-label={b.label} />
                  <ProviderLogo lab={b.id} className="size-5 rounded-full" />
                  <span className="min-w-0 flex-1 truncate">{b.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{b.n}</span>
                </label>
              ))}
              {picked.size > 0 && <button type="button" className="h-8 cursor-pointer self-start rounded-md px-2 text-xs text-accent hover:underline" onClick={() => setPicked(new Set())}>{t("Tous les fournisseurs")}</button>}
            </div>
          )}
        </div>
      )}
      <p className="flex justify-end px-2.5 text-[11px] text-muted-foreground">{t("Prix d'une tâche type")}</p>
      {total === 0 ? <p className="p-3 text-sm text-muted-foreground">{t("Aucun modèle ne correspond.")}</p> : (
        <div ref={box} role="radiogroup" aria-label={t("Modèles")} className="overflow-y-auto" style={{ height: Math.min(total, view) }} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
          <div className="relative" style={{ height: total }}>
            {shown.map((i) => {
              const it = items[i];
              return it.kind === "head" ? (
                <div key={it.key} role="presentation" style={{ position: "absolute", top: tops[i], left: 0, right: 0, height: HEAD_H }}
                  className="flex items-center gap-2 border-b border-border/60 px-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">
                  <ProviderLogo lab={it.lab} className="size-4 rounded" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{it.label}</span>
                  <span className="tabular-nums">{it.n}</span>
                </div>
              ) : (
                <div key={it.key} style={{ position: "absolute", top: tops[i], left: 0, right: 0, height: ROW_H }}>
                  <ModelRow m={it.m} selected={selected === it.m.id} onPick={() => onPick(it.m)} via={many || it.m.abonnement ? labels.get(it.m.fournisseur) : undefined} className="h-full" />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Picked({ link }: { link: ModeLink | null | undefined }) {
  if (!link) return <span className="text-xs text-muted-foreground">{t("Aucun modèle pour ce mode avec tes clés.")}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <ProviderLogo modelId={link.modele} lab={link.modele.includes("/") ? undefined : link.fournisseur} className="size-5 shrink-0" />
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
              <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" disabled={i === 0} aria-label={t("Monter {nom}", { nom: shortName(link.nom) })} onClick={() => move(i, i - 1)}><ArrowUp /></Button>
              <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" disabled={i === chain.length - 1} aria-label={t("Descendre {nom}", { nom: shortName(link.nom) })} onClick={() => move(i, i + 1)}><ArrowDown /></Button>
              <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" aria-label={t("Retirer {nom}", { nom: shortName(link.nom) })} onClick={() => setChain(chain.filter((_, k) => k !== i))}><X /></Button>
            </li>
          ))}
        </ol>
      )}
      {adding ? <ModelSearch level={level} onPick={add} /> : <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />{t("Ajouter un modèle")}</Button>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={busy || !chain.length} onClick={() => onSave(chain)}>{busy && <Loader2 className="animate-spin" />}{t("Utiliser cette liste")}</Button>
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

  if (!state) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture des modes…")}</p>;
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
            {open === id ? t("Fermer") : changeLabel}
          </Button>
        </div>
        {open === id && panel}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("Mode")}>
      {TIERS.map((tier) => {
        const mode = state.modes.find((m) => m.id === tier.id);
        return row(tier.id, tier.name, brain ? tier.desc : tier.descMedia, <Picked link={mode?.modele} />, !!mode?.modele, t("Changer"), (
          <div className="flex flex-col gap-2 border-t border-border pt-2">
            <ModelSearch level={level} selected={mode?.modele?.modele} onPick={(m) => change({ mode: tier.id, modele: m.id, fournisseur: m.fournisseur })} />
            {mode?.personnalise && <Button type="button" variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => change({ mode: tier.id, modele: null })}>{t("Revenir au choix de Noah")}</Button>}
          </div>
        ));
      })}
      {row("gratuit", t("Gratuit"), t("Les modèles gratuits, à tour de rôle."),
        state.gratuit.length ? <span className="truncate text-xs text-muted-foreground">{state.gratuit.length > 3
          ? t("{noms}, et {n} autres", { noms: state.gratuit.slice(0, 3).map((l) => shortName(l.nom)).join(", "), n: state.gratuit.length - 3 })
          : state.gratuit.map((l) => shortName(l.nom)).join(", ")}</span> : <Picked link={null} />,
        state.gratuit.length > 0, t("Voir"), (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <ol className="flex flex-col gap-1">{state.gratuit.map((l, i) => <li key={`${l.fournisseur}:${l.modele}`} className="flex items-center gap-2"><span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span><span className="min-w-0 flex-1"><Picked link={l} /></span></li>)}</ol>
            <p className="text-xs text-muted-foreground">{t("Certains gardent tes messages : rien de confidentiel.")}</p>
          </div>
        ))}
      {row("custom", t("Ma liste"), t("Ta liste, dans ton ordre."),
        state.custom.length ? <span className="truncate text-xs text-muted-foreground">{state.custom.map((l) => shortName(l.nom)).join(" → ")}</span> : <span className="text-xs text-muted-foreground">{t("Aucun modèle pour l'instant.")}</span>,
        state.custom.length > 0, t("Composer"), (
          <div className="border-t border-border pt-2">
            <ChainEditor level={level} initial={state.custom} busy={busy} onSave={(chain) => change({ chaine: chain.map((l) => ({ modele: l.modele, fournisseur: l.fournisseur })), actif: "custom" })} />
          </div>
        ))}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
