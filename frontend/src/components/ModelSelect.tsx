// Sélecteur de modèle commun : logo du fournisseur, coût dans une unité parlante, qualité, vitesse, forces.
// Recherche, filtre par fournisseur et tri. « Automatique » en tête.
import { Check, ChevronDown, Gauge, Search, Sparkles, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ProviderLogo, labName, labOf } from "./ProviderLogo";
import { t } from "@/i18n";

export type MediaModel = {
  id: string;
  name: string;
  created?: number;
  cost?: { value: number | null; label: string } | null;
  quality?: number | null;
  speed?: number | null;
  strengths?: string[];
  note?: string | null;
  description?: string;
};

// « Anthropic: Claude Sonnet » perd son labo ; « glm-5.3:cloud » (étiquette Ollama, sans espace) garde son nom.
const shortName = (name: string) => name.replace(/^[^:]+:\s+/, "");

function Dots({ value, icon: Icon, label }: { value?: number | null; icon: typeof Star; label: string }) {
  if (!value) return <span className="w-16 text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex w-16 items-center gap-0.5" title={t("{critere} : {note}/5", { critere: label, note: value })} aria-label={t("{critere} {note} sur 5", { critere: label, note: value })}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} className={cn("size-3", i <= value ? "fill-current text-foreground" : "text-muted-foreground/40")} />
      ))}
    </span>
  );
}

type Sort = "recommended" | "quality" | "price" | "speed";

export function ModelSelect({
  label,
  models,
  value,
  auto,
  routed,
  onChange,
}: {
  label: string;
  models: MediaModel[];
  value: string;
  /** Modèle que prendrait « Automatique » sans demande précise. */
  auto?: string | null;
  /** Automatique = routeur qui choisit selon chaque demande. */
  routed?: boolean;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [lab, setLab] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("recommended");

  const labs = useMemo(() => [...new Set(models.map((m) => labOf(m.id)))], [models]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    let ms = models.filter(
      (m) => (!lab || labOf(m.id) === lab) && (!q || `${m.id} ${m.name} ${(m.strengths ?? []).join(" ")}`.toLowerCase().includes(q)),
    );
    const price = (m: MediaModel) => m.cost?.value ?? Number.POSITIVE_INFINITY;
    const by: Record<Sort, (a: MediaModel, b: MediaModel) => number> = {
      recommended: (a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (b.speed ?? 0) - (a.speed ?? 0) || price(a) - price(b),
      quality: (a, b) => (b.quality ?? 0) - (a.quality ?? 0) || price(a) - price(b),
      price: (a, b) => price(a) - price(b),
      speed: (a, b) => (b.speed ?? 0) - (a.speed ?? 0) || price(a) - price(b),
    };
    ms = [...ms].sort(by[sort]);
    return ms;
  }, [models, query, lab, sort]);

  const current = models.find((m) => m.id === value);
  const autoModel = models.find((m) => m.id === auto);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("{type} : {modele}", { type: label, modele: value === "auto" ? t("Automatique") : current?.name ?? value })}
        onClick={() => setOpen(!open)}
        className="flex h-11 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3 text-left text-sm hover:border-muted-foreground/60"
      >
        {value === "auto" ? (
          <>
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Sparkles className="size-3.5" /></span>
            <span className="min-w-0 flex-1 truncate">
              <strong className="font-medium">{t("Automatique")}</strong>
              <span className="text-muted-foreground"> · {routed ? t("choisit selon chaque demande") : autoModel ? shortName(autoModel.name) : t("le meilleur disponible")}</span>
            </span>
          </>
        ) : (
          <>
            <ProviderLogo modelId={value} />
            <span className="min-w-0 flex-1 truncate font-medium">{current ? shortName(current.name) : value}</span>
            {current?.cost && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{current.cost.label}</span>}
          </>
        )}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Rechercher un modèle ou une force (texte, photo, logo…)")}
                aria-label={t("Rechercher un modèle")}
                className="h-9 w-full rounded-lg border border-border bg-background pr-2 pl-8 text-sm"
              />
            </div>
            <div role="radiogroup" aria-label={t("Trier")} className="flex gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
              {(
                [
                  ["recommended", t("Recommandés")],
                  ["quality", t("Qualité")],
                  ["price", t("Prix")],
                  ["speed", t("Vitesse")],
                ] as const
              ).map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={sort === id}
                  onClick={() => setSort(id)}
                  className={cn("h-8 cursor-pointer rounded-md px-2.5 font-medium text-muted-foreground", sort === id && "bg-background text-foreground shadow-sm")}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>

          {labs.length > 1 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("Fournisseurs")}>
              <button
                type="button"
                aria-pressed={!lab}
                onClick={() => setLab(null)}
                className={cn("h-7 cursor-pointer rounded-full border px-2.5 text-xs font-medium", !lab ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground")}
              >
                {t("Tous")}
              </button>
              {labs.map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={lab === l}
                  onClick={() => setLab(lab === l ? null : l)}
                  title={labName(l)}
                  className={cn(
                    "flex h-7 cursor-pointer items-center gap-1.5 rounded-full border py-0 pr-2.5 pl-1 text-xs font-medium",
                    lab === l ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground",
                  )}
                >
                  <ProviderLogo lab={l} className="size-5 rounded-full" />
                  {labName(l)}
                </button>
              ))}
            </div>
          )}

          <div role="radiogroup" aria-label={label} className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto">
            {!query && !lab && (
              <Row selected={value === "auto"} onPick={() => { onChange("auto"); setOpen(false); }}>
                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent"><Sparkles className="size-3.5" /></span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{t("Automatique")}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {routed
                      ? t("Choisit selon chaque demande.")
                      : autoModel ? t("Le meilleur disponible : {nom}", { nom: shortName(autoModel.name) }) : t("Le meilleur disponible")}
                  </span>
                </span>
              </Row>
            )}
            {list.map((m) => (
              <Row key={m.id} selected={value === m.id} onPick={() => { onChange(m.id); setOpen(false); }} title={m.note ?? m.description}>
                <ProviderLogo modelId={m.id} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{shortName(m.name)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {labName(labOf(m.id))}
                    {m.strengths?.length ? ` · ${m.strengths.slice(0, 3).join(", ")}` : ""}
                  </span>
                </span>
                <span className="hidden flex-col items-end gap-0.5 sm:flex">
                  <Dots value={m.quality} icon={Star} label={t("Qualité")} />
                  <Dots value={m.speed} icon={Gauge} label={t("Vitesse")} />
                </span>
                <span className="w-32 shrink-0 text-right text-xs tabular-nums">{m.cost?.label ?? <span className="text-muted-foreground">{t("Prix non publié")}</span>}</span>
              </Row>
            ))}
            {!list.length && <p className="p-3 text-sm text-muted-foreground">{t("Aucun modèle ne correspond.")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ selected, onPick, title, children }: { selected: boolean; onPick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      title={title}
      className={cn("flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted", selected && "bg-accent-soft ring-2 ring-accent hover:bg-accent-soft")}
    >
      {children}
      {selected && <Check className="size-4 shrink-0 text-accent" />}
    </button>
  );
}
