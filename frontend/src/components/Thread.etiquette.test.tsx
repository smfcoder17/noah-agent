import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// X11 : l'étiquette sous la saisie vient du cerveau que le serveur dit pour l'agent, jamais d'une valeur gardée de côté.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") } as unknown as typeof CSS;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
const get = vi.fn(async (_path: string): Promise<unknown> => ({}));
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), get: (path: string) => get(path), send: vi.fn(async () => ({})) }));
import { brainLabel } from "@/lib/modes";
import { AgentContext, Thread } from "./Thread";

const base = { agentId: "a", agentName: "Noah", agentColor: "#c2410c", agentShape: "gomme", agentDetail: "", details: false, hint: "", conversationId: null, say: () => {}, readOnly: false, canWatch: true };

function Scene({ model }: { model: string }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [], isRunning: false, onNew: async () => {}, convertMessage: (m) => m });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={{ ...base, agentModel: model }}>
        <Thread report={null} onReportRead={() => {}} onCall={() => {}} />
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}

it("brainLabel : le nom du mode (Auto…), sinon le modèle lisible, sinon rien", () => {
  expect(brainLabel({ mode: "auto", modele: null, fournisseur: null, fournisseur_nom: null })).toBe("Auto");
  expect(brainLabel({ mode: null, modele: "openai/gpt-5.1", fournisseur: "openrouter", fournisseur_nom: "OpenRouter" })).toBe("GPT 5.1");
  expect(brainLabel(undefined)).toBe("");
});

it("l'étiquette suit le cerveau de l'agent à chaque changement, sans relire le modèle de tous ni recharger", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  const chip = () => host.querySelector("[data-model-chip]")?.textContent;
  await act(async () => root.render(<Scene model="GPT 5.1" />));
  expect(chip()).toBe("GPT 5.1");
  await act(async () => root.render(<Scene model="Claude Sonnet 4.5" />)); // l'agent change de modèle
  expect(chip()).toBe("Claude Sonnet 4.5");
  await act(async () => root.render(<Scene model="Auto" />)); // le cerveau de tous passe en Auto, l'agent le suit
  expect(chip()).toBe("Auto");
  expect(get.mock.calls.some(([path]) => path === "/api/model")).toBe(false);
  await act(async () => root.unmount());
  host.remove();
});
