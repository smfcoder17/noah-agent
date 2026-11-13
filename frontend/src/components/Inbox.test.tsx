import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const proposition = { type: "proposition", id: "p1", agent_id: "a", agent: "Léa", texte: "Je peux trier tes courriels de la semaine.", cree: 1_700_000_000 };
vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => [proposition]),
  send: vi.fn(async () => ({ ok: true })),
  isProposition: (r: { type?: string }) => r.type === "proposition",
}));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {}, refreshAccords: async () => {}, useAccords: () => ({ items: [] }) }));
vi.mock("./Noah", () => ({ AgentFace: () => <span data-face /> }));
vi.mock("./LoginCard", () => ({ LoginCard: () => null }));
vi.mock("./Sidebar", () => ({ StateShape: () => null }));
vi.mock("./ui", () => ({
  Button: ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p}>{children}</button>,
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ErrorText: ({ children }: { children?: React.ReactNode }) => (children ? <p role="alert">{children}</p> : null),
}));
import { send } from "@/lib/api";
import { Inbox } from "./Inbox";

const agents = [{ id: "a", name: "Léa" }] as never[];
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const onOpenAgent = vi.fn();
beforeEach(async () => {
  vi.mocked(send).mockReset().mockResolvedValue({ ok: true });
  onOpenAgent.mockReset();
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Inbox open agents={agents} onOpenChange={() => {}} onOpenConversation={() => {}} onOpenAgent={onOpenAgent} />));
});
afterEach(async () => { await act(async () => root.unmount()); });
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="${name}"]`)!;

it("montre la proposition avec son agent, son texte, « Fais-le » et « Non »", () => {
  expect(host.textContent).toContain("Léa te propose");
  expect(host.textContent).toContain("Je peux trier tes courriels de la semaine.");
  expect(host.querySelector("[data-face]")).toBeTruthy();
  expect(button("Fais-le").textContent).toBe("Fais-le");
  expect(button("Non").textContent).toBe("Non");
  expect(host.textContent).not.toContain("Rien ne t'attend");
});

it("« Fais-le » envoie faire, retire la carte et ouvre la conversation de l'agent", async () => {
  await act(async () => button("Fais-le").click());
  expect(send).toHaveBeenCalledWith("/api/propositions/p1/reponse", { choix: "faire" });
  expect(host.textContent).not.toContain("Je peux trier");
  expect(onOpenAgent).toHaveBeenCalledWith("a");
});

it("« Non » envoie non et retire la carte, sans ouvrir la conversation", async () => {
  await act(async () => button("Non").click());
  expect(send).toHaveBeenCalledWith("/api/propositions/p1/reponse", { choix: "non" });
  expect(host.textContent).not.toContain("Je peux trier");
  expect(onOpenAgent).not.toHaveBeenCalled();
});

it("un échec remet la carte avec un mot simple", async () => {
  let fail!: (e: Error) => void;
  vi.mocked(send).mockReturnValue(new Promise((_, reject) => { fail = reject; }));
  await act(async () => button("Fais-le").click());
  expect(host.textContent).not.toContain("Je peux trier"); // retirée tout de suite
  await act(async () => fail(new Error("502")));
  expect(host.textContent).toContain("Je peux trier");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Léa n'a pas pu lancer cette proposition. Réessaie dans un instant.");
  expect(onOpenAgent).not.toHaveBeenCalled();
});

const failing = (status: number) => Object.assign(new Error(`Erreur ${status}`), { status });

it.each([404, 409])("déjà répondue ailleurs ou expirée (%i) : la carte part pour de bon, avec un mot simple", async (status) => {
  vi.mocked(send).mockRejectedValue(failing(status));
  await act(async () => button("Fais-le").click());
  expect(host.textContent).not.toContain("Je peux trier");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Cette proposition n'attend plus de réponse : elle a déjà été traitée ou elle a expiré.");
  expect(host.textContent).not.toContain("Réessaie");
});

it("serveur en panne (503) : la carte revient avec « Réessaie »", async () => {
  vi.mocked(send).mockRejectedValue(failing(503));
  await act(async () => button("Non").click());
  expect(host.textContent).toContain("Je peux trier");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Ta réponse n'est pas passée. Réessaie dans un instant.");
});
