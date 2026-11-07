// « De lui-même » : ce qu'un agent regarde sans qu'on le lui demande, et ce qu'il a le droit d'en faire (server/noah/proactif.py).
import { Loader2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { get, type ProactiveMode, type ProactiveState, send } from "@/lib/api";
import { cn, money } from "@/lib/utils";
import { Section } from "./AgentPowers";
import { Button, ErrorText } from "./ui";

const MODES: [ProactiveMode, string, string][] = [
  ["coupe", "Rien", "Il attend que tu lui parles. Tes routines et tes veilles continuent."],
  ["signaler", "Me prévenir", "Il regarde ce qu'il peut lire et tes objectifs. Il prépare et te propose, sans rien changer dehors."],
  ["agir", "Agir et me prévenir", "Il s'en occupe et te dit ce qu'il a fait. Les droits de tes connexions et les accords restent valables."],
];
const EVERY: [number, string][] = [[15, "Toutes les 15 min"], [30, "Toutes les 30 min"], [60, "Toutes les heures"], [120, "Toutes les 2 h"], [180, "Toutes les 3 h"], [360, "Toutes les 6 h"]];
const OUTCOME: Record<string, string> = {
  rien_de_neuf: "Rien de neuf : rien n'a coûté.",
  rien: "Du nouveau, mais rien d'important.",
  signale: "Il t'a écrit dans la conversation.",
  tour: "Il s'en occupe dans un fil. Le compte rendu arrivera dans la conversation.",
  propose: "Il t'a proposé une idée dans la conversation.",
  deja: "Il regarde déjà.",
  erreur: "Ce passage n'a pas abouti.",
};

const last = (t: number | null) => {
  if (!t) return "";
  const d = new Date(t * 1000);
  const today = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
  return today ? `aujourd'hui à ${time}` : `${d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" })} à ${time}`;
};

export function Proactive({ agentId }: { agentId: string }) {
  const path = `/api/agents/${agentId}/proactif`;
  const [state, setState] = useState<{ agent: string; value: ProactiveState } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [told, setTold] = useState("");
  const s = state?.agent === agentId ? state.value : null; // jamais le réglage d'un autre agent, même le temps de charger

  useEffect(() => {
    let current = true;
    setError("");
    setTold("");
    get<ProactiveState>(path).then((value) => current && setState({ agent: agentId, value })).catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
  }, [agentId, path]);

  const change = async (body: { mode?: ProactiveMode; minutes?: number }) => {
    setError("");
    setTold("");
    try {
      setState({ agent: agentId, value: await send<ProactiveState>(path, body, "PUT") });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const look = async () => {
    setBusy(true);
    setError("");
    setTold("");
    try {
      const r = await send<{ etat: string; raison?: string }>(`${path}/passer`, {});
      setTold(r.raison ? `Pas maintenant : ${r.raison}.` : OUTCOME[r.etat] ?? "");
      setState({ agent: agentId, value: await get<ProactiveState>(path) });
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
          <div role="radiogroup" aria-label="Ce qu'il fait de lui-même" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
            {MODES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={s.mode === id}
                disabled={!s.modifiable}
                onClick={() => s.mode !== id && change({ mode: id })}
                className={cn("min-h-9 cursor-pointer rounded-lg px-1.5 py-1 text-center text-xs font-medium disabled:cursor-default", s.mode === id ? "bg-surface shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{MODES.find(([id]) => id === s.mode)?.[2]}</p>
          {!s.modifiable && <p className="text-xs text-muted-foreground">Seul son propriétaire règle ceci.</p>}
          {s.mode !== "coupe" && (
            <>
              <select value={s.minutes} disabled={!s.modifiable} onChange={(e) => change({ minutes: Number(e.target.value) })} aria-label="À quelle fréquence il regarde" className="h-9 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm">
                {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">
                {s.sources.length ? `Il regarde : ${s.sources.join(", ")}.` : "Rien à lire pour l'instant : relie Google dans Connexions, ou ajoute une veille."}
                {s.objectifs > 0 ? ` ${s.objectifs} objectif${s.objectifs > 1 ? "s" : ""} en tête.` : " Aucun objectif écrit."}
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
