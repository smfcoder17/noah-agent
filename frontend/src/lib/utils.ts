import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { langue, locale, t } from "@/i18n";

/**
 * Adresse d'image ou de média venue d'un message de l'agent : refusée si elle vise l'hôte de Noah sur un autre port
 * (le cookie de session partirait avec, les cookies ne distinguant pas les ports).
 */
export function safeMedia(src: string | undefined): string | undefined {
  if (!src) return undefined;
  try {
    const u = new URL(src, location.href);
    return u.hostname === location.hostname && u.origin !== location.origin ? undefined : src;
  } catch {
    return undefined;
  }
}

/**
 * Télécharge sans quitter la page : une navigation (lien simple, window.open en « _self ») remplacerait l'application par la page
 * d'erreur si le serveur répond 502, et couperait l'appel en cours. Ici, seule une erreur charge une page, dans ce cadre caché.
 */
export function downloadFile(url: string, onFailed: () => void) {
  // Dans l'app Android, un cadre caché ne déclenche aucun téléchargement : le fichier est vérifié ici, puis confié à l'app.
  const native = window.Capacitor?.Plugins?.NoahShell?.download;
  if (native) {
    const stop = new AbortController();
    void fetch(url, { signal: stop.signal, credentials: "same-origin" })
      .then((r) => {
        stop.abort(); // seul l'état de la réponse compte ici : c'est l'app qui récupère le fichier
        if (!r.ok) return onFailed();
        void native({ url: new URL(url, location.href).href, mime: r.headers.get("content-type") ?? "" }).catch(onFailed);
      })
      .catch(onFailed);
    return;
  }
  const frame = document.createElement("iframe");
  frame.hidden = true;
  const late = setTimeout(() => frame.remove(), 300_000); // un vrai téléchargement ne déclenche pas « load »
  frame.onload = () => {
    clearTimeout(late);
    frame.remove();
    onFailed();
  };
  frame.src = url;
  document.body.appendChild(frame);
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Virgule décimale en français, point en anglais. */
const decimal = (s: string) => (langue() === "fr" ? s.replace(".", ",") : s);

export const money = (v: number | null | undefined) =>
  decimal(v == null ? "?" : v === 0 ? "0" : v < 0.1 ? v.toFixed(3) : v.toFixed(2));

export const contextSize = (n: number) =>
  !n ? "" : n >= 1e6 ? t("{n} M jetons", { n: decimal((n / 1e6).toFixed(n % 1e6 ? 1 : 0)) }) : t("{n} k jetons", { n: Math.round(n / 1000) });

export const fileSize = (n: number) =>
  n < 1024 ? t("{n} o", { n }) : n < 1048576 ? t("{n} Ko", { n: Math.round(n / 1024) }) : t("{n} Mo", { n: decimal((n / 1048576).toFixed(1)) });

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** « fr-CA » écrit « 14 h 52 » ; les autres langues suivent le navigateur. */
const dates = () => (langue() === "fr" ? "fr-CA" : locale());
const hour = (d: Date) => d.toLocaleTimeString(dates(), { hour: "2-digit", minute: "2-digit" });

/** « 14 h 52 », « hier, 14 h 52 », « 5 nov., 14 h 52 » : ce qu'il faut pour se repérer, sans plus. */
export function messageMoment(d: Date, now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return hour(d);
  if (sameDay(d, yesterday)) return t("hier, {heure}", { heure: hour(d) });
  const day = d.toLocaleDateString(dates(), { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  return `${day}, ${hour(d)}`;
}

/** « Aujourd'hui », « Hier », « jeudi 5 novembre » : le séparateur entre deux journées. */
export function dayLabel(d: Date, now = new Date()): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return t("Aujourd'hui");
  if (sameDay(d, yesterday)) return t("Hier");
  return d.toLocaleDateString(dates(), { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
