// Tout ce qui constitue l'agent, au même endroit : un résumé qui mène à l'écran de chaque chose, sans en refaire aucun. Et le menu à trois points, à côté de son nom.
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Agent, canAdmin, canTalk, get, type Goal } from "@/lib/api";
import { modeName, readableModel, REASONING } from "@/lib/modes";
import { Button } from "./ui";
import type { PanelTab } from "./SidePanel";

type Counts = { connexions?: string; competences?: number; routines?: number; memoire?: number; objectifs?: number };
type Conns = { google?: { connecte?: boolean }; applications?: { installe: boolean; connecte: boolean }[]; outils?: { connecte: boolean }[]; globaux?: { connecte: boolean }[] };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

function connectionsLine(c: Conns): string {
  const total = (c.google?.connecte ? 1 : 0) + (c.applications ?? []).filter((a) => a.installe && a.connecte).length + (c.outils ?? []).filter((t) => t.connecte).length;
  const shared = (c.globaux ?? []).filter((g) => g.connecte).length;
  const waiting = (c.globaux ?? []).length - shared;
  const parts = [total ? plural(total, "connectée", "connectées") : "Aucune"];
  if (shared) parts.push(`dont ${shared} pour tous`);
  if (waiting) parts.push(`${waiting} à relier`);
  return parts.join(", ");
}

function Tile({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="flex min-w-0 cursor-pointer items-center gap-1 rounded-xl bg-muted px-2.5 py-2 text-left hover:bg-muted/70 disabled:cursor-default disabled:hover:bg-muted">
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block truncate text-sm font-medium">{value}</span>
      </span>
      {onClick && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
    </button>
  );
}

export function AgentOverview({ agent, refreshKey, spent, onTab, onEdit, onBrain, onSpending, onGoals }: {
  agent: Agent;
  refreshKey: number;
  spent: string;
  onTab: (t: PanelTab) => void;
  onEdit: () => void;
  onBrain: () => void;
  onSpending: () => void;
  onGoals?: () => void;
}) {
  const [counts, setCounts] = useState<Counts>({});
  const admin = canAdmin(agent);
  const owner = agent.droit === "proprietaire";
  useEffect(() => {
    let current = true;
    setCounts({});
    const put = (part: Counts) => current && setCounts((c) => ({ ...c, ...part }));
    if (admin) {
      get<Conns>(`/api/agents/${agent.id}/connections`).then((c) => put({ connexions: connectionsLine(c) })).catch(() => {});
      get<{ competences: unknown[] }>(`/api/agents/${agent.id}/competences`).then((r) => put({ competences: r.competences.length })).catch(() => {});
      get<{ routines: unknown[] }>(`/api/agents/${agent.id}/routines`).then((r) => put({ routines: r.routines.length })).catch(() => {});
      get<{ memory: unknown[]; user: unknown[] }>(`/api/agents/${agent.id}/memory`).then((m) => put({ memoire: m.memory.length + m.user.length })).catch(() => {});
    }
    if (owner) get<{ objectifs: Goal[] }>("/api/goals").then((r) => put({ objectifs: r.objectifs.filter((g) => g.etat === "actif" && (!g.agent_id || g.agent_id === agent.id)).length })).catch(() => {});
    return () => {
      current = false;
    };
  }, [agent.id, admin, owner, refreshKey]);
  const show = (n: number | undefined, one: string, many?: string) => (n === undefined ? "…" : n ? plural(n, one, many) : "Aucune");
  const reasoning = REASONING.find((r) => r.id === agent.raisonnement)?.name;
  const brain = [agent.mode ? modeName(agent.mode) : readableModel(agent.model) || "Le réglage général", reasoning].filter(Boolean).join(" · ");
  return (
    <section aria-label="Ce qui constitue cet agent" className="grid grid-cols-2 gap-1.5">
      <Tile label="Personnalité et rôle" value={agent.role.trim() ? agent.role.trim().split("\n")[0] : "À écrire"} onClick={admin ? onEdit : undefined} />
      <Tile label="Modèle" value={brain} onClick={admin ? onBrain : undefined} />
      {owner && <Tile label="Objectifs" value={counts.objectifs === undefined ? "…" : counts.objectifs ? plural(counts.objectifs, "en cours", "en cours") : "Aucun"} onClick={onGoals} />}
      {admin && <Tile label="Connexions" value={counts.connexions ?? "…"} onClick={() => onTab("connections")} />}
      {admin && <Tile label="Compétences" value={show(counts.competences, "enseignée", "enseignées")} onClick={() => onTab("competences")} />}
      {admin && <Tile label="Routines" value={show(counts.routines, "routine")} onClick={() => onTab("routines")} />}
      {admin && <Tile label="Mémoire" value={counts.memoire === undefined ? "…" : counts.memoire ? plural(counts.memoire, "note") : "Vide"} onClick={() => onTab("memory")} />}
      <Tile label="Dépense du mois" value={spent} onClick={onSpending} />
    </section>
  );
}

/** Le raccourci à côté du nom : chaque entrée ouvre l'endroit où la chose se règle. */
export function AgentMenu({ agent, onOpen, onEdit }: { agent: Agent; onOpen: (t: PanelTab) => void; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const admin = canAdmin(agent);
  const items: [string, () => void][] = [
    ["Tout voir", () => onOpen("activity")],
    ...(admin ? ([
      ["Personnalité et rôle", onEdit],
      ["Connexions", () => onOpen("connections")],
      ["Compétences", () => onOpen("competences")],
      ["Routines", () => onOpen("routines")],
      ["Mémoire", () => onOpen("memory")],
    ] as [string, () => void][]) : []),
    ...(canTalk(agent) ? ([["Ordinateur", () => onOpen("computer")]] as [string, () => void][]) : []),
  ];
  return (
    <div ref={box} className="relative shrink-0">
      <Button variant="ghost" size="icon-sm" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={`Menu de ${agent.name}`} title={`Menu de ${agent.name}`}>
        <MoreHorizontal />
      </Button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-40 mt-1 flex w-52 flex-col rounded-xl border border-border bg-surface p-1 shadow-xl">
          {items.map(([label, act]) => (
            <button key={label} type="button" role="menuitem" onClick={() => { setOpen(false); act(); }} className="cursor-pointer rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted">{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
