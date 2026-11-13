import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Conversation } from "@/lib/api";

vi.mock("./Noah", () => ({ AgentFace: ({ agent }: { agent: Agent }) => <span data-agent={agent.id} />, agentColor: () => "#000" }));
import { SideRail } from "./desktop/SideRail";
import { Drawer } from "./mobile/Drawer";
import { AWAY, pageOf, RAIL_PAGE } from "./ConversationRail";

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const agent = (id: string, name: string, tasks: Agent["tasks"] = {}) =>
  ({ id, name, online: true, state: "idle", tasks, droit: "proprietaire", color: "#000", pinned: false, partage: false, role: "", step: null }) as Agent;
const conv = (id: string, title: string, main = false, en_cours = false, archived = false) =>
  ({ id, title, main, en_cours, archived, state: "idle", origin: "user", partagee: false, de: null, updated_at: "2026-11-11" }) as Conversation;

const noOp = () => {};
type Props = Parameters<typeof SideRail>[0];
const base = (over: Partial<Props> = {}): Props => ({ agent: null, agents: [], tabs: ["chat", "activity", "tasks", "files", "computer"], active: "chat", conversations: [], onTab: noOp, onAgent: noOp, onPickAgent: noOp, onMenu: noOp, onThread: noOp, onSettings: noOp, onGoals: noOp, onNewAgent: noOp, ...over });
const render = async (props: Props) => { await act(async () => root.render(<SideRail {...props} />)); };
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".agent-nav-row")];
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(text));

const agents = [agent("a", "Noah"), agent("b", "Veille", { work: 1 }), agent("c", "BMD", { approve: 2 }), agent("d", "Quatre"), agent("e", "Cinq")];
const threads = [conv("1", "Conversation", true), conv("2", "Fil du matin", false, true), conv("3", "De lui-même : Nouvelles notifications"), conv("4", "Demande de Noah : budget"), conv("5", "Vieux fil", false, false, true)];

it("aligne tous les agents en haut, avec leur état ; l'agent ouvert est sélectionné", async () => {
  const picked = vi.fn();
  await render(base({ agent: agents[0], agents, onPickAgent: picked }));
  expect(rows().map((r) => r.textContent)).toEqual(["NoahDisponible", "VeilleTravaille", "BMDÀ toi · 2 accords2", "QuatreDisponible", "CinqDisponible"]);
  expect(rows()[0].getAttribute("aria-current")).toBe("true");
  expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
  expect(rows().slice(1).every((r) => r.getAttribute("aria-current") === null && r.getAttribute("aria-expanded") === "false")).toBe(true);
  expect(rows()[2].getAttribute("aria-label")).toBe("BMD, À toi · 2 accords · 2 en attente");
  // Plus de section « Discussions » ni de bouton de nouvelle discussion : une seule discussion par agent.
  expect(host.textContent).not.toMatch(/Discussions/i);
  expect(host.querySelector('[aria-label="Nouvelle discussion"]')).toBeNull();
  await act(async () => rows()[1].click());
  expect(picked).toHaveBeenCalledWith("b");
});

it("déplie les options sous l'agent sélectionné seulement, Discussion par défaut, et se replie au clic", async () => {
  const onTab = vi.fn();
  await render(base({ agent: agents[1], agents, onTab }));
  const groups = [...host.querySelectorAll('[role="group"]')];
  expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Options de Veille"]);
  const options = [...groups[0].querySelectorAll("button")].map((b) => b.textContent);
  expect(options).toEqual(["Discussion", "Activité", "Tâches", "Fichiers", "Ordinateur"]);
  expect(button("Discussion")!.getAttribute("aria-current")).toBe("page");
  await act(async () => button("Fichiers")!.click());
  expect(onTab).toHaveBeenCalledWith("files");
  await render(base({ agent: agents[1], agents, onTab, active: "files" }));
  expect(button("Fichiers")!.getAttribute("aria-current")).toBe("page");
  expect(button("Discussion")!.getAttribute("aria-current")).toBeNull();
  // Un clic sur l'agent ouvert replie ses options, un autre les rouvre.
  await act(async () => rows()[1].click());
  expect(rows()[1].getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector('[role="group"]')).toBeNull();
  await act(async () => rows()[1].click());
  expect(host.querySelector('[aria-label="Options de Veille"]')).not.toBeNull();
});

it("garde l'accès à tous les anciens fils derrière l'Historique de l'agent", async () => {
  const onThread = vi.fn();
  await render(base({ agent: agents[0], agents, conversations: threads, onThread }));
  const history = button("Historique")!;
  expect(history.getAttribute("aria-expanded")).toBe("false");
  expect(history.textContent).toContain("4"); // trois fils ouverts et un archivé ; la principale n'en fait pas partie
  expect(history.querySelector('[aria-label="1 en cours"]')).not.toBeNull();
  await act(async () => history.click());
  const list = host.querySelector('[aria-label="Historique de Noah"]')!;
  expect([...list.querySelectorAll(".agent-nav-thread")].map((b) => b.textContent)).toEqual(["Fil du matin", "De lui-même : Nouvelles notifications", "Demande de Noah : budget", "Archivés (1)"]);
  await act(async () => button("Archivés")!.click());
  expect(list.textContent).toContain("Vieux fil");
  await act(async () => button("Demande de Noah")!.click());
  expect(onThread).toHaveBeenCalledWith("4");
});

it("ouvre l'historique de lui-même quand on y lit un fil, et le marque", async () => {
  await render(base({ agent: agents[0], agents, conversations: threads, activeThread: "3" }));
  expect(button("Historique")!.getAttribute("aria-expanded")).toBe("true");
  expect(button("De lui-même")!.getAttribute("aria-current")).toBe("page");
  expect(button("Discussion")!.getAttribute("aria-current")).toBeNull();
});

it("met À toi tout en haut avec son compteur, et peu d'entrées en bas", async () => {
  const inbox = vi.fn(), newAgent = vi.fn();
  await render(base({ agent: agents[0], agents, waiting: 3, onInbox: inbox, onNewAgent: newAgent }));
  const first = host.querySelector("aside")!.firstElementChild as HTMLButtonElement;
  expect(first.textContent).toBe("À toi3");
  expect(first.querySelector('[aria-label="3 en attente"]')).not.toBeNull();
  await act(async () => first.click());
  expect(inbox).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll(".rail-bottom button")].map((b) => b.textContent)).toEqual(["Nouvel agent", "Objectifs", "Rechercher", "Réglages"]);
  await act(async () => button("Nouvel agent")!.click());
  expect(newAgent).toHaveBeenCalledTimes(1);
});

it("le tiroir du téléphone suit la même logique : agent ouvert déplié, historique à un clic", async () => {
  const onThread = vi.fn(), close = vi.fn(), pick = vi.fn();
  await act(async () => root.render(<Drawer agents={agents} agentId="a" conversations={threads} tabs={["chat", "activity"]} waiting={1} onAgent={pick} onThread={onThread} onNewAgent={noOp} onTab={noOp} onCustomize={noOp} onSettings={noOp} onGoals={noOp} onClose={close} onLogout={noOp} />));
  expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[aria-label="Options de Noah"]')).not.toBeNull();
  expect(document.body.textContent).not.toMatch(/Discussions/);
  await act(async () => button("Historique")!.click());
  await act(async () => button("Fil du matin")!.click());
  expect(onThread).toHaveBeenCalledWith("2");
  expect(close).toHaveBeenCalled();
  await act(async () => rows()[2].click());
  expect(pick).toHaveBeenCalledWith("c");
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
