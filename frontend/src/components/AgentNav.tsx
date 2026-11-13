import { memo, useEffect, useState } from "react";
import { ChevronDown, History, SlidersHorizontal } from "lucide-react";
import type { Agent, Conversation } from "@/lib/api";
import { TAB_NAMES, type NavTab } from "@/lib/navPrefs";
import { cn } from "@/lib/utils";
import { TAB_ICONS } from "./mobile/BottomTabs";
import { agentSummary, StateShape } from "./Sidebar";
import { AgentFace } from "./Noah";

/** Ce que l'agent attend de la personne : ses accords et ses choix. */
export const pendingOf = (a: Agent) => (a.tasks?.approve ?? 0) + (a.tasks?.choice ?? 0);

/** L'historique d'un agent : ses fils hors conversation principale. Les ouverts d'abord, les archivés à part. */
export function historyOf(conversations: Conversation[]) {
  const others = conversations.filter((c) => !c.main);
  return { open: others.filter((c) => !c.archived), archived: others.filter((c) => c.archived) };
}

/**
 * Les agents, alignés en haut de la barre, comme une liste de contacts : une ligne par agent, avec son état.
 * Seul l'agent ouvert déplie ses options dessous (Discussion par défaut, puis les onglets choisis) et son historique :
 * une seule discussion par agent dans la barre, les autres fils restent à un clic.
 */
export const AgentNav = memo(function AgentNav({ agents, agentId, tabs, active, conversations, activeThread = null, onPick, onTab, onThread, onAgentPage, variant = "rail" }: {
  agents: Agent[];
  agentId: string | null;
  tabs: NavTab[];
  /** L'option ouverte de l'agent sélectionné. */
  active: NavTab;
  /** Les fils de l'agent sélectionné. */
  conversations: Conversation[];
  /** Le fil ouvert à la place de la conversation principale. */
  activeThread?: string | null;
  onPick: (id: string) => void;
  onTab: (t: NavTab) => void;
  onThread: (id: string | null) => void;
  /** La page de l'agent : cerveau, autonomie, apparence. */
  onAgentPage: () => void;
  variant?: "rail" | "drawer";
}) {
  const [folded, setFolded] = useState(false);
  const [historyAsked, setHistoryAsked] = useState<boolean | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Un autre agent s'ouvre déplié, l'historique replié.
  useEffect(() => { setFolded(false); setHistoryAsked(null); setArchivedOpen(false); }, [agentId]);
  const { open: history, archived } = historyOf(conversations);
  const inHistory = !!activeThread && conversations.some((c) => c.id === activeThread && !c.main);
  // L'historique s'ouvre seul quand on y lit un fil, et signale ceux qui travaillent ou attendent.
  const historyOpen = historyAsked ?? inHistory;
  const busy = history.filter((c) => c.en_cours).length;
  const options = tabs.includes("chat") ? tabs : (["chat", ...tabs] as NavTab[]);

  const thread = (c: Conversation) => (
    <button key={c.id} type="button" className="agent-nav-thread" title={c.title}
      aria-current={c.id === activeThread ? "page" : undefined}
      onClick={() => onThread(c.id)}>
      <span className="truncate">{c.title}</span>{c.en_cours && <span className="rail-dot" aria-label="en cours" />}
    </button>
  );

  return (
    <ul className={cn("agent-nav", variant === "drawer" && "agent-nav-drawer")} aria-label="Agents">
      {agents.map((a) => {
        const selected = a.id === agentId;
        const expanded = selected && !folded;
        const s = agentSummary(a);
        const pending = pendingOf(a);
        const panelId = `agent-nav-options-${a.id}`;
        return (
          <li key={a.id} className={cn("agent-nav-item", selected && "is-selected")}>
            <div className="agent-nav-head">
              <button type="button" className="agent-nav-row"
                aria-current={selected ? "true" : undefined}
                aria-expanded={selected ? expanded : false}
                aria-controls={selected ? panelId : undefined}
                aria-label={`${a.name}, ${s.text}${!selected && pending ? ` · ${pending} en attente` : ""}`}
                title={a.name}
                onClick={() => (selected ? setFolded(!folded) : onPick(a.id))}>
                <AgentFace agent={a} className={cn("shrink-0", variant === "drawer" ? "size-10" : "size-8")} />
                <span className="agent-nav-text">
                  <b>{a.name}</b>
                  <small className={s.tone}><StateShape state={s.state} />{s.text}</small>
                </span>
                {!selected && pending > 0 && <span className="rail-count" aria-hidden>{pending}</span>}
                {selected && <ChevronDown size={15} aria-hidden className={cn("agent-nav-chevron", !expanded && "-rotate-90")} />}
              </button>
              {selected && <button type="button" className="agent-nav-settings" aria-label={`Page de ${a.name}`} title={`Page de ${a.name}`} onClick={onAgentPage}><SlidersHorizontal size={15} /></button>}
            </div>
            {expanded && (
              <div id={panelId} role="group" aria-label={`Options de ${a.name}`} className="agent-nav-options">
                {options.map((t) => {
                  const Icon = TAB_ICONS[t];
                  const current = active === t && (t !== "chat" || !activeThread);
                  return (
                    <button key={t} type="button" className="agent-nav-option" aria-current={current ? "page" : undefined} onClick={() => onTab(t)}>
                      <Icon size={16} aria-hidden /><span>{TAB_NAMES[t]}</span>
                    </button>
                  );
                })}
                {(history.length > 0 || archived.length > 0) && <>
                  <button type="button" className="agent-nav-option" aria-expanded={historyOpen} aria-controls={`${panelId}-historique`} onClick={() => setHistoryAsked(!historyOpen)}>
                    <History size={16} aria-hidden /><span>Historique</span>
                    <span className="ml-auto flex items-center gap-1.5 text-xs tabular-nums">
                      {busy > 0 && !historyOpen && <span className="rail-dot" aria-label={`${busy} en cours`} />}
                      {history.length + archived.length}
                      <ChevronDown size={13} aria-hidden className={cn("transition-transform", !historyOpen && "-rotate-90")} />
                    </span>
                  </button>
                  {historyOpen && (
                    <div id={`${panelId}-historique`} role="group" aria-label={`Historique de ${a.name}`} className="agent-nav-history">
                      {history.map(thread)}
                      {archived.length > 0 && <>
                        <button type="button" className="agent-nav-thread agent-nav-archived" aria-expanded={archivedOpen || archived.some((c) => c.id === activeThread)} onClick={() => setArchivedOpen(!archivedOpen)}>
                          Archivés ({archived.length})
                        </button>
                        {(archivedOpen || archived.some((c) => c.id === activeThread)) && archived.map(thread)}
                      </>}
                    </div>
                  )}
                </>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
});
