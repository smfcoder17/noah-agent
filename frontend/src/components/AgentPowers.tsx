// Ce que l'agent sait et fait de lui-même, réglable depuis Détails : routines, mémoire, connexions, logiciels, dossiers.
import { Check, ChevronDown, ExternalLink, FolderOpen, HardDrive, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { askAgent } from "@/lib/askAgent";
import { desktop } from "@/lib/desktop";
import { cn, fileSize } from "@/lib/utils";
import { Button, ErrorText, Input, Textarea } from "./ui";

/** Section repliable de Détails, avec un compteur à droite du titre. */
function Section({ title, count, defaultOpen = false, children }: { title: string; count?: number | string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
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

/** Charge une ressource de l'agent et la recharge à la demande. */
function useAgentData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      get<T>(path)
        .then((d) => {
          setData(d);
          setError("");
        })
        .catch((e) => setError((e as Error).message)),
    [path],
  );
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  return { data, setData, error, setError, load };
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const time = d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `aujourd'hui à ${time}`;
  if (days === 1) return `demain à ${time}`;
  if (days === -1) return `hier à ${time}`;
  return `${d.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric", month: "short" })} à ${time}`;
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
};

const PRESETS: [string, string][] = [
  ["every day at 8am", "Chaque matin à 8 h"],
  ["every weekday at 9am", "Les jours de semaine à 9 h"],
  ["every monday 9am", "Chaque lundi à 9 h"],
  ["every day at 6pm", "Chaque soir à 18 h"],
  ["every 1h", "Toutes les heures"],
];

/** Horaire lisible : les formules prêtes en français, le reste tel quel. */
const scheduleLabel = (s: string) => PRESETS.find(([v]) => v === s)?.[1] ?? s;

export function Routines({ agentId }: { agentId: string }) {
  const { data, error, setError, load } = useAgentData<{ routines: Routine[] }>(`/api/agents/${agentId}/routines`);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const list = data?.routines ?? [];

  const act = async (r: Routine, action: string) => {
    if (action === "supprimer" && !confirm(`Supprimer la routine « ${r.name || r.prompt.slice(0, 40)} » ?`)) return;
    setBusy(r.id + action);
    try {
      await send(`/api/agents/${agentId}/routines/${r.id}/${action}`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Routines" count={list.length} defaultOpen>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {data && !list.length && !adding && (
        <p className="text-sm text-muted-foreground">
          Aucune routine. Demande-en une à l'agent (« chaque matin, résume mes mails ») ou crée-la ici. Ses résultats arrivent dans la conversation.
        </p>
      )}
      {list.map((r) => {
        const paused = !r.enabled || r.state === "paused";
        return (
          <div key={r.id} className="group flex flex-col gap-1 rounded-xl border border-border p-2.5">
            <div className="flex items-start gap-2">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", paused ? "bg-muted-foreground/40" : r.last_status === "error" ? "bg-danger" : "bg-ok")} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.name || r.prompt}</p>
                <p className="text-xs text-muted-foreground">
                  {scheduleLabel(r.schedule_display)}
                  {paused ? " · en pause" : r.next_run_at ? ` · prochaine ${when(r.next_run_at)}` : ""}
                </p>
              </div>
            </div>
            {r.name && <p className="line-clamp-2 pl-4 text-xs text-muted-foreground">{r.prompt}</p>}
            {r.last_error && <p className="pl-4 text-xs text-danger">Dernier passage en erreur : {r.last_error.slice(0, 160)}</p>}
            <div className="flex gap-1 pl-3">
              <Button size="sm" variant="ghost" onClick={() => act(r, paused ? "reprendre" : "pause")} disabled={!!busy}>
                {paused ? <Play /> : <Pause />}{paused ? "Reprendre" : "Pause"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => act(r, "lancer")} disabled={!!busy} title="Lancer au prochain passage du planificateur (moins d'une minute)">
                {busy === r.id + "lancer" ? <Loader2 className="animate-spin" /> : <Zap />}Lancer
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => act(r, "supprimer")} disabled={!!busy} aria-label="Supprimer la routine">
                <Trash2 />
              </Button>
            </div>
          </div>
        );
      })}
      {adding ? (
        <NewRoutine agentId={agentId} onDone={() => { setAdding(false); load(); }} />
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />Nouvelle routine</Button>
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
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await send(`/api/agents/${agentId}/routines`, { nom: name, consigne: prompt, quand: preset === "custom" ? custom : preset });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom (ex. Brief du matin)" aria-label="Nom de la routine" maxLength={80} />
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        required
        aria-label="Consigne"
        placeholder="Ce que l'agent doit faire à chaque passage. Ex. Résume mes mails non lus importants et mon agenda du jour."
      />
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Quand"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="h-9 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm"
        >
          {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          <option value="custom">Autre…</option>
        </select>
        {preset === "custom" && (
          <Input value={custom} onChange={(e) => setCustom(e.target.value)} required className="h-9 flex-1" placeholder="every 30m, 0 7 * * 1-5…" aria-label="Horaire personnalisé" />
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>Annuler</Button>
        <Button type="submit" size="sm" disabled={saving || !prompt.trim()}>{saving && <Loader2 className="animate-spin" />}Créer</Button>
      </div>
    </form>
  );
}

// --- Mémoire --------------------------------------------------------------------------------

type MemoryState = { memory: string[]; user: string[]; limites: { memory: number; user: number } };

export function Memory({ agentId }: { agentId: string }) {
  const { data, setData, error, setError } = useAgentData<MemoryState>(`/api/agents/${agentId}/memory`);
  const total = data ? data.memory.length + data.user.length : undefined;

  const save = async (target: "memory" | "user", entries: string[]) => {
    try {
      setData(await send<MemoryState>(`/api/agents/${agentId}/memory`, { cible: target, entrees: entries }, "PUT"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Section title="Mémoire" count={total}>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {data && (
        <>
          <MemoryList title="Ce qu'il sait de toi" entries={data.user} limit={data.limites.user} onSave={(e) => save("user", e)}
            empty="Rien encore. L'agent y note qui tu es, tes goûts et tes habitudes au fil des conversations." />
          <MemoryList title="Ses notes de travail" entries={data.memory} limit={data.limites.memory} onSave={(e) => save("memory", e)}
            empty="Rien encore. L'agent y garde ce qui lui servira plus tard : outils, décisions, contexte." />
          <p className="text-xs text-muted-foreground">Une modification compte dès la prochaine conversation.</p>
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
      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus aria-label="Souvenir" />
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Annuler</Button>
        <Button size="sm" onClick={commit}><Check />Enregistrer</Button>
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className={cn("text-[11px] tabular-nums", used > limit * 0.9 ? "text-warn" : "text-muted-foreground")} title="Place utilisée">
          {Math.round((100 * used) / limit)} %
        </span>
      </div>
      {!entries.length && editing === null && <p className="text-xs text-muted-foreground">{empty}</p>}
      {entries.map((e, i) =>
        editing === i ? (
          <div key={i}>{editor}</div>
        ) : (
          <div key={i} className="group flex items-start gap-1 rounded-lg px-2 py-1 text-sm hover:bg-muted">
            <p className="min-w-0 flex-1 whitespace-pre-wrap">{e}</p>
            <Button size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => start(i)} aria-label="Modifier ce souvenir"><Pencil /></Button>
            <Button size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onSave(entries.filter((_, j) => j !== i))} aria-label="Oublier ce souvenir"><Trash2 /></Button>
          </div>
        ),
      )}
      {editing === entries.length ? editor : (
        <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={() => start(entries.length)}><Plus />Ajouter</Button>
      )}
    </div>
  );
}

// --- Connexions -------------------------------------------------------------------------------

type GoogleState = { disponible: boolean; connecte?: boolean };

type App = { nom: string; description: string; source: string | null; oauth: boolean; hote: string | null; installe: boolean; connecte: boolean };
type ConnectionsState = { google: GoogleState; applications: App[] };

const appLabel = (name: string) => name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function Connections({ agentId }: { agentId: string }) {
  const { data, error, setError, load } = useAgentData<ConnectionsState>(`/api/agents/${agentId}/connections`);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const google = data?.google;
  const apps = data?.applications ?? [];
  const connected = apps.filter((a) => a.installe);
  const q = query.trim().toLowerCase();
  const others = apps.filter((a) => !a.installe && (!q || `${a.nom} ${a.description}`.toLowerCase().includes(q)));
  return (
    <Section title="Connexions" count={(google?.connecte ? 1 : 0) + connected.filter((a) => a.connecte).length}>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {google?.disponible && data && <GoogleCard agentId={agentId} onError={setError} />}
      {connected.map((a) => <AppRow key={a.nom} agentId={agentId} app={a} onChange={load} onError={setError} />)}
      {data && (browsing ? (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border p-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} className="h-9" placeholder="Notion, Todoist, Linear, Figma…" aria-label="Chercher une application" autoFocus />
          <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
            {others.map((a) => <AppRow key={a.nom} agentId={agentId} app={a} onChange={load} onError={setError} />)}
            {!others.length && <p className="p-2 text-xs text-muted-foreground">Aucune application ne correspond.</p>}
          </div>
          <Button size="sm" variant="ghost" className="self-end" onClick={() => setBrowsing(false)}>Fermer</Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setBrowsing(true)}><Plus />Connecter une application</Button>
      ))}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function AppRow({ agentId, app, onChange, onError }: { agentId: string; app: App; onChange: () => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
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
      const r = await send<{ adresse?: string; connecte?: boolean }>(`${base}/connect`, {});
      if (r.adresse) {
        window.open(r.adresse, "_blank", "noopener");
        setWaiting(true);
      } else onChange();
    });
  const finish = () =>
    run(async () => {
      await send(`${base}/finish`, { adresse: back });
      setWaiting(false);
      setBack("");
      onChange();
    });
  const remove = () =>
    run(async () => {
      if (!confirm(`Retirer ${appLabel(app.nom)} ? L'agent n'y aura plus accès.`)) return;
      await send(`${base}/remove`, {});
      onChange();
    });
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg px-2 py-1.5", app.installe && "border border-border p-2.5")}>
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-sm font-bold">{app.nom[0].toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{appLabel(app.nom)}</p>
          <p className="truncate text-xs text-muted-foreground" title={app.description}>{app.description}</p>
        </div>
        {app.connecte ? (
          <>
            <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />Connecté</span>
            <Button size="icon-sm" variant="ghost" onClick={remove} disabled={busy} aria-label={`Retirer ${appLabel(app.nom)}`}><Trash2 /></Button>
          </>
        ) : !waiting ? (
          <Button size="sm" variant={app.installe ? "default" : "outline"} onClick={connect} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}{app.installe ? "Terminer la connexion" : "Connecter"}
          </Button>
        ) : null}
      </div>
      {waiting && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Accepte dans l'onglet ouvert. Tu arrives ensuite sur une page qui ne s'affiche pas (adresse « 127.0.0.1 ») : c'est normal, copie son adresse complète ici.
          </p>
          <Input value={back} onChange={(e) => setBack(e.target.value)} className="h-9" placeholder="http://127.0.0.1:…/callback?code=…" aria-label={`Adresse de retour de ${appLabel(app.nom)}`} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={connect} disabled={busy}>Rouvrir</Button>
            <Button size="sm" onClick={finish} disabled={!back.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Terminer</Button>
          </div>
        </div>
      )}
    </div>
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
};

// « Écrire » comprend « lire » : cocher l'un coche l'autre, décocher la lecture retire l'écriture.
const WRITE_OF: Record<string, string> = { gmail_ecrire: "gmail_lire", agenda_ecrire: "agenda_lire", drive_ecrire: "drive_lire" };
const DEFAULT_ACCESS = ["gmail_lire", "agenda_lire", "drive_lire"];

/**
 * Google en un seul accord : l'utilisateur coche ce que l'agent peut faire. La première fois, l'agent crée
 * lui-même l'accès Google de l'utilisateur dans son navigateur (il l'appelle pour se connecter) ; ensuite Noah Agent
 * ouvre la page d'accord dans l'écran de l'agent et voit tout seul quand c'est accepté.
 */
function GoogleCard({ agentId, onError }: { agentId: string; onError: (e: string) => void }) {
  const base = `/api/agents/${agentId}/google`;
  const [state, setState] = useState<GoogleAccount | null>(null);
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<string[]>(DEFAULT_ACCESS);
  const [busy, setBusy] = useState(false);
  const waiting = state?.etape === "configuration" || state?.etape === "accord";

  const load = useCallback(() => get<GoogleAccount>(base).then(setState).catch((e) => onError((e as Error).message)), [base, onError]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
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
      const r = await send<GoogleAccount>(`${base}/connect`, { permissions: chosen });
      setState(r);
      setPicking(false);
      if (r.consigne) askAgent(r.consigne);
    });
  const cancel = () => run(async () => setState(await send<GoogleAccount>(`${base}/cancel`, {})));
  const disconnect = () =>
    run(async () => {
      if (confirm("Déconnecter Google de cet agent ? Il n'aura plus accès à tes courriels, ton agenda ni tes fichiers.")) {
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
        <span className="grid size-8 place-items-center rounded-lg bg-muted text-sm font-bold">G</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Google</p>
          <p className="truncate text-xs text-muted-foreground">{state.connecte ? state.compte || "Compte connecté" : "Gmail, Agenda, Drive, Docs, Sheets, Contacts"}</p>
        </div>
        {state.connecte && !waiting ? (
          <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />Connecté</span>
        ) : !picking && !waiting ? (
          <Button size="sm" onClick={() => { setChosen(state.voulu.length ? state.voulu : DEFAULT_ACCESS); setPicking(true); }}>Connecter</Button>
        ) : null}
      </div>

      {state.connecte && !picking && !waiting && (
        <p className="text-xs text-muted-foreground">L'agent peut : {names(state.permissions).join(", ") || "rien pour l'instant"}.</p>
      )}

      {picking && (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-muted-foreground">Ce que l'agent pourra faire (tu donnes ton accord une seule fois, dans Google) :</p>
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
              Première fois : l'agent crée ton accès Google dans son navigateur (environ 5 minutes). Il t'appelle seulement pour te connecter et
              accepter les conditions.{" "}
              <label className="cursor-pointer text-accent underline">
                J'ai déjà un fichier d'identifiants
                <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => uploadClient(e.target.files?.[0])} />
              </label>
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>Annuler</Button>
            <Button size="sm" onClick={connect} disabled={!chosen.length || busy}>
              {busy && <Loader2 className="animate-spin" />}{state.connecte ? "Mettre à jour les accès" : "Connecter Google"}
            </Button>
          </div>
        </div>
      )}

      {waiting && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="flex-1">
            {state.etape === "configuration"
              ? "L'agent crée ton accès Google (il t'appellera quand ce sera à toi)."
              : "Donne ton accord dans l'écran de l'agent (onglet Ordinateur)."}
          </span>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>Annuler</Button>
        </div>
      )}
      {state.etape === "erreur" && <p className="text-xs text-danger">{state.message}</p>}

      {state.connecte && !picking && !waiting && (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => { setChosen(state.permissions); setPicking(true); }}><Pencil />Modifier les accès</Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={disconnect} disabled={busy}>Déconnecter</Button>
        </div>
      )}
    </div>
  );
}

// --- Logiciels et disque ------------------------------------------------------------------------

type ComputerState = { disque: { total: number; libre: number; utilise: number }; espace_de_travail: number | null; paquets: string[] };

const bigSize = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1).replace(".", ",")} Go` : fileSize(n));

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
    <Section title="Logiciels et disque">
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {data && (
        <>
          <div className="flex items-center gap-2 text-sm">
            <HardDrive className="size-4 text-muted-foreground" />
            <span><b>{bigSize(data.disque.libre)}</b> libres</span>
            {data.espace_de_travail != null && <span className="text-muted-foreground">· ses fichiers : {bigSize(data.espace_de_travail)}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            Déjà là : Python 3, Node.js, git, curl, ffmpeg. L'agent installe seul ce qui lui manque ; tu peux aussi le faire ici.
          </p>
          {data.paquets.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.paquets.map((p) => <span key={p} className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs">{p}</span>)}
            </div>
          )}
          <form onSubmit={install} className="flex gap-2">
            <Input value={names} onChange={(e) => setNames(e.target.value)} className="h-9" placeholder="imagemagick, poppler-utils…" aria-label="Paquets à installer" />
            <Button type="submit" size="sm" className="h-9" disabled={busy || !names.trim()}>{busy && <Loader2 className="animate-spin" />}Installer</Button>
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
    <Section title="Dossiers" count={list.length}>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {data && data.racines.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Possible quand Noah tourne sur ton ordinateur : l'application de bureau te laisse lui confier des dossiers
          (documents à lire, dossier où ranger ce qu'il crée).
        </p>
      )}
      {data && data.racines.length > 0 && (
        <>
          <p className="text-xs text-muted-foreground">
            Donne-lui des dossiers de ton ordinateur. En lecture seule, il les lit sans rien y changer ; ton dossier de travail
            reçoit ce qu'il crée pour toi, même pendant les routines.
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
                  <Button variant="ghost" size="icon-sm" aria-label={`Ouvrir ${f.chemin}`} title="Ouvrir" onClick={() => app.openPath(f.chemin)}>
                    <ExternalLink />
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Retirer ${f.chemin}`} title="Ne plus partager"
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
                  Peut y écrire
                </label>
                <label className={cn("flex items-center gap-1.5", f.ecriture ? "cursor-pointer" : "opacity-50")}>
                  <input type="radio" name={`travail-${agentId}`} checked={f.travail} disabled={busy || !f.ecriture}
                    onChange={() => update(i, { travail: true })} />
                  Dossier de travail
                </label>
              </div>
            </div>
          ))}
          {app ? (
            <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={pick}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />}Choisir un dossier…
            </Button>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void add(path); }} className="flex gap-2">
              <Input value={path} onChange={(e) => setPath(e.target.value)} className="h-9" placeholder={`${data.racines[0]}/Documents`} aria-label="Chemin du dossier" />
              <Button type="submit" size="sm" className="h-9" disabled={busy || !path.trim()}>{busy && <Loader2 className="animate-spin" />}Ajouter</Button>
            </form>
          )}
          {busy && <p className="text-xs text-muted-foreground">Noah redémarre sa machine avec ces dossiers…</p>}
          <p className="text-xs text-muted-foreground">Dossiers possibles : sous {data.racines.join(", ")}.</p>
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
  critere: string;
  minutes: number;
  active: boolean;
  dernier_passage: number | null;
  derniere_alerte: number | null;
  erreur: string | null;
  passages: number;
  alertes: number;
};

const EVERY: [number, string][] = [
  [15, "toutes les 15 min"],
  [60, "toutes les heures"],
  [360, "toutes les 6 h"],
  [1440, "une fois par jour"],
];
const everyLabel = (m: number) => EVERY.find(([v]) => v === m)?.[1] ?? `toutes les ${m} min`;
const ago = (t: number | null) => (t ? when(new Date(t * 1000).toISOString()) : null);

/**
 * Veilles : Noah Agent relève une page ou un flux lui-même, sans modèle, et ne prévient l'agent que si les nouveautés
 * correspondent à ce que l'utilisateur cherche. Bien moins cher qu'une routine pour « préviens-moi si… ».
 */
export function Watches({ agentId }: { agentId: string }) {
  const { data, error, setError, load } = useAgentData<{ veilles: Watch[] }>(`/api/agents/${agentId}/watches`);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ nom: "", url: "", critere: "", minutes: 60 });
  const list = data?.veilles ?? [];

  const act = async (w: Watch, action: string) => {
    if (action === "supprimer" && !confirm(`Supprimer la veille « ${w.nom} » ?`)) return;
    setBusy(w.id + action);
    try {
      await send(`/api/agents/${agentId}/watches/${w.id}/${action}`, {});
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("new");
    setError("");
    try {
      await send(`/api/agents/${agentId}/watches`, form);
      setForm({ nom: "", url: "", critere: "", minutes: 60 });
      setAdding(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Veilles" count={list.length}>
      {data && !list.length && !adding && (
        <p className="text-sm text-muted-foreground">
          Surveille une page ou un flux sans faire travailler l'agent : il n'est prévenu que si une nouveauté compte pour toi.
          Demande-le-lui (« préviens-moi si ce produit passe sous 300 $ ») ou crée-la ici.
        </p>
      )}
      {list.map((w) => (
        <div key={w.id} className="flex flex-col gap-1 rounded-xl border border-border p-2.5">
          <div className="flex items-start gap-2">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", !w.active ? "bg-muted-foreground/40" : w.erreur ? "bg-danger" : "bg-ok")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{w.nom}</p>
              <p className="truncate text-xs text-muted-foreground" title={w.url}>{w.url}</p>
              <p className="text-xs text-muted-foreground">
                {everyLabel(w.minutes)}
                {!w.active ? " · en pause" : w.dernier_passage ? ` · vue ${ago(w.dernier_passage)}` : ""}
                {w.alertes > 0 && ` · ${w.alertes} alerte${w.alertes > 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
          {w.critere && <p className="line-clamp-2 pl-4 text-xs text-muted-foreground">Ce qui compte : {w.critere}</p>}
          {w.erreur && <p className="pl-4 text-xs text-danger">{w.erreur}</p>}
          <div className="flex gap-1 pl-3">
            <Button size="sm" variant="ghost" onClick={() => act(w, w.active ? "pause" : "reprendre")} disabled={!!busy}>
              {w.active ? <Pause /> : <Play />}{w.active ? "Pause" : "Reprendre"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(w, "verifier")} disabled={!!busy}>
              {busy === w.id + "verifier" ? <Loader2 className="animate-spin" /> : <Zap />}Vérifier
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => act(w, "supprimer")} disabled={!!busy} aria-label="Supprimer la veille">
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      {adding ? (
        <form onSubmit={create} className="flex flex-col gap-2 rounded-xl border border-border p-2.5">
          <Input value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} className="h-9" placeholder="Nom (ex. Prix du vélo)" aria-label="Nom de la veille" required />
          <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="h-9" placeholder="https://… (page ou flux RSS)" aria-label="Adresse à surveiller" type="url" required />
          <Textarea value={form.critere} onChange={(e) => setForm({ ...form, critere: e.target.value })} rows={2} placeholder="Ce qui compte (vide : toute nouveauté)" aria-label="Ce qui compte" />
          <select value={form.minutes} onChange={(e) => setForm({ ...form, minutes: Number(e.target.value) })} className="h-9 rounded-md border border-border bg-surface px-2 text-sm" aria-label="Fréquence">
            {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy === "new"}>{busy === "new" && <Loader2 className="animate-spin" />}Créer et relever</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Annuler</Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}><Plus />Nouvelle veille</Button>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
