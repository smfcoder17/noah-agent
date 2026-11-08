// Nouvelle version de l'app Android : le serveur annonce l'APK de sa Release, l'app la propose en une touche.
import { Download, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { get, type Status } from "@/lib/api";
import { appShell, tooOld } from "@/lib/platform";
import { Button } from "./ui";

type Offer = { version: string; url: string };
const DISMISSED = "noah:app-update-ignoree";

export function AppUpdate() {
  const [current, setCurrent] = useState("");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [state, setState] = useState<"" | "busy" | "sent">("");
  const [message, setMessage] = useState("");
  const [hidden, setHidden] = useState(false);
  const shell = appShell();
  useEffect(() => {
    if (shell?.kind !== "android") return;
    shell.version().then(setCurrent).catch(() => {});
    get<Status>("/api/status").then((s) => {
      const next = s.app_android ?? null;
      setOffer(next);
      try {
        setHidden(!!next && localStorage.getItem(DISMISSED) === next.version);
      } catch {
        /* pas de mémoire du « plus tard » */
      }
    }).catch(() => {});
  }, [shell?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!offer || shell?.kind !== "android" || !current || hidden || !tooOld(current, offer.version)) return null;

  const install = async () => {
    const native = window.Capacitor?.Plugins?.NoahShell;
    // Une app d'avant cette fonction n'a pas installUpdate : le navigateur du téléphone télécharge l'APK.
    if (!native?.installUpdate) return void window.location.assign(offer.url);
    setState("busy");
    setMessage("");
    try {
      await native.installUpdate({ url: offer.url });
      setState("sent");
      setMessage("Téléchargement en cours : Android te demandera de confirmer l'installation.");
    } catch (e) {
      setState("");
      setMessage((e as Error).message || "La mise à jour n'a pas pu démarrer.");
    }
  };
  const later = () => {
    try {
      localStorage.setItem(DISMISSED, offer.version);
    } catch {
      /* rien à retenir */
    }
    setHidden(true);
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/40 px-3 py-2 text-sm">
      <p className="min-w-0 flex-1">
        Nouvelle version de l'app : <b>{offer.version}</b> (tu as {current}). Tes agents et tes réglages restent.
        {message && <span className="block text-xs text-muted-foreground">{message}</span>}
      </p>
      <Button size="sm" onClick={install} disabled={state !== ""}>
        {state === "busy" ? <Loader2 className="animate-spin" /> : <Download />}Installer
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={later} aria-label="Plus tard"><X /></Button>
    </div>
  );
}
