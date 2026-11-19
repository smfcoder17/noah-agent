import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const decision = {
  id: "q9", genre: "question", de: "lea", de_nom: "Léa", tache_id: "t1", tache: "Newsletter de mars", conversation_id: "c1",
  titre: "Quelle longueur pour l'objet ?", pourquoi: "", choix: [], libre: true, reserve: "", chemin: [{ id: "lea", nom: "Léa" }, { id: "noah", nom: "Noah" }], cree: 1_700_000_000,
  reponse: "Court et direct", par: "Noah", par_id: "noah", le: 1_700_000_100, correction: "", corrigee: false, regle_id: null,
};
vi.mock("@/lib/api", () => ({ get: vi.fn(async () => ({ decisions: [decision] })), send: vi.fn(async () => ({ id: "q9", regle_id: "r1" })) }));
vi.mock("@/lib/ouverture", () => ({ useOuverture: () => ({ revision: "1" }) }));
vi.mock("./ui", () => ({
  Button: ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p}>{children}</button>,
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  ErrorText: ({ children }: { children?: React.ReactNode }) => (children ? <p role="alert">{children}</p> : null),
}));
import { get, send } from "@/lib/api";
import { Decisions } from "./Decisions";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  vi.mocked(send).mockClear();
  vi.mocked(get).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Decisions agentId="lea" refreshKey={0} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const bouton = (nom: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === nom)!;
const ecrire = async (champ: HTMLInputElement, valeur: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(champ, valeur);
  champ.dispatchEvent(new Event("input", { bubbles: true }));
});

it("liste ce que les agents ont décidé : la question, qui a répondu, quoi", () => {
  expect(get).toHaveBeenCalledWith("/api/decisions");
  expect(host.querySelector("h2")?.textContent).toBe("Décidé pour toi");
  expect(host.querySelector(".row-title")?.textContent).toBe("Quelle longueur pour l'objet ?");
  expect(host.querySelector(".row-sub")?.textContent).toBe("Noah a répondu : Court et direct");
});

it("« Corriger » montre la question et la réponse, enregistre la correction comme règle, la ligne dit « Corrigé par toi »", async () => {
  await act(async () => bouton("Corriger").click());
  const fenetre = host.querySelector('[role="dialog"]')!;
  expect(fenetre.textContent).toContain("Quelle longueur pour l'objet ?");
  expect(fenetre.textContent).toContain("Court et direct");
  expect((fenetre.querySelector('input[role="switch"]') as HTMLInputElement).checked).toBe(true);
  await ecrire(fenetre.querySelector<HTMLInputElement>("input.input")!, "Moins de 40 caractères");
  await act(async () => bouton("Enregistrer").click());
  expect(send).toHaveBeenCalledWith("/api/questions/q9/correction", { correction: "Moins de 40 caractères", regle: true });
  expect(host.querySelector(".row-sub")?.textContent).toBe("Corrigé par toi : Moins de 40 caractères");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it("une correction vide ne part pas ; sans « Retenir comme règle », elle part sans règle", async () => {
  await act(async () => bouton("Corriger").click());
  await act(async () => bouton("Enregistrer").click());
  expect(send).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Écris ta réponse");
  await act(async () => (host.querySelector('input[role="switch"]') as HTMLInputElement).click());
  await ecrire(host.querySelector<HTMLInputElement>("input.input")!, "Chaleureux");
  await act(async () => bouton("Enregistrer").click());
  expect(send).toHaveBeenCalledWith("/api/questions/q9/correction", { correction: "Chaleureux", regle: false });
});
