// Abonnement aux notifications de cet appareil : réconcilié avec le serveur à chaque ouverture de l'app. Le navigateur
// peut renouveler l'abonnement pendant que le serveur est indisponible ; sans ça, les notifications se perdraient
// jusqu'à ce qu'on ouvre Réglages → Appareils.
import { get, send } from "@/lib/api";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// Change à chaque déconnexion : une réconciliation commencée avant n'écrit plus son marqueur après.
let generation = 0;

/** À la déconnexion (ou session refusée, 401) : plus aucune notification ne montre son contenu dans ce navigateur. */
export async function forgetPushSession() {
  generation++;
  await caches.delete("noah-session").catch(() => {});
}

/** Rend true si les notifications sont actives ici (et renvoie l'abonnement du navigateur au serveur au besoin). */
export async function reconcilePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const started = generation;
  const [r, sub] = await Promise.all([
    get<{ abonne: boolean; endpoint: string | null; pour: string }>("/api/push/subscription"),
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()),
  ]);
  // Session ouverte dans ce navigateur : le service worker n'affiche le contenu que des messages qui lui sont destinés.
  if (started !== generation) return false; // déconnecté entre-temps : surtout ne pas réécrire l'ancien marqueur
  await caches.open("noah-session").then((c) => c.put("/__session", new Response(r.pour))).catch(() => {});
  if (started !== generation) await caches.delete("noah-session").catch(() => {}); // déconnexion pendant l'écriture
  if (!sub || Notification.permission !== "granted") return false;
  if (!r.abonne || r.endpoint !== sub.endpoint) {
    const j = sub.toJSON();
    await send("/api/push/subscription", { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth });
  }
  return true;
}
