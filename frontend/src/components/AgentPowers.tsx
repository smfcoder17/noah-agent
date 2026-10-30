// Ce que l'agent sait et fait de lui-même, réglable depuis Détails : routines, mémoire, connexions, logiciels.
import { Check, ChevronDown, ExternalLink, HardDrive, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
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

type GoogleState = { disponible: boolean; connecte?: boolean; identifiants?: boolean };

export function Connections({ agentId }: { agentId: string }) {
  const { data, setData, error, setError } = useAgentData<{ google: GoogleState }>(`/api/agents/${agentId}/connections`);
  const google = data?.google;
  return (
    <Section title="Connexions" count={google?.connecte ? 1 : undefined}>
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {google?.disponible && (
        <GoogleCard agentId={agentId} state={google} onState={(g) => setData({ google: g })} onError={setError} />
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}

function GoogleCard({ agentId, state, onState, onError }: { agentId: string; state: GoogleState; onState: (g: GoogleState) => void; onError: (e: string) => void }) {
  const [step, setStep] = useState<"idle" | "secret" | "code">("idle");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/api/agents/${agentId}/connections/google`;

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
  const authorize = () =>
    run(async () => {
      const r = await send<{ adresse: string }>(`${base}/start`, secret ? { client_secret: secret } : {});
      window.open(r.adresse, "_blank", "noopener");
      setStep("code");
    });
  const finish = () =>
    run(async () => {
      onState(await send<GoogleState>(`${base}/finish`, { code }));
      setStep("idle");
      setCode("");
    });
  const disconnect = () =>
    run(async () => {
      if (confirm("Déconnecter Google ? L'agent n'aura plus accès à Gmail, Agenda ni Drive.")) onState(await send<GoogleState>(`${base}/revoke`, {}));
    });

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 place-items-center rounded-lg bg-muted text-sm font-bold">G</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Google</p>
          <p className="text-xs text-muted-foreground">Gmail, Agenda, Drive, Docs, Sheets</p>
        </div>
        {state.connecte ? (
          <span className="flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />Connecté</span>
        ) : step === "idle" ? (
          <Button size="sm" onClick={() => (state.identifiants ? authorize() : setStep("secret"))} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}Connecter
          </Button>
        ) : null}
      </div>

      {step === "secret" && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Noah Agent est auto-hébergé : il se connecte à Google avec ta propre « application ». À faire une seule fois (5 minutes) :
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              Dans <a className="text-accent underline" href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud</a>, active Gmail API, Google Calendar API et Google Drive API.
            </li>
            <li>
              Dans <a className="text-accent underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Identifiants</a>, crée un « ID client OAuth » de type <b>Application de bureau</b> et télécharge le JSON.
            </li>
            <li>
              Dans <a className="text-accent underline" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Audience</a>, ajoute ton adresse comme utilisateur test.
            </li>
          </ol>
          <label className="flex cursor-pointer items-center gap-2 self-start rounded-lg border border-dashed border-border px-3 py-2 text-xs hover:bg-muted">
            <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => setSecret((await e.target.files?.[0]?.text()) ?? "")} />
            {secret ? <><Check className="size-3.5 text-ok" />Fichier chargé</> : "Choisir le fichier JSON téléchargé"}
          </label>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setStep("idle")}>Annuler</Button>
            <Button size="sm" onClick={authorize} disabled={!secret || busy}>{busy ? <Loader2 className="animate-spin" /> : <ExternalLink />}Autoriser dans Google</Button>
          </div>
        </div>
      )}

      {step === "code" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Après avoir accepté, Google t'envoie sur une page qui ne s'affiche pas (adresse « localhost »). C'est normal :
            copie l'adresse complète de cette page et colle-la ici.
          </p>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="http://localhost:1/?code=…" aria-label="Adresse de retour de Google" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={authorize} disabled={busy}>Rouvrir Google</Button>
            <Button size="sm" onClick={finish} disabled={!code.trim() || busy}>{busy && <Loader2 className="animate-spin" />}Terminer</Button>
          </div>
        </div>
      )}

      {state.connecte && (
        <Button size="sm" variant="ghost" className="self-start text-muted-foreground" onClick={disconnect} disabled={busy}>Déconnecter</Button>
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
