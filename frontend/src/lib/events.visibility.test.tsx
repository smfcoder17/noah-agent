import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ request: vi.fn(), get: vi.fn(async () => []), currentAuthEpoch: () => "test" }));
vi.mock("./api", () => api);
import { subscribeUpdates, useVisibleSubscription } from "./events";
import { KeepAlive } from "@/components/KeepAlive";

let stream: ReadableStreamDefaultController<Uint8Array>;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  api.request.mockImplementation(async () => ({ body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }) }));
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
const emit = async (count = 1) => {
  for (let i = 0; i < count; i++) stream.enqueue(new TextEncoder().encode(`event: donnees.changees\ndata: {}\n\n`));
  await Promise.resolve(); await Promise.resolve();
};

it("10 — regroupe une rafale et borne les relances à une toutes les 500 ms", async () => {
  const load = vi.fn(); stop = subscribeUpdates(load);
  await emit(10); await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100); await emit(10);
  await vi.advanceTimersByTimeAsync(399);
  expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(2);
  await emit(5); await vi.advanceTimersByTimeAsync(499);
  expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(load).toHaveBeenCalledTimes(3);
});

it("10 — garde un écran monté sans le relire caché et le relit à son retour", async () => {
  const load = vi.fn(), mounted = vi.fn();
  function Screen() {
    const subscribe = useVisibleSubscription();
    useEffect(() => { mounted(); return subscribe(load); }, [subscribe]);
    return <input defaultValue="Conservé" />;
  }
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => { root.render(<KeepAlive active><Screen /></KeepAlive>); await vi.advanceTimersByTimeAsync(0); });
    const input = host.querySelector("input");
    load.mockClear();
    await act(async () => root.render(<KeepAlive active={false}><Screen /></KeepAlive>));
    await act(async () => { await emit(5); await vi.advanceTimersByTimeAsync(1000); });
    expect(load).not.toHaveBeenCalled();
    await act(async () => { root.render(<KeepAlive active><Screen /></KeepAlive>); });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(host.querySelector("input")).toBe(input);
  } finally { await act(async () => root.unmount()); }
});

it("10 — attend aussi le retour de la fenêtre après un événement reçu en arrière-plan", async () => {
  const load = vi.fn(); stop = subscribeUpdates(load);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await emit(5); await vi.advanceTimersByTimeAsync(1000);
  expect(load).not.toHaveBeenCalled();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(1);
});
