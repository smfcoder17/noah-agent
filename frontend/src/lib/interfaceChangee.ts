// Le serveur sert-il une autre interface que celle de cette page ? Lu seulement par le bandeau « Noah a été mis à jour » (chargé à part).
// --- Interface plus récente sur le serveur ---------------------------------------------------------------------------------
// index.html nomme le script d'entrée (assets/index-AbC123xy.js) : si le serveur en sert un autre que celui de cette page,
// l'interface a changé. Aucune route de plus : c'est le même fichier que la page a chargé, relu avec le réseau d'abord.

const entree = (html: string) => /<script\b[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";

/** Le script d'entrée de la page ouverte (vide en développement et dans les tests : rien à comparer). */
export function entreeOuverte(): string {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return script ? new URL(script.src, location.href).pathname : "";
}

/** Vrai si le serveur sert maintenant une autre interface que celle de cette page. Injoignable ou illisible : faux. */
export async function interfaceChangee(): Promise<boolean> {
  const ouverte = entreeOuverte();
  if (!ouverte) return false;
  try {
    const r = await fetch("/", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return false;
    const servie = entree(await r.text());
    return Boolean(servie) && new URL(servie, location.href).pathname !== ouverte;
  } catch {
    return false;
  }
}
