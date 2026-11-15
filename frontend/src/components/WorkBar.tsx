// Barre du haut à droite de la conversation : une icône par contenu de l'agent, chacune avec son infobulle.
// Sur un téléphone, les mêmes entrées se replient dans un menu « … ».
import { Bug, MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { PanelTab } from "./SidePanel";
import type { Agent } from "@/lib/api";
import { workTabsFor } from "@/lib/workPanel";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type Props = { agent: Agent | null; active: PanelTab | null; onOpen: (tab: PanelTab) => void; details: boolean; onDetails: (on: boolean) => void };

/** Une icône seule ; son nom s'affiche au survol et au focus clavier, et c'est aussi son nom accessible. */
function BarIcon({ label, pressed, current, onClick, children }: { label: string; pressed?: boolean; current?: boolean; onClick: () => void; children: React.ReactNode }) {
  const tip = useId();
  return (
    <button type="button" className={cn("work-icon", current && "is-current")} aria-label={label} aria-describedby={tip} aria-pressed={pressed} aria-current={current ? "true" : undefined} onClick={onClick}>
      {children}
      <span role="tooltip" id={tip} className="work-tip">{label}</span>
    </button>
  );
}

export function WorkBar({ agent, active, onOpen, details, onDetails }: Props) {
  const tabs = workTabsFor(agent);
  return (
    <nav className="work-bar" aria-label={t("Contenus de l'agent")}>
      {tabs.map(({ tab, label, Icon }) => (
        <BarIcon key={tab} label={label} current={active === tab} onClick={() => onOpen(tab)}><Icon size={18} aria-hidden /></BarIcon>
      ))}
      <BarIcon label={t("Détails techniques")} pressed={details} onClick={() => onDetails(!details)}><Bug size={18} aria-hidden /></BarIcon>
    </nav>
  );
}

/** Le téléphone : un bouton « … » qui déroule les mêmes entrées, assez grandes pour le doigt. */
export function WorkMenu({ agent, active, onOpen, details, onDetails }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const tabs = workTabsFor(agent);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); box.current?.querySelector<HTMLButtonElement>("button")?.focus(); } };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key); };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  // Le focus revient sur « … » avant que l'entrée choisie disparaisse : le panneau ouvert le rendra là (relecture 0.3.0, partie 2 n°2).
  const pick = (action: () => void) => { setOpen(false); box.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); action(); };
  return (
    <div className="work-menu" ref={box}>
      <button type="button" className="shell-icon fill" aria-label={t("Contenus de l'agent")} aria-haspopup="menu" aria-expanded={open} disabled={!agent} onClick={() => setOpen(!open)}><MoreHorizontal size={20} /></button>
      {open && (
        <div role="menu" aria-label={t("Contenus de l'agent")} className="work-menu-list" onKeyDown={move}>
          {tabs.map(({ tab, label, Icon }) => (
            <button key={tab} type="button" role="menuitem" aria-current={active === tab ? "true" : undefined} onClick={() => pick(() => onOpen(tab))}><Icon size={20} aria-hidden /><span>{label}</span></button>
          ))}
          <button type="button" role="menuitemcheckbox" aria-checked={details} onClick={() => pick(() => onDetails(!details))}><Bug size={20} aria-hidden /><span>{t("Détails techniques")}</span></button>
        </div>
      )}
    </div>
  );
}
