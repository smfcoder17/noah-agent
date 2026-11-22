import { memo, useState } from "react";
import { Activity, Inbox, PanelLeft, Plus, Search, Settings } from "lucide-react";
import type { Agent, Me } from "@/lib/api";
import type { NavTab } from "@/lib/navPrefs";
import { useRailFolded } from "@/lib/workPanel";
import { cn } from "@/lib/utils";
import { AgentNav } from "../AgentNav";
import { AgentMenu } from "../AgentMenu";
import { t } from "@/i18n";

/** Ce que l'ordinateur sait de la personne qui lit : son nom, et ce qu'elle est pour ce serveur. */
export const roleDit = (me: Me | null) => (me?.role === "owner" ? t("Propriétaire") : t("Invité"));

/**
 * Barre de gauche, celle du prototype « Fil calme » : le nom en haut avec le bouton qui la replie ; « Pour toi », « Activité »,
 * « Rechercher » ; les agents alignés avec leur ligne d'état ; « Nouvel agent » ; en bas, Réglages et le compte. Les trois petits points de
 * chaque agent (au survol) ouvrent son menu. Les contenus de l'agent (Tâches, Fichiers…) sont dans le panneau de droite. Repliée, elle ne
 * garde que les icônes et les pastilles ; ce choix est retenu sur cet appareil. Objectifs, absent du prototype, est dans le menu du compte.
 */
export const SideRail = memo(function SideRail({ waiting = 0, onInbox, onActivity, activityDot = false, me = null, agent, agents = [], onAgent, onPickAgent, onSearch, onSettings, onGoals, onNewAgent, onAgentPage, onCustomize, onLogout }: {
  waiting?: number; onInbox?: () => void;
  /** Ouvre l'activité de l'agent affiché ; la pastille dit que des routines viennent de passer. */
  onActivity?: () => void; activityDot?: boolean;
  me?: Me | null; agent: Agent | null;
  /** Tous les agents, dans l'ordre du serveur (épinglés d'abord). */
  agents?: Agent[];
  /** Gardés pour le tiroir du téléphone ; la barre de l'ordinateur ne les affiche plus. */
  tabs?: NavTab[]; active?: NavTab;
  onTab?: (t: NavTab) => void;
  /** Ouvre la page de l'agent ouvert. */
  onAgent: () => void;
  /** Menu de l'agent (trois points, clic droit) : la page de l'agent donné, et sa fenêtre de personnalisation. */
  onAgentPage?: (id: string) => void;
  onCustomize?: (id: string) => void;
  /** Ouvre l'agent donné, depuis sa ligne. */
  onPickAgent?: (id: string) => void;
  /** Ouvre la page Rechercher (aussi Ctrl K). */
  onSearch: () => void;
  onSettings: () => void; onGoals: () => void;
  onNewAgent?: () => void;
  onLogout?: () => void;
}) {
  const [folded, setFolded] = useRailFolded();
  const [account, setAccount] = useState<{ x: number; y: number } | null>(null);
  const list = agents.length ? agents : agent ? [agent] : [];
  const name = me?.username ?? "";
  const entry = (label: string, Icon: typeof Inbox, onClick?: () => void, extra?: React.ReactNode, current = false) => (
    <button type="button" className="rail-row" onClick={onClick} aria-label={folded ? label : undefined} title={folded ? label : undefined} aria-current={current ? "page" : undefined}>
      <Icon size={18} aria-hidden /><span className="rail-label">{label}</span>{extra}
    </button>
  );
  return <aside className={cn("side-rail", folded && "is-folded")} aria-label={t("Navigation ordinateur")}>
    <div className="rail-top">
      <button type="button" className="icon-btn rail-fold" aria-expanded={!folded} aria-label={folded ? t("Déplier la barre") : t("Replier la barre")} title={folded ? t("Déplier la barre") : t("Replier la barre")} onClick={() => setFolded(!folded)}>
        <PanelLeft size={18} aria-hidden />
      </button>
      <span className="rail-brand">Noah</span>
    </div>
    {entry(t("Pour toi"), Inbox, onInbox, waiting > 0 ? <span className="rail-count ml-auto" aria-label={t("{n} en attente", { n: waiting })}>{waiting}</span> : <span className="sr-only">{t("{n} en attente", { n: 0 })}</span>)}
    {entry(t("Activité"), Activity, onActivity, activityDot ? <span className="dot glow ml-auto" role="img" aria-label={t("Des routines viennent de passer")} title={t("Des routines viennent de passer")} /> : null)}
    {entry(t("Rechercher"), Search, onSearch, <kbd className="kbd ml-auto rail-kbd">{/* i18n-ignore */}Ctrl K</kbd>)}
    <h2 className="section-label rail-agents-label">{t("Agents")}</h2>
    <nav aria-label={t("Navigation")} className="rail-agents-scroll">
      <AgentNav agents={list} agentId={agent?.id ?? null} tabs={[]} active="chat" showTabs={false}
        onPick={(id) => (onPickAgent ? onPickAgent(id) : onAgent())} onTab={() => {}} onCustomize={onCustomize}
        onAgentPage={(id) => { if (onAgentPage) return onAgentPage(id); if (id !== agent?.id) onPickAgent?.(id); onAgent(); }} />
      {onNewAgent && <div className="rail-new">{entry(t("Nouvel agent"), Plus, onNewAgent)}</div>}
    </nav>
    <div className="rail-bottom">
      {entry(t("Réglages"), Settings, onSettings)}
      <button type="button" className="rail-row rail-account" aria-haspopup="menu" aria-expanded={!!account} title={name}
        aria-label={`${name}, ${roleDit(me)}`}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAccount(account ? null : { x: r.left + 8, y: r.top - 8 - 2 * 40 }); }}>
        <span className="avatar plain" aria-hidden>{name.charAt(0).toUpperCase()}</span>
        <span className="agent-nav-text"><b>{name}</b><small className="text-muted-foreground">{roleDit(me)}</small></span>
      </button>
      {account && <AgentMenu label={t("Compte")} at={account} onClose={() => setAccount(null)}
        items={[{ key: "goals", label: t("Objectifs"), run: onGoals }, ...(onLogout ? [{ key: "logout", label: t("Me déconnecter"), run: onLogout }] : [])]} />}
    </div>
  </aside>;
});
