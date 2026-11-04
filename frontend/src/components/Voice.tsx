// Voix : dicter un message et le mode vocal (conversation à voix haute).
// Le micro est découpé en morceaux aux petites pauses : chaque morceau part à la transcription pendant que la
// personne continue de parler, et le texte apparaît au fur et à mesure (modèle choisi dans Réglages > Voix).
import { useAui, useAuiState } from "@assistant-ui/react";
import { AudioLines, Loader2, Mic } from "lucide-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { ApiError, request, send } from "@/lib/api";
import { appShell, nativeCall } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { CallStage } from "./CallStage";
import { Button } from "./ui";

const TICK = 50; // relevé du niveau, en ms
const VOICE = 0.035; // niveau (RMS) au-dessus duquel on considère que quelqu'un parle
const PAUSE = 700; // petite pause (virgule, respiration) : le morceau part à la transcription
const TURN_PAUSE = 500; // en mode vocal : le morceau part, et la réponse se prépare en silence
// Un appel dure des heures : aucun morceau ne doit grandir sans fin, le serveur en refuse au-delà de 20 Mo.
const QUIET_RENEW = 30_000; // morceau sans voix depuis ce temps : on le jette et on en ouvre un autre
const SEGMENT_MAX = 60_000; // parole ou bruit sans aucune pause : le morceau part quand même
const NETWORK_TRIES = 9; // transcription, réseau coupé : le son attend environ une minute avant d'être perdu
const LOST_WAIT = 600_000; // comme useAgentChat : au-delà, la réponse perdue avec le serveur n'arrivera plus
const RESUMED = 150; // parole qui annule la réponse préparée : la personne n'avait pas fini
// Couper la parole, en deux temps : un « mm-hm » ne dure pas assez pour arrêter l'agent, mais on baisse sa voix tout de suite.
const BARGE_LEVEL = 0.05; // niveau de voix par-dessus l'agent
const BARGE_LOWER = 100; // parole continue qui baisse sa voix
const BARGE_STOP = 600; // parole continue qui l'arrête : plus long qu'un mot bref
const BARGE_GAP = 150; // creux toléré entre deux syllabes ; au-delà, c'était un mot bref : sa voix remonte
const LOWERED = 0.1; // volume pendant le doute

type Tick = { rms: number; speech: number; silence: number; age: number };

/**
 * Micro ouvert en continu. `speech` : temps de voix dans le morceau en cours ; `silence` : silence continu jusqu'ici.
 * `cut()` ferme le morceau en cours et en ouvre un autre aussitôt, sans perdre de son.
 */
function useMic() {
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; timer: number; rec: { r: MediaRecorder; chunks: Blob[] } | null } | null>(null);
  const seg = useRef({ speech: 0, silence: 0, age: 0 });
  const level = useRef(0);
  const onTick = useRef<((t: Tick) => void) | null>(null);
  const onLost = useRef<(() => void) | null>(null);
  const opening = useRef(0);

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
    stream.getAudioTracks().forEach((t) => (t.onended = () => onLost.current?.()));
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
    const done = new Promise<void>((resolve) => (old.r.onstop = () => resolve()));
    if (old.r.state !== "inactive") old.r.stop();
    await done;
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
      // Deux transcriptions à la fois au plus (au-delà, le fournisseur répond 429). Le serveur passe déjà aux modèles de
      // secours : un refus de sa part a droit à trois essais, une coupure réseau attend le retour du réseau.
      const run = async () => {
        while (s.running >= 2) await new Promise((r) => setTimeout(r, 60));
        s.running++;
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              const text = await transcribe(blob, agentId);
              setError("");
              return text;
            } catch (e) {
              if (attempt >= (e instanceof ApiError ? 2 : NETWORK_TRIES - 1)) throw e;
              if (attempt >= 2) setError("Réseau coupé : ce que tu as dit partira dès son retour.");
              await new Promise((r) => setTimeout(r, Math.min(700 * (attempt + 1), 10_000)));
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
  /** Combien de morceaux restent à transcrire. */
  const inFlight = useCallback(() => state.current.inflight.size, []);
  /** Attend que tout ce qui a été dit soit transcrit. */
  const settle = useCallback(async () => {
    while (state.current.inflight.size) await Promise.all([...state.current.inflight]);
  }, []);
  return { submit, settle, inFlight, pending, error, setError };
}

/** La réponse s'est arrêtée sur une coupure : voir useAgentChat, qui recharge la conversation au retour du serveur. */
function isCutOff(m: { content: readonly { type: string; toolName?: string; args?: unknown }[] } | undefined) {
  return !!m?.content.some((p) => p.type === "tool-call" && p.toolName === "error" && String((p.args as { message?: unknown })?.message).startsWith("Connexion au serveur perdue"));
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
    .replace(/\s*\((?:demande\s+)?(?=[0-9a-f]*\d)[0-9a-f]{8,}\)/gi, "") // un identifiant interne ne se dit pas à voix haute
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
/** Réponse préparée en silence : on l'entend avec `speak`, ou on l'abandonne avec `drop`. */
type Held = { text: string; speak: () => Promise<VoiceReply>; drop: () => void };

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
    (id: string, ready?: HTMLAudioElement) =>
      new Promise<void>((resolve) => {
        stop.current?.();
        current.current?.pause();
        const a = ready ?? new Audio(`/api/voice/audio/${id}`);
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
          // « playing » revient après chaque manque de données : seul le premier compte.
          if (over || heard) return;
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
  /** Prépare une réponse sans la faire entendre : le son arrive dans l'élément, qui n'est pas lancé. */
  const hold = useCallback(
    (text: string, history: unknown[]): Held => {
      const id = audioId();
      const answer = send<VoiceReply>("/api/voice/reply", { agent_id: agentId, text, history, audio_id: id });
      answer.catch(() => {}); // lue par speak ; une réponse abandonnée n'intéresse personne
      const element = new Audio(`/api/voice/audio/${id}`);
      return {
        text,
        speak: async () => {
          const heard = play(id, element);
          try {
            const r = await answer;
            await heard;
            return r;
          } catch (e) {
            current.current?.pause();
            throw e;
          }
        },
        drop: () => {
          element.removeAttribute("src");
          element.load();
          send(`/api/voice/cancel/${id}`, {}).catch(() => {});
        },
      };
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
  /** Baisse ou remet la voix en cours, sans perdre ce qu'elle dit. */
  const lower = useCallback((on: boolean) => {
    if (current.current) current.current.volume = on ? LOWERED : 1;
  }, []);
  return { speak, reply, hold, cancel, lower };
}

/**
 * Silence qui marque la fin d'un tour, selon la fin de ce qui a été dit. Le transcripteur met souvent un point
 * à une phrase coupée (« j'ai une question. ») : seul le point d'interrogation conclut plus vite. Cette attente
 * ne s'ajoute pas au temps de réponse : la réponse se prépare pendant ce temps, à partir de TURN_PAUSE.
 */
function endOfTurnDelay(text: string) {
  const t = text.trim().toLowerCase();
  if (/\?$/.test(t)) return 1000;
  if (/[.!…]$/.test(t)) return 2300;
  if (/(,|;|:|\b(et|mais|donc|alors|ou|parce que|que|qui|de|du|des|le|la|les|un|une|pour|avec|sur|dans|euh|ben|genre|comme|si|quand))$/.test(t)) return 2500;
  return 2300;
}

/**
 * Mode vocal. Le micro écoute en continu : on peut parler pendant que l'agent parle (il se tait et écoute), et
 * faire de courtes pauses sans qu'il prenne la parole. Une voix rapide répond tout de suite pendant que l'agent
 * fait le travail avec son cerveau et ses outils ; à la fin, elle résume son résultat. Tout reste écrit dans la
 * conversation. `report` : compte rendu d'un rappel pris, lu dès que le micro est prêt.
 */
export function VoiceMode({ onClose, report, onReportRead, link }: {
  onClose: () => void;
  link: (text: string) => string;
  report?: { id: string; text: string } | null;
  onReportRead?: () => void;
}) {
  const { agentId, agentName, agentColor, say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const messages = useAuiState((s) => s.thread.messages);
  const mic = useMic();
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const busy = useRef(false); // un tour est en cours : on attend la fin du run de l'agent
  const started = useRef(false);
  const action = useRef(false);
  const answering = useRef<Promise<boolean> | null>(null); // la voix rapide parle encore : son tri n'est connu qu'à la fin de sa phrase
  const queue = useRef<{ text: string; action: boolean }[]>([]);
  const heard = useRef<string[]>([]); // ce que la personne a dit depuis le dernier tour envoyé
  const playing = useRef(false);
  const loud = useRef(0);
  const gap = useRef(0);
  const committing = useRef(false);
  const micReady = useRef<Promise<void> | null>(null);
  const reportSaid = useRef<string | null>(null);
  const voiceHeard = useRef(0);
  const held = useRef<Held | null>(null); // réponse préparée, pas encore confirmée
  const cutting = useRef(0); // morceaux coupés, pas encore partis à la transcription
  const cutOff = useRef<number | null>(null); // connexion perdue pendant un tour : l'agent continue, le résultat viendra au retour
  const lastSaid = useRef(""); // le tour parti à l'agent, à renvoyer si le serveur ne l'a jamais reçu

  const t = useTranscripts(agentId, (text) => {
    heard.current.push(text);
    setLive(heard.current.join(" "));
  });

  const { speak, reply: speakReply, hold, cancel, lower } = useSpeaker(agentId, (on, interrupted) => {
    loud.current = 0;
    gap.current = 0;
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

  const priorTurns = () => [...history(), ...queue.current.map((q) => ({ role: "user", text: q.text }))];
  const dropHeld = () => {
    held.current?.drop();
    held.current = null;
  };

  /** La voix rapide répond tout de suite ; rend `true` si la demande demande à l'agent d'agir. */
  const answer = async (text: string, ready: Held | null) => {
    try {
      if (ready) return (await ready.speak()).action;
      return (await speakReply({ text, history: priorTurns() })).action;
    } catch {
      return true; // pas de voix rapide : on attendra le résultat de l'agent
    }
  };

  /** Un tour : le message part à l'agent et, en même temps, la voix rapide répond. */
  const turn = async (text: string, ready: Held | null) => {
    if (busy.current) {
      // L'agent travaille encore : la voix rapide répond quand même, et l'agent reçoit la suite dès qu'il a fini.
      const item = { text, action: true };
      queue.current.push(item);
      setNote(`Je lui transmets ensuite : « ${text.slice(0, 60)} »`);
      item.action = await answer(text, ready);
      return;
    }
    busy.current = true;
    started.current = false;
    lastSaid.current = text;
    say(text);
    answering.current = answer(text, ready);
    action.current = await answering.current;
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
    // La réponse préparée ne vaut que pour exactement ce qui a été dit.
    const ready = held.current?.text === text ? held.current : null;
    if (ready) held.current = null;
    else dropHeld();
    if (text && alive.current) await turn(text, ready);
  };

  mic.onLost.current = () => {
    mic.close();
    setMuted(false);
    micReady.current = openMic();
  };

  mic.onTick.current = ({ rms, speech, silence, age }) => {
    if (playing.current) {
      // Interruption : sa voix baisse dès que la personne parle, et il se tait si elle continue. Un mot bref : elle remonte.
      if (rms > BARGE_LEVEL) {
        loud.current += TICK;
        gap.current = 0;
      } else if ((gap.current += TICK) >= BARGE_GAP && loud.current) {
        loud.current = 0;
        lower(false);
      }
      if (loud.current >= BARGE_STOP) cancel();
      else if (loud.current >= BARGE_LOWER) lower(true);
      return;
    }
    // La personne reprend : la réponse préparée n'a plus d'objet.
    if (held.current && speech >= RESUMED) dropHeld();
    // Un long silence ne contient rien : ni à garder en mémoire, ni à envoyer entier avec la prochaine phrase.
    if (speech < 250 && silence >= TURN_PAUSE && age >= QUIET_RENEW) {
      void mic.cut();
      return;
    }
    // Petite pause : ce morceau part à la transcription, la personne peut continuer.
    if (speech >= 250 && (silence >= TURN_PAUSE || age >= SEGMENT_MAX)) {
      cutting.current++;
      void mic.cut().then(({ blob }) => {
        cutting.current--;
        if (blob) t.submit(blob);
      });
      return;
    }
    const said = heard.current.join(" ");
    // Tout est transcrit et la personne se tait : on prépare la réponse, sans la faire entendre.
    if (said && !held.current && !committing.current && speech < RESUMED && silence >= TURN_PAUSE && !cutting.current && !t.inFlight()) {
      held.current = hold(said.trim(), priorTurns());
    }
    // Fin du tour : silence assez long pour ce qui a été dit, et plus rien en train d'être dit.
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
      dropHeld();
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
  const finished = (result: string) => {
    busy.current = false;
    started.current = false;
    cutOff.current = null;
    void (async () => {
      // Un agent rapide finit pendant l'accusé de réception : son résultat attend la fin de la phrase, et le tri de ce tour-ci.
      if (answering.current) action.current = await answering.current;
      answering.current = null;
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
        lastSaid.current = waiting.map((q) => q.text).join("\n");
        say(lastSaid.current);
      }
    })();
  };

  useEffect(() => {
    if (!busy.current) return;
    if (running) {
      started.current = true;
      return;
    }
    if (!started.current) return;
    const last = messages[messages.length - 1];
    // Connexion perdue : le tour reste ouvert, ce qui est dit d'ici là attend, et le résultat sera lu à son arrivée.
    if (isCutOff(last)) {
      cutOff.current = Date.now();
      setNote(`Connexion perdue : ${agentName} continue de son côté, je te lis la suite dès son retour.`);
      return;
    }
    finished(last?.role === "assistant" ? textOf(last) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    if (cutOff.current === null) return;
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || isCutOff(last)) return;
    // Le serveur revenu n'a pas ce tour : la coupure l'a perdu avant son arrivée, il repart. Sinon, c'est sa réponse.
    const before = messages[messages.length - 2];
    if (before?.role === "user" && textOf(before).includes(lastSaid.current)) finished(textOf(last));
    else {
      cutOff.current = null;
      started.current = false;
      setNote("");
      say(lastSaid.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Rien ne revient jamais (serveur perdu) : l'appel ne reste pas bloqué sur ce tour.
  useEffect(() => {
    const timer = setInterval(() => {
      if (cutOff.current !== null && Date.now() - cutOff.current > LOST_WAIT) {
        setNote("");
        finished("");
      }
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dans un navigateur, l'écran qui s'éteint coupe le micro. L'application Android, elle, tient l'appel écran éteint.
  useEffect(() => {
    if (appShell()?.kind === "android" || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    let over = false;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      void navigator.wakeLock.request("screen").then((l) => {
        if (over) void l.release();
        else lock = l;
      }, () => {});
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      over = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, []);

  // Android garde l'appel vivant hors de l'application ; sa notification et sa fenêtre flottante peuvent raccrocher.
  const hangUp = useRef(onClose);
  hangUp.current = onClose;
  useEffect(() => {
    const leave = () => hangUp.current();
    window.addEventListener("noah:raccrocher", leave);
    nativeCall(true, agentName, agentColor);
    return () => {
      window.removeEventListener("noah:raccrocher", leave);
      nativeCall(false, agentName, agentColor);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // L'appel s'ouvre : l'agent prépare ce qu'il devra savoir sans le chercher, et la durée commence.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    void send("/api/voice/prepare", { agent_id: agentId }).catch(() => {});
    const begun = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - begun) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [agentId]);

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
    : note || t.error ||
      (phase === "speaking" ? "Parle pour l'interrompre." : phase === "error" ? "Vérifie l'accès au micro." : "Parle naturellement, j'envoie quand tu as fini.");

  return (
    <CallStage
      phase={phase}
      status={words[phase]}
      hint={hint}
      seconds={seconds}
      busy={running || busy.current}
      needsYou={!!asked}
      muted={muted}
      level={<Level level={mic.level} />}
      messages={messages}
      link={link}
      extra={
        <>
          {(phase === "sending" || t.pending > 0) && <Loader2 className="size-5 animate-spin text-accent" />}
          {(phase === "listening" || phase === "waiting") && (live || t.pending > 0) && (
            <Button variant="outline" onClick={() => commit(true)}>Envoyer</Button>
          )}
          {phase === "error" && <Button variant="outline" onClick={openMic}>Réessayer</Button>}
        </>
      }
      onMute={() => {
        mic.mute(!muted);
        setMuted(!muted);
      }}
      onInterrupt={() => {
        cancel();
        void mic.cut(); // ce morceau ne contient que la voix de l'agent
      }}
      onHangUp={onClose}
    />
  );
}
