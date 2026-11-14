// Tout ce qui constitue l'agent, au même endroit : un résumé qui mène à l'écran de chaque chose, sans en refaire aucun. Et le menu à trois points, à côté de son nom.
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Agent, canAdmin, canTalk, get, type Goal } from "@/lib/api";
import { modeName, readableModel, REASONING } from "@/lib/modes";
import { Button } from "./ui";
import type { PanelTab } from "./SidePanel";
import { t } from "@/i18n";

type Counts = { connexions?: string; competences?: number; routines?: number; memoire?: number; objectifs?: number };
type Conns = { google?: { connecte?: boolean }; applications?: { installe: boolean; connecte: boolean }[]; outils?: { connecte: boolean }[]; globaux?: { connecte: boolean }[] };

function connectionsLine(c: Conns): string {
  const total = (c.google?.connecte ? 1 : 0) + (c.applications ?? []).filter((a) => a.installe && a.connecte).length + (c.outils ?? []).filter((o) => o.connecte).length;
  const shared = (c.globaux ?? []).filter((g) => g.connecte).length;
  const waiting = (c.globaux ?? []).length - shared;
  const parts = [total ? (total > 1 ? t("{n} connectées", { n: total }) : t("{n} connectée", { n: total })) : t("Aucune")];
  if (shared) parts.push(t("dont {n} pour tous", { n: shared }));
  if (waiting) parts.push(t("{n} à relier", { n: waiting }));
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
  const show = (n: number | undefined, word: (n: number) => string) => (n === undefined ? "…" : n ? word(n) : t("Aucune"));
  const reasoning = REASONING.find((r) => r.id === agent.raisonnement)?.name;
  const brain = [agent.mode ? modeName(agent.mode) : readableModel(agent.model) || t("Le réglage général"), reasoning].filter(Boolean).join(" · ");
  return (
    <section aria-label={t("Ce qui constitue cet agent")} className="grid grid-cols-2 gap-1.5">
      <Tile label={t("Personnalité et rôle")} value={agent.role.trim() ? agent.role.trim().split("\n")[0] : t("À écrire")} onClick={admin ? onEdit : undefined} />
      <Tile label={t("Modèle")} value={brain} onClick={admin ? onBrain : undefined} />
      {owner && <Tile label={t("Objectifs")} value={counts.objectifs === undefined ? "…" : counts.objectifs ? t("{n} en cours", { n: counts.objectifs }) : t("Aucun")} onClick={onGoals} />}
      {admin && <Tile label={t("Connexions")} value={counts.connexions ?? "…"} onClick={() => onTab("connections")} />}
      {admin && <Tile label={t("Compétences")} value={show(counts.competences, (n) => (n > 1 ? t("{n} enseignées", { n }) : t("{n} enseignée", { n })))} onClick={() => onTab("competences")} />}
      {admin && <Tile label={t("Routines")} value={show(counts.routines, (n) => (n > 1 ? t("{n} routines", { n }) : t("{n} routine", { n })))} onClick={() => onTab("routines")} />}
      {admin && <Tile label={t("Mémoire")} value={counts.memoire === undefined ? "…" : counts.memoire ? (counts.memoire > 1 ? t("{n} notes", { n: counts.memoire }) : t("{n} note", { n: counts.memoire })) : t("Vide")} onClick={() => onTab("memory")} />}
      <Tile label={t("Dépense du mois")} value={spent} onClick={onSpending} />
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
    [t("Tout voir"), () => onOpen("activity")],
    ...(admin ? ([
      [t("Personnalité et rôle"), onEdit],
      [t("Connexions"), () => onOpen("connections")],
      [t("Compétences"), () => onOpen("competences")],
      [t("Routines"), () => onOpen("routines")],
      [t("Mémoire"), () => onOpen("memory")],
    ] as [string, () => void][]) : []),
    ...(canTalk(agent) ? ([[t("Ordinateur"), () => onOpen("computer")]] as [string, () => void][]) : []),
  ];
  return (
    <div ref={box} className="relative shrink-0">
      <Button variant="ghost" size="icon-sm" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={t("Menu de {nom}", { nom: agent.name })} title={t("Menu de {nom}", { nom: agent.name })}>
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
