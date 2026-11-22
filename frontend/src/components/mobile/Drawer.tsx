import { Activity, Inbox, Plus, Search, Settings, Target, LogOut, SlidersHorizontal } from "lucide-react";
import type { Agent, Me } from "@/lib/api";
import { Dialog, DialogContent } from "../ui";
import type { NavTab } from "@/lib/navPrefs";
import { AgentNav } from "../AgentNav";
import { roleDit } from "../desktop/SideRail";
import { t } from "@/i18n";

/** Le menu du téléphone est la barre de l'ordinateur en tiroir : Pour toi, Activité, la recherche, les agents alignés, Nouvel agent, puis Réglages et le compte. */
export function Drawer({ waiting = 0, onInbox, onActivity, onSearch, activityDot = false, me = null, agents, agentId, active = "chat", onAgent, onAgentPage, onCustomizeAgent, onNewAgent, tabs, onTab, onCustomize, onSettings, onGoals, onClose, onLogout }: {
  waiting?: number; onInbox?: () => void; onActivity?: () => void; /** Ouvre la page Rechercher. */ onSearch?: () => void; activityDot?: boolean; me?: Me | null; agents: Agent[]; agentId: string | null; tabs: NavTab[];
  active?: NavTab;
  onAgent: (id: string) => void; onAgentPage?: (id: string) => void; onCustomizeAgent?: (id: string) => void; onNewAgent: () => void; onTab: (tab: NavTab) => void;
  onCustomize: () => void; onSettings: () => void; onGoals: () => void; onClose: () => void; onLogout: () => void;
}) {
  const name = me?.username ?? "";
  return <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title={t("Menu")} className="mobile-drawer">
    <div className="rail-top"><span className="rail-brand">Noah</span></div>
    <button type="button" className="rail-row" onClick={onInbox}><Inbox size={18} aria-hidden /><span className="rail-label">{t("Pour toi")}</span><span className={waiting > 0 ? "rail-count ml-auto" : "ml-auto"} aria-label={t("{n} en attente", { n: waiting })}>{waiting}</span></button>
    {onActivity && <button type="button" className="rail-row" onClick={onActivity}><Activity size={18} aria-hidden /><span className="rail-label">{t("Activité")}</span>{activityDot && <span className="dot glow ml-auto" role="img" aria-label={t("Des routines viennent de passer")} />}</button>}
    {onSearch && <button type="button" className="rail-row" onClick={onSearch}><Search size={18} aria-hidden /><span className="rail-label">{t("Rechercher")}</span></button>}
    <h2 className="section-label rail-agents-label">{t("Agents")}</h2>
    <nav aria-label={t("Navigation")}>
      <AgentNav variant="drawer" agents={agents} agentId={agentId} tabs={tabs} active={active}
        onPick={onAgent} onTab={(tab) => { onTab(tab); onClose(); }} onAgentPage={(id) => { onClose(); onAgentPage?.(id); }} onCustomize={onCustomizeAgent && ((id) => { onClose(); onCustomizeAgent(id); })} />
      <button type="button" className="rail-row" onClick={onNewAgent}><Plus size={18} aria-hidden /><span className="rail-label">{t("Nouvel agent")}</span></button>
    </nav>
    <div className="rail-bottom">
      <button type="button" className="rail-row" onClick={onGoals}><Target size={18} aria-hidden /><span className="rail-label">{t("Objectifs")}</span></button>
      <button type="button" className="rail-row" onClick={onCustomize}><SlidersHorizontal size={18} aria-hidden /><span className="rail-label">{t("Personnaliser les onglets")}</span></button>
      <button type="button" className="rail-row" onClick={onSettings}><Settings size={18} aria-hidden /><span className="rail-label">{t("Réglages")}</span></button>
      <button type="button" className="rail-row" onClick={onLogout}><LogOut size={18} aria-hidden /><span className="rail-label">{t("Me déconnecter")}</span></button>
      {name && <div className="rail-account static"><span className="avatar plain" aria-hidden>{name.charAt(0).toUpperCase()}</span><span className="agent-nav-text"><b>{name}</b><small className="text-muted-foreground">{roleDit(me)}</small></span></div>}
    </div>
  </DialogContent></Dialog>;
}
