import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

// Lot 2 de la 0.2.0 : au premier lancement, « Qu'est-ce que tu veux atteindre ? » crée un objectif. Facultatif.
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  get: vi.fn(async (path: string) => (path === "/api/presets" ? { version: 1, presets: [], defaut: { demandes: [] }, agents: {} } : [])),
  send: vi.fn(),
  request: vi.fn(() => new Promise(() => {})),
  streamChat: vi.fn(),
}));

import { send, type Status } from "@/lib/api";
import { Onboarding } from "./Onboarding";

beforeEach(() => {
  vi.mocked(send).mockImplementation(async (path: string) => (path === "/api/agents" ? { id: "noah-ab12" } : { id: "objectif-1" }));
});

const render = async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<Onboarding status={{ has_account: true, model_configured: true } as Status} onDone={() => {}} />));
  return host;
};
const goalField = (host: HTMLElement) => [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Qu'est-ce que tu veux atteindre ?"))!.querySelector("input")!;
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Continuer")!.click();

it("sur l'étape « Premier agent », sans étape de plus, avec une phrase d'aide", async () => {
  const host = await render();
  expect([...host.querySelectorAll("ol[aria-label='Étapes'] li")].map((li) => li.textContent)).toEqual(
    ["1. Code", "2. Installation", "3. Compte", "4. Modèle", "5. Premier agent", "6. Essai"]);
  expect(goalField(host)).toBeTruthy();
  expect(host.textContent).toContain("Tu peux laisser vide.");
});

it("rempli : l'objectif est créé pour le nouvel agent, après lui", async () => {
  const host = await render();
  await act(async () => type(goalField(host), "  Publier deux posts par semaine "));
  await act(async () => submit(host));
  expect(vi.mocked(send).mock.calls.map((c) => c[0])).toEqual(["/api/agents", "/api/goals"]);
  expect(send).toHaveBeenLastCalledWith("/api/goals", { texte: "Publier deux posts par semaine", agent_id: "noah-ab12" });
  expect(host.textContent).toContain("Premier essai");
});

it("laissé vide : aucun objectif, l'agent est créé quand même", async () => {
  const host = await render();
  await act(async () => submit(host));
  expect(vi.mocked(send).mock.calls.map((c) => c[0])).toEqual(["/api/agents"]);
  expect(host.textContent).toContain("Premier essai");
});

it("l'objectif refusé : l'erreur s'affiche, et le clic suivant ne crée pas un deuxième agent", async () => {
  vi.mocked(send).mockImplementation(async (path: string) => {
    if (path === "/api/agents") return { id: "noah-ab12" };
    throw new Error("50 objectifs au plus : retire ceux qui sont finis.");
  });
  const host = await render();
  await act(async () => type(goalField(host), "Apprendre l'espagnol"));
  await act(async () => submit(host));
  expect(host.querySelector("[role=alert], .text-danger")?.textContent ?? host.textContent).toContain("50 objectifs au plus");
  await act(async () => submit(host));
  expect(vi.mocked(send).mock.calls.filter((c) => c[0] === "/api/agents")).toHaveLength(1);
});
