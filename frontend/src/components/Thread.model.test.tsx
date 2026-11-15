import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// jsdom n'a ni matchMedia (lu dès l'import de chatMood), ni ResizeObserver, ni CSS.escape : un écran de téléphone, comme dans l'app.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") } as unknown as typeof CSS;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), get: vi.fn(async () => ({})), send: vi.fn(async () => ({})) }));
import { AgentContext, Thread } from "./Thread";

const AGENT = { agentId: "a", agentName: "Noah", agentColor: "#c2410c", agentShape: "gomme", agentDetail: "", agentModel: "", details: false, hint: "", conversationId: null, say: () => {}, readOnly: false, canWatch: false };

const user = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] });
const reply = (id: string, text: string, model?: string) => ({ id, role: "assistant", content: [{ type: "text", text }], status: { type: "complete", reason: "stop" }, metadata: { custom: { model } } });

function Scene() {
  const messages = [
    reply("a0", "Réponse d'avant, sans modèle."),
    user("u1", "Bonjour"),
    reply("a1", "Première réponse.", "openai/gpt-5.1"),
    user("u2", "Encore"),
    reply("a2", "Même modèle.", "openai/gpt-5.1"),
    user("u3", "Et là ?"),
    reply("a3", "Autre modèle.", "anthropic/claude-sonnet-4.5"),
  ] as unknown as ThreadMessageLike[];
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages, isRunning: false, onNew: async () => {}, convertMessage: (m) => m });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={AGENT}>
        <Thread report={null} onReportRead={() => {}} onCall={() => {}} />
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}

it("une ligne fine au premier modèle connu et à chaque changement, et le modèle de chaque réponse dans sa rangée d'actions", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<Scene />));
  await act(async () => {});
  const dividers = [...host.querySelectorAll<HTMLElement>("[data-model-divider]")];
  expect(dividers.map((d) => d.textContent)).toEqual(["Modèle : GPT 5.1", "Passage à Claude Sonnet 4.5"]);
  expect(dividers.map((d) => d.title)).toEqual(["openai/gpt-5.1", "anthropic/claude-sonnet-4.5"]);
  // Chaque ligne se tient juste avant la réponse qu'elle annonce.
  expect(dividers[0].nextElementSibling?.getAttribute("data-noah-msg")).toBe("a1");
  expect(dividers[1].nextElementSibling?.getAttribute("data-noah-msg")).toBe("a3");
  const modelOf = (id: string) => host.querySelector(`[data-noah-msg="${id}"] [data-message-model]`)?.textContent ?? null;
  expect([modelOf("a0"), modelOf("a1"), modelOf("a2"), modelOf("a3")]).toEqual([null, "GPT 5.1", "GPT 5.1", "Claude Sonnet 4.5"]);
  expect(host.querySelector('[data-noah-msg="u1"] [data-message-model]')).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
