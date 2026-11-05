// Réglages > Téléphone, dans l'app Android seulement : l'état réel de chaque droit, un bouton pour le demander, et la bulle flottante.
// Rien n'est demandé au démarrage : seulement depuis cet écran, ou au moment de s'en servir.
import { useAui } from "@assistant-ui/react";
import { Loader2, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { type Agent, get } from "@/lib/api";
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
  accorde: "Autorisé",
  a_demander: "Pas encore demandé",
  refuse: "Refusé",
  bloque: "Refusé dans Android",
  sans_droit: "Aucun droit à donner",
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
          {state === "bloque" ? "Ouvrir les réglages d'Android" : button ?? "Autoriser"}
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
    if (!agent || !rights) return setError("Crée d'abord un agent.");
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

  if (!rights) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture des droits du téléphone…</p>;
  const bubble = rights.bulle.active;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-2xl border border-accent/40 p-4">
        <p className="text-sm font-semibold">Mode flottant</p>
        <p className="text-xs text-muted-foreground">
          Une petite bulle reste au-dessus de tes apps. Touche-la pour ouvrir Noah. Maintiens-la pour dicter : relâche pour envoyer,
          glisse sur « Annuler » pour annuler. Noah ne voit rien des autres apps et n'utilise le réseau que quand tu dictes.
        </p>
        <label className="flex items-center gap-2 text-sm">
          Agent de la bulle
          <select className="rounded-lg border border-border bg-surface px-2 py-1 text-sm" value={agentId} onChange={(e) => setChosen(e.target.value)} disabled={bubble}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {bubble ? (
          <Button size="sm" variant="outline" className="self-start" onClick={stopBubble}>Arrêter la bulle</Button>
        ) : (
          <Button size="sm" className="self-start" onClick={startBubble}>
            {rights.superposition !== "accorde" ? "Autoriser la superposition" : rights.micro !== "accorde" ? "Autoriser le micro" : "Lancer la bulle"}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          Elle ne démarre jamais seule : après un redémarrage du téléphone, relance-la ici.
          {rights.notifications === "accorde" ? " Le bouton « Arrêter » est aussi dans sa notification." : " Sans notifications, tu l'arrêtes ici : Android n'affiche pas le bouton « Arrêter »."}
        </p>
      </div>
      <Row title="Notifications" state={rights.notifications} onAsk={() => ask("notifications")}>
        Refusées : aucun bandeau, ni fin de tâche, ni appel d'un agent. Les réponses restent dans la conversation.
        {rights.distributeurs === 0
          ? " Aucun distributeur n'est installé : installe l'app gratuite ntfy, ouvre-la une fois, puis touche « Activer » dans Réglages > Notifications."
          : rights.inscrit ? "" : " Le distributeur est là : touche « Activer » dans Réglages > Notifications."}
      </Row>
      <Row title="Micro" state={rights.micro} onAsk={() => ask("micro")}>
        Pour dicter et pour appeler un agent. Refusé : ni dictée, ni appel, ni bulle. Le reste marche à l'écrit.
      </Row>
      <Row title="Photos et fichiers" state={rights.photos}>
        Quand tu joins un fichier, Android te montre son sélecteur : Noah reçoit seulement ce que tu choisis, et n'a pas accès à ta galerie.
      </Row>
      <Row title="Position" state={rights.position} onAsk={() => choosePosition(true)} button="Autoriser et activer">
        Refusée : rien ne change, sauf le bouton « Joindre ma position ». Elle n'est lue que quand tu touches ce bouton, jamais en arrière-plan,
        et elle part dans ton message, donc chez le fournisseur du modèle de cet agent.
      </Row>
      {rights.position === "accorde" && (
        <label className="-mt-1 flex items-center gap-3 rounded-2xl border border-border p-4 text-sm">
          <input type="checkbox" checked={rights.positionActive} onChange={(e) => choosePosition(e.target.checked)} />
          <span>Proposer « Joindre ma position » dans la zone de saisie</span>
        </label>
      )}
      <Row title="Superposition" state={rights.superposition} onAsk={() => ask("superposition")}>
        Pour la bulle seulement. Refusée : pas de mode flottant, tout le reste marche.
      </Row>
      <Row title="Batterie sans restriction" state={rights.batterie} onAsk={() => ask("batterie")}>
        Pour que les appels sonnent aussi écran éteint, surtout sans ntfy. Refusée : Android peut retarder un appel quand le téléphone dort.
      </Row>
      <ErrorText>{error}</ErrorText>
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
      const line = `Ma position : ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} (à ${Math.round(p.precision)} m près)`;
      const current = aui.composer.getState().text;
      aui.composer.setText(current.trim() ? `${current.trimEnd()}\n${line}` : line);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button type="button" variant="ghost" size="icon" aria-label="Joindre ma position" title={error || "Joindre ma position au message"} className={error ? "text-warn" : "text-muted-foreground"} onClick={attach} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <MapPin />}
    </Button>
  );
}
