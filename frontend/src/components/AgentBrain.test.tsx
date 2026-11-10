import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ get: async (path: string) => path === "/api/model" ? { provider: "openrouter", model: "test" } : { modes: ["fast", "balanced", "smart"].map((id) => ({ id, modele: { modele: "test", fournisseur: "openrouter", nom: "Test" } })), gratuit: [], custom: [] }, send: vi.fn() }));
vi.mock("./Modes", () => ({ ModelSearch: () => <span>Choix du modèle</span> }));
vi.mock("./Providers", () => ({ Providers: () => <span>Fournisseurs</span> }));
vi.mock("./ProviderLogo", () => ({ ProviderLogo: ({ lab }: { lab: string }) => <span data-logo={lab} /> }));
import { AgentBrain } from "./AgentBrain";
it("présente Auto, les trois niveaux et les deux autres choix sur un seul écran", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<AgentBrain agentId="a" mode="auto" own={null} bare onChanged={() => {}} />));
  expect(host.querySelectorAll('[role="radio"]').length).toBe(3);
  for (const label of ["Simple", "Moyen", "Complexe", "Comme mes autres agents", "Un modèle précis", "Réflexion"]) expect(host.textContent).toContain(label);
  expect(host.querySelectorAll('[data-logo="openrouter"]').length).toBe(3);
  await act(async () => root.unmount());
});
