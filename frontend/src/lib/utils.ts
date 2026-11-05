import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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

export const money = (v: number | null | undefined) =>
  (v == null ? "?" : v === 0 ? "0" : v < 0.1 ? v.toFixed(3) : v.toFixed(2)).replace(".", ",");

export const contextSize = (n: number) =>
  !n ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(".", ",")} M jetons` : `${Math.round(n / 1000)} k jetons`;

export const fileSize = (n: number) =>
  n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1).replace(".", ",")} Mo`;
