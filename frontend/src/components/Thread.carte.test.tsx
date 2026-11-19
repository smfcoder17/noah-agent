import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// Page d'une tâche (0.4.0, L3) : la carte de la question vient après la consigne (« Noah à Hugo … »), pas au-dessus du fil.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") } as unknown as typeof CSS;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), get: vi.fn(async () => ({})), send: vi.fn(async () => ({})) }));
import { AgentContext, Thread } from "./Thread";

const AGENT = { agentId: "hugo", agentName: "Hugo", agentColor: "#0f8a5f", agentShape: "gomme", agentDetail: "", agentModel: "", details: false, hint: "", conversationId: "c-envoi", say: () => {}, readOnly: false, canWatch: false, tache: "Hugo" };
const consigne = { id: "m1", role: "user", content: [{ type: "text", text: "[Demande de l'agent Noah (noah), pas de l'utilisateur. Ta réponse finale lui sera transmise.]\n\nProgrammer l'envoi de jeudi." }] };
const reponse = { id: "m2", role: "assistant", content: [{ type: "text", text: "Liste prête. Il manque l'heure." }], status: { type: "complete", reason: "stop" } };

function Scene({ messages, tache = "Hugo" }: { messages: unknown[]; tache?: string }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: messages as ThreadMessageLike[], isRunning: false, onNew: async () => {}, convertMessage: (m) => m });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentContext.Provider value={{ ...AGENT, tache, carte: <section data-question="q1">Envoyer à 8 h ou à 12 h ?</section> }}>
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

it("la carte suit la consigne « Noah à Hugo », et précède la réponse de l'agent", async () => {
  const { host, fin } = await montrer([consigne, reponse]);
  const ordre = [...host.querySelectorAll("[data-noah-msg], [data-question]")].map((e) => e.getAttribute("data-question") ?? e.getAttribute("data-noah-msg"));
  expect(ordre).toEqual(["m1", "q1", "m2"]);
  expect(host.querySelector('[data-noah-msg="m1"] .msg-who')?.textContent).toBe("Noah à Hugo");
  expect(host.querySelectorAll("[data-question]")).toHaveLength(1);
  await fin();
});

it("sans consigne dans le fil, la carte ouvre le fil : elle ne disparaît pas", async () => {
  const { host, fin } = await montrer([reponse]);
  const ordre = [...host.querySelectorAll("[data-noah-msg], [data-question]")].map((e) => e.getAttribute("data-question") ?? e.getAttribute("data-noah-msg"));
  expect(ordre).toEqual(["q1", "m2"]);
  await fin();
});
