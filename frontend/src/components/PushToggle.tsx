// « Notifications sur cet appareil » : abonnement Web Push du navigateur (ou de l'app installée) à ce serveur Noah.
// Les messages sont chiffrés par le serveur pour cet appareil ; le service de push du navigateur ne peut pas les lire.
import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, send } from "@/lib/api";
import { pushSupported as supported, reconcilePush } from "@/lib/push";
import { Button, ErrorText } from "./ui";


function bytes(b64url: string) {
  const raw = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

type AndroidPush = { distributeurs: number; inscrit: boolean; permission: boolean };

/** App Android : les notifications passent par UnifiedPush (une app « distributeur » comme ntfy tient la connexion). */
function AndroidPushStatus() {
  const native = window.Capacitor?.Plugins?.NoahShell;
  const [state, setState] = useState<AndroidPush | null>(null);
  const [result, setResult] = useState("");
  const refresh = () => native?.pushStatus?.().then((s) => setState(s as AndroidPush)).catch(() => setState(null));
  useEffect(() => {
    refresh();
    // Relu régulièrement : inscription réussie par une relance automatique, permission changée dans Android…
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!native?.pushStatus || !state) return null;
  const retry = async () => {
    await native.pushSetup?.();
    // L'inscription peut aboutir après les relances natives (30 s, 2 min, 10 min) : relu toutes les 5 s, 15 min.
    let n = 0;
    const t = setInterval(async () => {
      const s = (await native.pushStatus?.().catch(() => null)) as AndroidPush | null;
      if (s) setState(s);
      if (s?.inscrit || ++n >= 180) clearInterval(t);
    }, 5000);
  };
  const test = async () => {
    setResult("");
    const r = await send<{ livres: number }>("/api/push/test", {}).catch(() => ({ livres: 0 }));
    setResult(r.livres ? "Message de test envoyé : il doit arriver dans quelques secondes." : "Le message de test n'est pas parti. Touche « Activer » de nouveau.");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-muted-foreground">Notifications sur ce téléphone</p>
      {!state.permission ? (
        <p className="text-xs text-muted-foreground">
          Les notifications de Noah sont coupées dans les réglages d'Android (Applis → Noah → Notifications).
        </p>
      ) : state.inscrit ? (
        <>
          <p className="text-xs text-muted-foreground">Actives : Noah te prévient même quand l'app est fermée.</p>
          <Button size="sm" variant="ghost" className="self-start" onClick={test}><Bell />Envoyer un test</Button>
          {result && <p className="text-xs text-muted-foreground">{result}</p>}
        </>
      ) : state.distributeurs === 0 ? (
        <>
          <p className="text-xs text-muted-foreground">
            Pour les recevoir sans service de Google, installe l'app gratuite <b>ntfy</b> (Play Store ou F-Droid). Elle
            garde la connexion pour toutes tes apps ; tes messages restent chiffrés pour ce téléphone.
          </p>
          <Button size="sm" variant="outline" className="self-start" onClick={retry}><Bell />C'est installé, activer</Button>
        </>
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={retry}><Bell />Activer les notifications</Button>
      )}
    </div>
  );
}

export function PushToggle() {
  if (window.Capacitor?.Plugins?.NoahShell) return <AndroidPushStatus />;
  return <WebPushToggle />;
}

function WebPushToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!supported()) return;
    reconcilePush().then(setOn).catch(() => setOn(false));
  }, []);
  if (!supported()) return null;

  const enable = async () => {
    setBusy(true);
    setError("");
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        throw new Error("Notifications refusées. Autorise-les pour ce site dans les réglages du navigateur.");
      }
      const reg = await navigator.serviceWorker.ready;
      const { cle } = await get<{ cle: string }>("/api/push/key");
      let sub = await reg.pushManager.getSubscription();
      // Abonnement fait avec une autre clé (autre serveur, clé recréée) : il ne marcherait pas.
      const key = sub?.options.applicationServerKey;
      if (sub && (!key || btoa(String.fromCharCode(...new Uint8Array(key))) !== btoa(String.fromCharCode(...bytes(cle))))) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(cle) });
      const json = sub.toJSON();
      await send("/api/push/subscription", { endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth });
      const r = await send<{ livres: number; echecs: number }>("/api/push/test", {});
      if (!r.livres) throw new Error("Le service de notifications du navigateur n'a pas accepté le message de test. Réessaie dans un moment.");
      setOn(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await del("/api/push/subscription");
      await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe();
      setOn(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-muted-foreground">Notifications sur cet appareil</p>
      <p className="text-xs text-muted-foreground">
        Quand Noah attend ton accord, termine une veille ou a besoin de toi, même si l'app est fermée.
      </p>
      {on ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={disable} disabled={busy}><BellOff />Couper les notifications</Button>
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={enable} disabled={busy || on === null}><Bell />Recevoir les notifications</Button>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
