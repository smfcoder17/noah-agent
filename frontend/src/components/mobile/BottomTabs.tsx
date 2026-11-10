import { Activity, Brain, CheckSquare, FolderOpen, MessageCircle, Monitor, Plug, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { TAB_NAMES, type NavTab } from "@/lib/navPrefs";

export const TAB_ICONS = { chat: MessageCircle, activity: Activity, tasks: CheckSquare, files: FolderOpen, computer: Monitor, connections: Plug, competences: Sparkles, memory: Brain };
export function BottomTabs({ tabs, active, onSelect, onCustomize }: { tabs: NavTab[]; active: NavTab; onSelect: (tab: NavTab) => void; onCustomize: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const held = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  return <nav className="bottom-tabs" aria-label="Navigation">{tabs.map((tab) => { const Icon = TAB_ICONS[tab]; return <button key={tab} type="button" aria-label={TAB_NAMES[tab]} aria-current={active === tab ? "page" : undefined}
    onPointerDown={() => { held.current = false; timer.current = setTimeout(() => { held.current = true; onCustomize(); }, 550); }} onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onContextMenu={(e) => { e.preventDefault(); onCustomize(); }} onClick={() => { if (!held.current) onSelect(tab); held.current = false; }}><Icon size={23} aria-hidden /></button>; })}</nav>;
}
