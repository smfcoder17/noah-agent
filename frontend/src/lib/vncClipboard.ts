import { get, send } from "@/lib/api";

// Presse-papiers entre l'ordinateur de l'utilisateur et l'écran de l'agent (noVNC, même origine que Noah Agent).
//
// noVNC envoie chaque touche à la machine distante, mais pas le texte copié. On ne passe pas par le presse-papiers
// X de la machine (le focus clavier s'y perd entre les fenêtres de Firefox) : Noah Agent agit dans le navigateur
// lui-même, dans l'onglet où l'utilisateur vient de cliquer.
// - Ctrl+V : la touche n'est pas envoyée ; le navigateur lit le presse-papiers (événement « paste », sans demande
//   d'autorisation) et Noah Agent tape ce texte là où est le curseur.
// - Ctrl+C / Ctrl+X : la touche part normalement ; Noah Agent lit le texte sélectionné et le met dans le
//   presse-papiers de l'utilisateur.

const isShortcut = (e: KeyboardEvent, key: string) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === key;

export function wireClipboard(frame: HTMLIFrameElement, agentId: string, onError: (message: string) => void): () => void {
  const win = frame.contentWindow;
  if (!win) return () => {};

  const onKey = (e: KeyboardEvent) => {
    if (isShortcut(e, "v")) {
      // Pas de preventDefault : le navigateur doit déclencher « paste ». noVNC, lui, ne voit pas la touche.
      e.stopImmediatePropagation();
    } else if (isShortcut(e, "c") || isShortcut(e, "x")) {
      get<{ texte: string }>(`/api/agents/${agentId}/clipboard/copy`)
        .then((r) => (r.texte ? win.navigator.clipboard.writeText(r.texte) : undefined))
        .catch(() => onError("Copie impossible : sélectionne le texte puis réessaie."));
    }
  };
  // V relâché : noVNC n'a pas vu son appui, il ne doit pas voir son relâchement non plus.
  const onKeyUp = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") e.stopImmediatePropagation();
  };
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) send(`/api/agents/${agentId}/clipboard/paste`, { texte: text }).catch((err) => onError((err as Error).message));
  };

  win.addEventListener("keydown", onKey, true);
  win.addEventListener("keyup", onKeyUp, true);
  win.addEventListener("paste", onPaste, true);
  return () => {
    win.removeEventListener("keydown", onKey, true);
    win.removeEventListener("keyup", onKeyUp, true);
    win.removeEventListener("paste", onPaste, true);
  };
}
