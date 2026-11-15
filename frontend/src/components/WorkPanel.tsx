// Panneau de droite, comme l'explorateur d'un éditeur de code : il s'ouvre à côté de la conversation, se règle en largeur,
// s'étend sur toute la page et se ferme par Échap. Sur un téléphone, c'est une feuille plein écran avec Retour.
import { ArrowLeft, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { PanelTab } from "./SidePanel";
import { PANEL_MIN, panelMax, usePanelWidth, useWide } from "@/lib/workPanel";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

const STEP = 32;

/** Une couche posée au-dessus (dialogue, visionneuse) reçoit Échap d'abord : le panneau ne se ferme pas avec elle. */
/** Seule une couche visible compte : un nœud resté monté mais masqué ne bloque pas Échap (relecture 0.3.0, partie 2 n°5). */
const covered = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"], .right-panel, [role="menu"]')].some((el) => {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const style = getComputedStyle(at);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
});

export function WorkPanel({ open, tab, title, expanded, onExpand, onClose, children }: {
  /** Gardé monté une fois ouvert (l'écran de l'ordinateur reste connecté) : fermé, il ne prend plus ni focus ni Échap. */
  open: boolean; tab: PanelTab; title: string; expanded: boolean; onExpand: (on: boolean) => void; onClose: () => void; children: React.ReactNode;
}) {
  const wide = useWide();
  const [width, setWidth] = usePanelWidth(tab);
  const self = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Ouvert : le focus entre dans le panneau ; fermé : il revient là où il était (l'icône qui l'a ouvert).
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    self.current?.focus({ preventScroll: true });
    return () => { if (before?.isConnected && !before.closest("[hidden]")) before.focus({ preventScroll: true }); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || covered()) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);

  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const right = self.current?.getBoundingClientRect().right ?? window.innerWidth;
    let last = width;
    const move = (m: PointerEvent) => { last = right - m.clientX; setWidth(last, false); }; // retenue au relâchement seulement
    const up = () => {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); handle.removeEventListener("pointercancel", up);
      setWidth(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const nudge = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setWidth(width + STEP);
    else if (e.key === "ArrowRight") setWidth(width - STEP);
    else if (e.key === "Home") setWidth(PANEL_MIN);
    else if (e.key === "End") setWidth(panelMax());
    else return;
    e.preventDefault();
  };

  return (
    <aside ref={self} tabIndex={-1} className={cn("work-panel", expanded && wide && "is-expanded")} style={wide && !expanded ? { width } : undefined}
      aria-label={title} data-panel={tab}>
      {wide && !expanded && (
        <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t("Largeur du panneau")} aria-valuemin={PANEL_MIN} aria-valuemax={panelMax()} aria-valuenow={width}
          className="work-panel-grip" onPointerDown={drag} onKeyDown={nudge} />
      )}
      <header className="work-panel-head">
        {!wide && <button type="button" className="shell-icon fill" aria-label={t("Retour")} onClick={onClose}><ArrowLeft size={20} /></button>}
        <h2>{title}</h2>
        {wide && <button type="button" className="shell-icon" aria-label={expanded ? t("Réduire le panneau") : t("Étendre sur toute la page")} title={expanded ? t("Réduire le panneau") : t("Étendre sur toute la page")} aria-pressed={expanded} onClick={() => onExpand(!expanded)}>
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>}
        {wide && <button type="button" className="shell-icon" aria-label={t("Fermer le panneau")} title={t("Fermer le panneau (Échap)")} onClick={onClose}><X size={18} /></button>}
      </header>
      <div className="work-panel-body">{children}</div>
    </aside>
  );
}
