import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type AgentMenuItem = { key: string; label: string; run: () => void };

/**
 * Le menu d'un agent (personnaliser, page de l'agent) : ouvert par ses trois petits points ou par un clic droit sur sa ligne.
 * `at` le pose au pointeur, hors de la barre (qui défile et se replie) ; sans `at`, il reste en place sous la ligne (tiroir du téléphone).
 * Le clavier y entre au premier choix ; Échap, un clic ailleurs ou un défilement le referment, Échap rend le focus à son point d'appel.
 */
export function AgentMenu({ label, items, at, onClose, onEscape }: { label: string; items: AgentMenuItem[]; at?: { x: number; y: number }; onClose: () => void; onEscape?: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const entries = () => [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    entries()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); onEscape?.(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = entries(), at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      } else if (e.key === "Tab") onClose();
    };
    // Un clic sur les points qui l'ont ouvert le referme lui-même (sinon il se refermerait puis se rouvrirait).
    const away = (e: Event) => { if (!box.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[data-agent-more]")) onClose(); };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, onEscape]);
  const style = at ? { left: Math.max(8, Math.min(at.x, window.innerWidth - 216)), top: Math.max(8, Math.min(at.y, window.innerHeight - 16 - items.length * 40)) } : undefined;
  const menu = (
    <div ref={box} role="menu" aria-label={label} className={at ? "agent-menu is-floating" : "agent-menu"} style={style} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {items.map((it) => <button key={it.key} type="button" role="menuitem" className="agent-menu-item" onClick={() => { it.run(); onClose(); }}>{it.label}</button>)}
    </div>
  );
  return at ? createPortal(menu, document.body) : menu;
}
