import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

// Lot 2 de la 0.2.0 : les routines d'un modèle d'agent arrivent en pause, et « Activer » en démarre une.
let listing: { routines: unknown[]; suggerees: unknown[] };

vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => listing),
  send: vi.fn(async () => ({})),
  request: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {}, useVisibleSubscription: () => {} }));

import { send } from "@/lib/api";
import { Routines } from "./AgentPowers";

const MATIN = { id: 7, nom: "Point du matin", quand: "chaque jour à 8 h", horaire: "0 8 * * *", consigne: "Résume mon agenda.", en_pause: true };
const VEILLE = { id: 8, nom: "Veille des courriels importants", quand: "toutes les heures", horaire: "0 * * * *", consigne: "Signale-moi.", en_pause: true };

beforeEach(() => {
  listing = { routines: [], suggerees: [MATIN, VEILLE] };
});

const render = async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<Routines agentId="assistant-ab12" />));
  return host;
};
const rows = (host: HTMLElement) => [...host.querySelectorAll("ul[aria-label='Routines en pause'] li")];

it("montre les routines du modèle en pause, avec leur moment en clair", async () => {
  const host = await render();
  const [matin, veille] = rows(host);
  expect(matin.textContent).toContain("Point du matin");
  expect(matin.textContent).toContain("Chaque jour à");
  expect(matin.textContent).toContain("En pause");
  expect(veille.textContent).toContain("Toutes les heures");
  expect(host.textContent).not.toContain("Aucune routine");
});

it("« Activer » démarre cette routine-là, une seule, puis relit la liste", async () => {
  const host = await render();
  listing = { routines: [{ id: "job-1", name: "Point du matin", prompt: "Résume mon agenda.", schedule_display: "0 8 * * *", enabled: true, state: "scheduled", next_run_at: null, last_run_at: null, last_status: null, last_error: null }], suggerees: [VEILLE] };
  const button = [...rows(host)[0].querySelectorAll("button")].find((b) => b.textContent?.includes("Activer"))!;
  await act(async () => button.click());
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("/api/agents/assistant-ab12/routines/suggerees/7/activer", {});
  expect(rows(host).map((r) => r.textContent)).toEqual([expect.stringContaining("Veille des courriels")]);
  expect(host.textContent).toContain("Point du matin");
});
