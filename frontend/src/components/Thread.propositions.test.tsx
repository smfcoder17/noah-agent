import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// Propositions de l'agent (0.4.0, X7) : plus de carte fixe écrite dans le code. Un fil sans proposition de l'agent n'en montre aucune ;
// l'écran vide dit seulement « Que doit faire X ? ». Et un message d'initiative porte sa petite marque (X5), pas un titre dans le texte.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") } as unknown as typeof CSS;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), get: vi.fn(async () => ({})), send: vi.fn(async () => ({})) }));
import { AgentContext, Thread } from "./Thread";

const AGENT = { agentId: "a", agentName: "Noah", agentColor: "#c2410c", agentShape: "gomme", agentDetail: "", agentModel: "", details: false, hint: "", conversationId: null, say: () => {}, readOnly: false, canWatch: false };
const user = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] });
const reply = (id: string, text: string, custom: Record<string, unknown> = {}) => ({ id, role: "assistant", content: [{ type: "text", text }], status: { type: "complete", reason: "stop" }, metadata: { custom } });

function Scene({ messages }: { messages: unknown[] }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: messages as ThreadMessageLike[], isRunning: false, onNew: async () => {}, convertMessage: (m) => m });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={AGENT}>
        <Thread report={null} onReportRead={() => {}} onCall={() => {}} />
      </AgentContext.Provider>
    </AssistantRuntimeProvider>
  );
}

async function montrer(messages: unknown[]) {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<Scene messages={messages} />));
  await act(async () => {});
  return { host, fin: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("l'écran vide dit « Que doit faire Noah ? » et ne propose aucune carte", async () => {
  const { host, fin } = await montrer([]);
  expect(host.textContent).toContain("Que doit faire Noah ?");
  expect(host.querySelector("[data-return-cards]")).toBeNull();
  expect(host.textContent).not.toContain("Montre-moi");
  expect(host.querySelectorAll(".thread button")).toHaveLength(0);
  await fin();
});

it("un fil où l'agent ne propose rien ne montre aucune carte, même après un long silence", async () => {
  const { host, fin } = await montrer([user("u1", "Bonjour"), reply("a1", "Bonjour, je suis là.")]);
  expect(host.querySelector("[data-return-cards]")).toBeNull();
  for (const phrase of ["Montre-moi", "Qu'est-ce qui attend ma réponse", "Que me proposes-tu", "Lance «"]) expect(host.textContent).not.toContain(phrase);
  await fin();
});

it("un message d'initiative porte une petite marque, un message ordinaire non", async () => {
  const { host, fin } = await montrer([reply("a1", "**Réunion déplacée**\n\nElle est à 15 h.", { initiative: true }), user("u1", "Merci"), reply("a2", "Je t'en prie.")]);
  expect(host.querySelector('[data-noah-msg="a1"] [data-marque-initiative]')?.getAttribute("title")).toBe("Message envoyé de sa propre initiative");
  expect(host.querySelector('[data-noah-msg="a2"] [data-marque-initiative]')).toBeNull();
  expect(host.textContent).not.toContain("De lui-même");
  await fin();
});
