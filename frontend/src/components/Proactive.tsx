// « De lui-même » : ce qu'un agent regarde sans qu'on le lui demande, et ce qu'il a le droit d'en faire (server/noah/proactif.py).
import { Loader2, Zap } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { langue, locale, t, tr, tServeur } from "@/i18n";
import { get, type ProactiveChange, type ProactiveMode, type ProactiveState, send } from "@/lib/api";
import { SeenActive } from "@/lib/seen";
import { useAgentData } from "@/lib/useAgentData";
import { cn, money } from "@/lib/utils";
import { Section } from "./AgentPowers";
import { Button, ErrorText } from "./ui";

const MODES: [ProactiveMode, string, string][] = [
  ["coupe", t("Rien"), t("Il attend que tu lui parles.")],
  ["signaler", t("Me signaler"), t("Il te propose des choses à faire. Tu choisis.")],
  ["agir", t("Agir et me dire"), t("Il agit, puis te dit quoi.")],
];
const EVERY: [number, string][] = [[15, t("Toutes les 15 min")], [30, t("Toutes les 30 min")], [60, t("Toutes les heures")], [120, t("Toutes les 2 h")], [180, t("Toutes les 3 h")], [360, t("Toutes les 6 h")]];
const STARTS = Array.from({ length: 24 }, (_, h) => h); // 0 h à 23 h
const ENDS = Array.from({ length: 24 }, (_, h) => h + 1); // 1 h à minuit, comme le serveur (1 à 24)
const hourName = (h: number) => (h === 24 ? t("minuit") : t("{h} h", { h }));
const ORDER = t("L'heure de fin vient après l'heure de début.");
const MAX = Array.from({ length: 7 }, (_, n) => n);
const DEFAULT_HOURS = { de: 8, a: 21 };
const DEFAULT_MAX = 3;
const OUTCOME: Record<string, string> = {
  rien_de_neuf: t("Rien de neuf : rien n'a coûté."),
  rien: t("Du nouveau, mais rien d'important."),
  signale: t("Il t'a écrit dans la conversation."),
  tour: t("Il s'en occupe. Compte rendu dans la conversation."),
  propose: t("Il t'a proposé une idée dans la conversation."),
  deja: t("Il regarde déjà."),
  erreur: t("Ce passage n'a pas abouti."),
};
const select = "h-10 cursor-pointer rounded-lg border border-border bg-background px-2 text-sm disabled:cursor-default";

const last = (when: number | null) => {
  if (!when) return "";
  const d = new Date(when * 1000);
  const today = d.toDateString() === new Date().toDateString();
  const lieu = langue() === "fr" ? "fr-CA" : locale(); // fr-CA : « 14 h 05 »
  const time = d.toLocaleTimeString(lieu, { hour: "2-digit", minute: "2-digit" });
  return today ? t("aujourd'hui à {heure}", { heure: time }) : t("{date} à {heure}", { date: d.toLocaleDateString(lieu, { day: "numeric", month: "short" }), heure: time });
};

/** Sans source, il propose quand même à partir de son rôle ; une source lui donne de quoi faire mieux. */
const sourcesLine = (s: ProactiveState) =>
  (s.sources.length ? t("Il regarde : {sources}.", { sources: s.sources.join(", ") }) : t("Il te propose des idées à partir de son rôle. Relie Google ou ajoute une veille : ses idées seront plus justes."))
  + (s.objectifs > 0 ? " " + (s.objectifs > 1 ? t("{n} objectifs en tête.", { n: s.objectifs }) : t("{n} objectif en tête.", { n: s.objectifs })) : "");

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
      <div role="radiogroup" aria-label={t("Ce qu'il fait de lui-même")} className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
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
      {!s.modifiable && <p className="text-xs text-muted-foreground">{t("Seul son propriétaire règle ceci.")}</p>}
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
        {tr("Il peut t'écrire de {debut} à {fin}", {
          debut: (
            <select value={hours.de} disabled={!s.modifiable} onChange={(e) => setHours(Number(e.target.value), hours.a)} aria-label={t("À partir de quelle heure")} className={select}>
              {STARTS.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
            </select>
          ),
          fin: (
            <select value={hours.a} disabled={!s.modifiable} onChange={(e) => setHours(hours.de, Number(e.target.value))} aria-label={t("Jusqu'à quelle heure")} className={select}>
              {ENDS.map((h) => <option key={h} value={h}>{hourName(h)}</option>)}
            </select>
          ),
        })}
      </p>
      {wrong && <p role="alert" className="text-xs text-warn">{wrong}</p>}
      <p className="flex flex-wrap items-center gap-1.5">
        {(() => {
          const nombre = (
            <select value={max} disabled={!s.modifiable} onChange={(e) => change({ propositions_max: Number(e.target.value) })} aria-label={t("Propositions par jour, au plus")} className={select}>
              {MAX.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          );
          return max > 1 ? tr("Au plus {nombre} propositions par jour", { nombre }) : tr("Au plus {nombre} proposition par jour", { nombre });
        })()}
      </p>
    </div>
  );
}

/** Le réglage en bref, là où on regarde l'agent : mode, heures, plafond. Le détail reste dans Routines. */
export function ProactiveQuick({ agentId }: { agentId: string }) {
  const { data: s, error, change } = useProactive(agentId);
  return (
    <section aria-labelledby={`proactif-${agentId}`} className="flex flex-col gap-2.5 rounded-2xl bg-surface p-3.5">
      <h3 id={`proactif-${agentId}`} className="text-sm font-semibold">{t("Quand tu ne lui parles pas")}</h3>
      {!s && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
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
      setTold(r.raison ? t("Pas maintenant : {raison}.", { raison: tServeur(r.raison) }) : OUTCOME[r.etat] ?? "");
      setState(await get<ProactiveState>(path));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("Quand tu ne lui parles pas")} defaultOpen>
      {!s && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>}
      {s && (
        <>
          <ModeChoice s={s} change={change} />
          {s.mode !== "coupe" && (
            <>
              <select value={s.minutes} disabled={!s.modifiable} onChange={(e) => change({ minutes: Number(e.target.value) })} aria-label={t("À quelle fréquence il regarde")} className={select}>
                {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <HoursAndMax s={s} change={change} />
              <p className="text-xs text-muted-foreground">
                {sourcesLine(s)}
                {s.objectifs > 0 ? "" : " " + t("Aucun objectif écrit.")}
              </p>
              {s.dernier_passage && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t("Vu {quand}.", { quand: last(s.dernier_passage) })}{" "}
                  {[
                    s.passages > 1 ? t("{n} passages", { n: s.passages }) : t("{n} passage", { n: s.passages }),
                    s.signalements > 1 ? t("{n} messages", { n: s.signalements }) : t("{n} message", { n: s.signalements }),
                    s.tours_du_jour > 1 ? t("{n} tours sur {max} aujourd'hui", { n: s.tours_du_jour, max: s.tours_max }) : t("{n} tour sur {max} aujourd'hui", { n: s.tours_du_jour, max: s.tours_max }),
                    s.cout > 0 && s.cout < 0.01 ? t("moins de 0,01 $") : t("{montant} $", { montant: money(s.cout) }),
                  ].join(", ")}.
                </p>
              )}
              {s.erreur && <p className="text-xs text-warn">{s.erreur}</p>}
              {s.modifiable && (
                <Button size="sm" variant="ghost" className="self-start" disabled={busy || s.en_cours} onClick={look}>
                  {busy ? <Loader2 className="animate-spin" /> : <Zap />}{s.en_cours ? t("Il travaille…") : t("Regarder maintenant")}
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
