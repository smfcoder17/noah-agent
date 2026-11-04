// Voix : dicter un message et le mode vocal (conversation à voix haute).
// Le micro est découpé en morceaux aux petites pauses : chaque morceau part à la transcription pendant que la
// personne continue de parler, et le texte apparaît au fur et à mesure (modèle choisi dans Réglages > Voix).
import { useAui, useAuiState } from "@assistant-ui/react";
import { AudioLines, Loader2, Mic, Square, X } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { request, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NoahTile } from "./Noah";
import { Button } from "./ui";

const TICK = 50; // relevé du niveau, en ms
const VOICE = 0.035; // niveau (RMS) au-dessus duquel on considère que quelqu'un parle
const PAUSE = 700; // petite pause (virgule, respiration) : le morceau part à la transcription

type Tick = { rms: number; speech: number; silence: number };

/**
 * Micro ouvert en continu. `speech` : temps de voix dans le morceau en cours ; `silence` : silence continu jusqu'ici.
 * `cut()` ferme le morceau en cours et en ouvre un autre aussitôt, sans perdre de son.
 */
function useMic() {
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; timer: number; rec: { r: MediaRecorder; chunks: Blob[] } | null } | null>(null);
  const seg = useRef({ speech: 0, silence: 0 });
  const level = useRef(0);
  const onTick = useRef<((t: Tick) => void) | null>(null);

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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    seg.current = { speech: 0, silence: 0 };
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      level.current = Math.min(1, rms * 8);
      const s = seg.current;
      if (rms > VOICE) {
        s.speech += TICK;
        s.silence = 0;
      } else s.silence += TICK;
      onTick.current?.({ rms, speech: s.speech, silence: s.silence });
    }, TICK);
    mic.current = { stream, ctx, timer, rec: recorder(stream) };
  }, []);

  /** Ferme le morceau en cours (et en rouvre un si `next`). Rend le son et le temps de voix qu'il contient. */
  const cut = useCallback(async (next = true): Promise<{ blob: Blob | null; speech: number }> => {
    const m = mic.current;
    const old = m?.rec;
    if (!m || !old) return { blob: null, speech: 0 };
    const speech = seg.current.speech;
    seg.current = { speech: 0, silence: seg.current.silence };
    m.rec = next ? recorder(m.stream) : null;
    const done = new Promise<void>((resolve) => (old.r.onstop = () => resolve()));
    if (old.r.state !== "inactive") old.r.stop();
    await done;
    return { blob: old.chunks.length ? new Blob(old.chunks, { type: old.r.mimeType }) : null, speech };
  }, []);

  const close = useCallback(() => {
    const m = mic.current;
    if (!m) return;
    mic.current = null;
    clearInterval(m.timer);
    if (m.rec && m.rec.r.state !== "inactive") m.rec.r.stop();
    m.stream.getTracks().forEach((t) => t.stop());
    m.ctx.close();
    level.current = 0;
  }, []);

  useEffect(() => close, [close]);
  return { open, cut, close, level, onTick, seg };
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

/** Transcrit les morceaux en parallèle mais rend les textes dans l'ordre où ils ont été dits. */
function useTranscripts(agentId: string, onText: (text: string) => void) {
  const state = useRef({ issued: 0, next: 0, running: 0, done: new Map<number, string>(), inflight: new Set<Promise<void>>() });
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const emit = useRef(onText);
  emit.current = onText;

  const submit = useCallback(
    (blob: Blob) => {
      const s = state.current;
      const i = s.issued++;
      setPending((n) => n + 1);
      // Deux transcriptions à la fois au plus (au-delà, le fournisseur répond 429), et trois essais par morceau :
      // le serveur passe déjà aux modèles de secours, ici on couvre une coupure réseau.
      const run = async () => {
        while (s.running >= 2) await new Promise((r) => setTimeout(r, 60));
        s.running++;
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              return await transcribe(blob, agentId);
            } catch (e) {
              if (attempt >= 2) throw e;
              await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
            }
          }
        } finally {
          s.running--;
        }
      };
      const p = run()
        .catch(() => {
          setError("Un passage n'a pas pu être transcrit (fournisseur indisponible). Le reste est bien là.");
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
  /** Attend que tout ce qui a été dit soit transcrit. */
  const settle = useCallback(async () => {
    while (state.current.inflight.size) await Promise.all([...state.current.inflight]);
  }, []);
  return { submit, settle, pending, error, setError };
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

/** Barres de niveau du micro, animées sans redessiner le reste de l'interface. */
function Level({ level }: { level: { current: number } }) {
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
  const mic = useMic();
  const [state, setState] = useState<"idle" | "recording" | "finishing">("idle");
  const recording = useRef(false);
  const t = useTranscripts(agentId, (text) => {
    const current = aui.composer.getState().text;
    aui.composer.setText(current.trim() ? `${current.trimEnd()} ${text}` : text);
  });

  mic.onTick.current = ({ speech, silence }) => {
    if (recording.current && speech >= 250 && silence >= PAUSE) {
      void mic.cut().then(({ blob }) => blob && t.submit(blob));
    }
  };

  const start = async () => {
    t.setError("");
    try {
      await mic.open();
      recording.current = true;
      setState("recording");
    } catch {
      t.setError("Micro refusé ou indisponible.");
    }
  };

  const finish = async (thenSend: boolean) => {
    if (!recording.current) return;
    recording.current = false;
    setState("finishing");
    const { blob, speech } = await mic.cut(false);
    mic.close();
    if (blob && speech >= 150) t.submit(blob); // un dernier morceau sans voix donnerait un texte inventé
    await t.settle();
    setState("idle");
    if (thenSend && aui.composer.getState().text.trim()) aui.composer.send();
  };

  return { state, level: mic.level, pending: t.pending, error: t.error, start, finish };
}

export type Dictation = ReturnType<typeof useDictation>;

/** Bouton du compositeur : appuyer pour dicter, appuyer à nouveau pour arrêter (le texte reste à relire). */
export function DictateButton({ dictation }: { dictation: Dictation }) {
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
        aria-label={state === "recording" ? "Arrêter la dictée" : "Dicter un message"}
        title={state === "recording" ? "Arrêter la dictée (Envoyer envoie directement)" : "Dicter"}
        className={cn(state === "idle" && "text-muted-foreground")}
      >
        {state === "finishing" ? <Loader2 className="animate-spin" /> : state === "recording" ? <Level level={level} /> : <Mic />}
      </Button>
      {state === "recording" && pending > 0 && (
        <Loader2 aria-label="Transcription en cours" className="absolute -right-0.5 -top-0.5 size-3 animate-spin text-accent" />
      )}
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

// --- Voix de l'agent -----------------------------------------------------------------------

/** Identifiant d'un flux audio (crypto.randomUUID n'existe qu'en HTTPS ; getRandomValues partout). */
const audioId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

type VoiceReply = { dire: string; action: boolean };

/**
 * Voix de l'agent en flux : le navigateur ouvre /api/voice/audio/<id> pendant que le serveur écrit la réponse
 * et la synthétise phrase par phrase. Le son commence au premier morceau reçu.
 * `onPlaying(true/false)` signale quand on l'entend vraiment (pour l'interruption à la voix).
 */
function useSpeaker(agentId: string, onPlaying: (playing: boolean, interrupted: boolean) => void) {
  const current = useRef<HTMLAudioElement | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const notify = useRef(onPlaying);
  notify.current = onPlaying;
  const play = useCallback(
    (id: string) =>
      new Promise<void>((resolve) => {
        stop.current?.();
        current.current?.pause();
        const a = new Audio(`/api/voice/audio/${id}`);
        current.current = a;
        let heard = false;
        let over = false;
        const end = (interrupted: boolean) => {
          if (over) return;
          over = true;
          if (heard) notify.current(false, interrupted);
          resolve();
        };
        // cancel() appelle end lui-même : load() annule l'événement « pause » encore en attente.
        stop.current = () => end(true);
        a.onplaying = () => {
          if (over) return;
          heard = true;
          notify.current(true, false);
        };
        a.onended = () => end(false);
        a.onerror = () => end(false);
        a.onpause = () => end(!a.ended);
        a.play().catch(() => end(false));
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
    stop.current?.();
    stop.current = null;
    a.pause();
    a.removeAttribute("src"); // coupe le téléchargement : le serveur arrête la synthèse
    a.load();
  }, []);
  return { speak, reply, cancel };
}

/**
 * Silence qui marque la fin d'un tour, selon la fin de ce qui a été dit. Le transcripteur met souvent un point
 * à une phrase coupée (« j'ai une question. ») : seul le point d'interrogation conclut plus vite.
 */
function endOfTurnDelay(text: string) {
  const t = text.trim().toLowerCase();
  if (/\?$/.test(t)) return 1000;
  if (/[.!…]$/.test(t)) return 1300;
  if (/(,|;|:|\b(et|mais|donc|alors|ou|parce que|que|qui|de|du|des|le|la|les|un|une|pour|avec|sur|dans|euh|ben|genre|comme|si|quand))$/.test(t)) return 2500;
  return 1400;
}

/**
 * Mode vocal. Le micro écoute en continu : on peut parler pendant que l'agent parle (il se tait et écoute), et
 * faire de courtes pauses sans qu'il prenne la parole. Une voix rapide répond tout de suite pendant que l'agent
 * fait le travail avec son cerveau et ses outils ; à la fin, elle résume son résultat. Tout reste écrit dans la
 * conversation. `report` : compte rendu d'un rappel pris, lu dès que le micro est prêt.
 */
export function VoiceMode({ onClose, report, onReportRead }: {
  onClose: () => void;
  report?: { id: string; text: string } | null;
  onReportRead?: () => void;
}) {
  const { agentId, agentName, agentColor, say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const messages = useAuiState((s) => s.thread.messages);
  const mic = useMic();
  const [speaking, setSpeaking] = useState(false);
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const busy = useRef(false); // un tour est en cours : on attend la fin du run de l'agent
  const started = useRef(false);
  const action = useRef(false);
  const queue = useRef<{ text: string; action: boolean }[]>([]);
  const heard = useRef<string[]>([]); // ce que la personne a dit depuis le dernier tour envoyé
  const playing = useRef(false);
  const loud = useRef(0);
  const committing = useRef(false);
  const micReady = useRef<Promise<void> | null>(null);
  const reportSaid = useRef<string | null>(null);
  const voiceHeard = useRef(0);

  const t = useTranscripts(agentId, (text) => {
    heard.current.push(text);
    setLive(heard.current.join(" "));
  });

  const { speak, reply: speakReply, cancel } = useSpeaker(agentId, (on, interrupted) => {
    loud.current = 0;
    if (on) voiceHeard.current++;
    if (on && mic.seg.current.speech > 0 && mic.seg.current.silence < 300) {
      // La personne parle encore quand la voix arrive : l'agent se tait aussitôt et on garde sa phrase.
      cancel();
      return;
    }
    playing.current = on;
    setSpeaking(on);
    // Pendant que l'agent parle, le micro entend surtout sa voix : on jette ce morceau, sauf si la personne
    // l'a interrompu en parlant (il contient alors le début de sa phrase).
    if (on || !interrupted) void mic.cut();
  });

  const textOf = (m: (typeof messages)[number]) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  const latest = useRef(messages);
  latest.current = messages;
  const history = () => latest.current.slice(-6).map((m) => ({ role: m.role, text: spoken(textOf(m)).slice(0, 800) }));

  /** La voix rapide répond tout de suite ; rend `true` si la demande demande à l'agent d'agir. */
  const answer = async (text: string) => {
    try {
      const prior = queue.current.map((q) => ({ role: "user", text: q.text }));
      return (await speakReply({ text, history: [...history(), ...prior] })).action;
    } catch {
      return true; // pas de voix rapide : on attendra le résultat de l'agent
    }
  };

  /** Un tour : le message part à l'agent et, en même temps, la voix rapide répond. */
  const turn = async (text: string) => {
    if (busy.current) {
      // L'agent travaille encore : la voix rapide répond quand même, et l'agent reçoit la suite dès qu'il a fini.
      const item = { text, action: true };
      queue.current.push(item);
      setNote(`Je lui transmets ensuite : « ${text.slice(0, 60)} »`);
      item.action = await answer(text);
      return;
    }
    busy.current = true;
    started.current = false;
    say(text);
    action.current = await answer(text);
  };

  /** Envoie ce qui a été dit (fin de tour détectée, ou bouton Envoyer). */
  const commit = async (force = false) => {
    if (committing.current) return;
    committing.current = true;
    setSending(true);
    if (force) {
      const { blob, speech } = await mic.cut();
      if (blob && speech >= 150) t.submit(blob);
    }
    await t.settle();
    const text = heard.current.join(" ").trim();
    heard.current = [];
    setLive("");
    committing.current = false;
    setSending(false);
    if (text && alive.current) await turn(text);
  };

  mic.onTick.current = ({ rms, speech, silence }) => {
    if (playing.current) {
      // Interruption : la personne parle fort et assez longtemps par-dessus l'agent → il se tait.
      loud.current = rms > 0.05 ? loud.current + TICK : Math.max(0, loud.current - TICK);
      if (loud.current >= 250) cancel();
      return;
    }
    // Petite pause : ce morceau part à la transcription, la personne peut continuer.
    if (speech >= 250 && silence >= PAUSE) {
      void mic.cut().then(({ blob }) => blob && t.submit(blob));
      return;
    }
    // Fin du tour : silence assez long pour ce qui a été dit, et plus rien en train d'être dit.
    const said = heard.current.join(" ");
    if (!committing.current && speech < 150 && (said || t.pending) && silence >= endOfTurnDelay(said)) void commit();
  };

  const openMic = async () => {
    setError("");
    try {
      await mic.open();
    } catch {
      setError("Micro refusé ou indisponible.");
    }
  };

  useEffect(() => {
    alive.current = true;
    micReady.current = openMic();
    return () => {
      alive.current = false;
      cancel();
      mic.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rappel pris : le compte rendu est lu une fois. S'il ne peut pas être entendu, on le dit : il reste écrit.
  const reportId = report?.id;
  useEffect(() => {
    if (!report || reportSaid.current === report.id) return;
    reportSaid.current = report.id;
    const text = spoken(report.text);
    onReportRead?.();
    void (async () => {
      await micReady.current;
      if (!alive.current) return;
      const before = voiceHeard.current;
      await speak(text);
      if (alive.current && voiceHeard.current === before) setNote("La voix n'a pas pu lire le compte rendu : il est écrit dans la conversation.");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  // Une action attend l'accord de la personne : on le dit à voix haute, une fois. L'accord se donne à l'écran, sur la carte
  // « À valider » : aucun mot entendu ne vaut « oui », une transcription peut se tromper (G11.7).
  const asked = (() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return null;
    const part = (last.content as readonly { type: string; toolName?: string; toolCallId?: string; result?: unknown; args?: { summary?: unknown } }[]).find(
      (p) => p.type === "tool-call" && p.toolName === "approval" && p.result === undefined,
    );
    return part ? { id: part.toolCallId ?? "", what: String(part.args?.summary ?? "").split("\n")[0] } : null;
  })();
  const askedSaid = useRef<string | null>(null);
  const askedId = asked?.id;
  useEffect(() => {
    if (!asked || askedSaid.current === asked.id) return;
    askedSaid.current = asked.id;
    void speak(`J'ai besoin de ton accord avant d'agir. ${spoken(asked.what).slice(0, 160)}. Réponds à l'écran : Autoriser ou Refuser.`).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedId]);

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
      if (action.current && result.trim() && alive.current) {
        // Réponse déjà courte : on la lit telle quelle, sans repasser par le modèle rapide.
        const short = spoken(result);
        try {
          if (short.length <= 240) await speak(short);
          else await speakReply({ text: result, mode: "result" });
        } catch {
          if (alive.current) await speak(short.slice(0, 400));
        }
      }
      if (!alive.current) return;
      setNote("");
      // Ce qui a été dit pendant qu'il travaillait part en un seul message ; la voix rapide y a déjà répondu.
      const waiting = queue.current.splice(0);
      if (waiting.length && alive.current) {
        busy.current = true;
        started.current = false;
        action.current = waiting.some((q) => q.action);
        say(waiting.map((q) => q.text).join("\n"));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const phase = error ? "error" : speaking ? "speaking" : sending ? "sending" : running || busy.current ? "waiting" : "listening";
  const words: Record<typeof phase, string> = {
    listening: "Je t'écoute…",
    sending: "J'envoie…",
    speaking: `${agentName} parle…`,
    waiting: asked ? `${agentName} attend ton accord, à l'écran` : `${agentName} s'en occupe… tu peux continuer à parler`,
    error: error || "Le mode vocal s'est arrêté.",
  };
  const hint = live
    ? `« ${live.slice(-90)} »`
    : note ||
      (phase === "speaking" ? "Parle pour l'interrompre." : phase === "error" ? "Vérifie l'accès au micro." : "Parle naturellement, j'envoie quand tu as fini.");

  return (
    <div role="region" aria-label="Mode vocal" className="flex w-full items-center gap-3 rounded-2xl border border-accent/40 bg-surface p-3 shadow-sm">
      <span className={cn("relative grid place-items-center rounded-full", phase === "speaking" && "animate-pulse")}>
        <NoahTile color={agentColor} className="size-11" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", phase === "error" && "text-warn")} aria-live="polite">{words[phase]}</p>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </div>
      {phase !== "error" && phase !== "speaking" && <span className="text-accent"><Level level={mic.level} /></span>}
      {(phase === "sending" || t.pending > 0) && <Loader2 className="size-5 animate-spin text-accent" />}
      {phase === "speaking" && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            cancel();
            void mic.cut(); // ce morceau ne contient que la voix de l'agent
          }}
        >
          <Square className="fill-current" />Interrompre
        </Button>
      )}
      {(phase === "listening" || phase === "waiting") && (live || t.pending > 0) && (
        <Button variant="outline" size="sm" onClick={() => commit(true)}>Envoyer</Button>
      )}
      {phase === "error" && <Button variant="outline" size="sm" onClick={openMic}>Réessayer</Button>}
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Quitter le mode vocal" title="Quitter le mode vocal"><X /></Button>
    </div>
  );
}
