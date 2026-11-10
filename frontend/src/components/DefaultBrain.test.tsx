import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../__fixtures__/cerveau/reponses.json?raw";
import { DefaultBrain } from "./DefaultBrain";
import { SettingsDialog } from "./Settings";

// Copie réelle fournie par le serveur OpenRouter (295 modèles), aucun catalogue inventé.
const responses = JSON.parse(recorded) as Record<string, unknown>;
let host: HTMLDivElement, root: Root;
let modes: Record<string, unknown>;
const fetchApi = vi.fn();
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  modes = structuredClone(responses["/api/modes/cerveau"]) as Record<string, unknown>;
  fetchApi.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/modes/cerveau" && init?.method === "PUT") {
      modes = { ...modes, ...JSON.parse(String(init.body)) };
      return Response.json(modes);
    }
    if (path === "/api/budget" && init?.method === "POST") return Response.json({ ok: true });
    if (path === "/api/modes/cerveau") return Response.json(modes);
    if (path in responses && !(responses[path] as { erreur?: string }).erreur) return Response.json(responses[path]);
    throw new Error(`Appel inattendu : ${init?.method || "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchApi);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = async (done = vi.fn()) => { await act(async () => root.render(<DefaultBrain onDone={done} onCancel={() => {}} />)); };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

it("rend le cerveau global réel : Auto, ses trois niveaux avec logos et modèles, puis le modèle précis et le budget", async () => {
  await render();
  const choices = host.querySelector('[aria-label="Cerveau par défaut"]')!;
  expect([...choices.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
    expect.stringContaining("Auto"), expect.stringContaining("Un modèle précis"),
  ]);
  const rows = [...choices.querySelectorAll("li")];
  expect(rows).toHaveLength(3);
  for (const [i, label, model, logo] of [[0, "Simple", "Muse Ember", "Meta"], [1, "Moyen", "GLM 5.3 FlashX Legal", "Z.ai"], [2, "Complexe", "Claude Fable 5.1", "Anthropic"]] as const) {
    expect(rows[i].textContent).toContain(label);
    expect(rows[i].textContent).toContain(model);
    expect(rows[i].querySelector(`[title="${logo}"] img`)).not.toBeNull();
    expect(rows[i].querySelector("button")?.textContent).toBe("Changer");
  }
  expect(host.textContent).toContain("Pour tous les agents");
  expect(host.textContent).not.toContain("Comme mes autres agents");
  expect(host.querySelector("fieldset legend")?.textContent).toBe("Budget");
  expect(button("Enregistrer le budget").disabled).toBe(false);
  expect(fetchApi.mock.calls.some(([path]) => path === "/api/models")).toBe(false);
});

it("affiche Auto même pendant l'attente de la consommation, sans autoriser l'écrasement d'un budget inconnu", async () => {
  const realFetch = fetchApi.getMockImplementation()!;
  let release!: (r: Response) => void;
  fetchApi.mockImplementation((path: string, init?: RequestInit) => path === "/api/usage" ? new Promise<Response>((resolve) => { release = resolve; }) : realFetch(path, init));
  await render();
  expect(host.querySelectorAll('[aria-label="Niveaux Auto"] li')).toHaveLength(3);
  expect(button("Enregistrer le budget").disabled).toBe(true);
  await act(async () => release(Response.json(responses["/api/usage"])));
  expect(button("Enregistrer le budget").disabled).toBe(false);
});

it("active Auto par la route globale et enregistre le budget sans renvoyer un modèle précis", async () => {
  const done = vi.fn();
  await render(done);
  const auto = host.querySelector<HTMLButtonElement>('[role="radio"]')!;
  expect(auto.getAttribute("aria-checked")).toBe("false"); // réponse réelle : actif=null
  await act(async () => auto.click());
  expect(auto.getAttribute("aria-checked")).toBe("true");
  expect(fetchApi).toHaveBeenCalledWith("/api/modes/cerveau", expect.objectContaining({ method: "PUT", body: JSON.stringify({ actif: "auto" }) }));
  await act(async () => button("Enregistrer le budget").click());
  expect(done).toHaveBeenCalledOnce();
  expect(fetchApi.mock.calls.some(([path, init]) => path === "/api/model" && init?.method === "POST")).toBe(false);
});

it("montre une erreur du cerveau et permet de recharger ses choix", async () => {
  const realFetch = fetchApi.getMockImplementation()!;
  fetchApi.mockImplementation((path: string, init?: RequestInit) => path === "/api/modes/cerveau" ? Promise.reject(new Error("Serveur indisponible")) : realFetch(path, init));
  await render();
  expect(host.textContent).toContain("Serveur indisponible");
  fetchApi.mockImplementation(realFetch);
  await act(async () => button("Réessayer le cerveau").click());
  expect(host.querySelectorAll('[aria-label="Niveaux Auto"] li')).toHaveLength(3);
});

it("branche cet écran dans Réglages > Modèles et budget > Cerveau", async () => {
  await act(async () => root.render(<SettingsDialog open tab="brain" owner onTab={() => {}} onOpenChange={() => {}} onBrainSaved={() => {}} />));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('[aria-label="Cerveau par défaut"]')).not.toBeNull();
  expect(dialog.querySelectorAll('[aria-label="Niveaux Auto"] li')).toHaveLength(3);
  expect(dialog.textContent).not.toContain("Comme mes autres agents");
});
