// Voix : dicter un message et le mode vocal (conversation à voix haute).
// Le micro est découpé en morceaux aux petites pauses : chaque morceau part à la transcription pendant que la
// personne continue de parler, et le texte apparaît au fur et à mesure (modèle choisi dans Réglages > Voix).
import { useAui } from "@assistant-ui/react";
import { AudioLines, Loader2, Mic } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { ApiError, get, request, type VoiceReady, voiceRefusal } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "./ui";
import { t } from "@/i18n";

export const TICK = 50; // relevé du niveau, en ms
const VOICE = 0.035; // niveau (RMS) au-dessus duquel on considère que quelqu'un parle
const PAUSE = 700; // petite pause (virgule, respiration) : le morceau part à la transcription
const TRIES_ERROR = 3; // un morceau que le serveur n'arrive pas à traiter (500) : insister ne l'arrangera pas
const TRIES_ABSENT = 40; // réseau coupé ou serveur qui redémarre (502, 503, 504) : environ 5 minutes pour revenir

type Tick = { rms: number; speech: number; silence: number; age: number };

/**
 * Micro ouvert en continu. `speech` : temps de voix dans le morceau en cours ; `silence` : silence continu jusqu'ici.
 * `cut()` ferme le morceau en cours et en ouvre un autre aussitôt, sans perdre de son.
 */
export function useMic() {
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; timer: number; rec: { r: MediaRecorder; chunks: Blob[] } | null } | null>(null);
  const seg = useRef({ speech: 0, silence: 0, age: 0 });
  const level = useRef(0);
  const onTick = useRef<((t: Tick) => void) | null>(null);
  const onLost = useRef<(() => void) | null>(null);
  const opening = useRef(0);
  const silenced = useRef(false); // micro coupé par la personne : vaut aussi pour un micro rouvert

  const recorder = (stream: MediaStream) => {
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.start(250);
    return { r, chunks };
  };

  const open = useCallback(async () => {
    if (mic.current) return;
    const asked = ++opening.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // Raccroché, ou rouvert entre-temps, pendant que le navigateur donnait le micro : celui-ci ne sert plus.
    if (asked !== opening.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    seg.current = { speech: 0, silence: 0, age: 0 };
    // Une autre application a pris le micro, ou l'appareil a disparu : sans ça, l'appel resterait sourd sans le dire.
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !silenced.current;
      t.onended = () => onLost.current?.();
    });
    let last = performance.now();
    const timer = window.setInterval(() => {
      // Le vrai temps écoulé : un onglet caché ne relève plus le niveau qu'une fois par seconde.
      const now = performance.now();
      const dt = Math.min(now - last, 1500);
      last = now;
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      level.current = Math.min(1, rms * 8);
      const s = seg.current;
      s.age += dt;
      if (rms > VOICE) {
        s.speech += dt;
        s.silence = 0;
      } else s.silence += dt;
      onTick.current?.({ rms, speech: s.speech, silence: s.silence, age: s.age });
    }, TICK);
    mic.current = { stream, ctx, timer, rec: recorder(stream) };
  }, []);

  /** Ferme le morceau en cours (et en rouvre un si `next`). Rend le son et le temps de voix qu'il contient. */
  const cut = useCallback(async (next = true): Promise<{ blob: Blob | null; speech: number }> => {
    const m = mic.current;
    const old = m?.rec;
    if (!m || !old) return { blob: null, speech: 0 };
    const speech = seg.current.speech;
    seg.current = { speech: 0, silence: seg.current.silence, age: 0 };
    m.rec = next ? recorder(m.stream) : null;
    if (old.r.state === "inactive") {
      await new Promise((r) => setTimeout(r, 100)); // arrêté avec son micro : son dernier morceau arrive
    } else {
      const done = new Promise<void>((resolve) => (old.r.onstop = () => resolve()));
      old.r.stop();
      await done;
    }
    return { blob: old.chunks.length ? new Blob(old.chunks, { type: old.r.mimeType }) : null, speech };
  }, []);

  const close = useCallback(() => {
    opening.current++;
    const m = mic.current;
    if (!m) return;
    mic.current = null;
    clearInterval(m.timer);
    if (m.rec && m.rec.r.state !== "inactive") m.rec.r.stop();
    m.stream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    m.ctx.close();
    level.current = 0;
  }, []);

  /** Micro coupé : la piste reste ouverte et le silence ne coûte rien. */
  const mute = useCallback((off: boolean) => {
    silenced.current = off;
    mic.current?.stream.getAudioTracks().forEach((t) => (t.enabled = !off));
  }, []);

  useEffect(() => close, [close]);
  return { open, cut, close, level, onTick, onLost, seg, mute };
}

async function transcribe(blob: Blob, agentId: string): Promise<string> {
  const format = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  const r = await request(`/api/voice/transcribe?format=${format}&agent_id=${encodeURIComponent(agentId)}`, {
    method: "POST",
    body: blob,
    headers: { "Content-Type": "application/octet-stream" },
  });
  return (await r.json()).text as string;
}

export const MIC_REFUSED = t("Micro refusé ou indisponible.");

/** Transcrit les morceaux en parallèle mais rend les textes dans l'ordre où ils ont été dits. */
export function useTranscripts(agentId: string, onText: (text: string) => void) {
  const state = useRef({ issued: 0, next: 0, running: 0, done: new Map<number, string>(), inflight: new Set<Promise<void>>() });
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const emit = useRef(onText);
  emit.current = onText;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const submit = useCallback(
    (blob: Blob) => {
      const s = state.current;
      const i = s.issued++;
      setPending((n) => n + 1);
      // Deux transcriptions à la fois au plus (au-delà, le fournisseur répond 429). Le serveur passe déjà aux modèles de
      // secours : son refus est définitif et il dit pourquoi. Réseau coupé ou serveur qui redémarre : le son attend leur retour.
      // Toujours un nombre d'essais borné : ce morceau retient ceux qui le suivent, un tour ne part qu'une fois tout transcrit.
      const run = async () => {
        while (s.running >= 2) await new Promise((r) => setTimeout(r, 60));
        s.running++;
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              const text = await transcribe(blob, agentId);
              setError("");
              return text;
            } catch (e) {
              const status = e instanceof ApiError ? e.status : 0;
              const refused = status > 0 && status < 500; // réessayer ne changera rien
              const absent = !status || status === 502 || status === 503 || status === 504;
              if (!live.current || refused || attempt >= (absent ? TRIES_ABSENT : TRIES_ERROR)) throw e;
              if (absent && attempt >= 3) setError(t("Réseau coupé : ce que tu as dit partira dès son retour."));
              await new Promise((r) => setTimeout(r, Math.min(700 * attempt, 10_000)));
            }
          }
        } finally {
          s.running--;
        }
      };
      const p = run()
        .catch((e) => {
          setError(e instanceof ApiError && e.status < 500 ? e.message : t("Un passage n'a pas pu être transcrit. Le reste est bien là."));
          return "";
        })
        .then((text) => {
          s.done.set(i, text.trim());
          while (s.done.has(s.next)) {
            const t = s.done.get(s.next)!;
            s.done.delete(s.next++);
            if (t) emit.current(t);
          }
          setPending((n) => n - 1);
          s.inflight.delete(p);
        });
      s.inflight.add(p);
    },
    [agentId],
  );
  /** Combien de morceaux restent à transcrire. */
  const inFlight = useCallback(() => state.current.inflight.size, []);
  /** Attend que tout ce qui a été dit soit transcrit. */
  const settle = useCallback(async () => {
    while (state.current.inflight.size) await Promise.all([...state.current.inflight]);
  }, []);
  return { submit, settle, inFlight, pending, error, setError };
}

/** Barres de niveau du micro, animées sans redessiner le reste de l'interface. */
export function Level({ level }: { level: { current: number } }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      [0.5, 0.8, 1, 0.8, 0.5].forEach((k, i) => {
        const el = bars.current[i];
        if (el) el.style.height = `${Math.max(3, level.current * k * 20)}px`;
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [level]);
  return (
    <span className="flex h-5 items-center gap-0.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} className="w-1 rounded-full bg-current transition-[height] duration-100" />
      ))}
    </span>
  );
}

// --- Dictée --------------------------------------------------------------------------------

/**
 * Dictée dans la zone de saisie. Le texte apparaît pendant qu'on parle (un morceau par petite pause).
 * `finish(true)` arrête, attend la fin de la transcription puis envoie : on peut appuyer sur Envoyer sans
 * arrêter l'enregistrement d'abord.
 */
export function useDictation() {
  const { agentId } = useContext(AgentContext);
  const aui = useAui();
  const dictation = useFieldDictation(agentId, (text) => {
    const current = aui.composer.getState().text;
    aui.composer.setText(current.trim() ? `${current.trimEnd()} ${text}` : text);
  });
  const finish = async (thenSend: boolean) => {
    if ((await dictation.finish(false)) && thenSend && aui.composer.getState().text.trim()) aui.composer.send();
    return true;
  };
  return { ...dictation, finish };
}

/** La même dictée pour n'importe quel champ : chaque morceau transcrit va à `onText`. Rend `false` s'il n'y avait rien à arrêter. */
export function useFieldDictation(agentId: string, onText: (text: string) => void) {
  const mic = useMic();
  const [state, setState] = useState<"idle" | "recording" | "finishing">("idle");
  const recording = useRef(false);
  const tx = useTranscripts(agentId, onText);

  mic.onTick.current = ({ speech, silence }) => {
    if (recording.current && speech >= 250 && silence >= PAUSE) {
      void mic.cut().then(({ blob }) => blob && tx.submit(blob));
    }
  };

  const start = async () => {
    tx.setError("");
    const refusal = await voiceRefusal("dictation");
    if (refusal) return tx.setError(refusal);
    try {
      await mic.open();
      recording.current = true;
      setState("recording");
    } catch {
      tx.setError(MIC_REFUSED);
    }
  };

  const finish = async (_thenSend: boolean) => {
    if (!recording.current) return false;
    recording.current = false;
    setState("finishing");
    const { blob, speech } = await mic.cut(false);
    mic.close();
    if (blob && speech >= 150) tx.submit(blob); // un dernier morceau sans voix donnerait un texte inventé
    await tx.settle();
    setState("idle");
    return true;
  };

  return { state, level: mic.level, pending: tx.pending, error: tx.error, start, finish };
}

export type Dictation = ReturnType<typeof useDictation>;

export const NO_AGENT = "voix"; // comme NO_AGENT côté serveur

/** La dictée est-elle possible ici : une clé, un modèle de voix, un navigateur qui donne le micro. Dans le doute (serveur muet), non. */
export function useCanDictate() {
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
    let gone = false;
    get<VoiceReady>("/api/voice/ready").then((r) => !gone && setCan(!r.dictation), () => {});
    return () => {
      gone = true;
    };
  }, []);
  return can;
}

/** Bouton du compositeur : appuyer pour dicter, appuyer à nouveau pour arrêter (le texte reste à relire). */
export function DictateButton({ dictation, what = t("un message"), field = false }: { dictation: Dictation; what?: string; field?: boolean }) {
  const { state, level, pending, error, start, finish } = dictation;
  return (
    <span className="relative">
      <Button
        type="button"
        variant={state === "recording" ? "warn" : "ghost"}
        size="icon"
        onClick={() => (state === "idle" ? start() : finish(false))}
        disabled={state === "finishing"}
        aria-pressed={state === "recording"}
        aria-label={state === "recording" ? t("Arrêter la dictée") : t("Dicter {quoi}", { quoi: what })}
        title={state === "recording" ? (field ? t("Arrêter la dictée") : t("Arrêter la dictée (Envoyer envoie directement)")) : t("Dicter")}
        className={cn("cible-tactile", state === "idle" && "text-muted-foreground")}
      >
        {state === "finishing" ? <Loader2 className="animate-spin" /> : state === "recording" ? <Level level={level} /> : <Mic />}
      </Button>
      {state === "recording" && pending > 0 && (
        <Loader2 aria-label={t("Transcription en cours")} className="absolute -right-0.5 -top-0.5 size-3 animate-spin text-accent" />
      )}
      {error && (
        <span role="alert" className={cn("absolute bottom-full mb-2 w-64 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn shadow", field ? "right-0" : "left-0")}>
          {error}
        </span>
      )}
    </span>
  );
}

export function VoiceModeButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" data-mode-vocal onClick={onClick} aria-label={t("Mode vocal")} title={t("Parler avec l'agent")} className="cible-tactile text-muted-foreground">
      <AudioLines />
    </Button>
  );
}


/**
 * Voix de l'agent en flux : le navigateur ouvre /api/voice/audio/<id> pendant que le serveur écrit la réponse
 * et la synthétise phrase par phrase. Le son commence au premier morceau reçu.
 * `onPlaying(true/false)` signale quand on l'entend vraiment (pour l'interruption à la voix).
 */