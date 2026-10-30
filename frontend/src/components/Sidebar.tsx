// Colonne de gauche : uniquement les agents. Clic droit (ou « ⋯ ») pour épingler ou personnaliser.
import { LogOut, MoreHorizontal, Palette, Pin, PinOff, Plus, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Agent, CurrentModel, TaskState, Usage } from "@/lib/api";
import { cn, money } from "@/lib/utils";
import { NoahTile, agentColor } from "./Noah";
import type { SettingsTab } from "./Settings";
import { Button } from "./ui";

// Formes d'état : rond = l'agent agit, losange = à toi, rond plein vert = terminé.
export const STATE_WORD: Record<TaskState, string> = {
  work: "travaille",
  approve: "attend ton accord",
  choice: "attend ton choix",
  done: "terminée",
  error: "a échoué",
  idle: "",
};

export function StateShape({ state, className }: { state: TaskState | "offline" | "starting"; className?: string }) {
  const base = "inline-block shrink-0";
  switch (state) {
    case "work":
      return <span aria-hidden className={cn(base, "size-2 rounded-full bg-accent ring-3 ring-accent/25", className)} />;
    case "starting":
      return <span aria-hidden className={cn(base, "size-2 animate-pulse rounded-full bg-accent", className)} />;
    case "choice":
      return <span aria-hidden className={cn(base, "size-[7px] rotate-45 border-2 border-warn", className)} />;
    case "approve":
      return <span aria-hidden className={cn(base, "size-2 rotate-45 bg-warn", className)} />;
    case "done":
      return <span aria-hidden className={cn(base, "size-2 rounded-full bg-ok", className)} />;
    case "error":
      return <span aria-hidden className={cn(base, "size-2 bg-danger", className)} />;
    default:
      return <span aria-hidden className={cn(base, "size-[7px] rounded-full border-2 border-muted-foreground", className)} />;
  }
}

/** Résumé d'un agent : sa conversation, et ce que ses fils font ou attendent de l'utilisateur. */
export function agentSummary(a: Agent): { state: TaskState | "offline" | "starting"; text: string; tone: string } {
  if (a.step) return { state: "starting", text: a.step, tone: "text-accent" };
  if (!a.online) return { state: "offline", text: "Hors ligne", tone: "text-muted-foreground" };
  const t = a.tasks ?? {};
  const mine = (t.approve ?? 0) + (t.choice ?? 0);
  if (mine) {
    const parts = [];
    if (t.approve) parts.push(`${t.approve} accord${t.approve > 1 ? "s" : ""}`);
    if (t.choice) parts.push(`${t.choice} choix`);
    return { state: t.approve ? "approve" : "choice", text: "À toi · " + parts.join(" · "), tone: "text-warn" };
  }
  if (t.work) return { state: "work", text: t.work > 1 ? `Travaille · ${t.work} fils` : "Travaille", tone: "text-accent" };
  if (a.state === "error") return { state: "error", text: "S'est arrêté sur une erreur", tone: "text-danger" };
  return { state: "idle", text: "Disponible", tone: "text-muted-foreground" };
}

type Menu = { agent: Agent; x: number; y: number };

export function Sidebar(props: {
  agents: Agent[];
  agentId: string | null;
  model: CurrentModel;
  usage: Usage | null;
  onClose: () => void;
  onSelectAgent: (id: string) => void;
  onPin: (agent: Agent, pinned: boolean) => void;
  onCustomize: (agent: Agent) => void;
  onNewAgent: () => void;
  onSettings: (tab: SettingsTab) => void;
  onLogout: () => void;
}) {
  const { agents, agentId, usage } = props;
  const pct = usage?.budget ? Math.min(100, (usage.month_cost / usage.budget) * 100) : null;
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const openMenu = (agent: Agent, x: number, y: number) => setMenu({ agent, x: Math.min(x, window.innerWidth - 230), y: Math.min(y, window.innerHeight - 120) });

  return (
    <>
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <img src="/assets/icon.svg" alt="" className="size-7" />
          <strong className="text-lg tracking-tight">Noah Agent</strong>
        </div>
        <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={props.onClose} aria-label="Fermer le menu"><X /></Button>
      </div>

      <nav aria-label="Agents" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        <h2 className="mb-1 px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Tes agents</h2>
        {agents.map((a, i) => {
          const active = a.id === agentId;
          const s = agentSummary(a);
          const lastPinned = a.pinned && !agents[i + 1]?.pinned && i < agents.length - 1;
          return (
            <div key={a.id} className={cn("group relative", lastPinned && "mb-1.5 border-b border-border pb-1.5")}>
              <button
                type="button"
                onClick={() => props.onSelectAgent(a.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(a, e.clientX, e.clientY);
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface/70",
                  active && "bg-surface shadow-sm",
                )}
              >
                <span className="relative">
                  <NoahTile color={agentColor(a)} className="size-10" />
                  {s.state !== "idle" && s.state !== "offline" && (
                    <span className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-sidebar">
                      <StateShape state={s.state} />
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{a.name}</span>
                    {a.pinned && <Pin className="size-3 shrink-0 rotate-45 text-muted-foreground" aria-label="Épinglé" />}
                  </span>
                  <span className={cn("truncate text-xs font-medium", s.tone)}>{s.text}</span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Options de ${a.name}`}
                className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 cursor-pointer rounded-md p-1 text-muted-foreground group-hover:block hover:bg-muted hover:text-foreground focus-visible:block"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu(a, r.left, r.bottom + 4);
                }}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={props.onNewAgent}
          className="mt-1 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-muted-foreground/50 px-2 py-2 text-left text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="grid size-10 place-items-center"><Plus className="size-4" /></span>Créer un agent
        </button>
      </nav>

      {menu && (
        <div
          role="menu"
          aria-label={`Options de ${menu.agent.name}`}
          className="fixed z-50 flex w-56 flex-col rounded-xl border border-border bg-surface p-1 text-sm shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            autoFocus
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted"
            onClick={() => {
              props.onPin(menu.agent, !menu.agent.pinned);
              setMenu(null);
            }}
          >
            {menu.agent.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {menu.agent.pinned ? "Désépingler" : "Épingler en haut"}
          </button>
          <button
            role="menuitem"
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted"
            onClick={() => {
              props.onCustomize(menu.agent);
              setMenu(null);
            }}
          >
            <Palette className="size-4" />Personnaliser
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button type="button" onClick={() => props.onSettings("brain")} className="flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-left hover:border-muted-foreground/50">
          <span className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Ce mois-ci</span>
            <span className="font-mono font-medium tabular-nums">
              {usage ? `${money(usage.month_cost)} $${usage.budget != null ? ` / ${money(usage.budget)} $` : ""}` : "—"}
            </span>
          </span>
          {pct != null && (
            <span role="meter" aria-label="Dépense du mois" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded-full bg-muted">
              <span className={cn("block h-full rounded-full", pct >= 90 ? "bg-warn" : "bg-foreground/70")} style={{ width: `${pct}%` }} />
            </span>
          )}
          <span className="truncate text-xs text-muted-foreground">Cerveau : <span className="font-mono text-foreground">{props.model?.model ?? "aucun"}</span></span>
        </button>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" className="flex-1 justify-start text-muted-foreground" onClick={() => props.onSettings("create")}><Settings />Réglages</Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={props.onLogout} aria-label="Se déconnecter" title="Se déconnecter"><LogOut /></Button>
        </div>
      </div>
    </>
  );
}
