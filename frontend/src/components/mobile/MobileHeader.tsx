import { Menu, SquarePen } from "lucide-react";
import type { Agent } from "@/lib/api";
import { agentSummary, StateShape } from "../Sidebar";
import { AgentFace } from "../Noah";
import { t } from "@/i18n";

export function MobileHeader({ agent, status, onMenu, onAgent, onNew, busy = false }: { busy?: boolean; agent: Agent | null; status: string; onMenu: () => void; onAgent: () => void; onNew: () => void }) {
  const summary = agent ? agentSummary(agent) : null;
  return <header className="mobile-header"><button className="shell-icon fill" aria-label={t("Menu")} onClick={onMenu}><Menu size={22} /></button>
    <button className="mobile-agent" aria-label={t("Page de l'agent")} disabled={!agent} onClick={onAgent}>{agent && <AgentFace agent={agent} className="size-[46px]" />}<b>{agent?.name ?? "Noah"}</b><small><StateShape state={summary?.state || "offline"} />{agent?.step || (summary?.state === "idle" ? status : summary?.text) || status}</small></button>
    <button className="shell-icon fill" disabled={busy} aria-label={t("Nouvelle discussion")} onClick={onNew}><SquarePen size={20} /></button></header>;
}
