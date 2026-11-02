// « Notifications sur cet appareil » : abonnement Web Push du navigateur (ou de l'app installée) à ce serveur Noah.
// Les messages sont chiffrés par le serveur pour cet appareil ; le service de push du navigateur ne peut pas les lire.
import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, send } from "@/lib/api";
import { Button, ErrorText } from "./ui";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function bytes(b64url: string) {
  const raw = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function PushToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!supported()) return;
    // Actif seulement si le serveur ET le navigateur ont l'abonnement (il peut expirer côté navigateur).
    Promise.all([get<{ abonne: boolean }>("/api/push/subscription"), navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription())])
      .then(([r, sub]) => setOn(r.abonne && !!sub && Notification.permission === "granted"))
      .catch(() => setOn(false));
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
