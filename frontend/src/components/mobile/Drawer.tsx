import { useState } from "react";
import type { Agent, Conversation } from "@/lib/api";
import { Dialog, DialogContent } from "../ui";
import type { NavTab } from "@/lib/navPrefs";
import { AgentNav } from "../AgentNav";

/** Le menu du téléphone suit la barre de l'ordinateur : À toi, les agents alignés, l'agent ouvert déplié, peu d'entrées en bas. */
export function Drawer({ waiting = 0, onInbox, agents, agentId, conversations, active = "chat", activeThread = null, onAgent, onAgentPage, onThread, onNewAgent, tabs, onTab, onCustomize, onSettings, onGoals, onClose, onLogout }: {
  waiting?: number; onInbox?: () => void; agents: Agent[]; agentId: string | null; conversations: Conversation[]; tabs: NavTab[];
  active?: NavTab; activeThread?: string | null;
  onAgent: (id: string) => void; onAgentPage?: () => void; onThread: (id: string | null) => void; onNewAgent: () => void; onTab: (tab: NavTab) => void;
  onCustomize: () => void; onSettings: () => void; onGoals: () => void; onClose: () => void; onLogout: () => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  const found = q ? conversations.filter((c) => c.title.toLocaleLowerCase().includes(q)) : [];
  const shown = q ? agents.filter((a) => a.name.toLocaleLowerCase().includes(q)) : agents;
  return <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title="Menu" className="mobile-drawer">
    <label className="sr-only" htmlFor="drawer-search">Rechercher</label><input id="drawer-search" className="shell-search" placeholder="Rechercher" value={query} onChange={(e) => setQuery(e.target.value)} />
    <button className="shell-row" onClick={onInbox}>À toi<span className={waiting > 0 ? "rail-count ml-auto" : "ml-auto"} aria-label={`${waiting} en attente`}>{waiting}</span></button>
    <h2 className="section-label">Agents</h2>
    <nav aria-label="Navigation">
      <AgentNav variant="drawer" agents={shown} agentId={agentId} tabs={tabs} active={active} conversations={conversations} activeThread={activeThread}
        onPick={onAgent} onTab={(t) => { onTab(t); onClose(); }} onThread={(id) => { onThread(id); onClose(); }} onAgentPage={() => { onClose(); onAgentPage?.(); }} />
    </nav>
    {q && <><h2 className="section-label">Fils trouvés</h2><div className="shell-group">{found.map((c) => <button className="shell-row" key={c.id} onClick={() => { onThread(c.main ? null : c.id); onClose(); }}>{c.title}</button>)}{!found.length && <p className="shell-row">Aucun fil.</p>}</div></>}
    <div className="shell-group mt-auto"><button className="shell-row" onClick={onNewAgent}>＋ Nouvel agent</button><button className="shell-row" onClick={onGoals}>Objectifs</button><button className="shell-row" onClick={onCustomize}>Personnaliser les onglets</button><button className="shell-row" onClick={onSettings}>Réglages<span className="ml-auto" aria-hidden>›</span></button><button className="shell-row" onClick={onLogout}>Me déconnecter</button></div>
  </DialogContent></Dialog>;
}
