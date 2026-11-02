// Réglages : le cerveau des agents, les modèles de création (image, vidéo, musique), la voix et le téléphone.
// Chaque type peut rester en « Automatique » : Noah Agent prend le meilleur modèle disponible avec la clé.
import { Check, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { get, request, send } from "@/lib/api";
import { ModelPicker } from "./ModelPicker";
import { PhonePairing } from "./PhonePairing";
import { type MediaModel, ModelSelect } from "./ModelSelect";
import { Dialog, DialogContent, Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";
import { Button } from "./ui";

export type SettingsTab = "brain" | "create" | "voice" | "phone";

type Kind = { label: string; setting: string; auto: string | null; routed?: boolean; models: MediaModel[] };
type MediaState = {
  available: boolean;
  reason: string | null;
  kinds: Record<string, Kind>;
  voice?: { setting: string; auto: string | null; voices: string[] };
  preferences?: string;
};

const HINTS: Record<string, string> = {
  image: "Illustrations, photos, logos, miniatures. En automatique, un logo va à un modèle vectoriel et une affiche avec du texte à un modèle fort en typographie.",
  video: "Clips de quelques secondes. Compte quelques minutes et plus cher qu'une image.",
  music: "Jingles, ambiances, chansons courtes.",
  speech: "La voix qui lit les réponses en mode vocal.",
  transcription: "Transforme ta voix en texte quand tu dictes ou parles.",
};

export function SettingsDialog({ open, tab, onTab, onOpenChange, onBrainSaved }: {
  open: boolean;
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onOpenChange: (o: boolean) => void;
  onBrainSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent title="Réglages" description="Les clés restent chiffrées sur cette machine. Les agents ne les voient jamais : ils passent par Noah Agent." className="max-w-4xl">
          <Tabs value={tab} onValueChange={(v) => onTab(v as SettingsTab)} className="flex min-h-0 flex-col gap-4">
            <TabsList className="self-start">
              <TabsTrigger value="brain">Cerveau</TabsTrigger>
              <TabsTrigger value="create">Création</TabsTrigger>
              <TabsTrigger value="voice">Voix</TabsTrigger>
              <TabsTrigger value="phone">Appareils</TabsTrigger>
            </TabsList>
            <TabsContent value="brain">
              <ModelPicker onCancel={() => onOpenChange(false)} onDone={onBrainSaved} />
            </TabsContent>
            <TabsContent value="create">
              <MediaPanel kinds={["image", "video", "music"]} withPreferences />
            </TabsContent>
            <TabsContent value="voice">
              <MediaPanel kinds={["transcription", "speech"]} withVoice />
            </TabsContent>
            <TabsContent value="phone">
              <PhonePairing />
            </TabsContent>
          </Tabs>
        </DialogContent>
      )}
    </Dialog>
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
  if (!state.available) return <p className="rounded-xl bg-warn-soft p-4 text-sm text-warn">{state.reason}</p>;

  return (
    <div className="flex flex-col gap-3">
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
              <ModelSelect label={k.label} models={k.models} value={k.setting} auto={k.auto} routed={k.routed} onChange={(id) => choose(kind, id)} />
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
      <p className="text-xs text-muted-foreground">
        « Automatique » suit les nouveaux modèles : Noah Agent prend le meilleur disponible, en qualité d'abord puis en coût.
      </p>
    </div>
  );
}

/** Ce que le routeur doit savoir de tes goûts : prioritaire sur ses propres règles. */
function Preferences({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border p-4">
      <label htmlFor="media-prefs" className="text-sm font-semibold">Tes préférences de création</label>
      <p className="text-xs text-muted-foreground">
        Le routeur les suit avant ses propres règles. L'agent y ajoute ce que sa mémoire sait de tes goûts.
      </p>
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
        <p className="text-xs text-muted-foreground">En automatique, une voix française du modèle choisi.</p>
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
