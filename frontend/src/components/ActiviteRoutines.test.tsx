import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const routine = { id: "r1", nom: "Veille des concurrents", quand: "every 60m", en_pause: false, supprimee: false, passages: 24, echecs: 0, vient: true, dernier_a: 1_700_000_000, bilan: "Rien de neuf.", dernier_etat: "ok" };
const passage = (id: number) => ({ id, routine_id: "r1", nom: "Veille des concurrents", etat: "ok", passe_a: 1_700_000_000 + id, duree: 3, resume: `Passage ${id}.`, amene: false });
const lot = (de: number, n: number) => Array.from({ length: n }, (_, i) => passage(de - i));
vi.mock("@/lib/api", () => ({
  get: vi.fn(async (path: string) => {
    if (path.endsWith("/routines-activite")) return { routines: [routine], non_vues: 24 };
    if (path.includes("/routines-passages?")) return path.includes("avant=") ? { passages: lot(24, 24), plus: false } : { passages: lot(74, 50), plus: true };
    return { ...passage(74), rendu: "Rendu complet du passage 74.", erreur: "" };
  }),
  send: vi.fn(async (path: string) => (path.endsWith("/routines-vues") ? { non_vues: 0 } : { conversation_id: "c1" })),
}));
vi.mock("./ui", () => ({ Button: ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p}>{children}</button> }));
import { get, send } from "@/lib/api";
import { Bilan } from "./ActiviteRoutines";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const onBrought = vi.fn(), onBack = vi.fn();
beforeEach(async () => {
  vi.mocked(send).mockClear();
  vi.mocked(get).mockClear();
  onBrought.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Bilan agentId="rita" routine={routine} onBack={onBack} onBrought={onBrought} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const bouton = (texte: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(texte))!;

it("le bilan dit la routine, son compte et son dernier résultat, sans rien dans le fil", () => {
  expect(host.querySelector("h1")?.textContent).toBe("Veille des concurrents");
  expect(host.textContent).toContain("every 60m · 24 passages");
  expect(host.textContent).toContain("Rien de neuf.");
  expect(bouton("Activité")).toBeDefined();
});

it("les passages se lisent 50 par 50", async () => {
  expect(host.querySelector("[data-routine-bilan]")).not.toBeNull();
  expect(host.textContent).toContain("Rien de neuf.");
  expect(host.querySelectorAll("[data-passage]")).toHaveLength(50);
  await act(async () => bouton("Voir plus").click());
  expect(get).toHaveBeenLastCalledWith("/api/agents/rita/routines-passages?routine=r1&limite=50&avant=25");
  expect(host.querySelectorAll("[data-passage]")).toHaveLength(74);
  expect(bouton("Voir plus")).toBeUndefined();
});

it("un clic de plus ouvre le détail d'un passage, et « Amener dans le fil » le pose dans la conversation", async () => {
  await act(async () => (host.querySelector("[data-passage] button") as HTMLButtonElement).click());
  expect(host.textContent).toContain("Rendu complet du passage 74.");
  await act(async () => bouton("Amener dans le fil").click());
  expect(send).toHaveBeenCalledWith("/api/agents/rita/routines-passages/74/amener", {});
  expect(onBrought).toHaveBeenCalledOnce();
  expect(bouton("Déjà dans le fil")).toBeDefined();
});
