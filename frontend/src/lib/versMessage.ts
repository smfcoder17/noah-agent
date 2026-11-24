// Aller à un message du fil : « Voir dans le fil » d'une question de « Pour toi » ouvre la conversation (App.openFromInbox), puis ce module
// attend que le message soit à l'écran (le fil se charge après l'ouverture), le fait défiler au centre et le met en évidence un instant.
// Un message du serveur s'affiche sous l'identifiant `h<id>` (useAgentChat.fromStored) ; Thread le porte dans `data-noah-msg`.

const DELAI = 10_000; // le fil met parfois du temps à venir ; au-delà, le lien n'a plus d'effet
const EVIDENCE = 2200;

// Visible seulement : un fil gardé en mémoire derrière « Pour toi » (KeepAlive) a déjà le message, mais caché.
const cible = (id: number): HTMLElement | null => {
  const el = document.querySelector<HTMLElement>(`[data-noah-msg="h${id}"]`);
  return el && el.getClientRects().length > 0 ? el : null;
};

function placer(el: HTMLElement) {
  el.scrollIntoView({ block: "center", behavior: "auto" });
  el.animate?.([{ backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)" }, { backgroundColor: "transparent" }], { duration: EVIDENCE, easing: "ease-out" });
}

/** Fait défiler jusqu'au message `id` dès qu'il existe, et le met en évidence. Rend de quoi annuler l'attente. */
export function viserMessage(id: number | null | undefined): () => void {
  if (id == null) return () => {};
  let fini = false;
  const observer = new MutationObserver(() => trouve());
  const arret = () => { fini = true; observer.disconnect(); window.clearTimeout(attente); };
  const attente = window.setTimeout(arret, DELAI);
  function trouve() {
    const el = cible(id as number);
    if (!el || fini) return;
    arret();
    placer(el);
    // Le fil se cale parfois en bas juste après son chargement : si le message n'est plus au centre, on y revient une fois.
    window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      if (el.isConnected && (r.bottom < 0 || r.top > window.innerHeight)) el.scrollIntoView({ block: "center", behavior: "auto" });
    }, 400);
  }
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
  trouve();
  return arret;
}
