// Abonnement aux notifications de cet appareil : réconcilié avec le serveur à chaque ouverture de l'app. Le navigateur
// peut renouveler l'abonnement pendant que le serveur est indisponible ; sans ça, les notifications se perdraient
// jusqu'à ce qu'on ouvre Réglages → Appareils.
import { get, send } from "@/lib/api";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// Change à chaque déconnexion, dans n'importe quel onglet (localStorage est partagé, comme le cache du service
// worker) : une réconciliation commencée avant, ici ou ailleurs, n'écrit plus son marqueur après.
const EPOCH = "noah-push-epoch";
let localEpoch = 0; // repli si localStorage est indisponible
const epoch = () => {
  try {
    return `${localStorage.getItem(EPOCH) || "0"}.${localEpoch}`;
  } catch {
    return `0.${localEpoch}`;
  }
};

/** À la déconnexion (ou session refusée, 401) : plus aucune notification ne montre son contenu dans ce navigateur. */
export async function forgetPushSession() {
  localEpoch++;
  try {
    localStorage.setItem(EPOCH, String(Number(localStorage.getItem(EPOCH) || 0) + 1));
  } catch {
    /* indisponible : seul cet onglet est protégé */
  }
  await caches.delete("noah-session").catch(() => {});
  // App Android : ses notifications (UnifiedPush) oublient aussi la session.
  await window.Capacitor?.Plugins?.NoahShell?.pushForget?.().catch(() => {});
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** La clé de l'abonnement du navigateur est-elle celle du serveur (base64url) ? */
export function sameKey(key: ArrayBuffer | null | undefined, cle: string): boolean {
  return !!key && b64url(new Uint8Array(key)) === cle.replace(/=+$/, "");
}

/** Rend true si les notifications sont actives ici (et renvoie l'abonnement du navigateur au serveur au besoin). */
export async function reconcilePush(): Promise<boolean> {
  const android = window.Capacitor?.Plugins?.NoahShell;
  if (android?.pushSetup) {
    // App Android : inscription UnifiedPush pour la session ouverte dans la fenêtre (refaite à chaque ouverture).
    await android.pushSetup().catch(() => {});
    return true;
  }
  if (!pushSupported()) return false;
  const started = epoch();
  const [r, sub] = await Promise.all([
    get<{ abonne: boolean; endpoint: string | null; pour: string }>("/api/push/subscription"),
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()),
  ]);
  // Session ouverte dans ce navigateur : le service worker n'affiche le contenu que des messages qui lui sont destinés.
  if (started !== epoch()) return false; // déconnecté entre-temps : surtout ne pas réécrire l'ancien marqueur
  await caches.open("noah-session").then((c) => c.put("/__session", new Response(r.pour))).catch(() => {});
  // Déconnexion (dans n'importe quel onglet) pendant l'écriture : elle incrémente avant d'effacer, on le voit donc ici.
  if (started !== epoch()) await caches.delete("noah-session").catch(() => {});
  if (!sub || Notification.permission !== "granted") return false;
  // Abonnement fait avec une autre clé du serveur (restauration, clé recréée) : le service de push refuserait nos envois.
  const { cle } = await get<{ cle: string }>("/api/push/key");
  if (!sameKey(sub.options.applicationServerKey, cle)) {
    await sub.unsubscribe().catch(() => {});
    return false; // « Recevoir les notifications » réabonne avec la bonne clé
  }
  if (!r.abonne || r.endpoint !== sub.endpoint) {
    const j = sub.toJSON();
    await send("/api/push/subscription", { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth });
  }
  return true;
}
