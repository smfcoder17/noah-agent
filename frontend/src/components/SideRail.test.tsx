import { act } from "react";
import { readFileSync } from "node:fs";
import { RAIL_KEY } from "@/lib/workPanel";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@/lib/api";

vi.mock("./Noah", () => ({ AgentFace: ({ agent }: { agent: Agent }) => <span data-agent={agent.id} />, agentColor: () => "#000" }));
import { SideRail } from "./desktop/SideRail";
import { Drawer } from "./mobile/Drawer";
import { AWAY, pageOf, RAIL_PAGE } from "./ConversationRail";

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.removeItem(RAIL_KEY); });

const agent = (id: string, name: string, tasks: Agent["tasks"] = {}) =>
  ({ id, name, online: true, state: "idle", tasks, droit: "proprietaire", color: "#000", pinned: false, partage: false, role: "", step: null }) as Agent;

const noOp = () => {};
type Props = Parameters<typeof SideRail>[0];
const base = (over: Partial<Props> = {}): Props => ({ agent: null, agents: [], tabs: ["chat", "activity", "tasks", "files", "computer"], active: "chat", onTab: noOp, onAgent: noOp, onPickAgent: noOp, onMenu: noOp, onSettings: noOp, onGoals: noOp, onNewAgent: noOp, ...over });
const render = async (props: Props) => { await act(async () => root.render(<SideRail {...props} />)); };
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".agent-nav-row")];
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(text));

const agents = [agent("a", "Noah"), agent("b", "Veille", { work: 1 }), agent("c", "BMD", { approve: 2 }), agent("d", "Quatre"), agent("e", "Cinq")];

it("aligne tous les agents en haut, avec leur état ; l'agent ouvert est sélectionné", async () => {
  const picked = vi.fn();
  await render(base({ agent: agents[0], agents, onPickAgent: picked }));
  expect(rows().map((r) => r.textContent)).toEqual(["NNoahDisponible", "VVeilleTravaille", "BBMDAttend ta réponse", "QQuatreDisponible", "CCinqDisponible"]);
  expect(rows()[0].getAttribute("aria-current")).toBe("true");
  expect(rows()[0].getAttribute("aria-expanded")).toBeNull(); // rien à déplier : ni options (en haut à droite), ni historique
  expect(rows().slice(1).every((r) => r.getAttribute("aria-current") === null && r.getAttribute("aria-expanded") === "false")).toBe(true);
  expect(rows()[2].getAttribute("aria-label")).toBe("BMD, Attend ta réponse · 2 en attente");
  // Plus de section « Discussions » ni de bouton de nouvelle discussion : une seule discussion par agent.
  expect(host.textContent).not.toMatch(/Discussions/i);
  expect(host.querySelector('[aria-label="Nouvelle discussion"]')).toBeNull();
  await act(async () => rows()[1].click());
  expect(picked).toHaveBeenCalledWith("b");
});

it("0.4.0 : la barre ne montre que les agents, sans historique ni liste de fils ; ouvrir un agent ouvre son fil", async () => {
  const picked = vi.fn();
  await render(base({ agent: agents[1], agents, onPickAgent: picked }));
  expect(host.querySelector('[role="group"]')).toBeNull();
  for (const label of ["Historique", "Discussion", "Tâches", "Fichiers", "Ordinateur", "Archivés"]) expect(button(label)).toBeUndefined();
  expect(host.textContent).not.toMatch(/Historique|Archivés/);
  expect(host.querySelector(".agent-nav-thread")).toBeNull();
  expect(rows()[1].getAttribute("aria-expanded")).toBeNull(); // rien à déplier sous l'agent ouvert
  await act(async () => rows()[2].click());
  expect(picked).toHaveBeenCalledWith("c");
});

it("met Pour toi tout en haut avec son compteur, puis Activité et Rechercher ; Nouvel agent, Réglages et le compte en bas", async () => {
  const inbox = vi.fn(), newAgent = vi.fn();
  await render(base({ agent: agents[0], agents, waiting: 3, onInbox: inbox, onNewAgent: newAgent }));
  const first = button("Pour toi")!;
  expect(first.textContent).toBe("Pour toi3");
  expect([...host.querySelectorAll("aside > button")].map((b) => b.textContent)).toEqual(["Pour toi3", "Activité", "RechercherCtrl K"]);
  expect(first.querySelector('[aria-label="3 en attente"]')).not.toBeNull();
  await act(async () => first.click());
  expect(inbox).toHaveBeenCalledTimes(1);
  const bottom = [...host.querySelectorAll(".rail-bottom > button")];
  expect(bottom[0].textContent).toBe("Réglages");
  expect(bottom).toHaveLength(2); // Réglages, puis le compte
  expect(host.querySelector(".rail-new")!.textContent).toBe("Nouvel agent");
  expect(host.querySelector(".rail-top .rail-fold")!.getAttribute("aria-label")).toBe("Replier la barre");
  await act(async () => button("Nouvel agent")!.click());
  expect(newAgent).toHaveBeenCalledTimes(1);
});

it("le tiroir du téléphone suit la même logique : agent ouvert déplié, aucun historique, aucune recherche de fils", async () => {
  const close = vi.fn(), pick = vi.fn();
  await act(async () => root.render(<Drawer agents={agents} agentId="a" tabs={["chat", "activity"]} waiting={1} onAgent={pick} onNewAgent={noOp} onTab={noOp} onCustomize={noOp} onSettings={noOp} onGoals={noOp} onClose={close} onLogout={noOp} />));
  expect(rows()[0].getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[aria-label="Options de Noah"]')).not.toBeNull();
  expect(document.body.textContent).not.toMatch(/Discussions|Historique|Archivés/);
  const search = document.querySelector<HTMLInputElement>("#drawer-search")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Quatre"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(rows().map((r) => r.textContent)).toEqual(["QQuatreDisponible"]);
  expect(document.body.textContent).not.toMatch(/Fils trouvés/);
  await act(async () => rows()[0].click());
  expect(pick).toHaveBeenCalledWith("d");
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

// ─── Lot barre : les trois petits points, le menu au survol, le clic droit ───────────────────────────────────────────────

const dots = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Menu de ${name}"]`);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const css = readFileSync("src/styles/desktop.css", "utf8");

it("point 1 : plus d'icône de réglages, trois petits points par agent à la place", async () => {
  await render(base({ agent: agents[0], agents }));
  expect(document.querySelector(".agent-nav-settings")).toBeNull();
  expect(document.querySelector('button[aria-label="Page de Noah"]')).toBeNull();
  for (const a of agents) {
    const b = dots(a.name)!;
    expect(b, a.name).not.toBeNull();
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.querySelectorAll("circle")).toHaveLength(3); // trois points, pas un autre pictogramme
  }
  // Les points ne sont pas dans le bouton de la ligne : le nom et le statut gardent toute la place.
  expect(rows()[0].querySelector(".agent-nav-more")).toBeNull();
  expect(css).not.toMatch(/padding-right:56px/);
});

it("point 2 : cachés par défaut, visibles au survol de n'importe quel agent, au focus clavier et sur écran tactile", () => {
  expect(css).toMatch(/\.agent-nav-more \{[^}]*opacity:0/);
  expect(css).toMatch(/\.agent-nav-item:hover \.agent-nav-more[^{]*\{[^}]*opacity:1/);
  expect(css).toMatch(/\.agent-nav-item:focus-within \.agent-nav-more[^{]*\{[^}]*opacity:1/);
  expect(css).toMatch(/\.agent-nav-more\[aria-expanded="true"\][^{]*\{[^}]*opacity:1/);
  expect(css).toMatch(/@media \(hover: none\)[^{]*\{[^}]*\.agent-nav-more[^}]*opacity:1/);
  // Le survol ne dépend pas de l'agent ouvert : la règle vise la ligne, pas `.is-selected`.
  expect(css).not.toMatch(/\.is-selected:hover \.agent-nav-more/);
});

it("point 2 : un clic sur les points d'un agent non ouvert ouvre son menu ; Personnaliser et Page agissent sur lui", async () => {
  const custom = vi.fn(), page = vi.fn(), pick = vi.fn(), open = vi.fn();
  await render(base({ agent: agents[0], agents, onCustomize: custom, onAgent: open, onPickAgent: pick, onAgentPage: page }));
  expect(menu()).toBeNull();
  await act(async () => dots("Veille")!.click());
  expect(menu()).not.toBeNull();
  expect(dots("Veille")!.getAttribute("aria-expanded")).toBe("true");
  expect(menuItems().map((b) => b.textContent)).toEqual(["Personnaliser", "Page de Veille"]);
  await act(async () => menuItems()[0].click());
  expect(custom).toHaveBeenCalledWith("b");
  expect(menu()).toBeNull(); // il se referme après le choix
  await act(async () => dots("Veille")!.click());
  await act(async () => menuItems()[1].click());
  expect(page).toHaveBeenCalledWith("b");
  expect(pick).not.toHaveBeenCalled(); // le menu n'ouvre pas la conversation de l'agent
  expect(open).not.toHaveBeenCalled();
});

it("point 2 : Échap referme le menu et rend le focus aux points ; un clic ailleurs le referme", async () => {
  await render(base({ agent: agents[0], agents, onCustomize: noOp }));
  await act(async () => dots("Noah")!.click());
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem"); // le clavier entre dans le menu
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(dots("Noah"));
  await act(async () => dots("Noah")!.click());
  await act(async () => { document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  expect(menu()).toBeNull();
});

it("point 2 : sans le droit d'administrer, le menu n'offre pas Personnaliser", async () => {
  const lecture = { ...agents[1], droit: "lecture" } as Agent;
  await render(base({ agent: agents[0], agents: [agents[0], lecture], onCustomize: noOp }));
  await act(async () => dots("Veille")!.click());
  expect(menuItems().map((b) => b.textContent)).toEqual(["Page de Veille"]);
});

it("point 3 : barre repliée, un clic droit sur un agent ouvre le même menu, sur cet agent", async () => {
  const custom = vi.fn();
  localStorage.setItem(RAIL_KEY, "1");
  await render(base({ agent: agents[0], agents, onCustomize: custom }));
  expect(document.querySelector("aside.side-rail")!.classList.contains("is-folded")).toBe(true);
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 120 });
  await act(async () => { rows()[1].dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true); // pas le menu du navigateur
  expect(menuItems().map((b) => b.textContent)).toEqual(["Personnaliser", "Page de Veille"]);
  expect(menu()!.getAttribute("aria-label")).toBe("Menu de Veille");
  await act(async () => menuItems()[0].click());
  expect(custom).toHaveBeenCalledWith("b");
});
