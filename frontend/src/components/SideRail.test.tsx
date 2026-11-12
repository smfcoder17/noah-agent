import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Conversation } from "@/lib/api";

vi.mock("../Noah", () => ({ AgentFace: ({ agent }: { agent: Agent }) => <span data-agent={agent.id} />, agentColor: () => "#000" }));
import { RAIL_AGENTS, SideRail } from "./desktop/SideRail";
import { AWAY, pageOf, RAIL_PAGE } from "./ConversationRail";

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const agent = (id: string, name: string, tasks: Agent["tasks"] = {}) =>
  ({ id, name, online: true, state: "approve", tasks, droit: "proprietaire", color: "#000", pinned: false, partage: false, role: "", step: null }) as Agent;
const conv = (id: string, title: string, main = false, en_cours = false) =>
  ({ id, title, main, en_cours, archived: false, state: "idle", origin: "user", partagee: false, de: null, updated_at: "2026-11-11" }) as Conversation;

const noOp = () => {};
const render = async (props: Parameters<typeof SideRail>[0]) => { await act(async () => root.render(<SideRail {...props} />)); };

it("montre trois agents d'office, avec leur état d'attente et le total derrière « Mes agents »", async () => {
  const agents = [agent("a", "Noah", { approve: 2 }), agent("b", "Veille"), agent("c", "Trois"), agent("d", "Quatre"), agent("e", "Cinq")];
  const picked = vi.fn();
  await render({ agent: agents[0], agents, tabs: [], active: "chat", conversations: [], onTab: noOp, onAgent: noOp, onPickAgent: picked, onMenu: noOp, onThread: noOp, onSettings: noOp, onGoals: noOp, onNew: noOp });
  const group = host.querySelector('[aria-label="Mes agents"]')!;
  const rows = [...group.querySelectorAll<HTMLButtonElement>(".rail-agent-row")];
  expect(rows).toHaveLength(RAIL_AGENTS);
  expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Noah · 2 en attente", "Veille", "Trois"]);
  expect(rows[0].textContent).toContain("2");
  expect(rows[0].getAttribute("aria-current")).toBe("page");
  // Les deux autres agents ne sont pas montrés, mais le total reste lisible.
  expect(host.textContent).not.toContain("Quatre");
  expect([...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Mes agents"))?.textContent).toContain("5");
  await act(async () => rows[1].click());
  expect(picked).toHaveBeenCalledWith("b");
});

it("affiche les discussions de chaque agent sans qu'on ait à cliquer", async () => {
  const agents = [agent("a", "Noah"), agent("b", "Veille")];
  const open = vi.fn();
  await render({ agent: agents[0], agents, threads: { a: [conv("1", "Conversation", true), conv("2", "Fil du matin")], b: [conv("3", "De lui-même : Nouvelles noti")] },
    tabs: [], active: "chat", conversations: [conv("1", "Conversation", true), conv("2", "Fil du matin")], activeThread: "2",
    onTab: noOp, onAgent: noOp, onPickAgent: noOp, onOpenAgentThread: open, onMenu: noOp, onThread: noOp, onSettings: noOp, onGoals: noOp, onNew: noOp });
  const subs = [...host.querySelectorAll<HTMLButtonElement>(".rail-subthread")];
  // La conversation principale n'est pas répétée sous l'agent : elle est déjà sa ligne.
  expect(subs.map((s) => s.textContent)).toEqual(["Fil du matin", "De lui-même : Nouvelles noti"]);
  expect(subs[0].getAttribute("aria-current")).toBe("page");
  await act(async () => subs[1].click());
  expect(open).toHaveBeenCalledWith("b", "3");
});

it("garde la colonne des repères par dix, et la fenêtre suit la lecture", () => {
  expect(RAIL_PAGE).toBe(10);
  expect(pageOf(0, 30)).toBe(0);
  expect(pageOf(9, 30)).toBe(0);
  expect(pageOf(10, 30)).toBe(1);
  expect(pageOf(29, 30)).toBe(2);
  expect(pageOf(0, 4)).toBe(0); // moins d'une page : une seule fenêtre
  expect(pageOf(99, 4)).toBe(0);
  expect(AWAY).toBe(3);
});
