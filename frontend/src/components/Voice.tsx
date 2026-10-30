// Voix : dicter un message (appuyer pour parler) et le mode vocal (conversation à voix haute).
// L'audio part au serveur, qui le transcrit avec le modèle choisi dans Réglages > Voix ;
// en mode vocal, la réponse de l'agent est relue avec la voix choisie, puis l'écoute reprend.
import { useAui, useAuiState } from "@assistant-ui/react";
import { AudioLines, Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { request } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NoahTile } from "./Noah";
import { Button } from "./ui";

/** Micro : enregistre, mesure le niveau, et prévient quand la personne a fini de parler. */
function useRecorder() {
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; timer: number; chunks: Blob[] } | null>(null);
  const [level, setLevel] = useState(0);

  const start = useCallback(async (onSilence?: () => void) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(250);
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    // Fin de phrase : on a entendu de la voix, puis 1,2 s de silence.
    let heard = 0;
    let quietSince = 0;
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 8));
      if (!onSilence) return;
      if (rms > 0.035) {
        heard += 100;
        quietSince = 0;
      } else if (heard > 300) {
        quietSince += 100;
        if (quietSince > 1200) {
          heard = 0;
          quietSince = 0;
          onSilence();
        }
      }
    }, 100);
    rec.current = { recorder, stream, ctx, timer, chunks };
  }, []);

  /** Arrête et rend l'enregistrement (ou null si on annule). */
  const stop = useCallback(async (keep = true): Promise<Blob | null> => {
    const r = rec.current;
    if (!r) return null;
    rec.current = null;
    clearInterval(r.timer);
    setLevel(0);
    const done = new Promise<void>((resolve) => (r.recorder.onstop = () => resolve()));
    if (r.recorder.state !== "inactive") r.recorder.stop();
    await done;
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close();
    return keep && r.chunks.length ? new Blob(r.chunks, { type: r.recorder.mimeType }) : null;
  }, []);

  useEffect(() => () => void stop(false), [stop]);
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

type Phase = "listening" | "transcribing" | "thinking" | "speaking" | "error";

/** Mode vocal : écoute → transcription → message → réponse lue à voix haute → écoute, dans le même fil. */
export function VoiceMode({ onClose }: { onClose: () => void }) {
  const { agentId, agentName, agentColor, say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const lastText = useAuiState((s) => {
    const m = s.thread.messages[s.thread.messages.length - 1];
    return m?.role === "assistant" ? m.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
  });
  const { start, stop, level } = useRecorder();
  const [phase, setPhase] = useState<Phase>("listening");
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const sent = useRef(false);
  const started = useRef(false); // la réponse a commencé (sinon on relirait l'ancienne)
  const alive = useRef(true);

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
          if (!text) return listen();
          sent.current = true;
          setPhase("thinking");
          say(text);
        } catch (e) {
          setError((e as Error).message);
          setPhase("error");
        }
      });
    } catch {
      setError("Micro refusé ou indisponible.");
      setPhase("error");
    }
  }, [start, stop, agentId, say]);

  useEffect(() => {
    alive.current = true;
    listen();
    return () => {
      alive.current = false;
      audio.current?.pause();
      void stop(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // La réponse est finie : on la lit, puis on écoute de nouveau.
  useEffect(() => {
    if (!sent.current || phase !== "thinking") return;
    if (running) {
      started.current = true;
      return;
    }
    if (!started.current) return;
    sent.current = false;
    started.current = false;
    const text = spoken(lastText);
    if (!text) return void listen();
    setPhase("speaking");
    request("/api/voice/speak", { method: "POST", body: JSON.stringify({ text, agent_id: agentId }) })
      .then((r) => r.blob())
      .then((b) => {
        if (!alive.current) return;
        audio.current = new Audio(URL.createObjectURL(b));
        audio.current.onended = () => listen();
        return audio.current.play();
      })
      .catch((e) => {
        setError((e as Error).message);
        setPhase("error");
      });
  }, [running, phase, lastText, agentId, listen]);

  const interrupt = async () => {
    audio.current?.pause();
    if (phase === "listening") {
      // Envoyer tout de suite ce qui a été dit, sans attendre le silence.
      setPhase("transcribing");
      const blob = await stop();
      const text = blob ? await transcribe(blob, agentId).catch(() => "") : "";
      if (text) {
        sent.current = true;
        setPhase("thinking");
        say(text);
      } else listen();
      return;
    }
    listen();
  };

  const words: Record<Phase, string> = {
    listening: "Je t'écoute…",
    transcribing: "Je transcris…",
    thinking: `${agentName} réfléchit…`,
    speaking: `${agentName} parle…`,
    error: error || "Le mode vocal s'est arrêté.",
  };

  return (
    <div role="region" aria-label="Mode vocal" className="flex w-full items-center gap-3 rounded-2xl border border-accent/40 bg-surface p-3 shadow-sm">
      <span className={cn("relative grid place-items-center rounded-full", phase === "speaking" && "animate-pulse")}>
        <NoahTile color={agentColor} className="size-11" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", phase === "error" && "text-warn")} aria-live="polite">{words[phase]}</p>
        <p className="text-xs text-muted-foreground">
          {phase === "listening" ? "Parle, j'envoie quand tu fais une pause." : phase === "speaking" ? "Touche « Interrompre » pour reprendre la parole." : "Ce que tu dis apparaît dans la conversation."}
        </p>
      </div>
      {phase === "listening" && <span className="text-accent"><Level level={level} /></span>}
      {(phase === "transcribing" || phase === "thinking") && <Loader2 className="size-5 animate-spin text-accent" />}
      {(phase === "speaking" || phase === "listening") && (
        <Button variant="outline" size="sm" onClick={interrupt}>
          {phase === "speaking" ? <><Square className="fill-current" />Interrompre</> : <>Envoyer</>}
        </Button>
      )}
      {phase === "error" && <Button variant="outline" size="sm" onClick={() => { setError(""); listen(); }}>Réessayer</Button>}
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Quitter le mode vocal" title="Quitter le mode vocal"><X /></Button>
    </div>
  );
}
