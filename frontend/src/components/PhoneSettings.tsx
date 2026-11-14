// Réglages > Téléphone, dans l'app Android seulement : l'état réel de chaque droit, un bouton pour le demander, et la bulle flottante.
// Rien n'est demandé au démarrage : seulement depuis cet écran, ou au moment de s'en servir.
import { useAui } from "@assistant-ui/react";
import { Loader2, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { t, tr } from "@/i18n";
import { type Agent, get } from "@/lib/api";
import { CONFIDENTIALITE_URL } from "@/lib/editeur";
import { Button, ErrorText } from "./ui";

type State = "accorde" | "a_demander" | "refuse" | "bloque" | "sans_droit";
type Rights = {
  notifications: State;
  micro: State;
  photos: State;
  position: State;
  superposition: State;
  batterie: State;
  distributeurs: number;
  inscrit: boolean;
  positionActive: boolean;
  bulle: { active: boolean; agent: string | null };
};

const native = () => window.Capacitor?.Plugins?.NoahShell;

/** L'app installée sait-elle faire tout ça ? Une app plus ancienne n'affiche pas l'onglet. */
export const phoneSettingsAvailable = () => !!native()?.droits;

const WORD: Record<State, string> = {
  accorde: t("Autorisé"),
  a_demander: t("Pas encore demandé"),
  refuse: t("Refusé"),
  bloque: t("Refusé dans Android"),
  sans_droit: t("Aucun droit à donner"),
};

function Row({ title, state, children, button, onAsk }: { title: string; state: State; children: React.ReactNode; button?: string; onAsk?: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{title}</p>
        <span className={state === "accorde" || state === "sans_droit" ? "text-xs text-accent" : "text-xs text-warn"}>{WORD[state]}</span>
      </div>
      <p className="text-xs text-muted-foreground">{children}</p>
      {onAsk && state !== "accorde" && state !== "sans_droit" && (
        <Button size="sm" variant="outline" className="self-start" onClick={onAsk}>
          {state === "bloque" ? t("Ouvrir les réglages d'Android") : button ?? t("Autoriser")}
        </Button>
      )}
    </div>
  );
}

export function PhoneSettings() {
  const [rights, setRights] = useState<Rights | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState("");
  const refresh = () => native()?.droits?.().then((r) => setRights(r as Rights)).catch(() => {});
  useEffect(() => {
    refresh();
    get<Agent[]>("/api/agents").then(setAgents).catch(() => {});
    // Retour depuis un écran d'Android (superposition, batterie) : l'état a pu changer.
    const back = () => !document.hidden && refresh();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async (droit: string) => {
    setError("");
    await native()?.demanderDroit?.({ droit }).catch((e: Error) => setError(e.message));
    await refresh();
  };
  const agentId = chosen || rights?.bulle.agent || agents[0]?.id || "";
  const startBubble = async () => {
    setError("");
    const agent = agents.find((a) => a.id === agentId);
    if (!agent || !rights) return setError(t("Crée d'abord un agent."));
    if (rights.superposition !== "accorde") return ask("superposition");
    if (rights.micro !== "accorde") return ask("micro");
    await native()?.bulle?.({ actif: true, agent: agent.id, nom: agent.name, couleur: agent.color, forme: agent.shape ?? "", detail: agent.detail ?? "" }).catch((e: Error) => setError(e.message));
    await refresh();
  };
  const stopBubble = async () => {
    await native()?.bulle?.({ actif: false }).catch(() => {});
    await refresh();
  };
  const choosePosition = async (on: boolean) => {
    setError("");
    if (on && rights?.position !== "accorde") {
      await ask("position");
      const now = (await native()?.droits?.()) as Rights | undefined;
      if (now?.position !== "accorde") return;
    }
    await native()?.positionOption?.({ actif: on });
    window.dispatchEvent(new Event("noah:position-option"));
    await refresh();
  };

  if (!rights) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Lecture des droits du téléphone…")}</p>;
  const bubble = rights.bulle.active;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-2xl border border-accent/40 p-4">
        <p className="text-sm font-semibold">{t("Mode flottant")}</p>
        <p className="text-xs text-muted-foreground">
          {t("Une bulle au-dessus de tes apps. Maintiens-la pour dicter.")}
        </p>
        <label className="flex items-center gap-2 text-sm">
          {t("Agent de la bulle")}
          <select className="rounded-lg border border-border bg-surface px-2 py-1 text-sm" value={agentId} onChange={(e) => setChosen(e.target.value)} disabled={bubble}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {bubble ? (
          <Button size="sm" variant="outline" className="self-start" onClick={stopBubble}>{t("Arrêter la bulle")}</Button>
        ) : (
          <Button size="sm" className="self-start" onClick={startBubble}>
            {rights.superposition !== "accorde" ? t("Autoriser la superposition") : rights.micro !== "accorde" ? t("Autoriser le micro") : t("Lancer la bulle")}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {t("Après un redémarrage, relance-la ici.")}
          {rights.notifications === "accorde" ? "" : " " + t("Sans notifications, arrête-la ici.")}
        </p>
      </div>
      <Row title={t("Notifications")} state={rights.notifications} onAsk={() => ask("notifications")}>
        {t("Fins de tâche et appels.")}
        {rights.distributeurs === 0
          ? " " + t("Installe l'app gratuite ntfy, puis « Activer » dans Réglages > Notifications.")
          : rights.inscrit ? "" : " " + t("Touche « Activer » dans Réglages > Notifications.")}
      </Row>
      <Row title={t("Micro")} state={rights.micro} onAsk={() => ask("micro")}>
        {t("Pour dicter et appeler un agent.")}
      </Row>
      <Row title={t("Photos et fichiers")} state={rights.photos}>
        {t("Noah ne reçoit que ce que tu choisis.")}
      </Row>
      <Row title={t("Position")} state={rights.position} onAsk={() => choosePosition(true)} button={t("Autoriser et activer")}>
        {t("Lue quand tu la joins, puis envoyée au fournisseur du modèle.")}
      </Row>
      {rights.position === "accorde" && (
        <label className="-mt-1 flex items-center gap-3 rounded-2xl border border-border p-4 text-sm">
          <input type="checkbox" checked={rights.positionActive} onChange={(e) => choosePosition(e.target.checked)} />
          <span>{t("Proposer « Joindre ma position » dans la zone de saisie")}</span>
        </label>
      )}
      <Row title={t("Superposition")} state={rights.superposition} onAsk={() => ask("superposition")}>
        {t("Pour la bulle seulement.")}
      </Row>
      <Row title={t("Batterie sans restriction")} state={rights.batterie} onAsk={() => ask("batterie")}>
        {t("Pour que les appels sonnent écran éteint.")}
      </Row>
      <ErrorText>{error}</ErrorText>
      <p className="text-xs text-muted-foreground">
        {tr("Ce que l'app fait de tes données : {lien}.", { lien: <a className="underline" href={CONFIDENTIALITE_URL}>{t("politique de confidentialité")}</a> })}
      </p>
    </div>
  );
}

/** Bouton de la zone de saisie : lit la position quand on le touche, et l'écrit dans le message, à relire avant d'envoyer. */
export function AttachPosition() {
  const aui = useAui();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const read = () => native()?.droits?.().then((r) => setOn(!!(r as Rights).positionActive)).catch(() => {});
    read();
    window.addEventListener("noah:position-option", read);
    return () => window.removeEventListener("noah:position-option", read);
  }, []);
  if (!on) return null;
  const attach = async () => {
    setBusy(true);
    setError("");
    try {
      const p = (await native()?.position?.()) as { latitude: number; longitude: number; precision: number };
      const line = t("Ma position : {lat}, {lon} (à {m} m près)", { lat: p.latitude.toFixed(5), lon: p.longitude.toFixed(5), m: Math.round(p.precision) });
      const current = aui.composer.getState().text;
      aui.composer.setText(current.trim() ? `${current.trimEnd()}\n${line}` : line);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={t("Joindre ma position")} title={error || t("Joindre ma position au message")} className={error ? "text-warn" : "text-muted-foreground"} onClick={attach} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <MapPin />}
    </Button>
  );
}
