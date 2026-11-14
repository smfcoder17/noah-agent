import { ObjectPage } from "./mobile/ObjectPage";
import { useVisibleSubscription } from "@/lib/events";
// Ce que l'agent sait et fait de lui-même, réglable depuis Détails : routines, mémoire, connexions, logiciels, dossiers.
import { Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FolderOpen, HardDrive, Loader2, Pause, Pencil, Play, Plus, SlidersHorizontal, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { get, request, send } from "@/lib/api";
import { appLabel } from "@/lib/appLabel";
import { askAgent } from "@/lib/askAgent";
import { type ListedModel, MODE_NAMES, type ModeId, scheduleLabel } from "@/lib/modes";
import { useAgentData } from "@/lib/useAgentData";
import { type ComputerFolders, desktop } from "@/lib/desktop";
import { cn, fileSize } from "@/lib/utils";
import { ConnectorScope, PendingGlobal } from "./ConnectorScope";
import { SavedLogins } from "./LoginCard";
import { ModelSearch } from "./Modes";
import { Button, ErrorText, Input, Textarea } from "./ui";
import { langue, locale, t, tr, tServeur } from "@/i18n";

/** Section repliable, avec un compteur à droite du titre. Seule dans son onglet (`alone`), elle n'a pas besoin de titre. */
export function Section({ title, count, defaultOpen = false, alone = false, children }: { title: string; count?: number | string; defaultOpen?: boolean; alone?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  if (alone) return <section aria-label={title} className="flex flex-col gap-2">{children}</section>;
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex cursor-pointer items-center gap-1.5 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        <span className="flex-1">{title}</span>
        {count !== undefined && count !== 0 && <span className="normal-case tracking-normal">{count}</span>}
      </button>
      {open && children}
    </section>
  );
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const lieu = langue() === "fr" ? "fr-CA" : locale(); // en français, l'heure reste écrite « 08 h 00 »
  const time = d.toLocaleTimeString(lieu, { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return t("aujourd'hui à {heure}", { heure: time });
  if (days === 1) return t("demain à {heure}", { heure: time });
  if (days === -1) return t("hier à {heure}", { heure: time });
  return t("{jour} à {heure}", { jour: d.toLocaleDateString(lieu, { weekday: "short", day: "numeric", month: "short" }), heure: time });
};

// --- Routines ----------------------------------------------------------------------------

type Routine = {
  id: string;
  name: string | null;
  prompt: string;
  schedule_display: string;
  enabled: boolean;
  state: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  modele?: string | null;
  fournisseur?: string | null;
  outils?: string[] | null;
  image?: string | null;
};

/** Une routine du modèle d'agent, en pause dans Noah : rien ne tourne tant que la personne ne l'active pas. */
export type SuggestedRoutine = { id: number; nom: string; quand: string; horaire: string; consigne: string; en_pause: true };

const PRESETS: [string, string][] = [
  ["every day at 8am", t("Chaque matin à 8 h")],
  ["every weekday at 9am", t("Les jours de semaine à 9 h")],
  ["every monday 9am", t("Chaque lundi à 9 h")],
  ["every day at 6pm", t("Chaque soir à 18 h")],
  ["every 1h", t("Toutes les heures")],
];

type RoutineChoice = { modele: string | null; fournisseur?: string | null; outils: string[] | null; image: string | null };

const ROUTINE_TOOLS: [string, string][] = [
  ["internet", t("Recherche sur internet")],
  ["navigateur", t("Navigateur")],
  ["fichiers", t("Fichiers")],
  ["commandes", t("Commandes et outils de Noah")],
  ["memoire", t("Mémoire")],
  ["images_vues", t("Lire des images")],
  ["competences", t("Compétences")],
];
const ROUTINE_MODES: ModeId[] = ["fast", "balanced", "smart", "gratuit", "custom"];

/** Ce qu'une routine fixe pour elle seule. Tout vide : elle suit le réglage de l'agent. */
function RoutineSettings({ value, onChange }: { value: RoutineChoice; onChange: (v: RoutineChoice) => void }) {
  const [images, setImages] = useState<ListedModel[]>([]);
  const [precise, setPrecise] = useState(false);
  useEffect(() => {
    get<{ modeles: ListedModel[] }>("/api/modes/image/modeles").then((r) => setImages(r.modeles)).catch(() => {}); // réservé au propriétaire : un invité n'a pas ce choix
  }, []);
  const isMode = !!value.modele && (ROUTINE_MODES as string[]).includes(value.modele);
  const select = "h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm text-foreground";
  const tools = value.outils;
  const toggle = (id: string) => {
    const now = tools ?? ROUTINE_TOOLS.map(([t]) => t);
    onChange({ ...value, outils: now.includes(id) ? now.filter((t) => t !== id) : [...now, id] });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2.5 text-xs">
      <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
        {t("Modèle")}
        <select
          aria-label={t("Modèle de la routine")}
          value={value.modele && !isMode ? "precis" : value.modele ?? ""}
          onChange={(e) => {
            if (e.target.value === "precis") return setPrecise(true);
            setPrecise(false);
            onChange({ ...value, modele: e.target.value || null, fournisseur: null });
          }}
          className={select}
        >
          <option value="">{t("Comme l'agent")}</option>
          {ROUTINE_MODES.map((m) => <option key={m} value={m}>{MODE_NAMES[m]}</option>)}
          <option value="precis">{value.modele && !isMode ? value.modele : t("Un modèle précis…")}</option>
        </select>
      </label>
      {precise && <ModelSearch level="cerveau" selected={value.modele} onPick={(m) => { onChange({ ...value, modele: m.id, fournisseur: m.fournisseur }); setPrecise(false); }} />}
      {images.length > 0 && (
        <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {t("Images")}
          <select aria-label={t("Modèle d'image de la routine")} value={value.image ?? ""} onChange={(e) => onChange({ ...value, image: e.target.value || null })} className={select}>
            <option value="">{t("Comme l'agent")}</option>
            {images.map((m) => <option key={m.id} value={m.id}>{m.name}{m.prix ? ` · ${m.prix}` : ""}</option>)}
          </select>
        </label>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-muted-foreground">{t("Outils permis")}</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={tools === null} onChange={() => onChange({ ...value, outils: tools === null ? ROUTINE_TOOLS.map(([t]) => t) : null })} />{t("Tous ceux de l'agent")}</label>
        {tools !== null && ROUTINE_TOOLS.map(([id, label]) => (
          <label key={id} className="flex items-center gap-2 pl-5"><input type="checkbox" checked={tools.includes(id)} onChange={() => toggle(id)} />{label}</label>
        ))}
        {tools !== null && !tools.includes("commandes") && <p className="text-warn">{t("Sans « Commandes et outils de Noah », la routine ne peut ni créer d'image ni te notifier elle-même.")}</p>}
      </fieldset>
    </div>
  );
}

const choiceSummary = (r: Routine) => {
  const parts = [
    r.modele ? t("Modèle : {nom}", { nom: MODE_NAMES[r.modele as ModeId] ?? r.modele }) : "",
    r.image ? t("Images : {nom}", { nom: r.image }) : "",
    r.outils ? (r.outils.length > 1 ? t("{n} outils permis", { n: r.outils.length }) : t("{n} outil permis", { n: r.outils.length })) : "",
  ].filter(Boolean);
  return parts.join(" · ");
};

export function Routines({ agentId }: { agentId: string }) {
  const { data, error, setError, load } = useAgentData<{ routines: Routine[]; suggerees?: SuggestedRoutine[] }>(`/api/agents/${agentId}/routines`);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tuning, setTuning] = useState<{ id: string; value: RoutineChoice } | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const list = data?.routines ?? [];
  const suggested = data?.suggerees ?? [];

  // Un geste : la routine du modèle devient une vraie routine, active tout de suite.
  const activate = async (s: SuggestedRoutine) => {
    setBusy(`suggeree-${s.id}`);
    setError("");
    try {
      await send(`/api/agents/${agentId}/routines/suggerees/${s.id}/activer`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveTuning = async () => {
    if (!tuning) return;
    setBusy(tuning.id + "regler");
    setError("");
    try {
      const { modele, fournisseur, outils, image } = tuning.value;
      await send(`/api/agents/${agentId}/routines/${tuning.id}/modifier`, { modele: modele ?? "", fournisseur, outils: outils ?? ["tous"], image: image ?? "" });
      setTuning(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const act = async (r: Routine, action: string) => {
    if (action === "supprimer" && !confirm(t("Supprimer la routine « {nom} » ?", { nom: r.name || r.prompt.slice(0, 40) }))) return false;
    setBusy(r.id + action);
    try {
      await send(`/api/agents/${agentId}/routines/${r.id}/${action}`, {});
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const open = list.find((r) => r.id === opened) ?? null;
  if (open) {
    const r = open;
    const paused = !r.enabled || r.state === "paused";
    return (
      <ObjectPage title={r.name || t("Routine")} onClose={() => { setOpened(null); setTuning(null); }}>
        <button type="button" onClick={() => { setOpened(null); setTuning(null); }} className="flex cursor-pointer items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />{t("Routines")}
        </button>
        <div className="flex items-start gap-2">
          <span className={cn("mt-2 size-2.5 shrink-0 rounded-full", paused ? "bg-muted-foreground/40" : r.last_status === "error" ? "bg-danger" : "bg-ok")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{r.name || r.prompt.slice(0, 60)}</h3>
            <p className="text-sm text-muted-foreground">
              {scheduleLabel(r.schedule_display)}{paused ? ` · ${t("en pause")}` : r.next_run_at ? ` · ${t("prochaine {quand}", { quand: when(r.next_run_at) ?? "" })}` : ""}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="outline" onClick={() => act(r, paused ? "reprendre" : "pause")} disabled={!!busy}>
            {paused ? <Play /> : <Pause />}{paused ? t("Reprendre") : t("Pause")}
          </Button>
          <Button variant="outline" onClick={() => act(r, "lancer")} disabled={!!busy}>
            {busy === r.id + "lancer" ? <Loader2 className="animate-spin" /> : <Zap />}{t("Lancer")}
          </Button>
          <Button variant="outline" className="text-danger" onClick={async () => { if (await act(r, "supprimer")) setOpened(null); }} disabled={!!busy}>
            <Trash2 />{t("Supprimer")}
          </Button>
        </div>
        {r.last_error && <p className="text-sm text-danger">{t("Dernier passage en erreur : {erreur}", { erreur: r.last_error.slice(0, 300) })}</p>}
        <div className="rounded-xl bg-muted/50 p-3 text-sm whitespace-pre-wrap">{r.prompt}</div>
        {choiceSummary(r) && <p className="text-sm text-muted-foreground">{choiceSummary(r)}</p>}
        {tuning?.id === r.id ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <RoutineSettings value={tuning.value} onChange={(value) => setTuning({ id: r.id, value })} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setTuning(null)}>{t("Annuler")}</Button>
              <Button size="sm" disabled={!!busy} onClick={saveTuning}>{busy === r.id + "regler" && <Loader2 className="animate-spin" />}{t("Enregistrer")}</Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" className="self-start" disabled={!!busy}
            onClick={() => setTuning({ id: r.id, value: { modele: r.modele ?? null, fournisseur: r.fournisseur ?? null, outils: r.outils ?? null, image: r.image ?? null } })}>
            <SlidersHorizontal />{t("Modèle et outils")}
          </Button>
        )}
        <ErrorText>{error}</ErrorText>
      </ObjectPage>
    );
  }

  return (
    <Section title={t("Routines")} count={list.length + suggested.length} defaultOpen>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
      {data && !list.length && !suggested.length && !adding && <p className="text-sm text-muted-foreground">{t("Aucune routine.")}</p>}
      {suggested.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">{t("Proposées par son modèle. Rien ne tourne tant que tu ne les actives pas.")}</p>
          <ul aria-label={t("Routines en pause")} className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-dashed border-border">
            {suggested.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-3">
                <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                <span className="min-w-0 flex-1" title={s.consigne}>
                  <span className="block truncate text-sm font-medium">{s.nom}</span>
                  <span className="block truncate text-xs text-muted-foreground">{scheduleLabel(s.horaire)} · {t("En pause")}</span>
                </span>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => activate(s)}>
                  {busy === `suggeree-${s.id}` ? <Loader2 className="animate-spin" /> : <Play />}{t("Activer")}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {list.length > 0 && (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {list.map((r) => {
            const paused = !r.enabled || r.state === "paused";
            return (
              <li key={r.id}>
                <button type="button" onClick={(e) => { e.currentTarget.closest("[role=tabpanel]")?.scrollTo(0, 0); setOpened(r.id); }} className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left hover:bg-muted/50">
                  <span className={cn("size-2 shrink-0 rounded-full", paused ? "bg-muted-foreground/40" : r.last_status === "error" ? "bg-danger" : "bg-ok")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.name || r.prompt}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {scheduleLabel(r.schedule_display)}{paused ? ` · ${t("en pause")}` : r.next_run_at ? ` · ${when(r.next_run_at)}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <NewRoutine agentId={agentId} onDone={() => { setAdding(false); load(); }} />
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />{t("Nouvelle routine")}</Button>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function NewRoutine({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState(PRESETS[0][0]);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tune, setTune] = useState(false);
  const [choice, setChoice] = useState<RoutineChoice>({ modele: null, fournisseur: null, outils: null, image: null });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const { modele, fournisseur, outils, image } = choice;
      await send(`/api/agents/${agentId}/routines`, {
        nom: name, consigne: prompt, quand: preset === "custom" ? custom : preset,
        ...(modele ? { modele, fournisseur } : {}), ...(outils ? { outils } : {}), ...(image ? { image } : {}),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Nom (ex. Brief du matin)")} aria-label={t("Nom de la routine")} maxLength={80} />
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        required
        aria-label={t("Consigne")}
        placeholder={t("Ce que l'agent doit faire à chaque passage. Ex. Résume mes mails non lus importants et mon agenda du jour.")}
      />
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t("Quand")}
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm"
        >
          {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          <option value="custom">{t("Autre…")}</option>
        </select>
        {preset === "custom" && ( // i18n-ignore : la syntaxe d'horaire que lit le serveur
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} required className="h-9 flex-1" placeholder="every 30m, 0 7 * * 1-5…" aria-label={t("Horaire personnalisé")} />
        )}
      </div>
      <button type="button" className="cursor-pointer self-start text-xs text-muted-foreground underline" aria-expanded={tune} onClick={() => setTune(!tune)}>
        {t("Modèle et outils de cette routine")}
      </button>
      {tune && <RoutineSettings value={choice} onChange={setChoice} />}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>{t("Annuler")}</Button>
        <Button type="submit" size="sm" disabled={saving || !prompt.trim()}>{saving && <Loader2 className="animate-spin" />}{t("Créer")}</Button>
      </div>
    </form>
  );
}

// --- Mémoire --------------------------------------------------------------------------------

type MemoryState = { memory: string[]; user: string[]; limites: { memory: number; user: number } };
type MemoryProposal = { cible: "memory" | "user"; entree: string; raison: string };
type MemoryReview = { propositions: MemoryProposal[]; avant: number; apres: number };

export function Memory({ agentId }: { agentId: string }) {
  const { data, setData, error, setError } = useAgentData<MemoryState>(`/api/agents/${agentId}/memory`);
  const total = data ? data.memory.length + data.user.length : undefined;
  const [review, setReview] = useState<MemoryReview | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const save = async (target: "memory" | "user", entries: string[]) => {
    try {
      setData(await send<MemoryState>(`/api/agents/${agentId}/memory`, { cible: target, entrees: entries }, "PUT"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runReview = async () => {
    setReviewing(true);
    setError("");
    try {
      setReview(await send<MemoryReview>(`/api/agents/${agentId}/memory/relire`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewing(false);
    }
  };
  const forget = async (items: MemoryProposal[]) => {
    if (!data || !review) return;
    for (const target of ["memory", "user"] as const) {
      const out = items.filter((p) => p.cible === target).map((p) => p.entree);
      if (out.length) await save(target, data[target].filter((e) => !out.includes(e)));
    }
    const rest = review.propositions.filter((p) => !items.includes(p));
    setReview(rest.length ? { ...review, propositions: rest } : null);
  };

  return (
    <Section title={t("Mémoire")} count={total} alone>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
      {data && (
        <>
          <MemoryList title={t("Ce qu'il sait de toi")} entries={data.user} limit={data.limites.user} onSave={(e) => save("user", e)}
            empty={t("Rien encore. L'agent y note qui tu es, tes goûts et tes habitudes au fil des conversations.")} />
          <MemoryList title={t("Ses notes de travail")} entries={data.memory} limit={data.limites.memory} onSave={(e) => save("memory", e)}
            empty={t("Rien encore. L'agent y garde ce qui lui servira plus tard : outils, décisions, contexte.")} />
          <p className="text-xs text-muted-foreground">
            {t("Tout ceci est relu à chaque message, et se paie à chaque fois. Une modification compte dès la prochaine conversation.")}
          </p>
          {review ? (
            <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2.5">
              {review.propositions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("Rien à retirer : tout semble utile à chaque message.")}</p>
              ) : (
                <>
                  <p className="text-sm font-medium">
                    {review.propositions.length > 1
                      ? t("Le modèle de décision propose de retirer {n} notes ({avant} → {apres} caractères). Rien ne part sans ton accord.", { n: review.propositions.length, avant: review.avant, apres: review.apres })
                      : t("Le modèle de décision propose de retirer {n} note ({avant} → {apres} caractères). Rien ne part sans ton accord.", { n: review.propositions.length, avant: review.avant, apres: review.apres })}
                  </p>
                  {review.propositions.map((p) => (
                    <div key={p.cible + p.entree} className="flex items-start gap-1 rounded-lg px-2 py-1 text-sm hover:bg-muted">
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2">{p.entree}</p>
                        <p className="text-xs text-muted-foreground">{p.raison}</p>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => forget([p])}><Trash2 />{t("Oublier")}</Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" className="self-start" onClick={() => forget(review.propositions)}><Trash2 />{t("Tout oublier")}</Button>
                </>
              )}
              <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={() => setReview(null)}>{t("Fermer")}</Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="self-start" disabled={reviewing || !total} onClick={runReview}>
              {reviewing && <Loader2 className="animate-spin" />}{t("Relire et proposer un nettoyage")}
            </Button>
          )}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function MemoryList({ title, entries, limit, empty, onSave }: { title: string; entries: string[]; limit: number; empty: string; onSave: (e: string[]) => Promise<void> }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const used = entries.join("\n§\n").length;
  const start = (i: number) => {
    setEditing(i);
    setDraft(i < entries.length ? entries[i] : "");
  };
  const commit = async () => {
    const next = [...entries];
    if (editing === null) return;
    if (!draft.trim()) next.splice(editing, 1);
    else if (editing < entries.length) next[editing] = draft.trim();
    else next.push(draft.trim());
    await onSave(next);
    setEditing(null);
  };
  const editor = (
    <div className="flex flex-col gap-1.5">
      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus aria-label={t("Souvenir")} />
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("Annuler")}</Button>
        <Button size="sm" onClick={commit}><Check />{t("Enregistrer")}</Button>
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className={cn("text-[11px] tabular-nums", used > limit * 0.9 ? "text-warn" : "text-muted-foreground")} title={t("Place utilisée")}>
          {t("{n} %", { n: Math.round((100 * used) / limit) })}
        </span>
      </div>
      {!entries.length && editing === null && <p className="text-xs text-muted-foreground">{empty}</p>}
      {entries.map((e, i) =>
        editing === i ? (
          <div key={i}>{editor}</div>
        ) : (
          <div key={i} className="group flex items-start gap-1 rounded-lg px-2 py-1 text-sm hover:bg-muted">
            <p className="min-w-0 flex-1 whitespace-pre-wrap">{e}</p>
            <Button size="icon-sm" variant="ghost" className="opacity-0 pointer-coarse:opacity-100 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => start(i)} aria-label={t("Modifier ce souvenir")}><Pencil /></Button>
            <Button size="icon-sm" variant="ghost" className="opacity-0 pointer-coarse:opacity-100 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onSave(entries.filter((_, j) => j !== i))} aria-label={t("Oublier ce souvenir")}><Trash2 /></Button>
          </div>
        ),
      )}
      {editing === entries.length ? editor : (
        <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={() => start(entries.length)}><Plus />{t("Ajouter")}</Button>
      )}
    </div>
  );
}

// --- Connexions -------------------------------------------------------------------------------

type GoogleState = { disponible: boolean; connecte?: boolean };

export type Droit = "lire" | "agir" | "confirmer";
type Etat = "ok" | "injoignable" | "a_connecter" | "jeton_refuse" | "refuse" | "";
type App = { nom: string; description: string; source: string | null; oauth: boolean; hote: string | null; installe: boolean; connecte: boolean; droit?: Droit; etat?: Etat; erreur?: string };
type FoundTool = { nom: string; description: string; lecture_seule: boolean };
type CustomTool = { nom: string; url: string; compte?: string; auth: "aucune" | "jeton" | "oauth"; jeton: boolean; droit: Droit; etat: Etat; erreur: string; connecte: boolean; outils: FoundTool[] };
type GlobalConnector = { nom: string; genre: string; connecte: boolean; origine: boolean };
type ConnectionsState = { google: GoogleState; applications: App[]; outils?: CustomTool[]; globaux?: GlobalConnector[]; age?: number };


const DROITS: [Droit, string][] = [
  ["confirmer", t("Demander confirmation")],
  ["lire", t("Lire seulement")],
  ["agir", t("Agir sans demander")],
];

/** Le droit vaut pour tout le serveur : MCP ne donne pas de quoi régler chaque action autrement que par sa déclaration de lecture. */
export function RightSelect({ agentId, name, droit, onChange, onError }: { agentId: string; name: string; droit: Droit; onChange: () => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const change = async (next: string) => {
    setBusy(true);
    onError("");
    try {
      await send(`/api/agents/${agentId}/connections/tools/${name}/droit`, { droit: next }, "PUT");
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <select aria-label={t("Droit de l'agent sur {nom}", { nom: appLabel(name) })} value={droit} disabled={busy} onChange={(e) => change(e.target.value)}
      className="h-8 cursor-pointer rounded-lg border border-border bg-background px-2 text-xs">
      {DROITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

const LOGOS = new Map<string, string | null>();

/** Le vrai logo, récupéré par le serveur Noah : le navigateur ne parle à aucun tiers. La lettre reste tant qu'il n'y en a pas. */
function AppLogo({ host, name, className }: { host?: string | null; name: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(host ? LOGOS.get(host) ?? null : null);
  useEffect(() => {
    if (!host || LOGOS.has(host) || !box.current) return;
    let gone = false;
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      seen.disconnect();
      request(`/api/logos/${encodeURIComponent(host)}`).then((res) => (res.status === 200 ? res.blob() : null)).then((blob) => {
        if (!blob) return void LOGOS.set(host, null);
        const url = URL.createObjectURL(blob);
        LOGOS.set(host, url);
        if (!gone) setSrc(url);
      }).catch(() => LOGOS.set(host, null));
    });
    seen.observe(box.current);
    return () => { gone = true; seen.disconnect(); };
  }, [host]);
  return (
    <span ref={box} className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg text-sm font-bold", src ? "bg-white ring-1 ring-border" : "bg-muted", className)}>
      {src ? <img src={src} alt="" className={cn("object-contain", className ? "size-3.5" : "size-6")} onError={() => setSrc(null)} /> : name[0].toUpperCase()}
    </span>
  );
}

const hostOf = (url?: string | null) => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

type Waiting = Record<string, "auto" | "coller">; // connexions dont l'accord est en cours : le fournisseur revient seul, ou la personne colle

export function Connections({ agentId, shared = false, owner = false }: { agentId: string; shared?: boolean; /** Son propriétaire : lui seul décide « pour tous mes agents ». */ owner?: boolean }) {
  const subscribeUpdates = useVisibleSubscription();
  const { data, error, setError, load } = useAgentData<ConnectionsState>(`/api/agents/${agentId}/connections`);
  const [waiting, setWaiting] = useState<Waiting>({});
  const wait = (name: string, mode?: "auto" | "coller") => setWaiting((w) => {
    const next = { ...w };
    if (mode) next[name] = mode;
    else delete next[name];
    return next;
  });
  const automatic = Object.entries(waiting).filter(([, m]) => m === "auto").map(([n]) => n).join(",");
  useEffect(() => { // le fournisseur revient directement sur le serveur : cet écran le voit en relisant l'état
    if (!automatic) return;
    const started = Date.now();
    const again = subscribeUpdates(() => {
      if (Date.now() - started > 600_000) setWaiting({});
      else void load();
    });
    return again;
  }, [automatic, load]);
  useEffect(() => {
    if (!data) return;
    for (const a of [...(data.applications ?? []), ...(data.outils ?? [])]) if (a.connecte && waiting[a.nom]) wait(a.nom);
  }, [data, waiting]);
  // La réponse gardée par le serveur a vieilli : affichée tout de suite, relue derrière.
  const age = data?.age;
  useEffect(() => {
    if (age) void load();
  }, [age, load]);
  const [browsing, setBrowsing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [arriving, setArriving] = useState("");
  const google = data?.google;
  const apps = data?.applications ?? [];
  const tools = data?.outils ?? [];
  const connected = apps.filter((a) => a.installe);
  const q = query.trim().toLowerCase();
  const others = apps.filter((a) => !a.installe && (!q || `${a.nom} ${a.description}`.toLowerCase().includes(q)));
  const globals = data?.globaux ?? [];
  const here = new Set([...connected.map((a) => a.nom), ...tools.map((t) => t.nom)]);
  const pending = owner ? globals.filter((g) => !g.connecte && g.nom !== "google" && !here.has(g.nom)) : [];
  const scope = (nom: string) => owner && <ConnectorScope key={`portee-${agentId}-${nom}`} agentId={agentId} nom={nom} global={globals.some((g) => g.nom === nom)} onChange={load} />;
  return (
    <Section title={t("Connexions")} count={(google?.connecte ? 1 : 0) + connected.filter((a) => a.connecte).length + tools.filter((t) => t.connecte).length} alone>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
      {/* En haut : parcourir le catalogue et voir d'un coup ce qui est branché. Le reste (Google, outils par adresse,
          sites du navigateur) vient dessous. */}
      {data && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant={browsing ? "default" : "outline"} size="sm" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
            <Plus />{t("Autres applications")}
          </Button>
          {connected.filter((a) => a.connecte).map((a) => (
            <span key={a.nom} className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-0.5 pr-2.5 pl-1 text-xs">
              <AppLogo host={a.hote ?? hostOf(a.source)} name={a.nom} className="size-5" />
              <span className="font-medium">{appLabel(a.nom)}</span>
            </span>
          ))}
          {!connected.filter((a) => a.connecte).length && !browsing && <span className="text-xs text-muted-foreground">{t("Rien de branché pour l'instant.")}</span>}
        </div>
      )}
      {data && browsing && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2">
          {/* i18n-ignore : des noms d'applications, pareils dans toutes les langues */}
          <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-9" placeholder="Notion, Todoist, Linear, Figma, brollss…" aria-label={t("Chercher une application")} autoFocus />
          <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
            {others.map((a) => <AppRow key={a.nom} agentId={agentId} app={a} waiting={waiting[a.nom]} onWait={(m) => wait(a.nom, m)} onChange={load} onError={setError} />)}
            {!others.length && <p className="p-2 text-xs text-muted-foreground">{t("Aucune application ne correspond.")}</p>}
          </div>
          <Button size="sm" variant="ghost" className="self-end" onClick={() => setBrowsing(false)}>{t("Fermer")}</Button>
        </div>
      )}
      {google?.disponible && data && <GoogleCard agentId={agentId} onError={setError} />}
      {google?.connecte && scope("google")}
      {connected.map((a) => <AppRow key={a.nom} agentId={agentId} app={a} waiting={waiting[a.nom]} onWait={(m) => wait(a.nom, m)} onChange={load} onError={setError} extra={a.connecte ? scope(a.nom) : null} />)}
      {tools.map((t) => <ToolRow key={t.nom} agentId={agentId} tool={t} waiting={waiting[t.nom]} onWait={(m) => wait(t.nom, m)} onChange={load} onError={setError} extra={t.connecte ? scope(t.nom) : null} />)}
      {pending.map((g) => <PendingGlobal key={g.nom} agentId={agentId} nom={g.nom} waiting={waiting[g.nom]} onWait={(m) => wait(g.nom, m)} onChange={load} onError={setError} />)}
      {data && <PublishCards agentId={agentId} shared={shared} tools={tools} onWait={wait} onChange={load} />}
      {data && <BrowserSites agentId={agentId} />}
      <SavedLogins agentId={agentId} />
      {arriving && <p className="text-xs text-muted-foreground">{t("« {nom} » arrive chez l'agent en moins d'une minute.", { nom: arriving })}</p>}
      {data && (adding ? (
        <AddTool agentId={agentId} shared={shared} onClose={() => setAdding(false)}
          onAdded={(name, mode) => { setAdding(false); if (mode) wait(name, mode); else setArriving(name); load(); }} />
      ) : (
        <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => setAdding(true)}>{t("Ajouter un outil par son adresse (avancé)")}</Button>
      ))}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

/** Publier par l'API : Instagram et X. Sans elles, l'agent publie avec son navigateur : c'est un plus, jamais un passage obligé. */
function PublishCards({ agentId, shared, tools, onWait, onChange }: { agentId: string; shared: boolean; tools: CustomTool[]; onWait: (name: string, mode?: "auto" | "coller") => void; onChange: () => void }) {
  const [state, setState] = useState<{ retour: string; adresse_publique: boolean } | null>(null);
  const [open, setOpen] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    get<{ retour: string; adresse_publique: boolean }>(`/api/agents/${agentId}/publication`).then(setState).catch(() => setState(null));
  }, [agentId]);
  if (!state) return null;
  const left = [["instagram", "Instagram", "instagram.com"], ["x", "X", "x.com"]].filter(([nom]) => !tools.some((t) => t.nom === nom));
  if (!left.length) return null;
  const toggle = (nom: string) => { setOpen((o) => (o === nom ? "" : nom)); setValue(""); setError(""); setTyping(false); };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (open === "instagram") {
        await send(`/api/agents/${agentId}/publication/instagram`, { jeton: value.trim() });
      } else {
        const r = await send<{ adresse: string }>(`/api/agents/${agentId}/publication/x`, { client_id: value.trim() });
        window.open(r.adresse, "_blank", "noopener");
        onWait("x", "auto");
      }
      setOpen("");
      setValue("");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const AGENT_DOES: Record<string, string> = {
    instagram: t("Connecte mon Instagram pour publier par l'API : suis la recette `python3 /opt/data/noah.py recette instagram`. Fais tout toi-même et appelle-moi seulement quand je dois me connecter."),
    x: t("Connecte mon compte X pour publier par l'API : suis la recette `python3 /opt/data/noah.py recette x`. Fais tout toi-même et appelle-moi seulement quand je dois me connecter."),
  };
  const possible = (nom: string) => (nom === "x" ? !!state.retour : state.adresse_publique);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="mt-1 text-sm font-medium">{t("Réseaux sociaux")}</p>
      {shared && <p className="text-xs font-medium text-warn">{t("Agent partagé : ses utilisateurs pourront publier sur ce compte.")}</p>}
      {left.map(([nom, label, host]) => (
        <div key={nom} className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
          <div className="flex items-center gap-2.5">
            <AppLogo host={host} name={nom} />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">{label}</p>
            {possible(nom) ? (
              <Button size="sm" variant="outline" onClick={() => toggle(nom)}>{open === nom ? t("Fermer") : t("Connecter")}</Button>
            ) : (
              <span className="text-xs text-muted-foreground">{t("Par le navigateur")}</span>
            )}
          </div>
          {open === nom && open !== "" && !value && !typing && (
            <div className="flex flex-col gap-2">
              <Button onClick={() => { askAgent(AGENT_DOES[nom]); setOpen(""); }}>{t("L'agent s'en charge")}</Button>
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setTyping(true)}>{nom === "x" ? t("J'ai déjà un Client ID") : t("J'ai déjà un jeton")}</Button>
            </div>
          )}
          {open === nom && (typing || value) && (
            <div className="flex items-center gap-2">
              <Input value={value} onChange={(e) => setValue(e.target.value)} type={nom === "x" ? "text" : "password"} autoComplete="off" className="h-9 min-w-0 flex-1" autoFocus
                placeholder={nom === "x" ? t("Client ID") : t("Jeton d'accès")} aria-label={nom === "x" ? t("Client ID de X") : t("Jeton d'accès Instagram")} />
              <Button size="sm" onClick={submit} disabled={!value.trim() || busy}>{busy && <Loader2 className="animate-spin" />}{nom === "x" ? t("Continuer") : t("Vérifier")}</Button>
            </div>
          )}
          {open === nom && <ErrorText>{error}</ErrorText>}
        </div>
      ))}
    </div>
  );
}

type Site = { hote: string; nom: string; compte: string; vu_a: number; retenu?: boolean };

/** Les sites où l'agent est connecté dans son navigateur, notés par lui (server/noah/sites.py). */
function BrowserSites({ agentId }: { agentId: string }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const load = useCallback(() => get<Site[]>(`/api/agents/${agentId}/sites`).then(setSites).catch(() => setSites([])), [agentId]);
  useEffect(() => { load(); }, [load]);
  if (!sites?.length) return null;
  const forget = async (host: string) => {
    await request(`/api/agents/${agentId}/sites/${encodeURIComponent(host)}`, { method: "DELETE" }).catch(() => {});
    load();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="mt-1 text-sm font-medium">{t("Dans son navigateur")}</p>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
        {sites.map((site) => (
          <li key={site.hote} className="flex items-center gap-2.5 p-2.5">
            <AppLogo host={site.hote} name={site.nom} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{site.nom}</span>
              <span className="block truncate text-xs text-muted-foreground">{site.compte || site.hote}</span>
            </span>
            {!site.retenu && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => forget(site.hote)} aria-label={t("Retirer {nom}", { nom: site.nom })}>{t("Retirer")}</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppRow({ agentId, app, waiting, onWait, onChange, onError, extra }: { agentId: string; app: App; waiting?: "auto" | "coller"; onWait: (mode?: "auto" | "coller") => void; onChange: () => void; onError: (e: string) => void; extra?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState("");
  const base = `/api/agents/${agentId}/connections/apps/${app.nom}`;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      const r = await send<{ adresse?: string; connecte?: boolean; retour?: boolean }>(`${base}/connect`, {});
      if (r.adresse) {
        window.open(r.adresse, "_blank", "noopener");
        onWait(r.retour ? "auto" : "coller");
      } else onChange();
    });
  const finish = () =>
    run(async () => {
      await send(`${base}/finish`, { adresse: back });
      onWait();
      setBack("");
      onChange();
    });
  const remove = () =>
    run(async () => {
      if (!confirm(t("Retirer {nom} ? L'agent n'y aura plus accès.", { nom: appLabel(app.nom) }))) return;
      await send(`${base}/remove`, {});
      onChange();
    });
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg px-2 py-1.5", app.installe && "border border-border p-2.5")}>
      <div className="flex items-center gap-2.5">
        <AppLogo host={app.hote ?? hostOf(app.source)} name={app.nom} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{appLabel(app.nom)}</p>
          {!app.installe && <p className="truncate text-xs text-muted-foreground" title={app.description}>{app.description}</p>}
        </div>
        {app.connecte ? (
          <>
            {app.etat && app.etat !== "ok"
              ? <span className="text-xs font-medium text-danger">{t("En panne")}</span>
              : <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />{t("Connecté")}</span>}
            <Button size="icon-sm" variant="ghost" onClick={remove} disabled={busy} aria-label={t("Retirer {nom}", { nom: appLabel(app.nom) })}><Trash2 /></Button>
          </>
        ) : !waiting ? (
          <Button size="sm" variant={app.installe ? "default" : "outline"} onClick={connect} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}{app.installe ? t("Terminer la connexion") : t("Connecter")}
          </Button>
        ) : null}
      </div>
      {app.installe && app.connecte && app.erreur && <p className="text-xs text-danger">{tServeur(app.erreur)}</p>}
      {app.installe && app.connecte && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("Ce qu'il peut faire")}</span>
          <RightSelect agentId={agentId} name={app.nom} droit={app.droit ?? "confirmer"} onChange={onChange} onError={onError} />
        </div>
      )}
      {extra}
      {waiting === "auto" && <LoginAuto onReopen={connect} busy={busy} />}
      {waiting === "coller" && <LoginBack label={appLabel(app.nom)} value={back} onValue={setBack} onReopen={connect} onFinish={finish} busy={busy} />}
    </div>
  );
}

/** Le fournisseur revient directement sur le serveur Noah : rien à faire ici, l'état se met à jour seul. */
export function LoginAuto({ onReopen, busy }: { onReopen: () => void; busy: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("Accepte dans l'onglet ouvert. Noah termine seul.")}</p>
      <Button size="sm" variant="ghost" onClick={onReopen} disabled={busy}>{t("Rouvrir")}</Button>
    </div>
  );
}

/** Retour du fournisseur OAuth : l'adresse de la page de retour, qu'Hermes attend sur un port de la machine de l'agent. */
export function LoginBack({ label, value, onValue, onReopen, onFinish, busy }: { label: string; value: string; onValue: (v: string) => void; onReopen: () => void; onFinish: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {t("Accepte dans l'onglet ouvert. Tu arrives ensuite sur une page qui ne s'affiche pas (adresse « 127.0.0.1 ») : c'est normal, copie son adresse complète ici.")}
      </p>
      {/* i18n-ignore : forme d'une adresse technique */}
      <Input value={value} onChange={(e) => onValue(e.target.value)} className="h-9" placeholder="http://127.0.0.1:…/callback?code=…" aria-label={t("Adresse de retour de {nom}", { nom: label })} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onReopen} disabled={busy}>{t("Rouvrir")}</Button>
        <Button size="sm" onClick={onFinish} disabled={!value.trim() || busy}>{busy && <Loader2 className="animate-spin" />}{t("Terminer")}</Button>
      </div>
    </div>
  );
}

const ETATS: Partial<Record<Etat, string>> = { injoignable: t("En panne"), refuse: t("Adresse refusée"), jeton_refuse: t("Jeton refusé"), a_connecter: t("À connecter") };

/** Un outil ajouté par adresse : son état, son droit, et ce qu'il offre. */
function ToolRow({ agentId, tool, waiting, onWait, onChange, onError, extra }: { agentId: string; tool: CustomTool; waiting?: "auto" | "coller"; onWait: (mode?: "auto" | "coller") => void; onChange: () => void; onError: (e: string) => void; extra?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState("");
  const base = `/api/agents/${agentId}/connections/tools/${tool.nom}`;
  const label = appLabel(tool.nom);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      const r = await send<{ adresse?: string; retour?: boolean }>(`${base}/connect`, {});
      if (r.adresse) window.open(r.adresse, "_blank", "noopener");
      onWait(r.retour ? "auto" : "coller");
    });
  const finish = () =>
    run(async () => {
      await send(`${base}/finish`, { adresse: back });
      onWait();
      setBack("");
      onChange();
    });
  const remove = () =>
    run(async () => {
      if (!confirm(t("Retirer {nom} ? L'agent n'y aura plus accès.", { nom: label }))) return;
      await send(`${base}/remove`, {});
      onChange();
    });
  const problem = ETATS[tool.etat];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-2.5">
        <AppLogo host={hostOf(tool.url)} name={tool.nom} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="truncate text-xs text-muted-foreground" title={tool.url}>{tool.compte ? `@${tool.compte}` : tool.url}</p>
        </div>
        {problem
          ? <span className={cn("text-xs font-medium", tool.etat === "a_connecter" ? "text-warn" : "text-danger")}>{problem}</span>
          : <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />{t("Connecté")}</span>}
        <Button size="icon-sm" variant="ghost" onClick={remove} disabled={busy} aria-label={t("Retirer {nom}", { nom: label })}><Trash2 /></Button>
      </div>
      {tool.erreur && <p className="text-xs text-danger">{t("{erreur} L'agent le sait et continue sans cet outil.", { erreur: tServeur(tool.erreur) })}</p>}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t("Ce qu'il peut faire")}</span>
        <RightSelect agentId={agentId} name={tool.nom} droit={tool.droit} onChange={onChange} onError={onError} />
        {tool.outils.length > 0 && <span title={tool.outils.map((o) => o.nom).join(", ")}>{tool.outils.length > 1 ? t("{n} outils", { n: tool.outils.length }) : t("{n} outil", { n: tool.outils.length })}</span>}
      </div>
      {extra}
      {tool.auth === "oauth" && !tool.connecte && !waiting && (
        <Button size="sm" className="self-start" onClick={connect} disabled={busy}>{busy && <Loader2 className="animate-spin" />}{t("Terminer la connexion")}</Button>
      )}
      {waiting === "auto" && <LoginAuto onReopen={connect} busy={busy} />}
      {waiting === "coller" && <LoginBack label={label} value={back} onValue={setBack} onReopen={connect} onFinish={finish} busy={busy} />}
    </div>
  );
}

/** Ajouter un serveur MCP par son adresse : rien ne s'enregistre avant un test réussi, avec exactement ces réglages. */
function AddTool({ agentId, shared, onClose, onAdded }: { agentId: string; shared: boolean; onClose: () => void; onAdded: (name: string, mode?: "auto" | "coller") => void }) {
  const base = `/api/agents/${agentId}/connections/tools`;
  const [form, setForm] = useState({ url: "", nom: "", auth: "aucune", jeton: "", droit: "confirmer" });
  const [found, setFound] = useState<{ nom: string; oauth: boolean; outils: FoundTool[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setFound(null); // un autre réglage demande un autre test
    setError("");
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const test = () => run(async () => setFound(await send<{ nom: string; oauth: boolean; outils: FoundTool[] }>(`${base}/test`, form)));
  const save = () =>
    run(async () => {
      const r = await send<{ nom: string; adresse?: string; retour?: boolean }>(base, form);
      if (r.adresse) window.open(r.adresse, "_blank", "noopener");
      onAdded(r.nom, r.adresse ? (r.retour ? "auto" : "coller") : undefined);
    });
  return (
    <form onSubmit={(e) => { e.preventDefault(); void (found ? save() : test()); }} className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <Input value={form.url} onChange={(e) => change({ url: e.target.value })} className="h-9" required placeholder={t("https://mcp.exemple.fr/mcp")} aria-label={t("Adresse du serveur MCP")} autoFocus />
      <Input value={form.nom} onChange={(e) => change({ nom: e.target.value })} className="h-9" placeholder={t("Nom (déduit de l'adresse si vide)")} aria-label={t("Nom de l'outil")} maxLength={31} />
      <div className="flex flex-wrap gap-2">
        <select aria-label={t("Authentification")} value={form.auth} onChange={(e) => change({ auth: e.target.value, jeton: "" })} className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm">
          <option value="aucune">{t("Sans authentification")}</option>
          <option value="jeton">{t("Avec un jeton")}</option>
          <option value="oauth">{t("Avec OAuth")}</option>
        </select>
        <select aria-label={t("Droit de l'agent")} value={form.droit} onChange={(e) => setForm({ ...form, droit: e.target.value })} className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm">
          {DROITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {form.auth === "jeton" && (
        <Input type="password" autoComplete="off" value={form.jeton} onChange={(e) => change({ jeton: e.target.value })} className="h-9" required placeholder={t("Jeton")} aria-label={t("Jeton")} />
      )}
      {form.auth === "jeton" && <p className="text-xs text-muted-foreground">{t("Le jeton reste chiffré sur ton serveur : ni l'agent ni cet écran ne le reverront.")}</p>}
      <p className="text-xs text-muted-foreground">{t("Le droit vaut pour tout ce serveur. « Lire seulement » s'en remet à ce que le serveur déclare en lecture. Avec « Confirmer », ce qu'il déclare en lecture passe sans accord. Dans une routine, personne ne peut confirmer : le reste y est refusé.")}</p>
      <p className="text-xs text-muted-foreground">{t("Une commande locale n'est pas acceptée ici : elle reviendrait à exécuter du code téléchargé sur la machine de l'agent.")}</p>
      <p className={cn("text-xs", shared ? "font-medium text-warn" : "text-muted-foreground")}>
        {shared ? t("Cet agent est partagé : cet outil servira aussi à ceux à qui tu donnes le droit admin.") : t("Si tu partages cet agent, cet outil servira aussi à ceux à qui tu donnes le droit admin.")}
      </p>
      {found && (
        <div className="rounded-lg bg-muted p-2 text-xs">
          {found.oauth ? (
            <p>{t("Le serveur répond et demande OAuth. Ses outils seront listés une fois la connexion acceptée.")}</p>
          ) : (
            <>
              <p className="font-medium">{found.outils.length > 1
                ? t("Connexion réussie : {n} outils trouvés, enregistré sous « {nom} ».", { n: found.outils.length, nom: found.nom })
                : t("Connexion réussie : {n} outil trouvé, enregistré sous « {nom} ».", { n: found.outils.length, nom: found.nom })}</p>
              <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                {found.outils.map((o) => <li key={o.nom} className="truncate" title={o.description}><span className="font-mono">{o.nom}</span>{o.lecture_seule ? ` · ${t("lecture")}` : ""}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
      <PrivateNetworks />
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t("Annuler")}</Button>
        {found
          ? <Button type="submit" size="sm" disabled={busy}>{busy && <Loader2 className="animate-spin" />}{found.oauth ? t("Enregistrer et connecter") : t("Enregistrer")}</Button>
          : <Button type="submit" size="sm" disabled={busy || !form.url.trim()}>{busy && <Loader2 className="animate-spin" />}{t("Tester la connexion")}</Button>}
      </div>
    </form>
  );
}

/** Pour le propriétaire seulement (la route refuse les autres, et rien ne s'affiche alors) : un outil sur son réseau privé. */
function PrivateNetworks() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    get<{ reseaux: string[] }>("/api/mcp/reseaux").then((r) => setText(r.reseaux.join(", "))).catch(() => setText(null));
  }, []);
  if (text === null) return null;
  const save = async () => {
    setError("");
    try {
      const r = await send<{ reseaux: string[] }>("/api/mcp/reseaux", { reseaux: text.split(/[\s,]+/).filter(Boolean) }, "PUT");
      setText(r.reseaux.join(", "));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t("Serveur sur ton réseau privé")}</summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        <p>{t("Adresses privées et http restent refusés, sauf sur un réseau que tu acceptes ici (exemple : 192.168.1.0/24). Le réseau interne de Noah reste toujours refusé.")}</p>
        <div className="flex gap-2">
          <Input value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} className="h-8" placeholder="192.168.1.0/24" aria-label={t("Réseaux privés acceptés")} />
          <Button type="button" size="sm" variant="outline" onClick={save}>{saved ? <Check /> : null}{t("Accepter")}</Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
    </details>
  );
}

type GoogleAccess = { id: string; service: string; nom: string };
type GoogleAccount = {
  identifiants: boolean;
  connecte: boolean;
  compte: string;
  permissions: string[];
  catalogue: GoogleAccess[];
  etape: "configuration" | "accord" | "fini" | "erreur" | null;
  message: string;
  voulu: string[];
  consigne?: string;
  autres?: { compte: string; permissions: string[] }[];
  droit?: Droit;
  ajout?: boolean;
};

/** Le « G » de Google, à ses couleurs, comme dans ses propres écrans de connexion. */
function GoogleLogo() {
  return (
    <span className="grid size-8 place-items-center rounded-lg border border-border bg-white">
      <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    </span>
  );
}

const GOOGLE_DROITS: [Droit, string][] = [
  ["confirmer", t("Lire sans demander, confirmer pour écrire")],
  ["agir", t("Lire et écrire sans demander")],
  ["lire", t("Lire seulement")],
];

// « Écrire » comprend « lire » : cocher l'un coche l'autre, décocher la lecture retire l'écriture.
const WRITE_OF: Record<string, string> = { gmail_ecrire: "gmail_lire", agenda_ecrire: "agenda_lire", drive_ecrire: "drive_lire" };
const DEFAULT_ACCESS = ["gmail_lire", "agenda_lire", "drive_lire"];

/**
 * Google en un seul accord : l'utilisateur coche ce que l'agent peut faire. La première fois, l'agent crée
 * lui-même l'accès Google de l'utilisateur dans son navigateur (il l'appelle pour se connecter) ; ensuite Noah Agent
 * valide lui-même la page d'accord de Google avec les accès cochés.
 */
function GoogleCard({ agentId, onError }: { agentId: string; onError: (e: string) => void }) {
  const subscribeUpdates = useVisibleSubscription();
  const base = `/api/agents/${agentId}/google`;
  const [state, setState] = useState<GoogleAccount | null>(null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>(DEFAULT_ACCESS);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false); // un compte Google de plus
  const waiting = state?.etape === "configuration" || state?.etape === "accord";

  const load = useCallback(() => get<GoogleAccount>(base).then(setState).catch((e) => onError((e as Error).message)), [base, onError]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    return subscribeUpdates(load);
  }, [waiting, load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setChosen((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id && WRITE_OF[x] !== id);
      return [...new Set([...cur, id, ...(WRITE_OF[id] ? [WRITE_OF[id]] : [])])];
    });
  const connect = () =>
    run(async () => {
      const r = await send<GoogleAccount>(`${base}/${adding ? "ajouter" : "connect"}`, { permissions: chosen });
      setState(r);
      setPicking(false);
      setAdding(false);
      if (r.consigne) askAgent(r.consigne);
    });
  const setRight = (droit: string) => run(async () => setState(await send<GoogleAccount>(`${base}/droit`, { droit }, "PUT")));
  const disconnectOther = (compte: string) =>
    run(async () => {
      if (confirm(t("Déconnecter {compte} de cet agent ?", { compte }))) {
        setState(await send<GoogleAccount>(`${base}/disconnect?compte=${encodeURIComponent(compte)}`, {}));
      }
    });
  const cancel = () => run(async () => setState(await send<GoogleAccount>(`${base}/cancel`, {})));
  const disconnect = () =>
    run(async () => {
      if (confirm(t("Déconnecter Google de cet agent ? Il n'aura plus accès à tes courriels, ton agenda ni tes fichiers."))) {
        setState(await send<GoogleAccount>(`${base}/disconnect`, {}));
      }
    });
  const uploadClient = (file: File | undefined) =>
    file &&
    run(async () => {
      await send("/api/google/client", { fichier: await file.text() });
      await load();
    });

  if (!state) return null;
  const services = [...new Set(state.catalogue.map((a) => a.service))];
  // Sans répéter la lecture quand l'écriture est accordée.
  const names = (ids: string[]) =>
    state.catalogue.filter((a) => ids.includes(a.id) && !ids.some((x) => WRITE_OF[x] === a.id)).map((a) => a.nom.toLowerCase());

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5">
        <GoogleLogo />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Google</p>
          <p className="truncate text-xs text-muted-foreground">{state.connecte ? state.compte || t("Compte connecté") : t("Gmail, Agenda, Drive, Docs, Sheets, Contacts")}</p>
        </div>
        {state.connecte && !waiting ? (
          <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />{t("Connecté")}</span>
        ) : !picking && !waiting ? (
          <Button size="sm" onClick={() => { setChosen(state.voulu.length ? state.voulu : DEFAULT_ACCESS); setPicking(true); }}>{t("Connecter")}</Button>
        ) : null}
      </div>

      {state.connecte && !picking && !waiting && (
        <p className="text-xs text-muted-foreground">{t("L'agent peut : {liste}.", { liste: names(state.permissions).join(", ") || t("rien pour l'instant") })}</p>
      )}
      {state.connecte && !picking && !waiting && (state.autres ?? []).map((o) => (
        <div key={o.compte} className="flex items-center gap-2 border-t border-border pt-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{o.compte}</p>
            <p className="truncate text-xs text-muted-foreground">{names(o.permissions).join(", ") || t("aucun accès")}</p>
          </div>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => disconnectOther(o.compte)} disabled={busy}>{t("Déconnecter")}</Button>
        </div>
      ))}
      {state.connecte && !picking && !waiting && (
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t("Droit de l'agent")}
          <select aria-label={t("Droit de l'agent sur Google")} value={state.droit ?? "confirmer"} disabled={busy} onChange={(e) => setRight(e.target.value)}
            className="h-8 cursor-pointer rounded-lg border border-border bg-background px-2 text-xs text-foreground">
            {GOOGLE_DROITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      )}

      {picking && (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-muted-foreground">
            {adding ? `${t("Un autre compte Google : choisis-le dans l'écran de l'agent, ou connecte-t'y s'il te le demande.")} ` : ""}
            {t("Ce que l'agent pourra faire. Ce choix vaut accord : Noah le donne à Google pour toi.")}
          </p>
          {services.map((s) => (
            <div key={s} className="flex flex-col gap-1">
              <p className="text-xs font-semibold">{s}</p>
              {state.catalogue.filter((a) => a.service === s).map((a) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-accent" checked={chosen.includes(a.id)} onChange={() => toggle(a.id)} />
                  {a.nom}
                </label>
              ))}
            </div>
          ))}
          {!state.identifiants && (
            <p className="text-xs text-muted-foreground">
              {t("Première fois : l'agent crée ton accès Google dans son navigateur et accepte pour toi les conditions de Google Cloud. Il t'appelle seulement pour te connecter à ton compte.")}{" "}
              <label className="cursor-pointer text-accent underline">
                {t("J'ai déjà un fichier d'identifiants")}
                <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => uploadClient(e.target.files?.[0])} />
              </label>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setPicking(false); setAdding(false); }}>{t("Annuler")}</Button>
            <Button size="sm" onClick={connect} disabled={!chosen.length || busy}>
              {busy && <Loader2 className="animate-spin" />}{adding ? t("Ajouter ce compte") : state.connecte ? t("Mettre à jour les accès") : t("Connecter Google")}
            </Button>
          </div>
        </div>
      )}

      {waiting && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="flex-1">
            {state.etape === "configuration"
              ? t("L'agent crée ton accès Google (il t'appellera seulement pour te connecter).")
              : tServeur(state.message) || t("Noah donne ton accord à Google…")}
          </span>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>{t("Annuler")}</Button>
        </div>
      )}
      {state.etape === "erreur" && <p className="text-xs text-danger">{tServeur(state.message)}</p>}

      {state.connecte && !picking && !waiting && (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => { setChosen(state.permissions); setAdding(false); setPicking(true); }}><Pencil />{t("Modifier les accès")}</Button>
          <Button size="sm" variant="ghost" onClick={() => { setChosen(state.permissions); setAdding(true); setPicking(true); }}><Plus />{t("Ajouter un compte")}</Button>
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={disconnect} disabled={busy}>{t("Déconnecter")}</Button>
        </div>
      )}
    </div>
  );
}

// --- Logiciels et disque ------------------------------------------------------------------------

type ComputerState = { disque: { total: number; libre: number; utilise: number }; espace_de_travail: number | null; paquets: string[] };

const bigSize = (n: number) => {
  if (n < 1e9) return fileSize(n);
  const decimales = n >= 1e11 ? 0 : 1;
  return t("{n} Go", { n: (n / 1e9).toLocaleString(locale(), { minimumFractionDigits: decimales, maximumFractionDigits: decimales }) });
};

export function Software({ agentId }: { agentId: string }) {
  const { data, error, setError, load } = useAgentData<ComputerState>(`/api/agents/${agentId}/computer`);
  const [names, setNames] = useState("");
  const [busy, setBusy] = useState(false);
  const install = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send(`/api/agents/${agentId}/install`, { paquets: names.split(/[\s,]+/).filter(Boolean) });
      setNames("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("Logiciels et disque")} alone>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
      {data && (
        <>
          <div className="flex items-center gap-2 text-sm">
            <HardDrive className="size-4 text-muted-foreground" />
            <span>{tr("{taille} libres", { taille: <b>{bigSize(data.disque.libre)}</b> })}</span>
            {data.espace_de_travail != null && <span className="text-muted-foreground">· {t("ses fichiers : {taille}", { taille: bigSize(data.espace_de_travail) })}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Déjà là : Python 3, Node.js, git, curl, ffmpeg. L'agent installe seul ce qui lui manque ; tu peux aussi le faire ici.")}
          </p>
          {data.paquets.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.paquets.map((p) => <span key={p} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">{p}</span>)}
            </div>
          )}
          <form onSubmit={install} className="flex gap-2">
            {/* i18n-ignore : des noms de paquets, pareils dans toutes les langues */}
            <Input value={names} onChange={(e) => setNames(e.target.value)} className="h-9" placeholder="imagemagick, poppler-utils…" aria-label={t("Paquets à installer")} />
            <Button type="submit" size="sm" className="h-9" disabled={busy || !names.trim()}>{busy && <Loader2 className="animate-spin" />}{t("Installer")}</Button>
          </form>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

// --- Dossiers de l'ordinateur ---------------------------------------------------------------------

type SharedFolder = { nom: string; chemin: string; ecriture: boolean; travail: boolean };
type FoldersState = { racines: string[]; dossiers: SharedFolder[] };

/**
 * Dossiers de l'ordinateur confiés à l'agent. En lecture seule par défaut ; « dossier de travail » : là où il range
 * ce qu'il crée, y compris pendant les routines. Chaque changement recrée sa machine (quelques secondes).
 */
type DeviceFolders = { id: string; nom: string; type: string; en_ligne: boolean; coupe: boolean; attente: number; dossiers: { id: string; nom: string; ecriture: boolean; absent?: boolean }[] };

/** Noah sur un serveur : les dossiers restent sur l'ordinateur et c'est l'application de bureau qui garde les droits. */
function ComputerFolderList() {
  const app = desktop();
  const [state, setState] = useState<ComputerFolders | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    app?.dossiers?.().then(setState).catch((e) => setError((e as Error).message));
  }, [app]);
  const act = (work: Promise<ComputerFolders | null> | undefined) =>
    work?.then((s) => s && setState(s)).catch((e) => setError((e as Error).message));
  if (!state) return error ? <p className="text-xs text-destructive">{error}</p> : null;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t("Tes dossiers restent sur cet ordinateur. Tes agents les lisent et y écrivent à la demande, selon le droit que tu donnes, tant que l'application est ouverte. Ce qu'ils lisent passe par le modèle que tu as choisi.")}
      </p>
      {state.coupe && (
        <p role="status" className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          {t("Accès coupé : aucun agent n'atteint cet ordinateur. Ce qui lui est destiné attend sur le serveur.")}
        </p>
      )}
      {state.dossiers.length === 0 && <p className="text-xs">{t("Aucun dossier confié pour l'instant.")}</p>}
      {state.dossiers.map((f) => (
        <div key={f.id} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5" data-dossier={f.nom}>
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{f.nom}</p>
              <p className="text-xs text-muted-foreground">{f.ecriture ? t("Lecture et écriture") : t("Lecture seule")}</p>
            </div>
            <Button variant="ghost" size="icon" aria-label={t("Ouvrir {nom}", { nom: f.nom })} title={t("Ouvrir")} onClick={() => app?.dossierOuvrir?.(f.id)}>
              <ExternalLink />
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("Ne plus confier {nom}", { nom: f.nom })} title={t("Ne plus confier")}
              onClick={() => { if (confirm(t("Ne plus confier « {nom} » à tes agents ? Le dossier reste sur ton ordinateur.", { nom: f.nom }))) void act(app?.dossierRetirer?.(f.id)); }}>
              <Trash2 />
            </Button>
          </div>
          <label className="flex cursor-pointer items-center gap-2 pl-6 text-xs">
            <input type="checkbox" className="size-4" checked={f.ecriture} aria-label={t("Tes agents peuvent écrire dans {nom}", { nom: f.nom })} onChange={(e) => act(app?.dossierDroit?.(f.id, e.target.checked))} />
            {t("Tes agents peuvent y écrire")}
          </label>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => act(app?.dossierAjouter?.())}><FolderOpen />{t("Choisir un dossier")}</Button>
        <Button variant="outline" size="sm" onClick={() => act(app?.couper?.(!state.coupe))}>{state.coupe ? t("Rendre l'accès") : t("Couper l'accès")}</Button>
      </div>
      {state.toujours.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-muted-foreground">{t("Commandes permises sans demander")}</p>
          {state.toujours.map((c) => (
            <div key={`${c.dossier}:${c.commande}`} className="flex items-center gap-2 text-xs">
              <code className="min-w-0 flex-1 truncate">{c.commande}</code>
              <span className="shrink-0 text-muted-foreground">{c.nom}</span>
              <Button variant="ghost" size="sm" aria-label={t("Oublier {commande}", { commande: c.commande })} onClick={() => act(app?.commandeOublier?.(c.commande, c.dossier))}>{t("Oublier")}</Button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}

const waitingFiles = (n: number, cut: boolean) =>
  n === 1
    ? (cut ? t("Un fichier attend que tu rendes l'accès depuis l'application de bureau.") : t("Un fichier attend sa reconnexion."))
    : (cut ? t("{n} fichiers attendent que tu rendes l'accès depuis l'application de bureau.", { n }) : t("{n} fichiers attendent sa reconnexion.", { n }));

/** Ailleurs que dans l'application de bureau : ce qui est confié, sans pouvoir le changer. */
function RemoteFolderList() {
  const [list, setList] = useState<DeviceFolders[] | null>(null);
  useEffect(() => {
    get<{ appareils: DeviceFolders[] }>("/api/devices").then((r) => setList(r.appareils.filter((d) => d.type === "desktop"))).catch(() => setList([]));
  }, []);
  if (!list) return null;
  if (!list.length) {
    return <p className="text-xs text-muted-foreground">{t("Installe l'application de bureau sur ton ordinateur et relie-la à ce compte : tu pourras y confier des dossiers à tes agents.")}</p>;
  }
  return (
    <>
      {list.map((d) => (
        <div key={d.id} className="flex flex-col gap-1 rounded-lg border border-border p-2.5">
          <p className="truncate text-sm font-medium">{d.nom || t("Ordinateur")}</p>
          <p className="text-xs text-muted-foreground">{d.coupe ? t("Accès coupé") : d.en_ligne ? t("En ligne") : t("Éteint, ou application fermée")}</p>
          {d.dossiers.map((f) => <p key={f.id} className="truncate text-xs text-muted-foreground">{f.nom} · {f.absent ? t("introuvable sur l'ordinateur") : f.ecriture ? t("lecture et écriture") : t("lecture seule")}</p>)}
          {!d.dossiers.length && <p className="text-xs text-muted-foreground">{d.en_ligne ? t("Aucun dossier confié.") : t("Ses dossiers s'afficheront quand il sera en ligne.")}</p>}
          {d.attente > 0 && <p className="text-xs">{waitingFiles(d.attente, d.coupe)}</p>}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t("Tu choisis ces dossiers et leurs droits depuis l'application de bureau.")}</p>
    </>
  );
}

export function Folders({ agentId }: { agentId: string }) {
  const { data, setData, error, setError } = useAgentData<FoldersState>(`/api/agents/${agentId}/folders`);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const app = desktop();

  const save = async (dossiers: SharedFolder[]) => {
    setBusy(true);
    setError("");
    try {
      const r = await send<{ dossiers: SharedFolder[] }>(`/api/agents/${agentId}/folders`, { dossiers }, "PUT");
      setData((d) => (d ? { ...d, dossiers: r.dossiers } : d));
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const list = data?.dossiers ?? [];
  const update = (i: number, change: Partial<SharedFolder>) =>
    save(list.map((f, j) => (j === i ? { ...f, ...change } : change.travail ? { ...f, travail: false } : f)));
  const add = async (chemin: string) => {
    if (!chemin.trim()) return;
    if (await save([...list, { nom: "", chemin: chemin.trim(), ecriture: false, travail: false }])) setPath("");
  };
  const pick = async () => {
    const chosen = await app?.pickFolder();
    if (chosen) await add(chosen);
  };

  return (
    <Section title={t("Dossiers")} count={list.length} alone>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
      {data && data.racines.length === 0 && (app?.dossiers ? <ComputerFolderList /> : <RemoteFolderList />)}
      {data && data.racines.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            {t("Donne-lui des dossiers de ton ordinateur. En lecture seule, il les lit sans rien y changer ; ton dossier de travail reçoit ce qu'il crée pour toi, même pendant les routines.")}
          </p>
          {list.map((f, i) => (
            <div key={f.nom} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
              <div className="flex items-start gap-2">
                <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={f.chemin}>{f.chemin.split(/[\\/]/).pop() || f.chemin}</p>
                  <p className="truncate text-xs text-muted-foreground" title={f.chemin}>{f.chemin}</p>
                </div>
                {app && (
                  <Button variant="ghost" size="icon-sm" aria-label={t("Ouvrir {nom}", { nom: f.chemin })} title={t("Ouvrir")} onClick={() => app.openPath(f.chemin)}>
                    <ExternalLink />
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={t("Retirer {nom}", { nom: f.chemin })} title={t("Ne plus partager")}
                  onClick={() => save(list.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={f.ecriture} disabled={busy}
                    onChange={(e) =>
                      // Le premier dossier où il peut écrire devient son dossier de travail.
                      update(i, { ecriture: e.target.checked, travail: e.target.checked && (f.travail || !list.some((x) => x.travail)) })
                    } />
                  {t("Peut y écrire")}
                </label>
                <label className={cn("flex items-center gap-1.5", f.ecriture ? "cursor-pointer" : "opacity-50")}>
                  <input type="radio" name={`travail-${agentId}`} checked={f.travail} disabled={busy || !f.ecriture}
                    onChange={() => update(i, { travail: true })} />
                  {t("Dossier de travail")}
                </label>
              </div>
            </div>
          ))}
          {app ? (
            <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={pick}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}{t("Choisir un dossier…")}
            </Button>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void add(path); }} className="flex gap-2">
              <Input value={path} onChange={(e) => setPath(e.target.value)} className="h-9" placeholder={`${data.racines[0]}/Documents`} aria-label={t("Chemin du dossier")} />
              <Button type="submit" size="sm" className="h-9" disabled={busy || !path.trim()}>{busy && <Loader2 className="animate-spin" />}{t("Ajouter")}</Button>
            </form>
          )}
          {busy && <p className="text-xs text-muted-foreground">{t("Noah redémarre sa machine avec ces dossiers…")}</p>}
          <p className="text-xs text-muted-foreground">{t("Dossiers possibles : sous {racines}.", { racines: data.racines.join(", ") })}</p>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

// --- Veilles ------------------------------------------------------------------------------------

type Watch = {
  id: string;
  nom: string;
  url: string;
  source: "page" | "gmail" | "agenda" | "outil";
  critere: string;
  consigne: string;
  reveils: number;
  cout: number;
  minutes: number;
  active: boolean;
  dernier_passage: number | null;
  derniere_alerte: number | null;
  erreur: string | null;
  passages: number;
  alertes: number;
};

const EVERY: [number, string][] = [
  [15, t("toutes les 15 min")],
  [60, t("toutes les heures")],
  [360, t("toutes les 6 h")],
  [1440, t("une fois par jour")],
];
const everyLabel = (m: number) => EVERY.find(([v]) => v === m)?.[1] ?? t("toutes les {n} min", { n: m });
const ago = (t: number | null) => (t ? when(new Date(t * 1000).toISOString()) : null);
const money = (v: number) => t("{n} $", { n: v.toLocaleString(locale(), { maximumFractionDigits: 20 }) });
const dollars = (v: number) =>
  v === 0 ? money(0) : v < 0.0001 ? t("moins de 0,0001 $") : money(Number(v.toFixed(v < 0.01 ? 4 : 3)));
/** Le compte qui prouve que l'agent ne tourne pas pour rien : « 12 passages, 1 réveil, 0,002 $ ». */
const tally = (w: Watch) =>
  [
    w.passages > 1 ? t("{n} passages", { n: w.passages }) : t("{n} passage", { n: w.passages }),
    w.consigne
      ? (w.reveils > 1 ? t("{n} réveils", { n: w.reveils }) : t("{n} réveil", { n: w.reveils }))
      : (w.alertes > 1 ? t("{n} alertes", { n: w.alertes }) : t("{n} alerte", { n: w.alertes })),
    dollars(w.cout),
  ].join(", ");

const SOURCES: [string, string, string][] = [
  ["page", t("Page ou flux"), t("https://… (page ou flux RSS)")],
  ["gmail", "Gmail", t("Recherche Gmail (ex. from:paul@exemple.fr), vide : les nouveaux courriels")],
  ["agenda", t("Agenda"), t("Heures à venir (vide : 24)")],
];
const sourceAddress = (kind: string, text: string) => (kind === "page" ? text.trim() : text.trim() ? `${kind}:${text.trim()}` : kind);
const sourceLabel = (w: Watch) =>
  w.source === "gmail" ? (w.url.includes(":") ? t("Gmail : {recherche}", { recherche: w.url.split(":").slice(1).join(":") }) : "Gmail")
  : w.source === "agenda" ? t("Agenda")
  : w.source === "outil" ? t("Outil {nom}", { nom: w.url.slice(6) })
  : w.url;

/**
 * Veilles et routines à condition : Noah Agent relève une source lui-même, sans modèle ; le modèle de décision ne lit que les
 * nouveautés. Une veille prévient ; une routine à condition réveille le cerveau, seulement si la condition est remplie.
 */
export function Watches({ agentId }: { agentId: string }) {
  const { data, error, setError, load } = useAgentData<{ veilles: Watch[] }>(`/api/agents/${agentId}/watches`);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const blank = { nom: "", source: "page", url: "", critere: "", consigne: "", minutes: 60 };
  const [form, setForm] = useState(blank);
  const [opened, setOpened] = useState<string | null>(null);
  const list = data?.veilles ?? [];

  const act = async (w: Watch, action: string) => {
    if (action === "supprimer" && !confirm(t("Supprimer la veille « {nom} » ?", { nom: w.nom }))) return false;
    setBusy(w.id + action);
    try {
      await send(`/api/agents/${agentId}/watches/${w.id}/${action}`, {});
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("new");
    setError("");
    try {
      await send(`/api/agents/${agentId}/watches`, {
        nom: form.nom, url: sourceAddress(form.source, form.url), critere: form.critere, consigne: form.consigne, minutes: form.minutes,
      });
      setForm(blank);
      setAdding(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = list.find((x) => x.id === opened) ?? null;
  if (open) {
    const w = open;
    return (
      <ObjectPage title={w.nom} onClose={() => setOpened(null)}>
        <button type="button" onClick={() => setOpened(null)} className="flex cursor-pointer items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />{t("Veilles")}
        </button>
        <div className="flex items-start gap-2">
          <span className={cn("mt-2 size-2.5 shrink-0 rounded-full", !w.active ? "bg-muted-foreground/40" : w.erreur ? "bg-danger" : "bg-ok")} />
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{w.nom}</h3>
            <p className="truncate text-sm text-muted-foreground" title={w.url}>{sourceLabel(w)}</p>
            <p className="text-sm text-muted-foreground">{everyLabel(w.minutes)}{!w.active ? ` · ${t("en pause")}` : w.dernier_passage ? ` · ${t("vue {quand}", { quand: ago(w.dernier_passage) ?? "" })}` : ""}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button variant="outline" onClick={() => act(w, w.active ? "pause" : "reprendre")} disabled={!!busy}>
            {w.active ? <Pause /> : <Play />}{w.active ? t("Pause") : t("Reprendre")}
          </Button>
          <Button variant="outline" onClick={() => act(w, "verifier")} disabled={!!busy}>
            {busy === w.id + "verifier" ? <Loader2 className="animate-spin" /> : <Zap />}{t("Vérifier")}
          </Button>
          <Button variant="outline" className="text-danger" onClick={async () => { if (await act(w, "supprimer")) setOpened(null); }} disabled={!!busy}>
            <Trash2 />{t("Supprimer")}
          </Button>
        </div>
        {w.erreur && <p className="text-sm text-danger">{tServeur(w.erreur)}</p>}
        {w.critere && <div className="rounded-xl bg-muted/50 p-3 text-sm">{tr("{titre} : {texte}", { titre: <b>{w.consigne ? t("Si") : t("Ce qui compte")}</b>, texte: w.critere })}</div>}
        {w.consigne && <div className="rounded-xl bg-muted/50 p-3 text-sm">{tr("{titre} : {texte}", { titre: <b>{t("Alors")}</b>, texte: w.consigne })}</div>}
        <p className="text-sm text-muted-foreground tabular-nums">{tally(w)}</p>
        <ErrorText>{error}</ErrorText>
      </ObjectPage>
    );
  }

  return (
    <Section title={t("Surveiller un changement")} count={list.length} defaultOpen>
      {data && !list.length && !adding && <p className="text-sm text-muted-foreground">{t("Aucune veille.")}</p>}
      {list.length > 0 && (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
          {list.map((w) => (
            <li key={w.id}>
              <button type="button" onClick={(e) => { e.currentTarget.closest("[role=tabpanel]")?.scrollTo(0, 0); setOpened(w.id); }} className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left hover:bg-muted/50">
                <span className={cn("size-2 shrink-0 rounded-full", !w.active ? "bg-muted-foreground/40" : w.erreur ? "bg-danger" : "bg-ok")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{w.nom}</span>
                  <span className="block truncate text-xs text-muted-foreground">{everyLabel(w.minutes)}{!w.active ? ` · ${t("en pause")}` : ""}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form onSubmit={create} className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
          <Input value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} className="h-9" placeholder={t("Nom (ex. Prix du vélo)")} aria-label={t("Nom de la veille")} required />
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value, url: "" })} className="h-9 rounded-md border border-border bg-surface px-2 text-sm" aria-label={t("Source")}>
            {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="h-9" placeholder={SOURCES.find(([v]) => v === form.source)?.[2]} aria-label={t("Ce qu'il faut relever")} required={form.source === "page"} />
          <Textarea value={form.critere} onChange={(e) => setForm({ ...form, critere: e.target.value })} rows={2} placeholder={t("Condition ou ce qui compte (ex. un courriel de Paul à propos d'une facture)")} aria-label={t("Condition")} />
          <Textarea value={form.consigne} onChange={(e) => setForm({ ...form, consigne: e.target.value })} rows={2} placeholder={t("Facultatif : ce que l'agent fera alors. Vide : il te prévient, sans se réveiller.")} aria-label={t("Ce que l'agent fera alors")} />
          <select value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })} className="h-9 rounded-md border border-border bg-surface px-2 text-sm" aria-label={t("Fréquence")}>
            {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy === "new"}>{busy === "new" && <Loader2 className="animate-spin" />}{t("Créer et relever")}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>{t("Annuler")}</Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />{t("Nouvelle veille")}</Button>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
