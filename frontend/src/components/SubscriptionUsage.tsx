import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { langue, t } from "@/i18n";
import { cn } from "@/lib/utils";

type Window = { id: string; pct: number | null; reset: number | null; etat: "permis" | "bientot" | "limite" };
export type Usage = { id: "claude" | "chatgpt" | "grok"; nom: string; offre: string; modele: string; mesure_le: number; tours: number; jetons: number; fenetres: Window[] };
type Answer = { en_ligne: boolean; abonnements: Usage[] };

/** Ce que la fenêtre mesure, dit comme la personne le dirait : « ta semaine Claude », « ton mois ChatGPT ». */
function windowName(p: Usage["id"], id: string): string {
  const minutes = /^minutes_(\d+)$/.exec(id);
  if (minutes) return t("ta fenêtre de {n} min", { n: minutes[1] });
  if (p === "claude") {
    if (id === "five_hour") return t("ta fenêtre de 5 h Claude");
    if (id === "seven_day") return t("ta semaine Claude");
    if (id === "seven_day_opus") return t("ta semaine Opus");
    if (id === "seven_day_sonnet") return t("ta semaine Sonnet");
  }
  if (p === "chatgpt") {
    if (id === "five_hour") return t("ta fenêtre de 5 h ChatGPT");
    if (id === "seven_day") return t("ta semaine ChatGPT");
    if (id === "thirty_day") return t("ton mois ChatGPT");
  }
  if (id === "five_hour") return t("ta fenêtre de 5 h");
  if (id === "seven_day") return t("ta semaine");
  if (id === "thirty_day") return t("ton mois");
  if (id === "abonnement") return t("ton abonnement");
  return id === "secondary" ? t("ta limite secondaire") : t("ta limite principale");
}

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(langue(), { weekday: "long", hour: "numeric", minute: "2-digit" });

/** « il y a 3 min » : la dernière mesure, dans la langue de l'interface. */
function ago(ms: number, now: number): string {
  const rtf = new Intl.RelativeTimeFormat(langue(), { numeric: "auto" });
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), "hour");
  return rtf.format(-Math.round(minutes / 1440), "day");
}

function Bar({ p, w }: { p: Usage["id"]; w: Window }) {
  const name = windowName(p, w.id);
  const pct = w.pct;
  const sentence = pct === null
    ? t("Limite atteinte sur {fenetre}", { fenetre: name })
    : w.reset ? t("{pct} % de {fenetre}, remise à zéro {quand}", { pct: Math.round(pct), fenetre: name, quand: when(w.reset) }) : t("{pct} % de {fenetre}", { pct: Math.round(pct), fenetre: name });
  return <div className="flex flex-col gap-1">
    <span className={cn("text-sm", w.etat === "limite" && "text-danger")}>{sentence}{w.etat === "limite" && pct !== null ? ` — ${t("limite atteinte")}` : w.etat === "bientot" ? ` — ${t("bientôt la limite")}` : ""}</span>
    <span role="meter" aria-label={name} aria-valuenow={Math.round(pct ?? 100)} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full", w.etat === "limite" ? "bg-danger" : w.etat === "bientot" || (pct ?? 100) >= 90 ? "bg-warn" : "bg-foreground/70")} style={{ width: `${pct ?? 100}%` }} />
    </span>
  </div>;
}

function Card({ u, now }: { u: Usage; now: number }) {
  return <div className="shell-row flex-col items-stretch gap-2" aria-label={u.nom}>
    <div className="flex flex-wrap items-baseline gap-x-2">
      <strong>{u.nom}</strong>
      {u.offre && <small className="text-muted-foreground text-[12.5px]">{t("offre {offre}", { offre: u.offre })}</small>}
      {u.modele && <small className="text-muted-foreground text-[12.5px]">{t("modèle {modele}", { modele: u.modele })}</small>}
    </div>
    {u.fenetres.map((w) => <Bar key={w.id} p={u.id} w={w} />)}
    {!u.fenetres.length && <p className="text-sm text-muted-foreground">{u.id === "grok"
      ? t("{n} tours comptés. xAI ne donne pas le reste : ni pourcentage, ni remise à zéro.", { n: u.tours })
      : t("{n} tours comptés. Aucune mesure du forfait reçue pour l'instant.", { n: u.tours })}</p>}
    <small className="text-muted-foreground text-[12.5px]">{t("Dernière mesure {quand}", { quand: ago(u.mesure_le, now) })}</small>
  </div>;
}

/** Réglages > Fournisseurs : l'utilisation de chaque abonnement relié à l'ordinateur (Claude Code, ChatGPT, Grok), telle que l'ordinateur l'a lue. */
export function SubscriptionUsage() {
  const [data, setData] = useState<Answer | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { get<Answer>("/api/abonnements/utilisation").then(setData).catch(() => setFailed(true)); }, []);
  if (failed) return null;
  const now = Date.now();
  return <section aria-label={t("Utilisation de tes abonnements")} className="flex flex-col gap-2">
    <h3 className="section-label">{t("Utilisation de tes abonnements")}</h3>
    {!data && <p role="status" className="text-sm text-muted-foreground">{t("Chargement…")}</p>}
    {data && !data.abonnements.length && <p className="shell-row text-sm text-muted-foreground">{t("Aucune mesure pour l'instant. Elle apparaît après un tour passé par ton ordinateur.")}</p>}
    {data && !!data.abonnements.length && <div className="shell-group">{data.abonnements.map((u) => <Card key={u.id} u={u} now={now} />)}</div>}
    {data && !data.en_ligne && !!data.abonnements.length && <p className="text-sm text-muted-foreground">{t("Ton ordinateur est éteint : ce sont les dernières mesures connues.")}</p>}
  </section>;
}
