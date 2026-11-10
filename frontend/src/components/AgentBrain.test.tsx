import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ get: async (path: string) => path === "/api/model" ? { provider: "openrouter", model: "test" } : { modes: ["fast", "balanced", "smart"].map((id) => ({ id, modele: { modele: "test", fournisseur: "openrouter", nom: "Test" } })), gratuit: [], custom: [] }, send: vi.fn() }));
vi.mock("./Modes", () => ({ ModelSearch: () => <span>Choix du modèle</span> }));
vi.mock("./Providers", () => ({ Providers: () => <span>Fournisseurs</span> }));
vi.mock("./ProviderLogo", () => ({ ProviderLogo: ({ lab }: { lab: string }) => <span data-logo={lab} /> }));
import { AgentBrain } from "./AgentBrain";
import { send } from "@/lib/api";
it("présente Auto, les trois niveaux et les deux autres choix sur un seul écran", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgentBrain agentId="a" mode="auto" own={null} bare onChanged={() => {}} />));
  expect(host.querySelectorAll('[role="radio"]').length).toBe(3);
  for (const label of ["Simple", "Moyen", "Complexe", "Comme mes autres agents", "Un modèle précis", "Réflexion"]) expect(host.textContent).toContain(label);
  expect(host.querySelectorAll('[data-logo="openrouter"]').length).toBe(3);
  expect([...host.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
    expect.stringContaining("Auto"), expect.stringContaining("Comme mes autres agents"), expect.stringContaining("Un modèle précis"),
  ]);
  const radios = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  await act(async () => radios[1].click());
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/model", { model: null }, "PUT");
  // B4 : choisir ne replie plus un panneau dont l'état ne servait plus.
  expect(host.querySelector('[role="radiogroup"]')).toBeTruthy();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/model", { mode: "auto" }, "PUT");
  expect(host.querySelectorAll(".brain-tier")).toHaveLength(3);
  await act(async () => root.unmount());
});
