import { Appearance } from "./Appearance";
import { Providers } from "./Providers";
// Réglages : le cerveau des agents, les modèles de création (image, vidéo, musique), la voix et le téléphone.
// Chaque type peut rester en « Automatique » : Noah Agent prend le meilleur modèle disponible avec la clé.
import { Bell, Check, ChevronLeft, ChevronRight, Cpu, Globe, KeyRound, Link2, Loader2, Play, Server, Smartphone, Star, Sun, User, Users, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Agent, get, request, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Boundary } from "./Boundary";
import { DoubleVerification } from "./DoubleVerification";
import { MailConfirmation } from "./MailConfirmation";
import { DefaultBrain } from "./DefaultBrain";
import { PhonePairing } from "./PhonePairing";
import { NotificationSettings } from "./NotificationSettings";
import { PhoneSettings, phoneSettingsAvailable } from "./PhoneSettings";
import { MyPassword, Profiles } from "./Profiles";
import { Updates } from "./Updates";
import { Vault } from "./Vault";
import { Flows } from "./Flows";
import { JudgeSetting } from "./Juge";
import { DecisionModel } from "./DecisionModel";
import { FastModel } from "./FastModel";
import { ModeRows } from "./Modes";
import type { Level } from "@/lib/modes";
import { type MediaModel, ModelSelect } from "./ModelSelect";
import { Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";
import { Button, Input, Label } from "./ui";
import { t, tr } from "@/i18n";

export type SettingsTab = "team" | "appearance" | "providers" | "home" | "mail" | "brain" | "create" | "voice" | "phone" | "notifications" | "telephone" | "security" | "updates" | "privacy" | "profiles" | "diagnostic" | "vault";

type Kind = { label: string; setting: string; auto: string | null; routed?: boolean; models: MediaModel[] };
type MediaState = {
  available: boolean;
  reason: string | null;
  kinds: Record<string, Kind>;
  voice?: { setting: string; auto: string | null; voices: string[] };
  preferences?: string;
  has_key?: boolean;
};

// Sept rubriques d'hier, douze du prototype « Fil calme » : seules celles qui ont un réglage réel sont montrées. Bureau et Abonnements
// attendent leur donnée (lots L7 et L12). Les anciens noms restent à l'intérieur : un message d'erreur qui dit « Réglages > Modèles et budget > Cerveau » reste vrai.
type Rubrique = { id: string; label: string; aide: string; Icon: LucideIcon; tabs: [SettingsTab, string][] };
function rubrics(owner: boolean): Rubrique[] {
  return [
    { id: "appearance", label: t("Apparence"), aide: t("Langue, thème, taille du texte"), Icon: Sun, tabs: [["appearance", t("Apparence")]] },
    { id: "account", label: t("Compte"), aide: t("Mot de passe, double vérification"), Icon: User, tabs: [["security", t("Sécurité")]] },
    { id: "vault", label: t("Coffre"), aide: t("Identifiants et clés"), Icon: KeyRound, tabs: [["vault", t("Coffre")]] },
    { id: "devices", label: t("Appareils"), aide: t("Relier un appareil, droits du téléphone"), Icon: Smartphone, tabs: [["phone", t("Appareils reliés")], ...(phoneSettingsAvailable() ? [["telephone", t("Ce téléphone")] as [SettingsTab, string]] : [])] },
    { id: "notifications", label: t("Notifications"), aide: t("Ce que tu reçois"), Icon: Bell, tabs: [["notifications", t("Notifications")]] },
    { id: "team", label: t("Équipe"), aide: t("Chef d'équipe, autonomie"), Icon: Star, tabs: [["team", t("Équipe")]] },
    ...(owner ? [
      { id: "models", label: t("Modèles et budget"), aide: t("Un modèle pour tous, budget, création, voix"), Icon: Cpu, tabs: [["brain", t("Cerveau")], ["create", t("Création")], ["voice", t("Voix")]] as [SettingsTab, string][] },
      { id: "providers", label: t("Fournisseurs"), aide: t("Où vont tes demandes"), Icon: Globe, tabs: [["providers", t("Fournisseurs")]] as [SettingsTab, string][] },
      { id: "people", label: t("Personnes"), aide: t("Qui a un compte sur ce serveur"), Icon: Users, tabs: [["profiles", t("Personnes")]] as [SettingsTab, string][] },
      { id: "server", label: t("Serveur"), aide: t("Mises à jour, courriel, confidentialité"), Icon: Server, tabs: [["updates", t("Mises à jour")], ["mail", t("Courriel")], ["privacy", t("Confidentialité")], ["diagnostic", t("Diagnostic")]] as [SettingsTab, string][] },
    ] : []),
  ];
}

const HINTS: Record<string, string> = {
  image: t("Illustrations, photos, logos."),
  video: t("Clips de quelques secondes."),
  music: t("Jingles, ambiances, chansons."),
  speech: t("Lit les réponses à voix haute."),
  transcription: t("Ta voix en texte."),
};

export function SettingsFrame({ open, onOpenChange, title, onBack, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; onBack?: () => void; children: React.ReactNode }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && <DialogContent aria-modal="true" title={title} onBack={onBack} className="desktop-settings max-w-4xl">{children}</DialogContent>}</Dialog>;
}

/** Les réglages : une page de la zone de travail (comme « Pour toi » et Activité), rubriques à gauche et détail à droite ; sur téléphone, le sommaire puis la rubrique. */
export function SettingsPage({ tab, owner, agents = [], onTab, onClose, onBrainSaved }: {
  tab: SettingsTab;
  /** Propriétaire de ce serveur : la configuration globale n'est montrée qu'à lui (le serveur la refuse aux autres). */
  owner: boolean;
  agents?: Agent[];
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  onBrainSaved: () => void;
}) {
  const all = rubrics(owner);
  const home = tab === "home"; // le sommaire du téléphone ; sur ordinateur, la première rubrique
  const rubric = all.find((r) => r.tabs.some(([x]) => x === tab)) ?? all[0];
  const current: SettingsTab = home ? rubric.tabs[0][0] : tab;
  const [pairNow, setPairNow] = useState(false);
  useEffect(() => {
    if (tab !== "phone") setPairNow(false); // le code ne s'affiche d'office que quand on vient pour ça
  }, [tab]);
  return (
    <main className="chat-pane" aria-label={t("Réglages")}>
      <header className="head"><div className="head-title flex min-w-0 grow items-center gap-2"><h1 className="cut">{t("Réglages")}</h1></div></header>
      <div className={cn("set", !home && "detail")}>
        <nav aria-label={t("Rubriques")} className="set-nav">
          <div className="px-0.5 pb-2.5 md:hidden">
            <button type="button" className="btn btn-ink w-full" onClick={() => { setPairNow(true); onTab("phone"); }}><Link2 className="size-[18px]" aria-hidden />{t("Relier un téléphone ou un ordinateur")}</button>
          </div>
          {all.map((r) => (
            <button key={r.id} type="button" className="set-link" aria-current={rubric.id === r.id && (!home || window.matchMedia?.("(min-width:768px)").matches) ? "page" : undefined} onClick={() => onTab(r.tabs[0][0])}>
              <r.Icon className="size-[18px] shrink-0 text-soft" aria-hidden />
              <span className="grow flex min-w-0 flex-col"><span className="cut">{r.label}</span><small className="cut text-[13px] font-normal text-soft md:hidden">{r.aide}</small></span>
              <ChevronRight className="size-4 shrink-0 text-soft md:hidden" aria-hidden />
            </button>
          ))}
        </nav>
        <div className="set-body">
          <div className="stack g24">
            <div className="md:hidden"><button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0 }} onClick={() => onTab("home")}><ChevronLeft className="size-4" aria-hidden />{t("Réglages")}</button></div>
            <h2 className="title">{rubric.label}</h2>
            <Tabs value={current} onValueChange={(v) => onTab(v as SettingsTab)} className="flex min-h-0 flex-col gap-4">
              {rubric.tabs.length > 1 && (
                <TabsList aria-label={rubric.label} className="seg self-start">
                  {rubric.tabs.map(([x, label]) => <TabsTrigger key={x} value={x}>{label}</TabsTrigger>)}
                </TabsList>
              )}
              <Boundary key={current} label={t("Cette rubrique")}>
                <TabsContent value="appearance"><Appearance /></TabsContent>
                <TabsContent value="providers"><Providers /></TabsContent>
                <TabsContent value="brain">
                  <div className="flex flex-col gap-3">
                    <DefaultBrain onCancel={onClose} onDone={onBrainSaved} />
                    <FastModel />
                    <DecisionModel />
                  </div>
                </TabsContent>
                <TabsContent value="create"><MediaPanel kinds={["image", "video", "music"]} withPreferences /></TabsContent>
                <TabsContent value="voice">
                  <div className="flex flex-col gap-3">
                    <MediaPanel kinds={["transcription", "speech"]} withVoice />
                    <VoiceServerPanel />
                  </div>
                </TabsContent>
                <TabsContent value="phone"><PhonePairing start={pairNow} /></TabsContent>
                <TabsContent value="notifications"><NotificationSettings /></TabsContent>
                <TabsContent value="telephone"><PhoneSettings /></TabsContent>
                <TabsContent value="security">
                  <MyPassword />
                  <DoubleVerification />
                  {!owner && <MailConfirmation owner={false} />}
                </TabsContent>
                <TabsContent value="vault"><Vault /></TabsContent>
                <TabsContent value="team"><Equipe agents={agents} /></TabsContent>
                <TabsContent value="mail"><MailConfirmation owner={owner} /></TabsContent>
                <TabsContent value="profiles"><Profiles /></TabsContent>
                <TabsContent value="updates"><Updates /></TabsContent>
                <TabsContent value="privacy"><Flows /></TabsContent>
                <TabsContent value="diagnostic"><Diagnostic /></TabsContent>
              </Boundary>
            </Tabs>
          </div>
        </div>
      </div>
    </main>
  );
}

/** L'équipe : qui orchestre, ce qui te revient toujours, jusqu'où tes agents avancent seuls. Le chef est le premier agent créé ; en désigner un autre attend L7. */
function Equipe({ agents }: { agents: Agent[] }) {
  const chef = agents.find((a) => a.chef);
  const reserve: [string, string][] = [
    [t("Payer"), t("Un achat, un renouvellement, un abonnement.")],
    [t("Supprimer définitivement"), t("Des fichiers, un agent, un compte.")],
    [t("Secrets et droits"), t("Clés, mots de passe, accès donnés à un agent ou à une personne.")],
    [t("Première publication"), t("Le premier message envoyé depuis un compte ou un site.")],
  ];
  return (
    <div className="flex flex-col gap-6" data-equipe>
      <section className="stack g8">
        <h3 className="h2">{t("Qui est chef d'équipe")}</h3>
        <p className="text-soft">{t("Il reçoit tes demandes larges, les confie aux autres, suit chaque tâche et te rend un seul compte. Le premier agent que tu as créé est ton chef d'équipe.")}</p>
        {chef ? (
          <div className="list"><div className="row"><span className="avatar" aria-hidden>{chef.name.charAt(0)}</span><span className="grow flex min-w-0 flex-col"><span className="row-title">{chef.name}</span><span className="row-sub">{chef.role}</span></span><span className="pill work">{t("Chef d'équipe")}</span></div></div>
        ) : <p className="note">{t("Aucun agent pour l'instant.")}</p>}
      </section>
      <section className="stack g8">
        <h3 className="h2">{t("Ce qui te revient toujours")}</h3>
        <p className="text-soft">{t("Ces sujets ne passent jamais par un agent : ils arrivent directement dans « Pour toi ». Tu ne peux pas les déléguer.")}</p>
        <div className="list">{reserve.map(([titre, aide]) => <div key={titre} className="row wrap"><span className="grow flex min-w-0 flex-col"><span className="row-title">{titre}</span><span className="row-sub">{aide}</span></span><span className="pill">{t("Toujours à toi")}</span></div>)}</div>
      </section>
      <JudgeSetting />
    </div>
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

  if (!state) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture des modèles disponibles…")}</p>;
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
                {saved === kind && <span className="inline-flex items-center gap-1 text-xs font-medium text-ok"><Check className="size-3.5" />{t("Enregistré")}</span>}
              </p>
              <p className="text-xs text-muted-foreground">{HINTS[kind]}</p>
            </div>
            {k.models.length ? (
              <div className="flex min-w-0 flex-col gap-2">
                <ModelSelect label={k.label} models={k.models} value={k.setting} auto={k.auto} routed={k.routed} onChange={(id) => choose(kind, id)} />
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">{t("Modes")}</summary>
                  <div className="mt-2"><ModeRows level={kind as Level} onChanged={() => load()} /></div>
                </details>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("Aucun modèle de ce type avec ta clé.")}</p>
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
  if (!state) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>;
  const copy = () =>
    navigator.clipboard.writeText(JSON.stringify(state, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        {t("Version {version} · {fournisseur} · {modele} · {n} agent(s) en ligne sur {total}", {
          version: state.version,
          fournisseur: state.fournisseur ?? t("aucun fournisseur"),
          modele: state.modele ?? t("aucun modèle"),
          n: state.agents.filter((a) => a.en_ligne).length,
          total: state.agents.length,
        })}
      </p>
      <Button variant="outline" size="sm" className="self-start" onClick={copy}>{copied ? t("Copié") : t("Tout copier")}</Button>
      {state.erreurs.length === 0 && <p>{t("Aucune erreur depuis le dernier démarrage.")}</p>}
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
      setMessage({ ok: true, text: t("Clé vérifiée et enregistrée.") });
      onSaved();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <div className="flex items-end gap-2">
        <Label className="flex-1">
          {t("Clé OpenRouter pour la voix et la création")}
          <Input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? t("Clé enregistrée (colle une autre clé pour la remplacer)") : t("Colle ta clé ici")}
          />
        </Label>
        <Button variant="outline" disabled={!key.trim()} onClick={save}>{t("Vérifier et enregistrer")}</Button>
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
      <label htmlFor="media-prefs" className="text-sm font-semibold">{t("Tes préférences de création")}</label>
      <textarea
        id="media-prefs"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== initial && onSave(value)}
        placeholder={t("Ex. Logos toujours en SVG. Couleurs de marque : corail et bleu nuit. Miniatures YouTube très contrastées. Budget serré : modèles économiques sauf si je dis « qualité max ».")}
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
      setMessage({ ok: true, text: t("Enregistré.") });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : t("Enregistrement impossible.") });
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div>
        <p className="text-sm font-semibold">{t("Ton propre serveur de voix")}</p>
        <p className="text-xs text-muted-foreground">
          {/* i18n-ignore : Speaches, nom du logiciel */}
          {tr("Facultatif, compatible OpenAI (ex. {lien}).", { lien: <a className="underline" href="https://speaches.ai/" target="_blank" rel="noreferrer">Speaches</a> })}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("base_url", t("Adresse"), t("http://mon-serveur:8000/v1"))}
        <label className="grid gap-1 text-xs font-medium">
          {t("Clé (facultative)")}
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={form.has_key ? t("Clé enregistrée, laisser vide pour la garder") : t("Aucune")}
            className="h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm font-normal"
          />
        </label>
        {field("speech_model", t("Modèle de synthèse"), t("Nom du modèle chez ce serveur"))}
        {field("transcription_model", t("Modèle de transcription"), t("Nom du modèle chez ce serveur"))}
        {field("voice", t("Voix"), t("Nom de la voix chez ce serveur"))}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={save}>{t("Enregistrer")}</Button>
        {form.has_key && (
          <Button
            variant="ghost"
            onClick={() =>
              send<VoiceServer>("/api/voice/server", { ...form, api_key: "" })
                .then(setForm)
                .then(() => setMessage({ ok: true, text: t("Clé retirée.") }))
                .catch(() => setMessage({ ok: false, text: t("La clé n'a pas pu être retirée.") }))
            }
          >
            {t("Retirer la clé")}
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
      const r = await request("/api/voice/speak", { method: "POST", body: JSON.stringify({ text: t("Bonjour, je suis Noah. Voici ma voix.") }) });
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
        <p className="text-sm font-semibold">{t("Voix")}</p>
      </div>
      <div className="flex gap-2">
        <select
          aria-label={t("Voix")}
          value={voice.setting}
          onChange={(e) => onChoose(e.target.value)}
          className="h-10 min-w-0 flex-1 cursor-pointer rounded-lg border border-border bg-background px-3 text-sm"
        >
          <option value="auto">{t("Automatique")}{voice.auto ? ` · ${label(voice.auto)}` : ""}</option>
          {voice.voices.map((v) => (
            <option key={v} value={v}>{label(v)}</option>
          ))}
        </select>
        <Button variant="outline" onClick={listen} disabled={playing} aria-label={t("Écouter la voix")}>
          {playing ? <Loader2 className="animate-spin" /> : <Play />}{t("Écouter")}
        </Button>
      </div>
    </div>
  );
}
