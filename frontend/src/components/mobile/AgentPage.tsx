import { Brain, ChevronRight, Shield, Plug, Sparkles, BookOpen, Palette, Bell } from "lucide-react";
import { type Agent, canAdmin } from "@/lib/api";
import type { PanelTab } from "../SidePanel";
import { AgentFace } from "../Noah";
import { ProactiveQuick } from "../Proactive";
import { ObjectPage } from "./ObjectPage";
import { t } from "@/i18n";

export function AgentPage({ agent, onClose, onPanel, onBrain, onEdit, onNotifications, onAutonomy }: { agent: Agent; onClose: () => void; onPanel: (t: PanelTab) => void; onBrain: () => void; onEdit: () => void; onNotifications: () => void; onAutonomy: () => void }) {
  return <ObjectPage title={agent.name} onClose={onClose}><div className="agent-identity"><AgentFace agent={agent} className="size-[84px]" /><b>{agent.name}</b><small>{agent.step || (agent.online ? t("En ligne") : t("Hors ligne"))}</small></div>
    {/* Ce qu'il fait de lui-même se règle ici, à la première page de l'agent : plus besoin d'ouvrir Routines. */}
    {canAdmin(agent) && <ProactiveQuick agentId={agent.id} />}
    <div className="shell-group">{[[t("Cerveau"), Brain, onBrain], [t("Autonomie"), Shield, onAutonomy], [t("Connexions"), Plug, () => onPanel("connections")], [t("Compétences"), Sparkles, () => onPanel("competences")], [t("Mémoire"), BookOpen, () => onPanel("memory")], [t("Apparence"), Palette, onEdit], [t("Notifications de Noah"), Bell, onNotifications]].map(([label, Icon, action]) => { const Glyph = Icon as typeof Brain; return <button key={String(label)} className="shell-row" onClick={action as () => void}><Glyph size={21} /><span className="grow">{String(label)}</span><ChevronRight size={18} /></button>; })}</div>
  </ObjectPage>;
}
