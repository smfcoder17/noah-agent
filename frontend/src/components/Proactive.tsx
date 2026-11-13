// « De lui-même » : ce qu'un agent regarde sans qu'on le lui demande, et ce qu'il a le droit d'en faire (server/noah/proactif.py).
import { Loader2, Zap } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { get, type ProactiveChange, type ProactiveMode, type ProactiveState, send } from "@/lib/api";
import { SeenActive } from "@/lib/seen";
import { useAgentData } from "@/lib/useAgentData";
import { cn, money } from "@/lib/utils";
import { Section } from "./AgentPowers";
import { Button, ErrorText } from "./ui";

const MODES: [ProactiveMode, string, string][] = [
  ["coupe", "Rien", "Il attend que tu lui parles."],
  ["signaler", "Me signaler", "Il te propose des choses à faire. Tu choisis."],
  ["agir", "Agir et me dire", "Il agit, puis te dit quoi."],
];
const EVERY: [number, string][] = [[15, "Toutes les 15 min"], [30, "Toutes les 30 min"], [60, "Toutes les heures"], [120, "Toutes les 2 h"], [180, "Toutes les 3 h"], [360, "Toutes les 6 h"]];
const STARTS = Array.from({ length: 24 }, (_, h) => h); // 0 h à 23 h
const ENDS = Array.from({ length: 24 }, (_, h) => h + 1); // 1 h à minuit, comme le serveur (1 à 24)
const hourName = (h: number) => (h === 24 ? "minuit" : `${h} h`);
const ORDER = "L'heure de fin vient après l'heure de début.";
const MAX = Array.from({ length: 7 }, (_, n) => n);
const DEFAULT_HOURS = { de: 8, a: 21 };
const DEFAULT_MAX = 3;
const OUTCOME: Record<string, string> = {
  rien_de_neuf: "Rien de neuf : rien n'a coûté.",
  rien: "Du nouveau, mais rien d'important.",
  signale: "Il t'a écrit dans la conversation.",
  tour: "Il s'en occupe. Compte rendu dans la conversation.",
  propose: "Il t'a proposé une idée dans la conversation.",
  deja: "Il regarde déjà.",
  erreur: "Ce passage n'a pas abouti.",
};
const select = "h-10 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm disabled:cursor-default";

const last = (t: number | null) => {
  if (!t) return "";
  const d = new Date(t * 1000);
  const today = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
  return today ? `aujourd'hui à ${time}` : `${d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" })} à ${time}`;
};

/** Sans source, il propose quand même à partir de son rôle ; une source lui donne de quoi faire mieux. */
const sourcesLine = (s: ProactiveState) =>
  (s.sources.length ? `Il regarde : ${s.sources.join(", ")}.` : "Il te propose des idées à partir de son rôle. Relie Google ou ajoute une veille : ses idées seront plus justes.")
  + (s.objectifs > 0 ? ` ${s.objectifs} objectif${s.objectifs > 1 ? "s" : ""} en tête.` : "");

function useProactive(agentId: string) {
  const path = `/api/agents/${agentId}/proactif`;
  const data = useAgentData<ProactiveState>(path, { freshOnReload: false });
  const change = async (body: ProactiveChange) => {
    data.setError("");
    try {
      data.setData(await send<ProactiveState>(path, body, "PUT"));
    } catch (e) {
      data.setError((e as Error).message);
    }
  };
  return { path, ...data, change };
}

/** Les trois modes, en mots simples. */
function ModeChoice({ s, change }: { s: ProactiveState; change: (b: ProactiveChange) => void }) {
  return (
    <>
      <div role="radiogroup" aria-label="Ce qu'il fait de lui-même" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
        {MODES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={s.mode === id}
            disabled={!s.modifiable}
            onClick={() => s.mode !== id && change({ mode: id })}
            className={cn("min-h-10 cursor-pointer rounded-lg px-1.5 py-1 text-center text-xs font-medium disabled:cursor-default", s.mode === id ? "bg-surface shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{MODES.find(([id]) => id === s.mode)?.[2]}</p>
      {!s.modifiable && <p className="text-xs text-muted-foreground">Seul son propriétaire règle ceci.</p>}
    </>
  );
}

/** Ses heures et son plafond : il se tait hors de ces heures et au-delà du plafond. */
function HoursAndMax({ s, change }: { s: ProactiveState; change: (b: ProactiveChange) => void }) {
  const hours = s.heures ?? DEFAULT_HOURS;
  const max = s.propositions_max ?? DEFAULT_MAX;
  const [wrong, setWrong] = useState("");
  /** Le début avant la fin, comme le serveur l'exige : sinon rien ne part, et la phrase le dit. */
  const setHours = (de: number, a: number) => {
    if (de >= a) return setWrong(ORDER);
    setWrong("");
    change({ heures: { de, a } });
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="flex flex-wrap items-center gap-1.5">
        Il peut t'écrire de
        <select value={hours.de} disabled={!s.modifiable} onChange={(e) => setHours(Number(e.target.value), hours.a)} aria-label="À partir de quelle heure" className={select}>
          {STARTS.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
        </select>
        à
        <select value={hours.a} disabled={!s.modifiable} onChange={(e) => setHours(hours.de, Number(e.target.value))} aria-label="Jusqu'à quelle heure" className={select}>
          {ENDS.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
        </select>
      </p>
      {wrong && <p role="alert" className="text-xs text-warn">{wrong}</p>}
      <p className="flex flex-wrap items-center gap-1.5">
        Au plus
        <select value={max} disabled={!s.modifiable} onChange={(e) => change({ propositions_max: Number(e.target.value) })} aria-label="Propositions par jour, au plus" className={select}>
          {MAX.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {max > 1 ? "propositions" : "proposition"} par jour
      </p>
    </div>
  );
}

/** Le réglage en bref, là où on regarde l'agent : mode, heures, plafond. Le détail reste dans Routines. */
export function ProactiveQuick({ agentId }: { agentId: string }) {
  const { data: s, error, change } = useProactive(agentId);
  return (
    <section aria-labelledby={`proactif-${agentId}`} className="flex flex-col gap-2.5 rounded-2xl bg-surface p-3.5">
      <h3 id={`proactif-${agentId}`} className="text-sm font-semibold">Quand tu ne lui parles pas</h3>
      {!s && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {s && (
        <>
          <ModeChoice s={s} change={change} />
          {s.mode !== "coupe" && (
            <>
              <HoursAndMax s={s} change={change} />
              <p className="text-xs text-muted-foreground">{sourcesLine(s)}</p>
            </>
          )}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

export function Proactive({ agentId }: { agentId: string }) {
  const active = useContext(SeenActive);
  const { path, data: s, setData: setState, error, setError, change: save } = useProactive(agentId);
  const [busy, setBusy] = useState(false);
  const [told, setTold] = useState("");

  useEffect(() => {
    if (!active) return;
    setError("");
    setTold("");
  }, [path, active, setError]);

  const change = (body: ProactiveChange) => {
    setTold("");
    void save(body);
  };
  const look = async () => {
    setBusy(true);
    setError("");
    setTold("");
    try {
      const r = await send<{ etat: string; raison?: string }>(`${path}/passer`, {});
      setTold(r.raison ? `Pas maintenant : ${r.raison}.` : OUTCOME[r.etat] ?? "");
      setState(await get<ProactiveState>(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Quand tu ne lui parles pas" defaultOpen>
      {!s && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>}
      {s && (
        <>
          <ModeChoice s={s} change={change} />
          {s.mode !== "coupe" && (
            <>
              <select value={s.minutes} disabled={!s.modifiable} onChange={(e) => change({ minutes: Number(e.target.value) })} aria-label="À quelle fréquence il regarde" className={select}>
                {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <HoursAndMax s={s} change={change} />
              <p className="text-xs text-muted-foreground">
                {sourcesLine(s)}
                {s.objectifs > 0 ? "" : " Aucun objectif écrit."}
              </p>
              {s.dernier_passage && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  Vu {last(s.dernier_passage)}. {s.passages} passage{s.passages > 1 ? "s" : ""}, {s.signalements} message{s.signalements > 1 ? "s" : ""}, {s.tours_du_jour} tour{s.tours_du_jour > 1 ? "s" : ""} sur {s.tours_max} aujourd'hui, {s.cout > 0 && s.cout < 0.01 ? "moins de 0,01" : money(s.cout)} $.
                </p>
              )}
              {s.erreur && <p className="text-xs text-warn">{s.erreur}</p>}
              {s.modifiable && (
                <Button size="sm" variant="ghost" className="self-start" disabled={busy || s.en_cours} onClick={look}>
                  {busy ? <Loader2 className="animate-spin" /> : <Zap />}{s.en_cours ? "Il travaille…" : "Regarder maintenant"}
                </Button>
              )}
              {told && <p role="status" className="text-xs text-muted-foreground">{told}</p>}
            </>
          )}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Section>
  );
}
