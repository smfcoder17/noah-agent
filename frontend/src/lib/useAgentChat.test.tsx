// Lot E (0.1.8) : le fil reste fluide pendant qu'une réponse s'écrit, une relecture ne l'efface pas, et rien ne passe d'un compte à l'autre.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, type Mock, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(async () => ({})), request: vi.fn(async () => ({ json: async () => [] })), streamChat: vi.fn(), uploadFile: vi.fn() }));
vi.mock("./api", () => {
  class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
  class StreamLost extends Error {}
  return { ApiError, StreamLost, currentAuthEpoch: () => "alice", ...api };
});
vi.mock("./events", () => ({
  useVisibleSubscription: () => () => () => {},
  useAccords: () => ({ items: [], recent: [] }),
  accordLabel: () => "",
  refreshAccords: async () => {},
}));

import { forgetSeen } from "./seen";
import { type ChatMessage, useAgentChat, visibleMessages } from "./useAgentChat";

type Chat = ReturnType<typeof useAgentChat>;
const textOf = (chat: Chat) => chat.runtime.thread.getState().messages.map((m) => m.content.map((p) => (p.type === "text" ? p.text : "")).join(""));

async function open(conversationId: string) {
  let chat!: Chat;
  function Screen() {
    chat = useAgentChat({ agentId: "a", conversationId, details: false, onConversationCreated: () => {}, onRunFinished: () => {} });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Screen />));
  return { chat: () => chat, close: () => act(async () => root.unmount()) };
}

const stored = (id: number, role: string, text: string) => ({ id, role, text, created_at: "2026-01-01 10:00:00" });
/** Le serveur : la page de messages de chaque conversation, et rien en cours. */
function serve(pages: Record<string, unknown[] | Promise<unknown[]>>) {
  api.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/en-cours")) return { occupe: false, activite: null, run_id: null, file: [], accord: null };
    const conv = path.match(/^\/api\/conversations\/([^/]+)\/messages/)?.[1];
    return conv ? pages[conv] ?? [] : [];
  });
}

beforeEach(() => {
  forgetSeen();
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

it("pendant le flux, un message qui ne change pas garde son objet", () => {
  const old: ChatMessage = { id: "h1", role: "user", content: [{ type: "text", text: "Bonjour" }] };
  const answered: ChatMessage = { id: "h2", role: "assistant", content: [{ type: "tool-call", toolCallId: "p1", toolName: "approval", args: {}, result: "oui" }] };
  const asking: ChatMessage = { id: "r1", role: "assistant", content: [{ type: "text", text: "Je regarde" }, { type: "tool-call", toolCallId: "p2", toolName: "approval", args: {} }] };
  const shown = visibleMessages([old, answered, asking]);
  expect(shown[0]).toBe(old);
  expect(shown[1]).toBe(answered);
  // Seul le message qui porte une demande d'accord ouverte est recopié, sans elle.
  expect(shown[2]).not.toBe(asking);
  expect(shown[2].content).toEqual([{ type: "text", text: "Je regarde" }]);
});

it("ouvrir une conversation ne demande sa page de messages qu'une fois", async () => {
  let answer!: (rows: unknown[]) => void;
  serve({ c6: new Promise<unknown[]>((resolve) => { answer = resolve; }) });
  const screen = await open("c6");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(api.get.mock.calls.filter(([path]) => String(path).includes("/c6/messages"))).toHaveLength(1);
  await act(async () => { answer([stored(1, "user", "Bonjour")]); });
  expect(textOf(screen.chat())).toEqual(["Bonjour"]);
  await screen.close();
});

it("un resync pendant le flux garde la réponse en cours d'écriture", async () => {
  serve({ c5: [] });
  let finish!: () => void;
  api.streamChat.mockImplementation(async (_body: unknown, onEvent: (ev: unknown) => void) => {
    onEvent({ type: "start", run_id: "run1", conversation_id: "c5" });
    onEvent({ type: "message", text: "Voici le début" });
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  const screen = await open("c5");
  await act(async () => { screen.chat().runtime.thread.append({ role: "user", content: [{ type: "text", text: "Raconte" }] }); });
  await vi.waitFor(() => expect(textOf(screen.chat())).toEqual(["Raconte", "Voici le début"]));

  // Le serveur n'a encore enregistré que la demande : sans garde, la relecture effacerait la réponse à l'écran.
  serve({ c5: [stored(1, "user", "Raconte")] });
  const tasks: Promise<unknown>[] = [];
  await act(async () => {
    window.dispatchEvent(new CustomEvent("noah:resync", { detail: tasks }));
    await Promise.all(tasks);
  });
  expect(tasks.length).toBe(2);
  expect(textOf(screen.chat())).toEqual(["Raconte", "Voici le début"]);

  await act(async () => { finish(); });
  await screen.close();
});

it("au changement de compte, les messages gardés en mémoire ne ressortent pas", async () => {
  serve({ c13: [stored(1, "user", "Secret d'Alice")] });
  const alice = await open("c13");
  await vi.waitFor(() => expect(textOf(alice.chat())).toEqual(["Secret d'Alice"]));
  await alice.close();

  // Témoin : sans changement de compte, la conversation se rouvre depuis la mémoire, avant toute réponse du serveur.
  serve({ c13: new Promise(() => {}) });
  const again = await open("c13");
  expect(textOf(again.chat())).toEqual(["Secret d'Alice"]);
  await again.close();

  forgetSeen(); // ce que fait api.ts à chaque connexion et déconnexion
  const bob = await open("c13");
  expect(textOf(bob.chat())).toEqual([]);
  await bob.close();
});

it("une lecture lancée pour le compte d'avant ne remplit pas l'écran du suivant", async () => {
  let answer!: (rows: unknown[]) => void;
  serve({ c14: new Promise<unknown[]>((resolve) => { answer = resolve; }) });
  const screen = await open("c14");
  forgetSeen(); // déconnexion pendant que la page de messages est en route
  await act(async () => { answer([stored(1, "user", "Secret d'Alice")]); await new Promise((r) => setTimeout(r, 20)); });
  expect(textOf(screen.chat())).toEqual([]);
  await screen.close();

  serve({ c14: new Promise(() => {}) });
  const next = await open("c14");
  expect(textOf(next.chat())).toEqual([]);
  await next.close();
});

it("pendant le travail, un message entre dans le fil tout de suite et reçoit l'accusé sans arrêter le travail", async () => {
  // Le travail tourne sur le serveur ; la page de messages reste en route (une relecture par-dessus est l'affaire d'autres tests).
  let opened = false;
  api.get.mockImplementation(async (path: string) => {
    if (path.endsWith("/en-cours")) return { occupe: true, activite: "Étape 2 sur 5 : compare les prix", run_id: "r1", file: [], accord: null };
    if (opened) return new Promise(() => {});
    opened = true;
    return [];
  });
  let answer!: (r: { type: string; reponse: string }) => void;
  const send = api.send as unknown as Mock<(path: string) => Promise<unknown>>;
  send.mockImplementation(async (path: string) => (path === "/api/chat/pendant" ? new Promise((resolve) => { answer = resolve; }) : {}));
  const screen = await open("c9");
  const said = () => textOf(screen.chat()).filter(Boolean); // la bulle vide est la ligne de travail de l'agent
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(screen.chat().whileBusy.active).toBe(true);
  await act(async () => { screen.chat().whileBusy.send("Ajoute aussi les horaires"); await new Promise((r) => setTimeout(r, 20)); });
  // Le tri n'a pas encore répondu : le message est déjà dans le fil, et rien n'a demandé l'arrêt du travail.
  expect(said()).toEqual(["Ajoute aussi les horaires"]);
  expect(send.mock.calls.map(([path]) => path)).toEqual(["/api/chat/pendant"]);
  await act(async () => { answer({ type: "precision", reponse: "Noté, je l'ajoute à ce que je fais." }); await new Promise((r) => setTimeout(r, 20)); });
  expect(said()).toEqual(["Ajoute aussi les horaires", "Noté, je l'ajoute à ce que je fais."]);
  expect(screen.chat().whileBusy.active).toBe(true);
  await screen.close();
});
