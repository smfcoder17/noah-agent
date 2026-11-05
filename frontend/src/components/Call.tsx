// Écran d'appel : un agent fait sonner l'utilisateur pour lui donner un compte rendu à la voix.
// Il s'ouvre par l'adresse d'une notification (/#appel=<id>) ou quand le relevé voit un rappel qui sonne.
// Ce n'est pas le bandeau de Handoff.tsx, qui demande à l'utilisateur d'agir dans le navigateur.
import { Phone, PhoneOff, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { type Agent, ApiError, get, send, type VoiceCall } from "@/lib/api";
import { AgentFace, agentColor, type NoahHandle } from "./Noah";

export type CallReport = { id: string; agentId: string; text: string };

const OVER: Record<string, string> = { manque: "Appel manqué", refuse: "Appel refusé", repondu: "Appel déjà pris" };

/** Sonnerie courte synthétisée. Sans geste de l'utilisateur, le navigateur peut la garder muette : l'écran reste. */
function useRing(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const tone = (freq: number, at: number, length: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
      gain.gain.setValueAtTime(0.18, at + length - 0.04);
      gain.gain.linearRampToValueAtTime(0, at + length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + length);
    };
    const ring = () => {
      void ctx.resume().catch(() => {});
      navigator.vibrate?.([400, 200, 400]);
      if (ctx.state !== "running") return;
      const t = ctx.currentTime;
      for (const start of [0, 0.5]) {
        tone(660, t + start, 0.4);
        tone(880, t + start, 0.4);
      }
    };
    ring();
    const timer = setInterval(ring, 3000);
    return () => {
      clearInterval(timer);
      navigator.vibrate?.(0);
      void ctx.close().catch(() => {});
    };
  }, [on]);
}

export function CallScreen({ agents, onOpen }: { agents: Agent[]; onOpen: (report: CallReport) => void }) {
  const [call, setCall] = useState<VoiceCall | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closed = useRef(new Set<string>()); // un relevé parti avant la réponse ne rouvre pas l'écran
  const openReport = useRef(onOpen);
  openReport.current = onOpen;
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const ringing = call?.etat === "sonne";
  useRing(ringing);
  // Pendant que ça sonne, l'agent sautille pour attirer l'œil, au rythme des ondes.
  const faceRef = useRef<NoahHandle>(null);
  useEffect(() => {
    if (!ringing) return;
    faceRef.current?.react("hop");
    const timer = setInterval(() => faceRef.current?.react("hop"), 2400);
    return () => clearInterval(timer);
  }, [ringing]);

  // Adresse d'une notification : le rappel a pu finir de sonner depuis, on le dit au lieu de ne rien montrer.
  useEffect(() => {
    const fromAddress = async () => {
      const [, id, picked] = location.hash.match(/^#appel=([\w-]+)(&decroche)?/) ?? [];
      if (!id) return;
      history.replaceState(null, "", location.pathname);
      if (picked) {
        // Déjà décroché sur l'écran d'appel du téléphone : pas de seconde sonnerie.
        closed.current.add(id);
        const done = await send<VoiceCall>(`/api/calls/${id}/answer`, {}).catch(() => null);
        if (done) return openReport.current({ id: done.id, agentId: done.agent_id, text: done.texte });
      }
      const found = await get<VoiceCall>(`/api/calls/${id}`).catch(() => null);
      if (found) setCall(found);
    };
    void fromAddress();
    window.addEventListener("hashchange", fromAddress);
    return () => window.removeEventListener("hashchange", fromAddress);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      const r = await get<{ appels: VoiceCall[] }>("/api/calls/pending").catch(() => null);
      if (!alive || !r) return;
      setCall((cur) => {
        if (cur && cur.etat !== "sonne") return cur; // écran « appel manqué » : il reste jusqu'à ce qu'on le ferme
        if (cur && r.appels.some((a) => a.id === cur.id)) return cur;
        return r.appels.find((a) => !closed.current.has(a.id)) ?? null; // pris ailleurs ou fini : l'écran se ferme
      });
    };
    void poll();
    const timer = setInterval(poll, 4000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);

  // Le clavier arrive sur l'action principale, et retrouve sa place à la fermeture.
  const open = !!call;
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    first.current?.focus();
    return () => before?.focus?.();
  }, [open]);

  if (!call) return null;

  const close = () => {
    closed.current.add(call.id);
    setError("");
    setCall(null);
  };
  const listen = (c: VoiceCall) => {
    close();
    onOpen({ id: c.id, agentId: c.agent_id, text: c.texte });
  };
  const decide = async (action: "answer" | "decline") => {
    setBusy(true);
    setError("");
    try {
      const done = await send<VoiceCall>(`/api/calls/${call.id}/${action}`, {});
      if (action === "answer") listen(done);
      else close();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Il a fini de sonner entre-temps : on montre où il en est.
        setCall(await get<VoiceCall>(`/api/calls/${call.id}`).catch(() => null));
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (ringing) void decide("decline");
      else close();
    } else if (e.key === "Tab") {
      // Le focus reste dans l'écran d'appel.
      const items = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      const edge = e.shiftKey ? items[0] : items[items.length - 1];
      if (items.length && document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? items[items.length - 1] : items[0]).focus();
      }
    }
  };

  const agent = agents.find((a) => a.id === call.agent_id);
  const face = agent ?? { id: call.agent_id, color: call.couleur, shape: call.forme, detail: call.detail };
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`${baseId}-titre`}
      aria-describedby={`${baseId}-texte`}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-between gap-6 overflow-y-auto bg-background px-6 pt-[max(48px,env(safe-area-inset-top))] pb-[max(32px,env(safe-area-inset-bottom))] text-center"
    >
      <div className="flex min-h-0 w-full max-w-md flex-1 flex-col items-center gap-4">
        <p className="text-sm text-muted-foreground">{ringing ? "Appel vocal" : "Appel"}</p>
        <h1 id={`${baseId}-titre`} className="text-center text-2xl font-semibold">
          {ringing ? `${call.agent} t'appelle` : `${OVER[call.etat] ?? "Appel terminé"} : ${call.agent}`}
        </h1>
        <div className={`relative my-auto flex shrink-0 items-center justify-center ${ringing ? "noah-call-waves" : ""}`}>
          {ringing && [0, 1, 2].map((i) => <span key={i} aria-hidden="true" className="noah-call-wave" style={{ animationDelay: `${i * 0.8}s`, background: agentColor(face) }} />)}
          <AgentFace agent={face} handle={faceRef} state={ringing ? "listening" : "idle"} className="relative size-28" />
        </div>
        <p id={`${baseId}-texte`} className={`overflow-y-auto text-sm whitespace-pre-wrap text-muted-foreground ${ringing ? "sr-only" : "max-h-[40vh]"}`}>{call.texte}</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
      {ringing ? (
        <div className="flex w-full max-w-md items-start justify-center gap-16">
          <button type="button" disabled={busy} onClick={() => decide("decline")} className="flex flex-col items-center gap-2 text-sm disabled:opacity-50">
            <span className="flex size-[72px] items-center justify-center rounded-full bg-danger text-white"><PhoneOff className="size-7" /></span>
            Refuser
          </button>
          <button ref={first} type="button" disabled={busy} onClick={() => decide("answer")} className="flex flex-col items-center gap-2 text-sm disabled:opacity-50">
            <span className="noah-call-answer flex size-[72px] items-center justify-center rounded-full bg-[#22a565] text-white"><Phone className="size-7" /></span>
            Répondre
          </button>
        </div>
      ) : (
        <div className="flex w-full max-w-md gap-3">
          <Button ref={first} size="lg" className="flex-1" onClick={() => listen(call)}>
            <Phone />Écouter le compte rendu
          </Button>
          <Button size="lg" variant="outline" className="flex-1" onClick={close}>
            <X />Fermer
          </Button>
        </div>
      )}
    </div>
  );
}
