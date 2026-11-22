import { useEffect } from "react";
import { apercuSeSuperpose } from "@/lib/workPanel";

/** Tant que l'aperçu est ouvert à droite, mesure ce qui reste à la discussion ; trop peu : `data-apercu="sur"` sur le body, et l'aperçu prend la
 * place exacte du panneau (styles/desktop.css) au lieu de pousser la page. Chargé à la demande, avec l'aperçu : il ne pèse pas sur le premier écran. */
export default function ApercuSurLePanneau() {
  useEffect(() => {
    const mesurer = () => {
      const largeur = (sel: string) => { const el = document.querySelector<HTMLElement>(sel); return el && el.offsetParent !== null ? el.getBoundingClientRect().width : 0; };
      const panneau = document.querySelector(".work-panel.is-expanded") ? Infinity : largeur(".work-panel");
      const libre = document.documentElement.clientWidth - largeur(".side-rail") - panneau;
      if (apercuSeSuperpose(libre)) {
        document.body.dataset.apercu = "sur";
        if (Number.isFinite(panneau) && panneau > 0) document.body.style.setProperty("--apercu-largeur", `${Math.round(panneau)}px`);
      } else { delete document.body.dataset.apercu; document.body.style.removeProperty("--apercu-largeur"); }
    };
    mesurer();
    window.addEventListener("resize", mesurer);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mesurer);
    const zone = document.querySelector(".work-area");
    if (zone) observer?.observe(zone);
    return () => { window.removeEventListener("resize", mesurer); observer?.disconnect(); delete document.body.dataset.apercu; document.body.style.removeProperty("--apercu-largeur"); };
  }, []);
  return null;
}
