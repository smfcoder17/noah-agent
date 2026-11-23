import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const carte = {
  id: "q1", genre: "question", de: "hugo", de_nom: "Hugo", tache_id: "t1", tache: "Envoi de la newsletter", conversation_id: "c1",
  titre: "Quelle heure pour l'envoi ?", pourquoi: "Deux créneaux sont libres.", choix: ["8 h", "12 h"], libre: true, reserve: "",
  chemin: [{ id: "hugo", nom: "Hugo" }, { id: "noah", nom: "Noah" }], cree: 1_700_000_000,
};
const ligne = { type: "question", id: "q1", agent_id: "hugo", agent: "Hugo", conversation_id: "c1", titre: "Envoi", main: false, a_moi: true, etat: "approve", demande: carte.titre, apercu: [], created: 1_700_000_000, question: carte };
const idee = { type: "proposition", id: "p1", agent_id: "a", agent: "Léa", texte: "Je peux trier tes courriels.", cree: 1_700_000_100 };
vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => [ligne, idee]),
  send: vi.fn(async () => ({ ok: true })),
  del: vi.fn(async () => ({})),
  isProposition: (r: { type?: string }) => r.type === "proposition",
  isDecisionEchec: (r: { type?: string }) => r.type === "decision",
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

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const ouvrir = vi.fn();
beforeEach(async () => {
  vi.mocked(send).mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<Inbox open agents={[{ id: "hugo", name: "Hugo" }] as never[]} onOpenChange={() => {}} onOpenConversation={ouvrir} />));
});
afterEach(async () => { await act(async () => root.unmount()); });

it("assemble la question et la proposition, dit combien de décisions reviennent, sans ouvrir de fil", () => {
  expect(host.textContent).toContain("2 décisions te reviennent. Le reste se règle entre agents.");
  expect(host.querySelector('section.card[data-question="q1"] h2')?.textContent).toBe("Quelle heure pour l'envoi ?");
  expect(host.textContent).toContain("Hugo, transmis par Noah");
  expect(host.textContent).toContain("Léa te propose");
  expect(host.textContent).not.toContain("Une question attend ta réponse.");
});

it("répondre depuis « Pour toi » envoie la réponse à la question, sans ouvrir la conversation", async () => {
  const bouton = [...host.querySelectorAll("button")].find((b) => b.textContent === "12 h")!;
  await act(async () => bouton.click());
  expect(send).toHaveBeenCalledWith("/api/questions/q1/reponse", { reponse: "12 h" });
  expect(ouvrir).not.toHaveBeenCalled();
});

it("la question répondue ailleurs (la tâche, le fil) quitte la liste sans attendre la relève", async () => {
  await act(async () => { window.dispatchEvent(new CustomEvent("noah:question-repondue", { detail: { id: "q1", reponse: "8 h" } })); });
  expect(host.querySelector('[data-question="q1"]')).toBeNull();
  expect(host.textContent).toContain("Une décision te revient.");
});

it("en page (zone de travail, comme le prototype) : un titre, la phrase de compte, des cartes", async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Inbox open page agents={[{ id: "hugo", name: "Hugo" }] as never[]} onOpenChange={() => {}} onOpenConversation={ouvrir} />));
  expect(host.querySelector("main.chat-pane header h1")?.textContent).toBe("Pour toi");
  expect(host.querySelector(".col.narrow h2.title")?.textContent).toBe("Pour toi");
  expect(host.querySelector(".col.narrow > .stack p")?.textContent).toBe("2 décisions te reviennent. Le reste se règle entre agents.");
  expect(host.querySelectorAll(".col.narrow li.card, .col.narrow section.card").length).toBe(2);
});
