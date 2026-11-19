// Mode vocal (appel avec l'agent) : chargé seulement quand la personne le lance (budget B2, 0.4.0). La dictée reste dans Voice.tsx.
import { useAuiState } from "@assistant-ui/react";
import { Loader2 } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AgentContext } from "@/lib/agentContext";
import { request, send, voiceRefusal } from "@/lib/api";
import { appShell, nativeCall } from "@/lib/platform";
import { CallStage } from "./CallStage";
import { Button } from "./ui";
import { t } from "@/i18n";
import { Level, MIC_REFUSED, TICK, useMic, useTranscripts } from "./Voice";

const TURN_PAUSE = 500; // en mode vocal : le morceau part, et la réponse se prépare en silence
// Un appel dure des heures : aucun morceau ne doit grandir sans fin, le serveur en refuse au-delà de 20 Mo.
const QUIET_RENEW = 30_000; // morceau sans voix depuis ce temps : on le jette et on en ouvre un autre
const SEGMENT_MAX = 60_000; // parole ou bruit sans aucune pause : le morceau part quand même
const LOST_WAIT = 600_000; // comme useAgentChat : au-delà, la réponse perdue avec le serveur n'arrivera plus
const RESUMED = 150; // parole qui annule la réponse préparée : la personne n'avait pas fini
// Couper la parole, en deux temps : un « mm-hm » ne dure pas assez pour arrêter l'agent, mais on baisse sa voix tout de suite.
const BARGE_LEVEL = 0.05; // niveau de voix par-dessus l'agent
const BARGE_LOWER = 100; // parole continue qui baisse sa voix
const BARGE_STOP = 600; // parole continue qui l'arrête : plus long qu'un mot bref
const BARGE_GAP = 150; // creux toléré entre deux syllabes ; au-delà, c'était un mot bref : sa voix remonte
const LOWERED = 0.1; // volume pendant le doute

/** Le tour s'est fini sur cette erreur. */
function failureOf(m: { content: readonly { type: string; toolName?: string; args?: unknown }[] } | undefined) {
  const part = m?.content.find((p) => p.type === "tool-call" && p.toolName === "error");
  return part ? String((part.args as { message?: unknown })?.message ?? "") : "";
}

/** Une coupure, et non un échec : voir useAgentChat, qui recharge la conversation au retour du serveur. */
const isCutOff = (m: Parameters<typeof failureOf>[0]) => failureOf(m).startsWith(t("Connexion au serveur perdue. La réponse s'affichera dès son retour."));

/** Ce qu'on lit à voix haute : le texte de la réponse, sans widgets, code ni mise en forme. */
function spoken(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/MEDIA:\S+/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>`|]/g, "")
    .replace(/\/opt\/data\/\S+/g, t("le fichier"))
    .replace(/\s*\((?:demande\s+)?(?=[0-9a-f]*\d)[0-9a-f]{8,}\)/gi, "") // un identifiant interne ne se dit pas à voix haute
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

// --- Voix de l'agent -----------------------------------------------------------------------

/** Identifiant d'un flux audio (crypto.randomUUID n'existe qu'en HTTPS ; getRandomValues partout). */
const audioId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

type VoiceReply = { dire: string; action: boolean };
/** Dit pendant que l'agent travaille. `sorting` : le serveur est en train de dire si c'est une précision pour le travail en cours. */
type Waiting = { text: string; action: boolean; id: string; sorting?: Promise<void> };
/** Réponse préparée en silence : on l'entend avec `speak`, ou on l'abandonne avec `drop`. */
type Held = { text: string; speak: () => Promise<VoiceReply>; drop: () => void };

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
        // Une session de fenêtre expirée refuse ce son, alors que la requête qui l'a demandé vient de la renouveler : un seul nouvel essai.
        let retried = false;
        a.onerror = () => {
          if (retried || heard || over) return end(false);
          retried = true;
          void request("/api/me")
            .catch(() => {})
            .then(() => {
              if (over) return;
              a.src = `/api/voice/audio/${id}`;
              a.load();
              a.play().catch(() => end(false));
            });
        };
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
  if (/\?$/.test(t)) return 800;
  if (/[.!…]$/.test(t)) return 1600;
  if (/(,|;|:|\b(et|mais|donc|alors|ou|parce que|que|qui|de|du|des|le|la|les|un|une|pour|avec|sur|dans|euh|ben|genre|comme|si|quand))$/.test(t)) return 2300;
  return 1900;
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
  const { agentId, agentName, agentColor, agentShape, agentDetail, conversationId, say } = useContext(AgentContext);
  const running = useAuiState((s) => s.thread.isRunning);
  const allMessages = useAuiState((s) => s.thread.messages);
  const messages = useMemo(() => allMessages.filter((m) => !m.content.some((p) => p.type === "tool-call" && (p.toolName === "trace" || p.toolName === "tache"))), [allMessages]);
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
  const queue = useRef<Waiting[]>([]);
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
  const lastId = useRef(""); // son identifiant : renvoyé, le serveur le reconnaît s'il l'avait reçu
  const alikeBefore = useRef(0); // combien de messages disaient déjà la même chose : « Continue » peut se répéter
  const runningNow = useRef(running);
  runningNow.current = running;

  const tx = useTranscripts(agentId, (text) => {
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
  const alike = (text: string) => latest.current.filter((m) => m.role === "user" && textOf(m).includes(text)).length;
  const sendTurn = (text: string) => {
    lastSaid.current = text;
    lastId.current = audioId();
    alikeBefore.current = alike(text);
    say(text, lastId.current);
  };
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

  /** Une précision n'attend pas la fin de ce qu'elle corrige. Le serveur trie comme pour un message écrit ; une demande à la suite
   * reste ici, où l'appel lira son résultat. Même identifiant à chaque essai : une seule précision. */
  const sortOut = async (item: Waiting) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500));
      const body = { agent_id: agentId, conversation_id: conversationId, client_id: item.id, text: item.text, garder: true };
      const sorted = await send<{ type: string }>("/api/chat/pendant", body).catch(() => null);
      if (!sorted) continue;
      if (sorted.type !== "tache") {
        queue.current = queue.current.filter((q) => q !== item);
        setNote(t("C'est transmis : « {texte} »", { texte: item.text.slice(0, 60) }));
      }
      return;
    }
  };

  /** Un tour : le message part à l'agent et, en même temps, la voix rapide répond. */
  const turn = async (text: string, ready: Held | null) => {
    if (busy.current || runningNow.current) {
      // L'agent travaille encore, parti de la voix ou du clavier : la voix rapide répond quand même, et il reçoit la suite dès qu'il a fini.
      if (!busy.current) {
        busy.current = true;
        started.current = true;
        action.current = false;
        lastSaid.current = "";
      }
      const item: Waiting = { text, action: true, id: audioId() };
      queue.current.push(item);
      setNote(t("Je lui transmets ensuite : « {texte} »", { texte: text.slice(0, 60) }));
      item.action = await answer(text, ready);
      if (item.action && runningNow.current && queue.current.includes(item)) item.sorting = sortOut(item);
      return;
    }
    busy.current = true;
    started.current = false;
    sendTurn(text);
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
      if (blob && speech >= 150) tx.submit(blob);
    }
    await tx.settle();
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
    // Ce qui venait d'être dit part quand même : seul le micro a changé. Pendant que l'agent parle, ce morceau contient surtout sa
    // voix : on le jette, comme à la fin de sa phrase.
    const echo = playing.current;
    void mic.cut(false).then(({ blob, speech }) => {
      mic.close();
      if (blob && speech >= 150 && !echo) tx.submit(blob);
      if (alive.current) micReady.current = openMic();
    });
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
        if (blob) tx.submit(blob);
      });
      return;
    }
    const said = heard.current.join(" ");
    // Tout est transcrit et la personne se tait : on prépare la réponse, sans la faire entendre.
    if (said && !held.current && !committing.current && speech < RESUMED && silence >= TURN_PAUSE && !cutting.current && !tx.inFlight()) {
      held.current = hold(said.trim(), priorTurns());
    }
    // Fin du tour : silence assez long pour ce qui a été dit, et plus rien en train d'être dit.
    if (!committing.current && speech < 150 && (said || tx.pending) && silence >= endOfTurnDelay(said)) void commit();
  };

  const openMic = async () => {
    setError("");
    const refusal = await voiceRefusal("call");
    if (refusal) return setError(refusal);
    try {
      await mic.open();
      if (alive.current) nativeCall(true, agentName, agentColor, agentShape, agentDetail); // Android refuse ce service tant que le micro n'est pas accordé
    } catch {
      setError(MIC_REFUSED);
    }
  };

  // On raccroche, ou la page se ferme, pendant que l'agent travaille : « Je lui transmets ensuite » reste vrai. Le serveur garde
  // ces demandes jusqu'à ce qu'il ait fini. Ce que la voix rapide a classé comme simple échange n'a pas à le relancer.
  const leaveRequests = () => {
    const waiting = queue.current.splice(0).filter((q) => q.action);
    if (!waiting.length) return;
    // Son identifiant à chacune : si son tri est encore en vol, le serveur la reconnaît et ne la fait pas partir deux fois.
    for (const q of waiting) {
      void request("/api/chat/ensuite", {
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ agent_id: agentId, conversation_id: conversationId, client_id: q.id, text: q.text }),
      }).catch(() => {});
    }
  };

  useEffect(() => {
    alive.current = true;
    micReady.current = openMic();
    window.addEventListener("pagehide", leaveRequests);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", leaveRequests);
      leaveRequests();
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
      if (alive.current && voiceHeard.current === before) setNote(t("La voix n'a pas pu lire le compte rendu : il est écrit dans la conversation."));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  // Une action attend l'accord de la personne : on le dit à voix haute, une fois. L'accord se donne à l'écran, sur la carte
  // « À valider » : aucun mot entendu ne vaut « oui », une transcription peut se tromper (G11.7).
  const asked = (() => {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return null;
    const part = (last.content as readonly { type: string; toolName?: string; toolCallId?: string; result?: unknown; args?: { demande?: unknown } }[]).find(
      (p) => p.type === "tool-call" && p.toolName === "approval" && p.result === undefined,
    );
    return part ? { id: part.toolCallId ?? "", what: String(part.args?.demande ?? "") } : null;
  })();
  const askedSaid = useRef<string | null>(null);
  const askedId = asked?.id;
  useEffect(() => {
    if (!asked || askedSaid.current === asked.id) return;
    askedSaid.current = asked.id;
    void speak(t("J'ai besoin de ton accord avant d'agir. {demande}. Réponds à l'écran : Autoriser ou Refuser.", { demande: spoken(asked.what).slice(0, 160) })).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askedId]);

  // L'agent a fini : on lit le résumé de ce qu'il a fait (s'il a agi), puis la demande suivante part.
  const finished = (result: string, failed = false) => {
    busy.current = false;
    started.current = false;
    cutOff.current = null;
    void (async () => {
      // Un agent rapide finit pendant l'accusé de réception : son résultat attend la fin de la phrase, et le tri de ce tour-ci.
      if (answering.current) action.current = await answering.current;
      answering.current = null;
      if ((failed || action.current) && result.trim() && alive.current) {
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
      setNote(failed ? result : "");
      // Ce qui a été dit pendant qu'il travaillait part en un seul message ; la voix rapide y a déjà répondu.
      await Promise.all(queue.current.map((q) => q.sorting)); // une précision déjà transmise ne repart pas
      if (!alive.current) return;
      const waiting = queue.current.splice(0);
      if (waiting.length && alive.current) {
        busy.current = true;
        started.current = false;
        action.current = waiting.some((q) => q.action);
        sendTurn(waiting.map((q) => q.text).join("\n"));
      }
    })();
  };

  const conclude = (last: (typeof messages)[number] | undefined) => {
    // Un échec se dit : sinon l'appel resterait sur « Je t'écoute », comme si le travail se faisait.
    const failure = failureOf(last);
    if (failure) finished(t("{nom} n'a pas pu répondre. {erreur}", { nom: agentName, erreur: failure }), true);
    else finished(last?.role === "assistant" ? textOf(last) : "");
  };
  const resend = () => {
    if (runningNow.current) return; // il travaille : le serveur a reçu ce tour, sa réponse arrivera par le rechargement
    cutOff.current = null;
    started.current = false;
    setNote("");
    say(lastSaid.current, lastId.current);
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
      setNote(t("Connexion perdue : {nom} continue de son côté, je te lis la suite dès son retour.", { nom: agentName }));
      // Première phrase d'une conversation : aucun historique à relire, elle repart dès que le serveur répond.
      if (messages.length <= 2 && lastSaid.current) {
        const retry = setInterval(() => {
          if (!alive.current || cutOff.current === null) return clearInterval(retry);
          void request("/api/status").then(() => {
            clearInterval(retry);
            if (alive.current && cutOff.current !== null && isCutOff(latest.current[latest.current.length - 1])) resend();
          }, () => {});
        }, 4000);
      }
      return;
    }
    // Coupure en cours : sa réponse arrive par le rechargement, l'effet suivant la lira ; ici, ce fil n'est pas encore à jour.
    if (cutOff.current !== null) return;
    conclude(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    if (cutOff.current === null) return;
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant" || isCutOff(last)) return;
    // Le serveur revenu n'a pas ce tour : la coupure l'a perdu avant son arrivée, il repart. Sinon, c'est sa réponse.
    if (!lastSaid.current || alike(lastSaid.current) > alikeBefore.current) conclude(last);
    else resend();
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
    listening: t("Je t'écoute…"),
    sending: t("J'envoie…"),
    speaking: t("{nom} parle…", { nom: agentName }),
    waiting: asked ? t("{nom} attend ton accord, à l'écran", { nom: agentName }) : t("{nom} s'en occupe… tu peux continuer à parler", { nom: agentName }),
    error: error || t("Le mode vocal s'est arrêté."),
  };
  const hint = live
    ? t("« {texte} »", { texte: live.slice(-90) })
    : note || tx.error ||
      (phase === "speaking" ? t("Parle pour l'interrompre.") : phase === "error" ? (error === MIC_REFUSED ? t("Vérifie l'accès au micro.") : "") : t("Parle naturellement, j'envoie quand tu as fini."));

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
          {(phase === "sending" || tx.pending > 0) && <Loader2 className="size-5 animate-spin text-accent" />}
          {(phase === "listening" || phase === "waiting") && (live || tx.pending > 0) && (
            <Button variant="outline" onClick={() => commit(true)}>{t("Envoyer")}</Button>
          )}
          {phase === "error" && <Button variant="outline" onClick={openMic}>{t("Réessayer")}</Button>}
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
