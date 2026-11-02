// Réglages > Mises à jour : version en service, la prochaine (installée seule pendant le créneau calme), l'historique.
// Modèle : Home Assistant (« Mettre à jour » / « Passer ») et Synology DSM (créneau choisi, report automatique).
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";

type Summary = {
  version: string;
  disponible: { version: string; notes: string; majeure: boolean; migration: boolean; ignoree: boolean; composants: string[] } | null;
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
  dernier_rapport: { ok: boolean; erreur?: string } | null;
  historique: { quand: number; texte: string }[];
};

const NAMES: Record<string, string> = {
  "noah-server": "Noah", "noah-launcher": "lanceur des agents", hermes: "agents (Hermes)", navigateur: "navigateur des agents", caddy: "HTTPS (Caddy)",
};

const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function Updates() {
  const [s, setS] = useState<Summary | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => get<Summary>("/api/updates").then(setS).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
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
      if (!(e as Error).message.startsWith("Pas maintenant") || !confirm(`${(e as Error).message} Installer quand même ? Noah redémarrera en quelques minutes.`)) throw e;
      await send("/api/updates/install?force=true", {});
    }
  });
  const save = (body: { auto?: boolean; heure?: string | number }) => act("save", () => send("/api/updates/settings", body, "PUT"));

  if (!s) return error ? <ErrorText>{error}</ErrorText> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture…</p>;
  const next = s.disponible;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
        <div>
          <p className="font-medium">Noah {s.version}</p>
          <p className="text-xs text-muted-foreground">{s.verifie ? `Vérifié le ${when(s.verifie)}` : "Pas encore vérifié"}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => act("check", () => send("/api/updates/check", {}))}>
          {busy === "check" ? <Loader2 className="animate-spin" /> : <RefreshCw />}Vérifier
        </Button>
      </div>

      {s.intervention && (
        <div className="flex flex-col gap-2 rounded-xl bg-warn-soft p-4 text-warn">
          <p>Une mise à jour n'a pas pu revenir en arrière pour : {s.intervention.join(", ")}. Ils sont arrêtés pour protéger leurs données ; tout le reste fonctionne sur la version d'avant. Les sauvegardes sont gardées.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={!!busy} onClick={() => act("resolve", () => send("/api/updates/resolve", { action: "reessayer" }))}>Réessayer la restauration</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => confirm("Les laisser arrêtés tels quels ? Tu t'en occupes (sauvegardes dans le volume noah-backups).") && act("resolve", () => send("/api/updates/resolve", { action: "garder" }))}>Les laisser arrêtés</Button>
          </div>
        </div>
      )}

      {s.en_cours && <p className="flex items-center gap-2 rounded-xl bg-muted p-4"><Loader2 className="size-4 animate-spin" />Mise à jour en cours. Noah peut être indisponible une minute ou deux.</p>}

      {next?.ignoree ? (
        <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="size-4 text-accent" />Noah est à jour (une version ignorée attend la suivante).</p>
      ) : next ? (
        <div className="flex flex-col gap-3 rounded-xl border border-accent/40 p-4">
          <p className="font-medium">Noah {next.version} est prête{next.majeure ? " (version majeure)" : ""}</p>
          {next.composants.length > 0 && <p className="text-xs text-muted-foreground">Change : {next.composants.map((c) => NAMES[c] || c).join(", ")}</p>}
          {next.notes && <p className="whitespace-pre-line text-xs text-muted-foreground">{next.notes}</p>}
          <p className="text-xs text-muted-foreground">
            {s.attente === "en dehors du créneau calme" ? `Elle s'installera seule entre ${s.creneau} (${s.fuseau}).` : s.attente ? `En attente : ${s.attente}.` : "Installation imminente."}
            {" "}Tout est sauvegardé avant, et Noah revient à la version actuelle si quelque chose ne marche pas.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={!!busy || s.en_cours} onClick={install}>{busy === "install" && <Loader2 className="animate-spin" />}Installer maintenant</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("later", () => send("/api/updates/postpone", {}))}>Pas ce soir</Button>
            {!next.ignoree && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("skip", () => send("/api/updates/skip", {}))}>Ignorer cette version</Button>}
          </div>
        </div>
      ) : !s.erreur && <p className="flex items-center gap-2 text-muted-foreground"><CheckCircle2 className="size-4 text-accent" />Noah est à jour.</p>}

      {s.erreur && <p className="rounded-xl bg-warn-soft p-4 text-warn">{s.erreur}</p>}
      {s.dernier_rapport && !s.dernier_rapport.ok && <p className="rounded-xl bg-warn-soft p-4 text-warn">Dernière mise à jour annulée : {s.dernier_rapport.erreur || "un composant ne répondait plus, l'ancienne version a été remise"}.</p>}

      <div className="flex flex-col gap-2 rounded-xl border border-border p-4">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={s.auto} onChange={(e) => save({ auto: e.target.checked })} />
          Installer les mises à jour automatiquement
        </label>
        <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
          Créneau :
          <select className="rounded-md border border-border bg-surface px-2 py-1 text-foreground" value={String(s.heure)} onChange={(e) => save({ heure: e.target.value })}>
            <option value="auto">quand je n'utilise pas Noah (appris)</option>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>à partir de {h} h</option>)}
          </select>
          <span className="text-xs">en ce moment : {s.creneau}, {s.fuseau}</span>
        </label>
        <p className="text-xs text-muted-foreground">Jamais pendant une tâche, une validation en attente ou un écran ouvert. Une version majeure attend 7 jours, sauf si tu l'installes avant.</p>
      </div>

      {s.historique.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-muted-foreground">Historique</p>
          {s.historique.map((h, i) => <p key={i} className="text-xs text-muted-foreground">{when(h.quand)} · {h.texte}</p>)}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
