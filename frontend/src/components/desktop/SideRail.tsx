import { memo } from "react";
import { Menu, Search, Settings, SquarePen, Target } from "lucide-react";
import type { Agent, Conversation } from "@/lib/api";
import { TAB_NAMES, type NavTab } from "@/lib/navPrefs";
import { TAB_ICONS } from "../mobile/BottomTabs";
import { AgentFace } from "../Noah";

export const SideRail = memo(function SideRail({ agent, tabs, active, conversations, onTab, onAgent, onMenu, onThread, onSettings, onGoals, onNew }: { agent: Agent | null; tabs: NavTab[]; active: NavTab; conversations: Conversation[]; onTab: (t: NavTab) => void; onAgent: () => void; onMenu: () => void; onThread: (id: string | null) => void; onSettings: () => void; onGoals: () => void; onNew: () => void }) {
  return <aside className="side-rail" aria-label="Navigation ordinateur"><button className="rail-agent" onClick={onAgent} aria-label="Page de l'agent">{agent && <AgentFace agent={agent} className="size-[38px]" />}<span><b>{agent?.name || "Noah"}</b><small><i className="status-dot" />{agent?.step || (agent?.online ? "En ligne" : "Hors ligne")}</small></span></button>
    <nav aria-label="Navigation">{tabs.map((t) => { const Icon = TAB_ICONS[t]; return <button className="rail-row" key={t} aria-label={TAB_NAMES[t]} aria-current={active === t ? "page" : undefined} onClick={() => onTab(t)}><Icon size={18} /><span>{TAB_NAMES[t]}</span></button>; })}</nav>
    <div className="flex items-center justify-between"><h2 className="section-label">Discussions</h2><button className="shell-icon" onClick={onNew} aria-label="Nouvelle discussion"><SquarePen size={18} /></button></div>
    <div className="rail-threads">{conversations.map((c) => <button className="rail-thread" key={c.id} onClick={() => onThread(c.main ? null : c.id)}>{c.title}</button>)}</div>
    <nav className="rail-bottom"><button className="rail-row" onClick={onMenu}><Menu size={18} /><span>Mes agents</span></button><button className="rail-row" onClick={onGoals}><Target size={18} /><span>Objectifs</span></button><button className="rail-row" onClick={onMenu}><Search size={18} /><span>Rechercher</span></button><button className="rail-row" onClick={onSettings}><Settings size={18} /><span>Réglages</span></button></nav>
  </aside>;
});
