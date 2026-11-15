import { memo, useCallback, useEffect, useState } from "react";
import { ChevronDown, History } from "lucide-react";
import { type Agent, type Conversation, canAdmin } from "@/lib/api";
import { TAB_NAMES, type NavTab } from "@/lib/navPrefs";
import { cn } from "@/lib/utils";
import { TAB_ICONS } from "./mobile/BottomTabs";
import { agentSummary, StateShape } from "./Sidebar";
import { AgentFace } from "./Noah";
import { AgentMenu } from "./AgentMenu";
import { t } from "@/i18n";

/** Ce que l'agent attend de la personne : ses accords et ses choix. */
export const pendingOf = (a: Agent) => (a.tasks?.approve ?? 0) + (a.tasks?.choice ?? 0);

/** L'historique d'un agent : ses fils hors conversation principale. Les ouverts d'abord, les archivés à part. */
export function historyOf(conversations: Conversation[]) {
  const others = conversations.filter((c) => !c.main);
  return { open: others.filter((c) => !c.archived), archived: others.filter((c) => c.archived) };
}

/**
 * Les agents, alignés en haut de la barre, comme une liste de contacts : une ligne par agent, avec son état.
 * Seul l'agent ouvert déplie dessous son historique, et sur le téléphone ses options (Discussion par défaut, puis les onglets
 * choisis) : une seule discussion par agent dans la barre, les autres fils restent à un clic. Sur l'ordinateur, les options
 * sont en haut à droite de la conversation (`showTabs={false}`) et l'agent ouvert montre son grand visage, sans tuile.
 * Chaque ligne a trois petits points, cachés jusqu'au survol, qui ouvrent le menu de l'agent ; un clic droit sur la ligne l'ouvre aussi,
 * ce qui sert barre repliée, où seuls les visages restent.
 */
export const AgentNav = memo(function AgentNav({ agents, agentId, tabs, active, conversations, activeThread = null, onPick, onTab, onThread, onAgentPage, onCustomize, variant = "rail", showTabs = true }: {
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
  /** La page de l'agent donné : cerveau, autonomie, apparence. */
  onAgentPage: (id: string) => void;
  /** La fenêtre de personnalisation de l'agent donné ; seulement pour ceux qu'on peut administrer. */
  onCustomize?: (id: string) => void;
  variant?: "rail" | "drawer";
  /** Les options de l'agent sous sa ligne (téléphone). */
  showTabs?: boolean;
}) {
  const [folded, setFolded] = useState(false);
  const [historyAsked, setHistoryAsked] = useState<boolean | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** Le menu ouvert : l'agent, et le pointeur si c'est un clic droit ou la barre (sinon il reste sous la ligne). */
  const [menu, setMenu] = useState<{ id: string; at?: { x: number; y: number } } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const dotsOf = (id: string) => document.querySelector<HTMLElement>(`[data-agent-more="${id}"]`);
  // Un autre agent s'ouvre déplié, l'historique replié.
  useEffect(() => { setFolded(false); setHistoryAsked(null); setArchivedOpen(false); }, [agentId]);
  const { open: history, archived } = historyOf(conversations);
  const inHistory = !!activeThread && conversations.some((c) => c.id === activeThread && !c.main);
  // L'historique s'ouvre seul quand on y lit un fil, et signale ceux qui travaillent ou attendent.
  const historyOpen = historyAsked ?? inHistory;
  const busy = history.filter((c) => c.en_cours).length;
  const options = !showTabs ? [] : tabs.includes("chat") ? tabs : (["chat", ...tabs] as NavTab[]);
  const hasHistory = history.length > 0 || archived.length > 0;

  const thread = (c: Conversation) => (
    <button key={c.id} type="button" className="agent-nav-thread" title={c.title}
      aria-current={c.id === activeThread ? "page" : undefined}
      onClick={() => onThread(c.id)}>
      <span className="truncate">{c.title}</span>{c.en_cours && <span className="rail-dot" aria-label={t("en cours")} />}
    </button>
  );

  return (
    <ul className={cn("agent-nav", variant === "drawer" && "agent-nav-drawer")} aria-label={t("Agents")}>
      {agents.map((a) => {
        const selected = a.id === agentId;
        const hero = selected && variant === "rail";
        const foldable = selected && (options.length > 0 || hasHistory);
        const expanded = foldable && !folded;
        const s = agentSummary(a);
        const pending = pendingOf(a);
        const panelId = `agent-nav-options-${a.id}`;
        return (
          <li key={a.id} className={cn("agent-nav-item", selected && "is-selected", hero && "is-hero")} onContextMenu={(e) => { e.preventDefault(); setMenu({ id: a.id, at: { x: e.clientX, y: e.clientY } }); }}>
            <div className="agent-nav-head">
              <button type="button" className="agent-nav-row"
                aria-current={selected ? "true" : undefined}
                aria-expanded={foldable ? expanded : selected ? undefined : false}
                aria-controls={expanded ? panelId : undefined}
                aria-label={`${a.name}, ${s.text}${!selected && pending ? ` · ${t("{n} en attente", { n: pending })}` : ""}`}
                title={a.name}
                onClick={() => (selected ? foldable && setFolded(!folded) : onPick(a.id))}>
                <AgentFace agent={a} bare={hero} className={cn("shrink-0", hero ? "agent-nav-hero-face" : variant === "drawer" ? "size-10" : "size-8")} />
                <span className="agent-nav-text">
                  <b>{a.name}</b>
                  <small className={s.tone}><StateShape state={s.state} />{s.text}</small>
                </span>
                {!selected && pending > 0 && <span className="rail-count" aria-hidden>{pending}</span>}
                {foldable && <ChevronDown size={15} aria-hidden className={cn("agent-nav-chevron", !expanded && "-rotate-90")} />}
              </button>
              <button type="button" className="agent-nav-more" data-agent-more={a.id} aria-label={t("Menu de {nom}", { nom: a.name })} title={t("Menu de {nom}", { nom: a.name })}
                aria-haspopup="menu" aria-expanded={menu?.id === a.id}
                onClick={(e) => {
                  if (menu?.id === a.id) return setMenu(null);
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ id: a.id, at: variant === "rail" ? { x: r.left, y: r.bottom + 4 } : undefined });
                }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>
              </button>
            </div>
            {menu?.id === a.id && <AgentMenu label={t("Menu de {nom}", { nom: a.name })} at={menu.at} onClose={closeMenu} onEscape={() => dotsOf(a.id)?.focus()}
              items={[
                ...(onCustomize && canAdmin(a) ? [{ key: "customize", label: t("Personnaliser"), run: () => onCustomize(a.id) }] : []),
                { key: "page", label: t("Page de {nom}", { nom: a.name }), run: () => onAgentPage(a.id) },
              ]} />}
            {expanded && (
              <div id={panelId} role="group" aria-label={t("Options de {nom}", { nom: a.name })} className="agent-nav-options">
                {options.map((tab) => {
                  const Icon = TAB_ICONS[tab];
                  const current = active === tab && (tab !== "chat" || !activeThread);
                  return (
                    <button key={tab} type="button" className="agent-nav-option" aria-current={current ? "page" : undefined} onClick={() => onTab(tab)}>
                      <Icon size={16} aria-hidden /><span>{TAB_NAMES[tab]}</span>
                    </button>
                  );
                })}
                {hasHistory && <>
                  <button type="button" className="agent-nav-option" aria-expanded={historyOpen} aria-controls={`${panelId}-historique`} onClick={() => setHistoryAsked(!historyOpen)}>
                    <History size={16} aria-hidden /><span>{t("Historique")}</span>
                    <span className="ml-auto flex items-center gap-1.5 text-xs tabular-nums">
                      {busy > 0 && !historyOpen && <span className="rail-dot" aria-label={t("{n} en cours", { n: busy })} />}
                      {history.length + archived.length}
                      <ChevronDown size={13} aria-hidden className={cn("transition-transform", !historyOpen && "-rotate-90")} />
                    </span>
                  </button>
                  {historyOpen && (
                    <div id={`${panelId}-historique`} role="group" aria-label={t("Historique de {nom}", { nom: a.name })} className="agent-nav-history">
                      {history.map(thread)}
                      {archived.length > 0 && <>
                        <button type="button" className="agent-nav-thread agent-nav-archived" aria-expanded={archivedOpen || archived.some((c) => c.id === activeThread)} onClick={() => setArchivedOpen(!archivedOpen)}>
                          {t("Archivés ({n})", { n: archived.length })}
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
