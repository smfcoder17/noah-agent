import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// « Pour toi » (0.4.0, L3) : un seul nombre pour la barre, l'en-tête du téléphone et la page : ce que la page liste.
// Deux questions d'agents et une proposition : 3, pas 1. Les accords (request_id) viennent de useAccords, pas d'ici.
const lignes = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("./api", () => ({ get: vi.fn(async () => lignes.rows), isProposition: (r: { type?: string }) => r.type === "proposition" }));
vi.mock("./events", () => ({ subscribeUpdates: () => () => {} }));
vi.mock("./seen", () => ({ onForget: () => {}, seenGeneration: () => 0 }));
import { setAutresCount, setPropositionCount, usePropositionCount } from "./propositions";

function Nombre() {
  return <span data-n>{usePropositionCount(true)}</span>;
}

it("le nombre est celui des lignes de la page : propositions, questions, choix, connexions ; pas les accords", async () => {
  lignes.rows = [
    { type: "question", id: "q1" }, { type: "question", id: "q2" }, { type: "proposition", id: "p1" },
    { id: "accord", request_id: "r1" },
    { id: "choix", etat: "choice" },
  ];
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<Nombre />));
  await act(async () => {});
  expect(host.querySelector("[data-n]")?.textContent).toBe("4");
  // Une question répondue sur place : la barre suit sans attendre la relecture.
  await act(async () => setAutresCount(2));
  expect(host.querySelector("[data-n]")?.textContent).toBe("3");
  await act(async () => setPropositionCount(0));
  expect(host.querySelector("[data-n]")?.textContent).toBe("2");
  await act(async () => root.unmount());
  host.remove();
});
