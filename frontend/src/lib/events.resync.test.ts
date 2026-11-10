import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(async (path: string) => path === "/api/agents" ? [{ id: "a" }] : path.endsWith("conversations") ? [{ id: "c" }] : []), request: vi.fn() }));
vi.mock("./api", () => ({ currentAuthEpoch: () => "alice", ...api }));
import { subscribeUpdates } from "./events";

it("relit les données après un trou de dix minutes avant de rouvrir le flux", async () => {
  const order: string[] = [];
  api.request.mockImplementationOnce(async () => ({ body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('id: 42\nevent: resync\ndata: {}\n\n')); c.close(); } }) }));
  api.request.mockImplementation(async (_path, init) => { order.push("réouverture"); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("fermé")))); });
  const stop = subscribeUpdates(async () => { order.push("données relues"); });
  await vi.waitFor(() => expect(api.request).toHaveBeenCalledTimes(2), { timeout: 4000 });
  expect(api.get).toHaveBeenCalledWith("/api/agents/a/conversations");
  expect(api.get).toHaveBeenCalledWith("/api/conversations/c/en-cours?suivi=false");
  expect(order.indexOf("données relues")).toBeLessThan(order.indexOf("réouverture"));
  expect(api.request.mock.calls[1][1].headers).toEqual({ "Last-Event-ID": "42" });
  stop();
});
