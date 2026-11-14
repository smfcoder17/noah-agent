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

function Scene() {
  const messages = [
    { id: "u1", role: "user", content: [{ type: "text", text: "Dis-moi quelque chose." }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "Voici une réponse de l'agent." }], status: { type: "complete", reason: "stop" } },
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

it("chaque réponse d'agent porte « Signaler », pas les messages de la personne, et le signalement reprend la réponse", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<Scene />));
  await act(async () => {});
  const answer = host.querySelector('[data-noah-msg="a1"]')!;
  const mine = host.querySelector('[data-noah-msg="u1"]')!;
  expect(answer.querySelector('button[aria-label="Signaler la réponse"]')).not.toBeNull();
  expect(mine.querySelector('button[aria-label="Signaler la réponse"]')).toBeNull();

  await act(async () => answer.querySelector<HTMLButtonElement>('button[aria-label="Signaler la réponse"]')!.click());
  await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="radio"]')!.click());
  const link = document.querySelector<HTMLAnchorElement>('[role="dialog"] a[href^="mailto:"]')!;
  expect(decodeURIComponent(new URL(link.href).searchParams.get("body") ?? "")).toContain("Voici une réponse de l'agent.");
  await act(async () => root.unmount());
  host.remove();
});
