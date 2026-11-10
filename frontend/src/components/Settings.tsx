import { SettingsTwoColumns } from "./desktop/SettingsTwoColumns";
import { Appearance } from "./Appearance";
import { Providers } from "./Providers";
// Réglages : le cerveau des agents, les modèles de création (image, vidéo, musique), la voix et le téléphone.
// Chaque type peut rester en « Automatique » : Noah Agent prend le meilleur modèle disponible avec la clé.
import { Check, ChevronRight, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { get, request, send } from "@/lib/api";
import { noahPaused, setNoahPaused } from "@/lib/noahFace";
import { Boundary } from "./Boundary";
import { DoubleVerification } from "./DoubleVerification";
import { MailConfirmation } from "./MailConfirmation";
import { DefaultBrain } from "./DefaultBrain";
import { PhonePairing } from "./PhonePairing";
import { NotificationSettings } from "./NotificationSettings";
import { PhoneSettings, phoneSettingsAvailable } from "./PhoneSettings";
import { MyPassword, Profiles } from "./Profiles";
import { Updates } from "./Updates";
import { Flows } from "./Flows";
import { JudgeSetting } from "./Juge";
import { DecisionModel } from "./DecisionModel";
import { ModeRows } from "./Modes";
import type { Level } from "@/lib/modes";
import { type MediaModel, ModelSelect } from "./ModelSelect";
import { Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";
import { Button, Input, Label } from "./ui";

export type SettingsTab = "appearance" | "providers" | "home" | "mail" | "brain" | "create" | "voice" | "phone" | "notifications" | "telephone" | "security" | "updates" | "privacy" | "profiles" | "diagnostic";

type Kind = { label: string; setting: string; auto: string | null; routed?: boolean; models: MediaModel[] };
type MediaState = {
  available: boolean;
  reason: string | null;
  kinds: Record<string, Kind>;
  voice?: { setting: string; auto: string | null; voices: string[] };
  preferences?: string;
  has_key?: boolean;
};

// Six rubriques, rangées par ce que la personne vient faire. Les anciens noms restent à l'intérieur : un message d'erreur qui dit « Réglages > Modèles et budget > Cerveau » reste vrai.
function rubrics(owner: boolean): { id: string; label: string; tabs: [SettingsTab, string][] }[] {
  return [
    { id: "appearance", label: "Apparence", tabs: [["appearance", "Apparence"]] },
    { id: "account", label: "Compte", tabs: [["security", "Sécurité"]] },
    { id: "devices", label: "Appareils", tabs: [["phone", "Appareils reliés"], ...(phoneSettingsAvailable() ? [["telephone", "Ce téléphone"] as [SettingsTab, string]] : [])] },
    { id: "notifications", label: "Notifications", tabs: [["notifications", "Notifications"]] },
    ...(owner ? [
      { id: "models", label: "Modèles et budget", tabs: [["brain", "Cerveau"], ["providers", "Fournisseurs"], ["create", "Création"], ["voice", "Voix"]] as [SettingsTab, string][] },
      { id: "people", label: "Personnes", tabs: [["profiles", "Personnes"]] as [SettingsTab, string][] },
      { id: "server", label: "Serveur", tabs: [["updates", "Mises à jour"], ["mail", "Courriel"], ["privacy", "Confidentialité"], ["diagnostic", "Diagnostic"]] as [SettingsTab, string][] },
    ] : []),
  ];
}

const HINTS: Record<string, string> = {
  image: "Illustrations, photos, logos.",
  video: "Clips de quelques secondes.",
  music: "Jingles, ambiances, chansons.",
  speech: "Lit les réponses à voix haute.",
  transcription: "Ta voix en texte.",
};

export function SettingsFrame({ open, onOpenChange, title, onBack, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; onBack?: () => void; children: React.ReactNode }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && <DialogContent aria-modal="true" title={title} onBack={onBack} className="desktop-settings max-w-4xl">{children}</DialogContent>}</Dialog>;
}

export function SettingsDialog({ open, tab, owner, onTab, onOpenChange, onBrainSaved }: {
  open: boolean;
  tab: SettingsTab;
  /** Propriétaire de ce serveur : la configuration globale n'est montrée qu'à lui (le serveur la refuse aux autres). */
  owner: boolean;
  onTab: (t: SettingsTab) => void;
  onOpenChange: (o: boolean) => void;
  onBrainSaved: () => void;
}) {
  const all = rubrics(owner);
  const rubric = all.find((r) => r.tabs.some(([t]) => t === tab)) ?? all[0];
  const home = tab === "home"; // le sommaire du téléphone
  const [pairNow, setPairNow] = useState(false);
  useEffect(() => {
    if (tab !== "phone") setPairNow(false); // le code ne s'affiche d'office que quand on vient pour ça
  }, [tab]);
  return (
    <SettingsFrame open={open} onOpenChange={onOpenChange} title={home ? "Réglages" : rubric.label} onBack={home ? undefined : () => onTab("home")}>
          <SettingsTwoColumns navigation={all.map((r) => <button key={r.id} aria-current={rubric.id === r.id ? "page" : undefined} onClick={() => onTab(r.tabs[0][0])}>{r.label}</button>)}>
          {home ? (
            <nav aria-label="Rubriques" className="flex flex-col">
              <button type="button" onClick={() => { setPairNow(true); onTab("phone"); }} className="mb-2 flex cursor-pointer items-center justify-between rounded-xl bg-accent-soft px-3 py-3.5 text-left text-sm font-medium text-accent">
                Relier un téléphone ou un ordinateur<ChevronRight className="size-4" />
              </button>
              {all.map((r) => (
                <button key={r.id} type="button" onClick={() => onTab(r.tabs[0][0])} className="flex cursor-pointer items-center justify-between border-b border-border py-3.5 text-left text-sm font-medium last:border-b-0">
                  {r.label}<ChevronRight className="size-4 text-muted-foreground" />
                </button>
              ))}
            </nav>
          ) : (<>
          <div className="hidden">
            <Tabs value={rubric.id} onValueChange={(id) => onTab(all.find((r) => r.id === id)!.tabs[0][0])} className="self-start">
              <TabsList aria-label="Rubriques" className="flex-wrap">
                {all.map((r) => <TabsTrigger key={r.id} value={r.id}>{r.label}</TabsTrigger>)}
              </TabsList>
            </Tabs>
            {/* Le geste qu'on vient faire le plus souvent ici : un clic, et le code s'affiche. */}
            {tab !== "phone" && <button type="button" onClick={() => { setPairNow(true); onTab("phone"); }} className="cursor-pointer rounded-lg bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent">Relier un appareil</button>}
          </div>
          <Tabs value={tab} onValueChange={(v) => onTab(v as SettingsTab)} className="flex min-h-0 flex-col gap-4">
            {rubric.tabs.length > 1 && (
              <TabsList aria-label={rubric.label} className="flex-wrap self-start">
                {rubric.tabs.map(([t, label]) => <TabsTrigger key={t} value={t}>{label}</TabsTrigger>)}
              </TabsList>
            )}
            <Boundary key={tab} label="Cette rubrique">
            <TabsContent value="appearance"><Appearance /></TabsContent>
            <TabsContent value="providers"><Providers /></TabsContent>
            <TabsContent value="brain">
              <div className="flex flex-col gap-3">
                <DefaultBrain onCancel={() => onOpenChange(false)} onDone={onBrainSaved} />
                <DecisionModel />
              </div>
            </TabsContent>
            <TabsContent value="create">
              <MediaPanel kinds={["image", "video", "music"]} withPreferences />
            </TabsContent>
            <TabsContent value="voice">
              <div className="flex flex-col gap-3">
                <MediaPanel kinds={["transcription", "speech"]} withVoice />
                <VoiceServerPanel />
              </div>
            </TabsContent>
            <TabsContent value="phone">
              <PhonePairing start={pairNow} />
            </TabsContent>
            <TabsContent value="notifications">
              <NotificationSettings />
            </TabsContent>
            <TabsContent value="telephone">
              <PhoneSettings />
            </TabsContent>
            <TabsContent value="security">
              <MyPassword />
              <DoubleVerification />
              {!owner && <MailConfirmation owner={false} />}
              <FaceMotion />
            </TabsContent>
            <TabsContent value="mail">
              <MailConfirmation owner={owner} />
            </TabsContent>
            <TabsContent value="profiles">
              <Profiles />
            </TabsContent>
            <TabsContent value="updates">
              <Updates />
            </TabsContent>
            <TabsContent value="privacy">
              <div className="flex flex-col gap-4">
                <JudgeSetting />
                <Flows />
              </div>
            </TabsContent>
            <TabsContent value="diagnostic">
              <Diagnostic />
            </TabsContent>
            </Boundary>
          </Tabs>
          </>)}
          </SettingsTwoColumns>
    </SettingsFrame>
  );
}


/** Le mouvement des visages se coupe ici : le réglage reste sur cet appareil. */
function FaceMotion() {
  const [still, setStill] = useState(noahPaused);
  return (
    <label className="mt-3 flex items-center gap-3 rounded-2xl border border-border p-4 text-sm">
      <input
        type="checkbox"
        checked={still}
        onChange={(e) => {
          setStill(e.target.checked);
          setNoahPaused(e.target.checked);
        }}
      />
      <span>
        <span className="block font-semibold">Visages immobiles</span>
        <span className="block text-xs text-muted-foreground">Sur cet appareil.</span>
      </span>
    </label>
  );
}

function MediaPanel({ kinds, withVoice, withPreferences }: { kinds: string[]; withVoice?: boolean; withPreferences?: boolean }) {
  const [state, setState] = useState<MediaState | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = useCallback(() => get<MediaState>("/api/media").then(setState).catch((e) => setState({ available: false, reason: e.message, kinds: {} })), []);
  useEffect(() => {
    load();
  }, [load]);

  const choose = async (kind: string, model: string) => {
    await send("/api/media", { kind, model });
    setSaved(kind);
    load();
    setTimeout(() => setSaved(null), 1500);
  };

  if (!state) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture des modèles disponibles…</p>;
  if (!state.available)
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-xl bg-warn-soft p-4 text-sm text-warn">{state.reason}</p>
        <MediaKeyRow hasKey={!!state.has_key} onSaved={load} />
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <MediaKeyRow hasKey={!!state.has_key} onSaved={load} />
      {kinds.map((kind) => {
        const k = state.kinds[kind];
        if (!k) return null;
        return (
          <div key={kind} className="grid gap-2 rounded-2xl border border-border p-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] sm:items-start">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-semibold">
                {k.label}
                {saved === kind && <span className="inline-flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />Enregistré</span>}
              </p>
              <p className="text-xs text-muted-foreground">{HINTS[kind]}</p>
            </div>
            {k.models.length ? (
              <div className="flex min-w-0 flex-col gap-2">
                <ModelSelect label={k.label} models={k.models} value={k.setting} auto={k.auto} routed={k.routed} onChange={(id) => choose(kind, id)} />
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">Modes</summary>
                  <div className="mt-2"><ModeRows level={kind as Level} onChanged={() => load()} /></div>
                </details>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Aucun modèle de ce type avec ta clé.</p>
            )}
          </div>
        );
      })}
      {withPreferences && <Preferences initial={state.preferences ?? ""} onSave={(v) => choose("preferences", v)} />}
      {withVoice && state.voice && state.voice.voices.length > 0 && (
        <VoiceRow voice={state.voice} onChoose={(v) => choose("voice", v)} />
      )}
    </div>
  );
}

type DiagnosticState = {
  version: string;
  fournisseur: string | null;
  modele: string | null;
  agents: { id: string; en_ligne: boolean }[];
  erreurs: { quand: string; ou: string; agent: string | null; texte: string }[];
};

/** Les erreurs récentes du serveur, sans accéder à la machine. Le tout se copie pour un agent. */
function Diagnostic() {
  const [state, setState] = useState<DiagnosticState | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    get<DiagnosticState>("/api/diagnostic").then(setState).catch((e) => setError(e.message));
  }, []);
  if (error) return <p className="rounded-xl bg-warn-soft p-4 text-sm text-warn">{error}</p>;
  if (!state) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>;
  const copy = () =>
    navigator.clipboard.writeText(JSON.stringify(state, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        Version {state.version} · {state.fournisseur ?? "aucun fournisseur"} · {state.modele ?? "aucun modèle"} ·{" "}
        {state.agents.filter((a) => a.en_ligne).length} agent(s) en ligne sur {state.agents.length}
      </p>
      <Button variant="outline" size="sm" className="self-start" onClick={copy}>{copied ? "Copié" : "Tout copier"}</Button>
      {state.erreurs.length === 0 && <p>Aucune erreur depuis le dernier démarrage.</p>}
      {state.erreurs.map((e, i) => (
        <details key={i} className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer font-medium">{e.quand} · {e.ou}{e.agent ? ` · ${e.agent}` : ""}</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px]">{e.texte}</pre>
        </details>
      ))}
    </div>
  );
}

/** La clé OpenRouter de la voix et de la création. Elle ne change pas le cerveau. */
function MediaKeyRow({ hasKey, onSaved }: { hasKey: boolean; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setMessage(null);
    try {
      await send("/api/media/key", { api_key: key });
      setKey("");
      setMessage({ ok: true, text: "Clé vérifiée et enregistrée." });
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <div className="flex items-end gap-2">
        <Label className="flex-1">
          Clé OpenRouter pour la voix et la création
          <Input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? "Clé enregistrée (colle une autre clé pour la remplacer)" : "Colle ta clé ici"}
          />
        </Label>
        <Button variant="outline" disabled={!key.trim()} onClick={save}>Vérifier et enregistrer</Button>
      </div>
      {message && <p className={message.ok ? "text-sm text-ok" : "text-sm text-warn"}>{message.text}</p>}
    </div>
  );
}

/** Ce que le routeur doit savoir de tes goûts : prioritaire sur ses propres règles. */
function Preferences({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <label htmlFor="media-prefs" className="text-sm font-semibold">Tes préférences de création</label>
      <textarea
        id="media-prefs"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== initial && onSave(value)}
        placeholder="Ex. Logos toujours en SVG. Couleurs de marque : corail et bleu nuit. Miniatures YouTube très contrastées. Budget serré : modèles économiques sauf si je dis « qualité max »."
        className="w-full rounded-lg border border-border bg-background p-3 text-sm"
      />
    </div>
  );
}

type VoiceServer = { base_url: string; has_key: boolean; speech_model: string; transcription_model: string; voice: string };

/** Un serveur de voix au choix, compatible OpenAI. Sans adresse, tout reste sur OpenRouter. */
function VoiceServerPanel() {
  const [form, setForm] = useState<VoiceServer | null>(null);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    get<VoiceServer>("/api/voice/server").then(setForm).catch(() => {});
  }, []);
  if (!form) return null;
  const field = (name: "base_url" | "speech_model" | "transcription_model" | "voice", label: string, placeholder: string) => (
    <label className="grid gap-1 text-xs font-medium">
      {label}
      <input
        value={form[name]}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
        placeholder={placeholder}
        className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm font-normal"
      />
    </label>
  );
  const save = async () => {
    try {
      // Une clé vide n'est pas envoyée : on garde celle qui existe, sauf si l'adresse change (le serveur la retire alors).
      setForm(await send<VoiceServer>("/api/voice/server", { ...form, ...(key ? { api_key: key } : {}) }));
      setKey("");
      setMessage({ ok: true, text: "Enregistré." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Enregistrement impossible." });
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div>
        <p className="text-sm font-semibold">Ton propre serveur de voix</p>
        <p className="text-xs text-muted-foreground">
          Facultatif, compatible OpenAI (ex. <a className="underline" href="https://speaches.ai/" target="_blank" rel="noreferrer">Speaches</a>).
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("base_url", "Adresse", "http://mon-serveur:8000/v1")}
        <label className="grid gap-1 text-xs font-medium">
          Clé (facultative)
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={form.has_key ? "Clé enregistrée, laisser vide pour la garder" : "Aucune"}
            className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm font-normal"
          />
        </label>
        {field("speech_model", "Modèle de synthèse", "Nom du modèle chez ce serveur")}
        {field("transcription_model", "Modèle de transcription", "Nom du modèle chez ce serveur")}
        {field("voice", "Voix", "Nom de la voix chez ce serveur")}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={save}>Enregistrer</Button>
        {form.has_key && (
          <Button
            variant="ghost"
            onClick={() =>
              send<VoiceServer>("/api/voice/server", { ...form, api_key: "" })
                .then(setForm)
                .then(() => setMessage({ ok: true, text: "Clé retirée." }))
                .catch(() => setMessage({ ok: false, text: "La clé n'a pas pu être retirée." }))
            }
          >
            Retirer la clé
          </Button>
        )}
        {message && <span role="status" className={message.ok ? "text-xs text-ok" : "text-xs text-warn"}>{message.text}</span>}
      </div>
    </div>
  );
}

function VoiceRow({ voice, onChoose }: { voice: NonNullable<MediaState["voice"]>; onChoose: (v: string) => void }) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const label = (v: string) => v.replace(/:.*$/, "");
  const listen = async () => {
    setPlaying(true);
    try {
      const r = await request("/api/voice/speak", { method: "POST", body: JSON.stringify({ text: "Bonjour, je suis Noah. Voici ma voix." }) });
      audio.current?.pause();
      audio.current = new Audio(URL.createObjectURL(await r.blob()));
      audio.current.onended = () => setPlaying(false);
      await audio.current.play();
    } catch {
      setPlaying(false);
    }
  };
  return (
    <div className="grid gap-2 rounded-2xl border border-border p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center">
      <div>
        <p className="text-sm font-semibold">Voix</p>
      </div>
      <div className="flex gap-2">
        <select
          aria-label="Voix"
          value={voice.setting}
          onChange={(e) => onChoose(e.target.value)}
          className="h-10 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-3 text-sm"
        >
          <option value="auto">Automatique{voice.auto ? ` · ${label(voice.auto)}` : ""}</option>
          {voice.voices.map((v) => (
            <option key={v} value={v}>{label(v)}</option>
          ))}
        </select>
        <Button variant="outline" onClick={listen} disabled={playing} aria-label="Écouter la voix">
          {playing ? <Loader2 className="animate-spin" /> : <Play />}Écouter
        </Button>
      </div>
    </div>
  );
}
