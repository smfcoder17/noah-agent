import { memo } from "react";
import { Inbox, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Target } from "lucide-react";
import type { Agent, Conversation } from "@/lib/api";
import type { NavTab } from "@/lib/navPrefs";
import { useRailFolded } from "@/lib/workPanel";
import { cn } from "@/lib/utils";
import { AgentNav } from "../AgentNav";
import { t } from "@/i18n";

/**
 * Barre de gauche, minimale : ce qui attend la personne, puis ses agents alignés ; l'agent ouvert montre son grand visage,
 * son nom, son état et ses réglages à côté. Ses contenus (Activité, Tâches, Fichiers…) sont en haut à droite de la
 * conversation. Repliée, elle ne garde que les icônes et les visages ; ce choix est retenu sur cet appareil.
 */
export const SideRail = memo(function SideRail({ waiting = 0, onInbox, agent, agents = [], conversations, activeThread = null, onAgent, onPickAgent, onMenu, onThread, onSettings, onGoals, onNewAgent }: {
  waiting?: number; onInbox?: () => void; agent: Agent | null;
  /** Tous les agents, dans l'ordre du serveur (épinglés d'abord). */
  agents?: Agent[];
  /** Gardés pour le tiroir du téléphone, qui les montre encore sous l'agent ; la barre de l'ordinateur ne les affiche plus. */
  tabs?: NavTab[]; active?: NavTab;
  /** Les fils de l'agent ouvert : sa discussion, et son historique. */
  conversations: Conversation[];
  /** Le fil ouvert, pour le marquer dans l'historique. */
  activeThread?: string | null;
  onTab?: (t: NavTab) => void;
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
  const [folded, setFolded] = useRailFolded();
  const list = agents.length ? agents : agent ? [agent] : [];
  const entry = (label: string, Icon: typeof Inbox, onClick?: () => void) => (
    <button className="rail-row" onClick={onClick} aria-label={folded ? label : undefined} title={folded ? label : undefined}><Icon size={18} aria-hidden /><span className="rail-label">{label}</span></button>
  );
  return <aside className={cn("side-rail", folded && "is-folded")} aria-label={t("Navigation ordinateur")}>
    <button className="rail-row" onClick={onInbox} aria-label={folded ? t("À toi") : undefined} title={folded ? t("À toi") : undefined}><Inbox size={18} aria-hidden /><span className="rail-label">{t("À toi")}</span>{waiting > 0 ? <span className="rail-count ml-auto" aria-label={t("{n} en attente", { n: waiting })}>{waiting}</span> : <span className="sr-only">{t("{n} en attente", { n: 0 })}</span>}</button>
    <h2 className="section-label rail-agents-label">{t("Agents")}</h2>
    <nav aria-label={t("Navigation")} className="rail-agents-scroll">
      <AgentNav agents={list} agentId={agent?.id ?? null} tabs={[]} active="chat" showTabs={false} conversations={conversations} activeThread={activeThread}
        onPick={(id) => (onPickAgent ? onPickAgent(id) : onAgent())} onTab={() => {}} onThread={onThread} onAgentPage={onAgent} />
    </nav>
    <div className="rail-bottom">
      {onNewAgent && entry(t("Nouvel agent"), Plus, onNewAgent)}
      {entry(t("Objectifs"), Target, onGoals)}
      {entry(t("Rechercher"), Search, onMenu)}
      {entry(t("Réglages"), Settings, onSettings)}
      <button className="rail-row rail-fold" aria-expanded={!folded} aria-label={folded ? t("Déplier la barre") : t("Replier la barre")} title={folded ? t("Déplier la barre") : t("Replier la barre")} onClick={() => setFolded(!folded)}>
        {folded ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}<span className="rail-label">{t("Replier la barre")}</span>
      </button>
    </div>
  </aside>;
});
