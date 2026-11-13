import { memo } from "react";
import { Inbox, Plus, Search, Settings, Target } from "lucide-react";
import type { Agent, Conversation } from "@/lib/api";
import type { NavTab } from "@/lib/navPrefs";
import { AgentNav } from "../AgentNav";

/**
 * Barre de gauche, sur le modèle de Grok Bot : ce qui attend la personne, puis ses agents alignés. L'agent ouvert
 * déplie ses options et son historique ; en bas, quatre entrées fixes.
 */
export const SideRail = memo(function SideRail({ waiting = 0, onInbox, agent, agents = [], tabs, active, conversations, activeThread = null, onTab, onAgent, onPickAgent, onMenu, onThread, onSettings, onGoals, onNewAgent }: {
  waiting?: number; onInbox?: () => void; agent: Agent | null;
  /** Tous les agents, dans l'ordre du serveur (épinglés d'abord). */
  agents?: Agent[];
  tabs: NavTab[]; active: NavTab;
  /** Les fils de l'agent ouvert : sa discussion, et son historique. */
  conversations: Conversation[];
  /** Le fil ouvert, pour le marquer dans l'historique. */
  activeThread?: string | null;
  onTab: (t: NavTab) => void;
  /** Ouvre la page de l'agent ouvert. */
  onAgent: () => void;
  /** Ouvre l'agent donné, depuis sa ligne. */
  onPickAgent?: (id: string) => void;
  /** Recherche : agents et fils. */
  onMenu: () => void;
  onThread: (id: string | null) => void;
  onSettings: () => void; onGoals: () => void;
  onNewAgent?: () => void;
}) {
  const list = agents.length ? agents : agent ? [agent] : [];
  return <aside className="side-rail" aria-label="Navigation ordinateur">
    <button className="rail-row" onClick={onInbox}><Inbox size={18} /><span>À toi</span>{waiting > 0 ? <span className="rail-count ml-auto" aria-label={`${waiting} en attente`}>{waiting}</span> : <span className="sr-only">0 en attente</span>}</button>
    <h2 className="section-label rail-agents-label">Agents</h2>
    <nav aria-label="Navigation" className="rail-agents-scroll">
      <AgentNav agents={list} agentId={agent?.id ?? null} tabs={tabs} active={active} conversations={conversations} activeThread={activeThread}
        onPick={(id) => (onPickAgent ? onPickAgent(id) : onAgent())} onTab={onTab} onThread={onThread} onAgentPage={onAgent} />
    </nav>
    <div className="rail-bottom">
      {onNewAgent && <button className="rail-row" onClick={onNewAgent}><Plus size={18} /><span>Nouvel agent</span></button>}
      <button className="rail-row" onClick={onGoals}><Target size={18} /><span>Objectifs</span></button>
      <button className="rail-row" onClick={onMenu}><Search size={18} /><span>Rechercher</span></button>
      <button className="rail-row" onClick={onSettings}><Settings size={18} /><span>Réglages</span></button>
    </div>
  </aside>;
});
