// Une mise à jour du serveur remplace les fichiers de l'interface (leurs noms portent une empreinte) : une page restée ouverte
// demande alors des morceaux qui n'existent plus. Elle se recharge seule, une fois, plutôt que d'afficher un écran cassé.
import { sauverPile } from "./navigation";

const DERNIER = "noah:rechargement";
const MINUTE = 60_000;
/** Annonce que l'interface de cette page n'est plus celle du serveur : le bandeau se montre. */
export const INTERFACE_CHANGEE = "noah:interface-changee";

/** Le rechargement lui-même, à part : les tests le remplacent (jsdom ne recharge rien). */
export const fenetre = { recharger: () => location.reload() };

/** L'erreur d'un morceau de l'interface qui n'a pas pu être chargé (import dynamique, préchargement, ChunkLoadError). */
export function estMorceauIntrouvable(erreur: unknown): boolean {
  const texte = erreur instanceof Error ? `${erreur.name} ${erreur.message}` : String(erreur ?? "");
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading (?:CSS )?chunk [\w-]+ failed/i.test(texte);
}

/** Un texte en cours d'écriture (la saisie du chat, ou le champ où se trouve le curseur) : un rechargement seul le perdrait. */
function brouillonEnCours(): boolean {
  const plein = (el: Element | null) => !!el && (("value" in el ? String((el as HTMLInputElement).value) : el.textContent ?? "").trim() !== "");
  const actif = document.activeElement;
  const champ = actif instanceof HTMLTextAreaElement || (actif instanceof HTMLInputElement && actif.type !== "password") || (actif instanceof HTMLElement && actif.isContentEditable);
  return plein(document.querySelector("[data-composer-input]")) || (champ && plein(actif));
}

/** Recharge la page, en gardant l'endroit où l'on était. Sauf si un texte est en cours d'écriture (le bandeau « Noah a été mis à jour » le propose alors),
 * ou si elle l'a déjà fait il y a moins d'une minute (pas de boucle
 * quand le serveur est vraiment cassé) : rend alors false et ne fait rien. `forcer` passe outre, pour un clic de la personne. */
export function recharger({ forcer = false } = {}): boolean {
  if (!forcer && brouillonEnCours()) { window.dispatchEvent(new Event(INTERFACE_CHANGEE)); return false; }
  try {
    const dernier = Number(sessionStorage.getItem(DERNIER) ?? 0);
    if (!forcer && Date.now() - dernier < MINUTE) return false;
    sessionStorage.setItem(DERNIER, String(Date.now()));
  } catch {
    if (!forcer) { window.dispatchEvent(new Event(INTERFACE_CHANGEE)); return false; } // stockage bloqué : pas de garde-fou possible, pas de rechargement automatique
  }
  sauverPile();
  fenetre.recharger();
  return true;
}

/** Les deux signaux d'un morceau perdu : l'événement de Vite (préchargement) et une promesse rejetée hors de tout écran. */
export function surveillerMorceaux() {
  window.addEventListener("vite:preloadError", () => { recharger(); });
  window.addEventListener("unhandledrejection", (e) => { if (estMorceauIntrouvable(e.reason)) recharger(); });
}
