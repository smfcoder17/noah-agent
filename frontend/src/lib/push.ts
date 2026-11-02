// Abonnement aux notifications de cet appareil : réconcilié avec le serveur à chaque ouverture de l'app. Le navigateur
// peut renouveler l'abonnement pendant que le serveur est indisponible ; sans ça, les notifications se perdraient
// jusqu'à ce qu'on ouvre Réglages → Appareils.
import { get, send } from "@/lib/api";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Rend true si les notifications sont actives ici (et renvoie l'abonnement du navigateur au serveur au besoin). */
export async function reconcilePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const [r, sub] = await Promise.all([
    get<{ abonne: boolean; endpoint: string | null }>("/api/push/subscription"),
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()),
  ]);
  if (!sub || Notification.permission !== "granted") return false;
  if (!r.abonne || r.endpoint !== sub.endpoint) {
    const j = sub.toJSON();
    await send("/api/push/subscription", { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth });
  }
  return true;
}
