// Réglage du cerveau pour tous les agents. Les niveaux viennent de la même API qu'AgentBrain,
// sans dépendre du catalogue d'un fournisseur ni du temps de calcul de la consommation.
import { useEffect, useState } from "react";
import { type CurrentModel, get, send, type Usage } from "@/lib/api";
import { type ListedModel, type ModesState, type OwnBrain, type TierId, MODE_NAMES, modeName, readableModel } from "@/lib/modes";
import { cn, money } from "@/lib/utils";
import { ModelSearch, shortName } from "./Modes";
import { ProviderLogo } from "./ProviderLogo";
import { Button, ErrorText, Input } from "./ui";
import { t } from "@/i18n";

const LEVELS: [TierId, string][] = [["fast", t("Simple")], ["balanced", t("Moyen")], ["smart", t("Complexe")]];

const names = (list: string[]) => list.length > 1 ? t("{debut} et {fin}", { debut: list.slice(0, -1).join(", "), fin: list[list.length - 1] }) : list[0];
const ownLabel = (a: OwnBrain) => a.mode ? t("mode {nom}", { nom: modeName(a.mode) }) : [a.fournisseur_nom, readableModel(a.modele)].filter(Boolean).join(" · ");

/** « Noah et BMD gardent leur propre modèle (OpenRouter · GPT 6.1 Terra) », ou chacun avec le sien s'ils diffèrent. */
function ownSentence(own: OwnBrain[]): string {
  const labels = own.map(ownLabel);
  const several = own.length > 1;
  if (labels.every((l) => l === labels[0])) {
    const vars = { noms: names(own.map((a) => a.nom)), modele: labels[0] };
    return several ? t("{noms} gardent leur propre modèle ({modele})", vars) : t("{noms} garde son propre modèle ({modele})", vars);
  }
  const noms = names(own.map((a, i) => `${a.nom} (${labels[i]})`));
  return several ? t("{noms} gardent leur propre modèle", { noms }) : t("{noms} garde son propre modèle", { noms });
}

export function DefaultBrain({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [state, setState] = useState<ModesState | null>(null);
  const [current, setCurrent] = useState<CurrentModel>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [monthly, setMonthly] = useState("");
  const [daily, setDaily] = useState("");
  const [choosing, setChoosing] = useState<TierId | "precis" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [budgetError, setBudgetError] = useState("");

  const loadBrain = async () => {
    setLoadError("");
    try {
      const [model, modes] = await Promise.all([get<CurrentModel>("/api/model"), get<ModesState>("/api/modes/cerveau")]);
      setCurrent(model);
      setState(modes);
    } catch (e) { setLoadError((e as Error).message); }
  };
  const loadBudget = async () => {
    setBudgetError("");
    try {
      const u = await get<Usage>("/api/usage");
      setUsage(u);
      setMonthly(u.budget == null ? "" : String(u.budget));
      setDaily(u.daily == null ? "" : String(u.daily));
    } catch (e) { setBudgetError((e as Error).message); }
  };
  useEffect(() => { void loadBrain(); void loadBudget(); }, []);

  const change = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const changeModes = (body: object) => change(async () => {
    const next = await send<ModesState>("/api/modes/cerveau", body, "PUT");
    setState(next);
    setCurrent((c) => c ? { ...c, model: next.en_service } : c);
    setChoosing(null);
  });
  const precise = (m: ListedModel) => change(async () => {
    // Seul le fournisseur en service réutilise son adresse. Les autres clés sont gardées par le serveur.
    await send("/api/model", { provider: m.fournisseur, model: m.id, base_url: m.fournisseur === current?.provider ? current.base_url : undefined });
    await loadBrain();
    setChoosing(null);
  });
  const saveBudget = () => change(async () => {
    await send("/api/budget", { monthly: monthly === "" ? null : Number(monthly), daily: daily === "" ? null : Number(daily) });
    onDone();
  });
  // Le choix propre à un agent prime, c'est voulu : on le montre, et on propose de le ramener sur le cerveau de tous.
  const own = state?.agents_propres ?? [];
  const applyToAll = () => change(async () => {
    try {
      for (const a of own) await send(`/api/agents/${a.id}/model`, { model: null }, "PUT"); // comme « Comme mes autres agents »
    } finally { await loadBrain(); }
  });
  const auto = state?.actif === "auto";
  const canAuto = state?.modes.some((m) => m.modele);
  const row = (name: string, checked: boolean, under: string, onClick: () => void, disabled = false) => (
    <button type="button" role="radio" aria-checked={checked} disabled={busy || disabled} onClick={onClick}
      className={cn("flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50", checked && "bg-accent-soft/40")}>
      <span aria-hidden className={cn("size-[18px] shrink-0 rounded-full border-2 border-border", checked && "border-[6px] border-accent")} />
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{name}</span><span className="block truncate text-xs text-muted-foreground">{under}</span></span>
    </button>
  );

  return <div className="flex flex-col gap-5">
    <p className="text-sm text-muted-foreground">{t("Pour tous les agents")}</p>
    {!state && !loadError && <p role="status">{t("Chargement du cerveau…")}</p>}
    {loadError && <div><ErrorText>{loadError}</ErrorText><Button variant="outline" onClick={loadBrain}>{t("Réessayer le cerveau")}</Button></div>}
    {state && <>
      <div role="radiogroup" aria-label={t("Cerveau par défaut")} className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
        <div>
          {row(t("Auto"), auto, t("Noah choisit selon la tâche"), () => changeModes({ actif: "auto" }), !canAuto)}
          <ul aria-label={t("Niveaux Auto")} className="flex flex-col gap-1 px-3 pb-3">
            {LEVELS.map(([tier, label]) => {
              const model = state.modes.find((m) => m.id === tier)?.modele;
              return <li key={tier} className="flex flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2 py-2 text-sm sm:pl-8">
                  <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
                  {model && <ProviderLogo modelId={model.modele} />}
                  <span className="min-w-0 flex-1 truncate font-medium" title={model?.nom}>{model ? shortName(model.nom) : t("Aucun modèle disponible")}</span>
                  <button type="button" disabled={busy} aria-label={t("Changer le modèle {niveau}", { niveau: label })} aria-expanded={choosing === tier} className="shrink-0 cursor-pointer text-accent hover:underline" onClick={() => setChoosing(choosing === tier ? null : tier)}>{choosing === tier ? t("Fermer") : t("Changer")}</button>
                </div>
                {choosing === tier && <ModelSearch level="cerveau" selected={model?.modele} onPick={(m) => changeModes({ mode: tier, modele: m.id, fournisseur: m.fournisseur })} />}
              </li>;
            })}
          </ul>
        </div>
        {row(t("Un modèle précis"), !state.actif, !state.actif ? readableModel(current?.model) : t("Le même modèle pour chaque tâche"), () => setChoosing(choosing === "precis" ? null : "precis"), !current)}
      </div>
      {state.actif && state.actif !== "auto" && <p className="text-xs text-muted-foreground">{t("Mode actuel : {mode}. Choisis Auto ou un modèle précis pour le remplacer.", { mode: MODE_NAMES[state.actif] })}</p>}
      {choosing === "precis" && <ModelSearch level="cerveau" selected={!state.actif ? current?.model : null} onPick={precise} />}
      {own.length > 0 && <div role="status" aria-label={t("Agents avec leur propre modèle")} className="flex flex-col items-start gap-2 rounded-xl border border-warn/40 bg-warn/5 p-3 text-sm">
        <p>{own.length > 1 ? t("{phrase}. Ce cerveau ne s'applique pas à eux.", { phrase: ownSentence(own) }) : t("{phrase}. Ce cerveau ne s'applique pas à lui.", { phrase: ownSentence(own) })}</p>
        <Button variant="outline" disabled={busy} onClick={applyToAll}>{own.length > 1 ? t("Leur appliquer ce cerveau") : t("Lui appliquer ce cerveau")}</Button>
      </div>}
    </>}
    <fieldset disabled={busy || !usage} className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <legend className="px-1.5 text-sm font-semibold">{t("Budget")}</legend>
      {!usage && !budgetError && <p role="status">{t("Chargement du budget…")}</p>}
      <label className="flex flex-wrap items-center gap-2 text-sm">{t("Plafond")}<Input type="number" min={0} step={1} placeholder={t("Illimité")} className="w-28" value={monthly} onChange={(e) => setMonthly(e.target.value)} />{t("$ par mois")}</label>
      {usage && <p className="text-xs text-muted-foreground">{t("Dépensé ce mois-ci : {montant} $", { montant: money(usage.month_cost) })}</p>}
      {usage?.non_suivi && <p className="text-xs text-warn">{t("Certains appels n'ont pas de prix connu ce mois-ci : ce plafond ne les compte pas. Surveille aussi ta dépense chez le fournisseur.")}</p>}
      <label className="flex flex-wrap items-center gap-2 text-sm">{t("Par agent")}<Input type="number" min={0} step={0.5} placeholder={t("Illimité")} className="w-28" value={daily} onChange={(e) => setDaily(e.target.value)} />{t("$ par jour")}</label>
      <p className="text-xs text-muted-foreground">{t("Au plafond, les agents s'arrêtent et te demandent.")}</p>
    </fieldset>
    {budgetError && <div><ErrorText>{budgetError}</ErrorText><Button variant="outline" onClick={loadBudget}>{t("Réessayer le budget")}</Button></div>}
    <ErrorText>{error}</ErrorText>
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" onClick={onCancel}>{t("Annuler")}</Button>
      <Button onClick={saveBudget} disabled={busy || !usage}>{busy ? t("Enregistrement…") : t("Enregistrer le budget")}</Button>
    </div>
  </div>;
}
