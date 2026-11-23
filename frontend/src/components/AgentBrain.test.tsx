import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ get: async (path: string) => path === "/api/model" ? { provider: "openrouter", model: "test" } : { modes: ["fast", "balanced", "smart"].map((id) => ({ id, modele: { modele: "test", fournisseur: "openrouter", nom: "Test" } })), gratuit: [], custom: [] }, send: vi.fn() }));
vi.mock("./Modes", () => ({ ModelSearch: ({ onPick }: { onPick: (m: { id: string; fournisseur: string }) => void }) => <button data-pick onClick={() => onPick({ id: "qwen3", fournisseur: "autre:vllm" })}>Choix du modèle</button> }));
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

// X11 : le choix d'un modèle précis dit aussi chez quel fournisseur (l'un des « autres » peut le servir), et prévient l'application.
it("un modèle précis part avec son fournisseur, et le changement est annoncé (noah:cerveau)", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  const heard = vi.fn();
  window.addEventListener("noah:cerveau", heard);
  await act(async () => root.render(<AgentBrain agentId="a" mode={null} own={null} bare onChanged={() => {}} />));
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.textContent?.includes("Un modèle précis"))!.click());
  await act(async () => host.querySelector<HTMLButtonElement>("[data-pick]")!.click());
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/model", { model: "qwen3", provider: "autre:vllm" }, "PUT");
  expect(heard).toHaveBeenCalledOnce();
  window.removeEventListener("noah:cerveau", heard);
  await act(async () => root.unmount());
  host.remove();
});
