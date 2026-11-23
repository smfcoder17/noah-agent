// X15 : le modèle de décision n'a pas pu répondre (clé refusée…). La personne le voit une fois, dans « Pour toi », avec le geste pour en changer.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const echec = { type: "decision", id: "decision-echec", modele: "mistralai/ministral-8b", raison: "Clé refusée par OpenRouter (401).", created: 1_700_000_000, cree: 1_700_000_000 };
let rows: unknown[] = [echec];
vi.mock("@/lib/api", () => ({
  get: vi.fn(async (path: string) => path === "/api/a-toi" ? rows : { modele: "mistralai/ministral-8b", nom: "Ministral 8B", secours: null, raison: null, prix_entree: 0.1, ms: 400, choisi_par: "auto", candidats: [], cerveau: "x", en_cours: false, mesure: true, type: null, decisions: [], ecartes: [], aucun: false, petits: [{ modele: "mistralai/ministral-8b", nom: "Ministral 8B", prix_entree: 0.1 }], cles: { openrouter: true, typesafe: false, openai: false } }),
  send: vi.fn(async () => ({ modele: "autre/petit", nom: "Petit", secours: null, raison: null, prix_entree: 0.05, ms: 300, choisi_par: "toi", candidats: [], cerveau: "x", en_cours: false, mesure: true, type: null, decisions: [], ecartes: [], aucun: false, petits: [], cles: { openrouter: true, typesafe: false, openai: false } })),
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
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, title }: { children: React.ReactNode; title: string }) => <div role="dialog" aria-label={title}>{children}</div>,
  ErrorText: ({ children }: { children?: React.ReactNode }) => (children ? <p role="alert">{children}</p> : null),
}));
import { del, send } from "@/lib/api";
import { Inbox } from "./Inbox";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const render = async () => { await act(async () => root.render(<Inbox open agents={[]} onOpenChange={() => {}} onOpenConversation={() => {}} />)); };
beforeEach(() => {
  rows = [echec];
  vi.mocked(del).mockClear();
  vi.mocked(send).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;

it("une clé refusée donne une carte : le modèle, la raison, ce qu'il décide, et deux gestes", async () => {
  await render();
  const card = host.querySelector('[aria-label="Le modèle de décision n\'a pas pu répondre"]')!;
  expect(card).toBeTruthy();
  expect(card.textContent).toContain("Ministral 8B n'a pas pu répondre");
  expect(card.textContent).toContain("Clé refusée par OpenRouter (401).");
  expect(card.textContent).toContain("veilles, routines, mémoire");
  expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Changer de modèle", "Plus tard"]);
  expect(host.textContent).toContain("Une décision te revient");
  expect(host.textContent).not.toContain("Rien ne t'attend");
});

it("« Changer de modèle » ouvre le choix du modèle de décision, et le nouveau choix ferme la carte", async () => {
  await render();
  await act(async () => button("Changer de modèle").click());
  const dialog = host.querySelector('[role="dialog"][aria-label="Modèle de décision"]')!;
  expect(dialog).toBeTruthy();
  const select = dialog.querySelector<HTMLSelectElement>("select")!; // le choix est déjà ouvert : aucun clic de plus
  expect(select).toBeTruthy();
  await act(async () => {
    select.value = "auto";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(send).toHaveBeenCalledWith("/api/decision", { modele: "auto" });
  expect(host.querySelector('[aria-label="Le modèle de décision n\'a pas pu répondre"]')).toBeNull();
  expect(host.querySelector('[role="dialog"][aria-label="Modèle de décision"]')).toBeNull(); // le choix se referme
});

it("« Plus tard » ferme la carte, une seule fois, côté serveur aussi", async () => {
  await render();
  await act(async () => button("Plus tard").click());
  expect(del).toHaveBeenCalledWith("/api/decision/echec");
  expect(host.querySelector('[aria-label="Le modèle de décision n\'a pas pu répondre"]')).toBeNull();
  expect(host.textContent).toContain("Rien ne t'attend");
});

it("sans échec, aucune carte", async () => {
  rows = [];
  await render();
  expect(host.querySelector('[aria-label="Le modèle de décision n\'a pas pu répondre"]')).toBeNull();
});
