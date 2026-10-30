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
    // Fin de phrase : on a entendu de la voix, puis 0,6 s de silence (relevé toutes les 50 ms).
    const TICK = 50;
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
        heard += TICK;
        quietSince = 0;
      } else if (heard > 300) {
        quietSince += TICK;
        if (quietSince > 600) {
          heard = 0;
          quietSince = 0;
          onSilence();
        }
      }
    }, TICK);
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

type Phase = "listening" | "transcribing" | "speaking" | "waiting" | "error";

/** Lit un texte phrase par phrase : la première part pendant que la suivante se prépare. */
function useSpeaker(agentId: string) {
  const current = useRef<HTMLAudioElement | null>(null);
  const token = useRef(0);
  const fetchAudio = useCallback(
    (text: string) =>
      request("/api/voice/speak", { method: "POST", body: JSON.stringify({ text, agent_id: agentId }) })
        .then((r) => r.blob())
        .then((b) => URL.createObjectURL(b)),
    [agentId],
  );
  const speak = useCallback(
    async (text: string) => {
      const run = ++token.current;
      const parts = text.match(/[^.!?…]+[.!?…]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
      // Regroupe les phrases très courtes pour éviter les pauses entre deux appels.
      const chunks: string[] = [];
      for (const p of parts) {
        if (chunks.length && chunks[chunks.length - 1].length < 60) chunks[chunks.length - 1] += ` ${p}`;
        else chunks.push(p);
      }
      let next = fetchAudio(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const url = await next;
        if (run !== token.current) return;
        if (i + 1 < chunks.length) next = fetchAudio(chunks[i + 1]);
        await new Promise<void>((resolve) => {
          const a = new Audio(url);
          current.current = a;
          a.onended = () => resolve();
          a.onerror = () => resolve();
          a.onpause = () => resolve();
          a.play().catch(() => resolve());
        });
        if (run !== token.current) return;
      }
    },
    [fetchAudio],
  );
  const cancel = useCallback(() => {
    token.current++;
    current.current?.pause();
  }, []);
  return { speak, cancel };
}

/**
 * Mode vocal. Une voix rapide répond tout de suite (moins d'une seconde) pendant que l'agent fait le travail
 * avec son cerveau et ses outils ; à la fin, elle résume son résultat. Tout reste écrit dans la conversation.
 */
export function VoiceMode({ onClose }: { onClose: () => void }) {
  const { agentId, agentName, agentColor, say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const messages = useAuiState((s) => s.thread.messages);
  const { start, stop, level } = useRecorder();
  const { speak, cancel } = useSpeaker(agentId);
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
      const reply = await send<{ dire: string; action: boolean }>("/api/voice/reply", { agent_id: agentId, text, history: history() });
      action.current = reply.action;
      if (reply.dire && alive.current) await speak(reply.dire);
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
          const r = await send<{ dire: string }>("/api/voice/reply", { agent_id: agentId, text: result, mode: "result" });
          if (alive.current && r.dire) await speak(r.dire);
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
