import { useVisibleSubscription } from "@/lib/events";
// Réglages > Serveur > Mises à jour : version en service, la prochaine (installée seule pendant le créneau calme), l'historique.
// Modèle : Home Assistant (« Mettre à jour » / « Passer ») et Synology DSM (créneau choisi, report automatique).
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { locale, t, tServeur } from "@/i18n";
import { get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";

type Summary = {
  version: string;
  disponible: { version: string; correction?: boolean; notes: string; majeure: boolean; migration: boolean; ignoree: boolean; composants: string[] } | null;
  attente: string | null;
  occupe: string | null;
  auto: boolean;
  heure: string | number;
  creneau: string;
  fuseau: string;
  verifie: number | null;
  erreur: string | null;
  en_cours: boolean;
  intervention: string[] | null;
  gardes: string[];
  dernier_rapport: { ok: boolean; erreur?: string } | null;
  historique: { quand: number; texte: string }[];
};

const NAMES: Record<string, string> = {
  "noah-server": "Noah", "noah-launcher": t("lanceur des agents"), hermes: t("agents (Hermes)"), navigateur: t("navigateur des agents"), caddy: "HTTPS (Caddy)",
};

const when = (sec: number) => new Date(sec * 1000).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });

export function Updates() {
  const subscribeUpdates = useVisibleSubscription();
  const [s, setS] = useState<Summary | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => get<Summary>("/api/updates").then(setS).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
    const stop = subscribeUpdates(load);
    return () => stop();
  }, [load]);

  const act = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what);
    setError("");
    try {
      await run();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const install = () => act("install", async () => {
    try {
      await send("/api/updates/install", {});
    } catch (e) {
      const m = (e as Error).message;
      // i18n-ignore : début du message du serveur (409), en français s'il n'a pas de traduction
      const notNow = m.startsWith("Pas maintenant") || m.startsWith(t("Pas maintenant"));
      if (!notNow || !confirm(t("{message} Installer quand même ? Noah redémarrera en quelques minutes.", { message: m }))) throw e;
      await send("/api/updates/install?force=true", {});
    }
  });
  const save = (body: { auto?: boolean; heure?: string | number }) => act("save", () => send("/api/updates/settings", body, "PUT"));

  if (!s) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture…")}</p>;
  const next = s.disponible;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
        <div>
          <p className="font-medium">Noah {s.version}</p>
          <p className="text-xs text-muted-foreground">{s.verifie ? t("Vérifié le {date}", { date: when(s.verifie) }) : t("Pas encore vérifié")}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act("check", () => send("/api/updates/check", {}))}>
          {busy === "check" ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t("Vérifier")}
        </Button>
      </div>

      {s.intervention && (
        <div className="flex flex-col gap-2 rounded-xl bg-warn-soft p-4 text-warn">
          <p>{t("Une mise à jour n'a pas pu revenir en arrière pour : {composants}. Ils sont arrêtés pour protéger leurs données ; tout le reste fonctionne sur la version d'avant. Les sauvegardes sont gardées.", { composants: s.intervention.join(", ") })}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={!!busy} onClick={() => act("resolve", () => send("/api/updates/resolve", { action: "reessayer" }))}>{t("Réessayer la restauration")}</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => confirm(t("Les laisser arrêtés tels quels ? Tu t'en occupes (sauvegardes dans le volume noah-backups).")) && act("resolve", () => send("/api/updates/resolve", { action: "garder" }))}>{t("Les laisser arrêtés")}</Button>
          </div>
        </div>
      )}

      {s.gardes.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-border p-4 text-muted-foreground">
          <p>{t("Mis de côté après une mise à jour, en attente de ta vérification : {composants}. Noah n'y touche pas.", { composants: s.gardes.join(", ") })}</p>
          <Button size="sm" variant="outline" className="self-start" disabled={!!busy} onClick={() => confirm(t("Tu t'en es occupé ? Noah pourra de nouveau les démarrer et les mettre à jour.")) && act("resolve", () => send("/api/updates/resolve", { action: "liberer" }))}>{t("Je m'en suis occupé")}</Button>
        </div>
      )}

      {s.en_cours && <p className="flex items-center gap-2 rounded-xl bg-muted p-4"><Loader2 className="size-4 animate-spin" />{t("Mise à jour en cours. Noah peut être indisponible une minute ou deux.")}</p>}

      {next?.ignoree ? (
        <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="size-4 text-accent" />{t("Noah est à jour (une version ignorée attend la suivante).")}</p>
      ) : next ? (
        <div className="flex flex-col gap-3 rounded-xl border border-accent/40 p-4">
          <p className="font-medium">{next.correction ? t("Une correction est prête") : next.majeure ? t("Noah {version} est prête (version majeure)", { version: next.version }) : t("Noah {version} est prête", { version: next.version })}</p>
          {next.composants.length > 0 && <p className="text-xs text-muted-foreground">{t("Change : {composants}", { composants: next.composants.map((c) => NAMES[c] || c).join(", ") })}</p>}
          {next.notes && <p className="whitespace-pre-line text-xs text-muted-foreground">{next.notes}</p>}
          <p className="text-xs text-muted-foreground">
            {/* i18n-ignore : valeur d'attente renvoyée par le serveur */}
            {s.attente === "en dehors du créneau calme" ? t("Elle s'installera seule entre {creneau} ({fuseau}).", { creneau: s.creneau, fuseau: s.fuseau }) : s.attente ? t("En attente : {raison}.", { raison: tServeur(s.attente) }) : t("Installation imminente.")}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={!!busy || s.en_cours} onClick={install}>{busy === "install" && <Loader2 className="animate-spin" />}{t("Installer maintenant")}</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("later", () => send("/api/updates/postpone", {}))}>{t("Pas ce soir")}</Button>
            {!next.ignoree && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("skip", () => send("/api/updates/skip", {}))}>{t("Ignorer cette version")}</Button>}
          </div>
        </div>
      ) : !s.erreur && <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="size-4 text-accent" />{t("Noah est à jour.")}</p>}

      {s.erreur && <p className="rounded-xl bg-warn-soft p-4 text-warn">{tServeur(s.erreur)}</p>}
      {s.dernier_rapport && !s.dernier_rapport.ok && <p className="rounded-xl bg-warn-soft p-4 text-warn">{t("Dernière mise à jour annulée : {raison}.", { raison: s.dernier_rapport.erreur ? tServeur(s.dernier_rapport.erreur) : t("un composant ne répondait plus, l'ancienne version a été remise") })}</p>}

      <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.auto} onChange={(e) => save({ auto: e.target.checked })} />
          {t("Installer les mises à jour automatiquement")}
        </label>
        <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
          {t("Créneau :")}
          <select className="rounded-md border border-border bg-surface px-2 py-1 text-foreground" value={String(s.heure)} onChange={(e) => save({ heure: e.target.value })}>
            <option value="auto">{t("quand je n'utilise pas Noah (appris)")}</option>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t("à partir de {h} h", { h })}</option>)}
          </select>
          <span className="text-xs">{t("en ce moment : {creneau}, {fuseau}", { creneau: s.creneau, fuseau: s.fuseau })}</span>
        </label>
      </div>

      {s.historique.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-muted-foreground">{t("Historique")}</p>
          {s.historique.map((h, i) => <p key={i} className="text-xs text-muted-foreground">{when(h.quand)} · {tServeur(h.texte)}</p>)}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
