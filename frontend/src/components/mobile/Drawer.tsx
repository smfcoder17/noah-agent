import { useState } from "react";
import type { Agent, Conversation } from "@/lib/api";
import { AgentFace } from "../Noah";
import { Dialog, DialogContent } from "../ui";
import { TAB_NAMES, type NavTab } from "@/lib/navPrefs";

export function Drawer({ waiting = 0, onInbox, agents, agentId, conversations, onAgent, onThread, onNewAgent, tabs, onTab, onCustomize, onSettings, onGoals, onClose, onLogout }: {
  waiting?: number; onInbox?: () => void; agents: Agent[]; agentId: string | null; conversations: Conversation[]; tabs: NavTab[];
  onAgent: (id: string) => void; onThread: (id: string | null) => void; onNewAgent: () => void; onTab: (tab: NavTab) => void;
  onCustomize: () => void; onSettings: () => void; onGoals: () => void; onClose: () => void; onLogout: () => void;
}) {
  const [query, setQuery] = useState("");
  return <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent title="Menu" className="mobile-drawer">
    <label className="sr-only" htmlFor="drawer-search">Rechercher</label><input id="drawer-search" className="shell-search" placeholder="Rechercher" value={query} onChange={(e) => setQuery(e.target.value)} />
    <button className="shell-row" onClick={onInbox}>À toi<span className="ml-auto" aria-label={`${waiting} en attente`}>{waiting}</span></button>
    <h2 className="section-label">Agents</h2><div className="shell-group">{agents.filter((a) => a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((a) => <button key={a.id} className="shell-row" aria-current={a.id === agentId ? "page" : undefined} onClick={() => onAgent(a.id)}><AgentFace agent={a} className="size-[46px]" /><b>{a.name}</b></button>)}<button className="shell-row" onClick={onNewAgent}>＋ Nouvel agent</button></div>
    <h2 className="section-label">Discussions</h2><div className="shell-group">{conversations.filter((c) => c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((c) => <button className="shell-row" key={c.id} onClick={() => { onThread(c.main ? null : c.id); onClose(); }}>{c.title}</button>)}{!conversations.length && <p className="shell-row">Aucune discussion.</p>}</div>
    <div className="flex items-center justify-between"><h2 className="section-label">Onglets</h2><button onClick={onCustomize}>Personnaliser</button></div><div className="shell-group">{tabs.map((tab) => <button className="shell-row" key={tab} onClick={() => onTab(tab)}>{TAB_NAMES[tab]}<span className="ml-auto" aria-hidden>⠿</span></button>)}</div>
    <div className="shell-group mt-auto"><button className="shell-row" onClick={onGoals}>Objectifs</button><button className="shell-row" onClick={onSettings}>Réglages<span className="ml-auto" aria-hidden>›</span></button><button className="shell-row" onClick={onLogout}>Me déconnecter</button></div>
  </DialogContent></Dialog>;
}
