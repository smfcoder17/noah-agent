import { Menu } from "lucide-react";
import type { Agent } from "@/lib/api";
import { agentSummary, etatMot } from "../Sidebar";
import { t } from "@/i18n";

/** L'en-tête du téléphone, celui du prototype : le menu, le nom et « rôle · état », puis `menu` (Pour toi, appeler, panneau). */
export function MobileHeader({ agent, status, onMenu, onAgent, menu, titre }: { menu?: React.ReactNode; titre?: string; agent: Agent | null; status: string; onMenu: () => void; onAgent: () => void }) {
  const summary = agent ? agentSummary(agent) : null;
  const mot = agent ? (summary?.state === "idle" ? status : etatMot(agent).mot) : status;
  if (titre) return <header className="mobile-header"><button type="button" className="icon-btn" aria-label={t("Menu")} onClick={onMenu}><Menu size={20} aria-hidden /></button><h1 className="mobile-titre">{titre}</h1></header>;
  return <header className="mobile-header"><button type="button" className="icon-btn" aria-label={t("Menu")} onClick={onMenu}><Menu size={20} aria-hidden /></button>
    <button type="button" className="mobile-agent" aria-label={t("Page de l'agent")} disabled={!agent} onClick={onAgent}><b>{agent?.name ?? "Noah"}</b><small>{[agent?.role, mot.toLowerCase()].filter(Boolean).join(" · ")}</small></button>
    {menu}</header>;
}
