// Voix : dicter un message (appuyer pour parler) et le mode vocal (conversation à voix haute).
// L'audio part au serveur, qui le transcrit avec le modèle choisi dans Réglages > Voix ;
// en mode vocal, la réponse de l'agent est relue avec la voix choisie, puis l'écoute reprend.
import { useAui, useAuiState } from "@assistant-ui/react";
import { AudioLines, Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { request, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NoahTile } from "./Noah";
import { Button } from "./ui";

/**
 * Micro : enregistre, mesure le niveau, et prévient quand la personne a fini de parler.
 * `persistent` (mode vocal) garde le micro ouvert entre deux phrases : chaque tour démarre sans attendre
 * l'autorisation du navigateur, et le début de la phrase n'est pas coupé.
 */
function useRecorder(persistent = false) {
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; timer: number } | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[] } | null>(null);
  const vad = useRef<{ onSilence?: () => void; heard: number; quiet: number }>({ heard: 0, quiet: 0 });
  const [level, setLevel] = useState(0);

  const open = useCallback(async () => {
    if (mic.current) return mic.current.stream;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    // Fin de phrase : on a entendu de la voix, puis 0,6 s de silence (relevé toutes les 50 ms).
    const TICK = 50;
    const timer = window.setInterval(() => {
      if (!rec.current) return; // micro ouvert mais pas d'enregistrement : l'agent parle
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 8));
      const v = vad.current;
      if (!v.onSilence) return;
      if (rms > 0.035) {
        v.heard += TICK;
        v.quiet = 0;
      } else if (v.heard > 300) {
        v.quiet += TICK;
        if (v.quiet > 600) {
          const cb = v.onSilence;
          vad.current = { heard: 0, quiet: 0 };
          cb();
        }
      }
    }, TICK);
    mic.current = { stream, ctx, timer };
    return stream;
  }, []);

  const close = useCallback(() => {
    const m = mic.current;
    if (!m) return;
    mic.current = null;
    clearInterval(m.timer);
    m.stream.getTracks().forEach((t) => t.stop());
    m.ctx.close();
  }, []);

  /** Arrête et rend l'enregistrement (ou null si on annule). */
  const stop = useCallback(
    async (keep = true): Promise<Blob | null> => {
      const r = rec.current;
      rec.current = null;
      vad.current = { heard: 0, quiet: 0 };
      setLevel(0);
      if (r) {
        const done = new Promise<void>((resolve) => (r.recorder.onstop = () => resolve()));
        if (r.recorder.state !== "inactive") r.recorder.stop();
        await done;
      }
      if (!persistent) close();
      return r && keep && r.chunks.length ? new Blob(r.chunks, { type: r.recorder.mimeType }) : null;
    },
    [close, persistent],
  );

  const start = useCallback(
    async (onSilence?: () => void) => {
      if (rec.current) await stop(false);
      const stream = await open();
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start(250);
      vad.current = { onSilence, heard: 0, quiet: 0 };
      rec.current = { recorder, chunks };
    },
    [open, stop],
  );

  useEffect(
    () => () => {
      void stop(false);
      close();
    },
    [stop, close],
  );
  return { start, stop, level };
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

/** Ce qu'on lit à voix haute : le texte de la réponse, sans widgets, code ni mise en forme. */
function spoken(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/MEDIA:\S+/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>`|]/g, "")
    .replace(/\/opt\/data\/\S+/g, "le fichier")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

function Level({ level }: { level: number }) {
  return (
    <span className="flex h-5 items-center gap-0.5" aria-hidden>
      {[0.5, 0.8, 1, 0.8, 0.5].map((k, i) => (
        <span key={i} className="w-1 rounded-full bg-current transition-[height] duration-100" style={{ height: `${Math.max(3, level * k * 20)}px` }} />
      ))}
    </span>
  );
}

/** Bouton du compositeur : appuyer pour dicter, appuyer à nouveau pour transcrire dans la zone de saisie. */
export function DictateButton() {
  const { agentId } = useContext(AgentContext);
  const aui = useAui();
  const { start, stop, level } = useRecorder();
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState("");

  const toggle = async () => {
    setError("");
    if (state === "idle") {
      try {
        await start();
        setState("recording");
      } catch {
        setError("Micro refusé ou indisponible.");
      }
      return;
    }
    if (state !== "recording") return;
    setState("transcribing");
    try {
      const blob = await stop();
      const text = blob ? await transcribe(blob, agentId) : "";
      if (text) {
        const current = aui.composer.getState().text;
        aui.composer.setText(current ? `${current.trimEnd()} ${text}` : text);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setState("idle");
    }
  };

  return (
    <span className="relative">
      <Button
        type="button"
        variant={state === "recording" ? "warn" : "ghost"}
        size="icon"
        onClick={toggle}
        aria-pressed={state === "recording"}
        aria-label={state === "recording" ? "Arrêter et transcrire" : "Dicter un message"}
        title={state === "recording" ? "Arrêter et transcrire" : "Dicter"}
        className={cn(state === "idle" && "text-muted-foreground")}
      >
        {state === "transcribing" ? <Loader2 className="animate-spin" /> : state === "recording" ? <Level level={level} /> : <Mic />}
      </Button>
      {error && (
        <span role="alert" className="absolute bottom-full left-0 mb-2 w-64 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn shadow">
          {error}
        </span>
      )}
    </span>
  );
}

export function VoiceModeButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" onClick={onClick} aria-label="Mode vocal" title="Parler avec l'agent" className="text-muted-foreground">
      <AudioLines />
    </Button>
  );
}

type Phase = "listening" | "transcribing" | "speaking" | "waiting" | "error";

/** Identifiant d'un flux audio (crypto.randomUUID n'existe qu'en HTTPS ; getRandomValues partout). */
const audioId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

type VoiceReply = { dire: string; action: boolean };

/**
 * Voix de l'agent en flux : le navigateur ouvre /api/voice/audio/<id> pendant que le serveur écrit la réponse
 * et la synthétise phrase par phrase. Le son commence au premier morceau reçu.
 */
function useSpeaker(agentId: string) {
  const current = useRef<HTMLAudioElement | null>(null);
  const play = useCallback(
    (id: string) =>
      new Promise<void>((resolve) => {
        current.current?.pause();
        const a = new Audio(`/api/voice/audio/${id}`);
        current.current = a;
        a.onended = a.onerror = a.onpause = () => resolve();
        a.play().catch(() => resolve());
      }),
    [],
  );
  /** Lit un texte déjà connu. */
  const speak = useCallback(
    async (text: string) => {
      const id = audioId();
      send("/api/voice/say", { text, agent_id: agentId, audio_id: id }).catch(() => current.current?.pause());
      await play(id);
    },
    [agentId, play],
  );
  /** Réponse de la voix rapide (ou résumé du résultat), entendue pendant qu'elle s'écrit. */
  const reply = useCallback(
    async (body: { text: string; history?: unknown[]; mode?: "turn" | "result" }) => {
      const id = audioId();
      const answer = send<VoiceReply>("/api/voice/reply", { agent_id: agentId, ...body, audio_id: id });
      const heard = play(id);
      try {
        const r = await answer;
        await heard;
        return r;
      } catch (e) {
        current.current?.pause();
        throw e;
      }
    },
    [agentId, play],
  );
  const cancel = useCallback(() => {
    const a = current.current;
    if (!a) return;
    a.pause();
    a.removeAttribute("src"); // coupe le téléchargement : le serveur arrête la synthèse
    a.load();
  }, []);
  return { speak, reply, cancel };
}

/**
 * Mode vocal. Une voix rapide répond tout de suite (moins d'une seconde) pendant que l'agent fait le travail
 * avec son cerveau et ses outils ; à la fin, elle résume son résultat. Tout reste écrit dans la conversation.
 */
export function VoiceMode({ onClose }: { onClose: () => void }) {
  const { agentId, agentName, agentColor, say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const messages = useAuiState((s) => s.thread.messages);
  const { start, stop, level } = useRecorder(true);
  const { speak, reply: speakReply, cancel } = useSpeaker(agentId);
  const [phase, setPhase] = useState<Phase>("listening");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const busy = useRef(false); // un tour est en cours : on attend la fin du run de l'agent
  const started = useRef(false);
  const action = useRef(false);
  const queue = useRef<string[]>([]);
  const textOf = (m: (typeof messages)[number]) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  // Les rappels du micro gardent la première version des fonctions : l'historique passe par une référence.
  const latest = useRef(messages);
  latest.current = messages;
  const history = () => latest.current.slice(-6).map((m) => ({ role: m.role, text: spoken(textOf(m)).slice(0, 800) }));

  const listen = useCallback(async () => {
    if (!alive.current) return;
    setPhase("listening");
    try {
      await start(async () => {
        setPhase("transcribing");
        const blob = await stop();
        try {
          const text = blob ? await transcribe(blob, agentId) : "";
          if (!alive.current) return;
          if (text) await turn(text);
          else listen();
        } catch (e) {
          setError((e as Error).message);
          setPhase("error");
        }
      });
    } catch {
      setError("Micro refusé ou indisponible.");
      setPhase("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, stop, agentId]);

  /** Un tour : le message part à l'agent et, en même temps, la voix rapide répond. */
  const turn = async (text: string) => {
    if (busy.current) {
      // L'agent travaille encore : on garde la demande pour la lui donner juste après.
      queue.current.push(text);
      setNote(`Noté pour après : « ${text.slice(0, 60)} »`);
      return listen();
    }
    busy.current = true;
    started.current = false;
    say(text);
    setPhase("speaking");
    try {
      action.current = (await speakReply({ text, history: history() })).action;
    } catch {
      action.current = true; // pas de voix rapide : on attendra le résultat de l'agent
    }
    if (!alive.current || !busy.current) return; // l'agent a déjà fini : la suite est déjà lancée
    setPhase("waiting");
    listen();
  };

  useEffect(() => {
    alive.current = true;
    listen();
    return () => {
      alive.current = false;
      cancel();
      void stop(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // L'agent a fini : on lit le résumé de ce qu'il a fait (s'il a agi), puis la demande suivante part.
  useEffect(() => {
    if (!busy.current) return;
    if (running) {
      started.current = true;
      return;
    }
    if (!started.current) return;
    busy.current = false;
    started.current = false;
    const last = messages[messages.length - 1];
    const result = last?.role === "assistant" ? textOf(last) : "";
    (async () => {
      if (action.current && result.trim()) {
        await stop(false);
        setPhase("speaking");
        // Réponse déjà courte : on la lit telle quelle, sans repasser par le modèle rapide (−0,7 s).
        const short = spoken(result);
        if (short.length <= 240) {
          if (alive.current) await speak(short);
        } else try {
          if (alive.current) await speakReply({ text: result, mode: "result" });
        } catch {
          if (alive.current) await speak(spoken(result).slice(0, 400));
        }
      }
      if (!alive.current) return;
      const next = queue.current.shift();
      setNote("");
      if (next) await turn(next);
      else if (phase !== "listening") listen();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const interrupt = async () => {
    cancel();
    if (phase === "listening" || phase === "waiting") {
      // Envoyer tout de suite ce qui a été dit, sans attendre le silence.
      setPhase("transcribing");
      const blob = await stop();
      const text = blob ? await transcribe(blob, agentId).catch(() => "") : "";
      if (text) await turn(text);
      else listen();
      return;
    }
    await stop(false);
    listen();
  };

  const words: Record<Phase, string> = {
    listening: "Je t'écoute…",
    transcribing: "Je transcris…",
    speaking: `${agentName} parle…`,
    waiting: `${agentName} s'en occupe… tu peux continuer à parler`,
    error: error || "Le mode vocal s'est arrêté.",
  };

  return (
    <div role="region" aria-label="Mode vocal" className="flex w-full items-center gap-3 rounded-2xl border border-accent/40 bg-surface p-3 shadow-sm">
      <span className={cn("relative grid place-items-center rounded-full", phase === "speaking" && "animate-pulse")}>
        <NoahTile color={agentColor} className="size-11" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", phase === "error" && "text-warn")} aria-live="polite">{words[phase]}</p>
        <p className="truncate text-xs text-muted-foreground">
          {note || (phase === "listening" || phase === "waiting" ? "Parle, j'envoie quand tu fais une pause." : phase === "speaking" ? "Touche « Interrompre » pour reprendre la parole." : "Ce que tu dis apparaît dans la conversation.")}
        </p>
      </div>
      {(phase === "listening" || phase === "waiting") && <span className="text-accent"><Level level={level} /></span>}
      {(phase === "transcribing" || (phase === "waiting" && running)) && <Loader2 className="size-5 animate-spin text-accent" />}
      {phase !== "error" && phase !== "transcribing" && (
        <Button variant="outline" size="sm" onClick={interrupt}>
          {phase === "speaking" ? <><Square className="fill-current" />Interrompre</> : <>Envoyer</>}
        </Button>
      )}
      {phase === "error" && <Button variant="outline" size="sm" onClick={() => { setError(""); listen(); }}>Réessayer</Button>}
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Quitter le mode vocal" title="Quitter le mode vocal"><X /></Button>
    </div>
  );
}
