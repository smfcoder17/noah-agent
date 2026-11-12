// Ce que la page de Noah peut demander à Chromium. Liste fermée : tout le reste est refusé, à toute page.
// Micro (dictée, mode vocal), plein écran (lecteur) et notifications (Réglages → Notifications) : pour l'interface de Noah seulement.
// Écrire une image dans le presse-papiers : la page qui le demande doit être Noah, pas le lecteur d'une vidéo.
const PAGE = new Set(["media", "fullscreen", "notifications"]);

/** origin : serveur de Noah ; pageUrl : adresse de la fenêtre ; asking : adresse du cadre qui demande. */
function allowed(origin, pageUrl, permission, asking) {
  const same = (url) => {
    try {
      return !!origin && new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  if (!origin || !pageUrl || !same(pageUrl)) return false;
  if (permission === "clipboard-sanitized-write") return !!asking && same(asking);
  // Une notification demandée par un cadre d'une autre origine est refusée ; sans adresse connue, la fenêtre de Noah fait foi.
  if (permission === "notifications") return !asking || same(asking);
  return PAGE.has(permission);
}

module.exports = { allowed };
