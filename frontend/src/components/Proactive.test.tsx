import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = {
  mode: "signaler", choisi: false, minutes: 60, modifiable: true, sources: [], objectifs: 0, dernier_passage: null, erreur: null,
  passages: 0, signalements: 0, tours_du_jour: 0, tours_max: 12, en_cours: false, cout: 0, heures: { de: 8, a: 21 }, propositions_max: 3,
};
vi.mock("@/lib/api", () => ({
  get: vi.fn(async () => state),
  send: vi.fn(async (_p: string, body: object) => ({ ...state, ...body })),
}));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {} }));
vi.mock("./AgentPowers", () => ({ Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { send } from "@/lib/api";
import { SEEN } from "@/lib/seen";
import { ProactiveQuick } from "./Proactive";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  SEEN.clear();
  vi.mocked(send).mockClear();
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(<ProactiveQuick agentId="a" />));
});
afterEach(async () => { await act(async () => root.unmount()); });
const pick = async (label: string, value: string) => {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

it("montre les trois modes en mots simples et les réglages par défaut", () => {
  expect(host.textContent).toContain("Quand tu ne lui parles pas");
  const radios = [...host.querySelectorAll('[role="radio"]')];
  expect(radios.map((r) => r.textContent)).toEqual(["Rien", "Me signaler", "Agir et me dire"]);
  expect(radios[1].getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="À partir de quelle heure"]')!.value).toBe("8");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Jusqu\'à quelle heure"]')!.value).toBe("21");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Propositions par jour, au plus"]')!.value).toBe("3");
  expect(host.textContent).toContain("Il te propose des idées à partir de son rôle");
  expect(host.textContent).not.toContain("Rien à lire");
});

it("enregistre les heures et le plafond", async () => {
  await pick("À partir de quelle heure", "9");
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/proactif", { heures: { de: 9, a: 21 } }, "PUT");
  await pick("Jusqu'à quelle heure", "18");
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/proactif", { heures: { de: 9, a: 18 } }, "PUT");
  await pick("Propositions par jour, au plus", "1");
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/proactif", { propositions_max: 1 }, "PUT");
  expect(host.textContent).toContain("proposition par jour"); // singulier à 1
  expect(host.textContent).not.toContain("propositions par jour");
});

it("« Rien » coupe et cache les heures", async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
  expect(send).toHaveBeenLastCalledWith("/api/agents/a/proactif", { mode: "coupe" }, "PUT");
  expect(host.querySelector('select[aria-label="À partir de quelle heure"]')).toBeNull();
});
