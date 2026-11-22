import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// Finitions 0.4.2 : le détail d'une routine s'ouvre dans le panneau, à pleine largeur, avec un retour (plus de petite fenêtre centrée).
const ROUTINE = { id: "r1", name: "Veille des prix", prompt: "Chaque matin, regarde le prix du vélo.", schedule_display: "every day at 8:00", enabled: true, state: "scheduled", next_run_at: null, last_status: "ok" };

vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => ({ routines: [ROUTINE], suggerees: [] })),
  send: vi.fn(async () => ({})),
  request: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {}, useVisibleSubscription: () => {} }));

import { Routines } from "./AgentPowers";

const onDetail = vi.fn();
it("un clic sur une routine ouvre son détail dans le panneau, sans fenêtre, et le retour rend la liste", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<Routines agentId="noah" onDetail={onDetail} />));
  const ligne = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Veille des prix"))!;
  expect(host.querySelector("[data-routine-detail]")).toBeNull();
  await act(async () => ligne.click());
  const detail = host.querySelector("[data-routine-detail]")!;
  expect(detail).not.toBeNull();
  expect(detail.textContent).toContain("Chaque matin, regarde le prix du vélo.");
  expect(onDetail).toHaveBeenLastCalledWith(true); // le panneau n’affiche alors que ce détail
  expect(document.querySelector('[role="dialog"]')).toBeNull(); // pas de petite fenêtre centrée
  const retour = detail.querySelector<HTMLButtonElement>('button[aria-label="Retour aux routines"]')!;
  await act(async () => retour.click());
  expect(host.querySelector("[data-routine-detail]")).toBeNull();
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Veille des prix"))).toBe(true);
});
