// Partage vers Noah (Web Share Target, PWA installée sur Android ; iOS ne le propose pas) : le titre, le texte ou le
// lien partagé arrivent dans l'adresse. Ils deviennent une citation jointe au prochain message de la conversation
// principale : l'utilisateur dit à l'agent quoi en faire.
let shared: string | null = null;

/** À l'ouverture : lit le partage et nettoie l'adresse (il ne revient pas au prochain rechargement). */
export function captureShare() {
  const p = new URLSearchParams(location.search);
  const parts: string[] = [];
  for (const key of ["partage_titre", "partage_texte", "partage_lien"]) {
    const v = p.get(key)?.trim();
    // Beaucoup d'apps mettent le lien aussi dans le texte : pas de doublon.
    if (v && !parts.some((x) => x.includes(v))) parts.push(v);
  }
  if (!parts.length) return;
  shared = parts.join("\n");
  history.replaceState(null, "", location.pathname);
}

/** Gardé jusqu'à l'envoi du message : la conversation peut être recréée entre-temps (chargement, changement d'agent). */
export const pendingShare = () => shared;
export const clearShare = () => {
  shared = null;
};
