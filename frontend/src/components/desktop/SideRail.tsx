import { memo } from "react";
import { Check, ChevronRight, Inbox, Menu, Search, Settings, SquarePen, Target } from "lucide-react";
import type { Agent, Conversation } from "@/lib/api";
import { TAB_NAMES, type NavTab } from "@/lib/navPrefs";
import { TAB_ICONS } from "../mobile/BottomTabs";
import { agentSummary, StateShape } from "../Sidebar";
import { AgentFace } from "../Noah";

/** Le nombre d'agents montrés d'office : au-delà, « Mes agents » ouvre la liste complète. */
export const RAIL_AGENTS = 3;

export const SideRail = memo(function SideRail({ waiting = 0, onInbox, agent, agents = [], threads = {}, tabs, active, conversations, activeThread = null, onTab, onAgent, onPickAgent, onMenu, onThread, onOpenAgentThread, onSettings, onGoals, onNew }: {
  waiting?: number; onInbox?: () => void; agent: Agent | null;
  /** Tous les agents : les trois premiers sont montrés, le reste derrière « Mes agents ». */
  agents?: Agent[];
  /** Leurs discussions, déjà lues : chacun montre les siennes sans qu'on ait à cliquer. */
  threads?: Record<string, Conversation[]>;
  tabs: NavTab[]; active: NavTab; conversations: Conversation[];
  /** Le fil ouvert, pour le marquer dans la liste. */
  activeThread?: string | null;
  onTab: (t: NavTab) => void; onAgent: () => void;
  /** Ouvre l'agent donné, depuis sa ligne dans le rail. */
  onPickAgent?: (id: string) => void;
  onMenu: () => void; onThread: (id: string | null) => void;
  /** Ouvre un fil d'un autre agent : l'agent d'abord, puis son fil. */
  onOpenAgentThread?: (agentId: string, convId: string | null) => void;
  onSettings: () => void; onGoals: () => void; onNew: () => void;
}) {
  const summary = agent ? agentSummary(agent) : null;
  const shown = agents.slice(0, RAIL_AGENTS);
  const extra = agents.length - shown.length;
  const pending = (a: Agent) => (a.tasks?.approve ?? 0) + (a.tasks?.choice ?? 0);
  /** Deux ou trois fils par agent : la liste reste courte, la principale n'est pas répétée (elle est la ligne de l'agent). */
  const threadsOf = (a: Agent) => (threads[a.id] ?? []).filter((c) => !c.main && !c.archived).slice(0, 3);
  return <aside className="side-rail" aria-label="Navigation ordinateur"><button className="rail-agent" onClick={onAgent} aria-label="Page de l'agent">{agent && <AgentFace agent={agent} className="size-[38px]" />}<span><b>{agent?.name || "Noah"}</b><small><StateShape state={summary?.state || "offline"} />{summary?.text || "Hors ligne"}</small></span></button>
    <button className="rail-row" onClick={onInbox}><Inbox size={18} /><span>À toi</span><span className="ml-auto" aria-label={`${waiting} en attente`}>{waiting}</span></button>
    <nav aria-label="Navigation">{tabs.map((t) => { const Icon = TAB_ICONS[t]; return <button className="rail-row" key={t} aria-label={TAB_NAMES[t]} aria-current={active === t ? "page" : undefined} onClick={() => onTab(t)}><Icon size={18} /><span>{TAB_NAMES[t]}</span></button>; })}</nav>
    <div className="flex items-center justify-between"><h2 className="section-label">Discussions</h2><button className="shell-icon" onClick={onNew} aria-label="Nouvelle discussion"><SquarePen size={18} /></button></div>
    <div className="rail-threads">{conversations.map((c) => <button className="rail-thread" key={c.id} aria-current={!c.main && c.id === activeThread ? "page" : undefined} title={c.title} onClick={() => onThread(c.main ? null : c.id)}>{c.title}{c.en_cours && <span className="rail-dot" aria-hidden />}</button>)}</div>
    <div className="rail-bottom">
      {/* Les agents, sans clic : trois lignes, et « Mes agents » pour les autres. Leurs fils se lisent dessous. */}
      <div className="rail-agents" role="group" aria-label="Mes agents">
        {shown.map((a) => (
          <div key={a.id} className="rail-agent-block">
            <button className="rail-row rail-agent-row" aria-current={a.id === agent?.id ? "page" : undefined}
              aria-label={`${a.name}${pending(a) ? ` · ${pending(a)} en attente` : ""}`}
              title={a.name}
              onClick={() => (onPickAgent ? onPickAgent(a.id) : onAgent())}>
              <AgentFace agent={a} className="size-[22px]" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              {!!pending(a) && <span className="rail-count">{pending(a)}</span>}
              {a.id === agent?.id && <Check size={14} aria-hidden className="shrink-0 text-accent" />}
            </button>
            {threadsOf(a).map((c) => (
              <button key={c.id} className="rail-thread rail-subthread"
                aria-current={a.id === agent?.id && c.id === activeThread ? "page" : undefined}
                title={`${a.name} · ${c.title}`}
                onClick={() => (onOpenAgentThread ? onOpenAgentThread(a.id, c.id) : onThread(c.id))}>
                {c.title}{c.en_cours && <span className="rail-dot" aria-hidden />}
              </button>
            ))}
          </div>
        ))}
      </div>
      <button className="rail-row" onClick={onMenu}><Menu size={18} /><span>Mes agents</span><span className="ml-auto flex items-center gap-1 tabular-nums">{extra > 0 ? agents.length : ""}<ChevronRight size={14} aria-hidden /></span></button>
      <button className="rail-row" onClick={onGoals}><Target size={18} /><span>Objectifs</span></button>
      <button className="rail-row" onClick={onMenu}><Search size={18} /><span>Rechercher</span></button>
      <button className="rail-row" onClick={onSettings}><Settings size={18} /><span>Réglages</span></button>
    </div>
  </aside>;
});
