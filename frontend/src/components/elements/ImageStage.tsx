// L'image ouverte dans la visionneuse, et son zoom. L'ancien zoom agrandissait l'image par `transform: scale` dans une grille
// centrée : la taille calculée de l'image ne changeait pas, donc la zone de défilement non plus, et tout ce qui dépassait en haut
// et à gauche restait hors d'atteinte (l'image paraissait rognée). Ici l'image zoomée prend sa vraie taille (largeur et hauteur
// d'ajustement × zoom) dans une zone qui défile, centrée par `margin: auto` : chaque bord se rejoint en faisant défiler ou en
// faisant glisser l'image. Le point au centre de la vue reste au centre quand le zoom change.
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "@/i18n";

const MIN = 1, MAX = 4;
const clamp = (z: number) => Math.max(MIN, Math.min(MAX, z));

export function ImageStage({ src, alt, onError, onClose }: { src: string; alt: string; onError: () => void; onClose?: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [zoom, setZoomState] = useState(1);
  /** La taille de l'image ajustée à la vue (zoom 1), relevée au chargement et quand la vue change de taille. */
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  /** Le point de l'image au centre de la vue, en proportion, à garder au centre après un changement de zoom. */
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const points = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; zoom: number; y: number; x: number; moved: boolean } | null>(null);

  const measure = () => {
    const el = img.current;
    if (el && zoom === 1 && el.clientWidth && el.clientHeight) setFit({ w: el.clientWidth, h: el.clientHeight });
  };
  const setZoom = (next: number) => {
    const s = stage.current, z = clamp(next);
    if (z === zoom) return;
    if (zoom === 1) measure();
    if (s && s.scrollWidth && s.scrollHeight) anchor.current = { x: (s.scrollLeft + s.clientWidth / 2) / s.scrollWidth, y: (s.scrollTop + s.clientHeight / 2) / s.scrollHeight };
    setZoomState(z);
  };
  useLayoutEffect(() => {
    const s = stage.current, a = anchor.current;
    anchor.current = null;
    if (!s || !a) return;
    s.scrollLeft = a.x * s.scrollWidth - s.clientWidth / 2;
    s.scrollTop = a.y * s.scrollHeight - s.clientHeight / 2;
  }, [zoom]);
  useLayoutEffect(() => {
    const s = stage.current;
    if (!s || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => measure());
    watch.observe(s);
    return () => watch.disconnect();
  });

  const zoomed = zoom > 1 && fit;
  const size = zoomed ? { width: fit.w * zoom, height: fit.h * zoom, maxWidth: "none", maxHeight: "none" } : undefined;
  return (
    <>
      <div ref={stage} className="image-stage" data-zoom={zoom} style={{ cursor: zoom > 1 ? "grab" : undefined }}
        onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); } }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const p = [...points.current.values()];
          gesture.current = { distance: p.length === 2 ? Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) : 0, zoom, y: e.clientY, x: e.clientX, moved: false };
        }}
        onPointerMove={(e) => {
          const before = points.current.get(e.pointerId);
          if (!before) return;
          points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const p = [...points.current.values()], g = gesture.current;
          if (p.length === 2 && g?.distance) { setZoom(g.zoom * Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) / g.distance); return; }
          // Un doigt ou la souris, image agrandie : l'image suit le geste.
          if (p.length === 1 && zoom > 1 && stage.current) {
            stage.current.scrollLeft -= e.clientX - before.x;
            stage.current.scrollTop -= e.clientY - before.y;
            if (g) g.moved = true;
          }
        }}
        onPointerUp={(e) => {
          const g = gesture.current;
          if (points.current.size === 1 && zoom === 1 && g && e.clientY - g.y > 120) onClose?.();
          points.current.delete(e.pointerId);
        }}
        onPointerCancel={(e) => points.current.delete(e.pointerId)}
        onDoubleClick={() => setZoom(zoom > 1 ? 1 : 2)}>
        <img ref={img} src={src} alt={alt} draggable={false} onError={onError} onLoad={measure} style={size} />
      </div>
      <label className="image-zoom">{t("Zoom")} <input type="range" min={MIN} max={MAX} step=".1" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
    </>
  );
}
