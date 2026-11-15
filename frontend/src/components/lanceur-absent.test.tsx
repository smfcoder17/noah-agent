// Relecture 0.3.0, point 12 : lanceur absent, Fichiers et Connexions disent ce qui se passe et proposent de réessayer.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Connections } from "./AgentPowers";
import { Files } from "./Files";

const ABSENT = "Le lanceur des agents ne répond pas : l'agent est peut-être arrêté ou en train de redémarrer. Réessaie dans un instant.";
class NoObserver { observe() {} disconnect() {} unobserve() {} }

function serve(down: string) {
  const state = { down: true, calls: 0 };
  vi.stubGlobal("IntersectionObserver", NoObserver);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    if (path === down) {
      state.calls += 1;
      if (state.down) return new Response(JSON.stringify({ detail: ABSENT }), { status: 503, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(path.endsWith("/files") ? [] : { google: {}, applications: [], outils: [], globaux: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ detail: "absent" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }));
  return state;
}

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  unmount = () => { act(() => root.unmount()); host.remove(); };
  return host;
}

const retry = (host: HTMLElement) => [...host.querySelectorAll("button")].find((b) => b.textContent === "Réessayer");

it("12 Fichiers : lanceur absent, un message clair et Réessayer", async () => {
  const state = serve("/api/agents/z9/files");
  const host = await render(<Files agentId="z9" refreshKey={0} canDelete={false} onGiven={() => {}} />);
  expect(host.textContent).toContain(ABSENT);
  expect(host.textContent).not.toContain("Erreur interne");
  state.down = false;
  const before = state.calls;
  await act(async () => retry(host)!.click());
  await flush();
  expect(state.calls).toBe(before + 1);
  expect(host.textContent).toContain("Aucun fichier pour l'instant.");
});

it("12 Connexions : lanceur absent, un message clair et Réessayer", async () => {
  const state = serve("/api/agents/z8/connections");
  const host = await render(<Connections agentId="z8" />);
  expect(host.textContent).toContain(ABSENT);
  state.down = false;
  const before = state.calls;
  await act(async () => retry(host)!.click());
  await flush();
  expect(state.calls).toBe(before + 1);
  expect(host.textContent).not.toContain(ABSENT);
});
