import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../__fixtures__/cerveau/reponses.json?raw";
import type { OwnBrain } from "@/lib/modes";
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

const OWN: OwnBrain[] = [
  { id: "noah", nom: "Noah", modele: "openai/gpt-6.1-terra", mode: null, fournisseur: "openrouter", fournisseur_nom: "OpenRouter" },
  { id: "bmd", nom: "BMD", modele: "openai/gpt-6.1-terra", mode: null, fournisseur: "openrouter", fournisseur_nom: "OpenRouter" },
];

it("sans agent qui garde son propre modèle, aucune ligne en plus", async () => {
  await render();
  expect(host.querySelector('[aria-label="Agents avec leur propre modèle"]')).toBeNull();
});

it("Auto choisi : la réponse dit que Noah et BMD gardent leur modèle OpenRouter, et un bouton les remet sur le cerveau de tous", async () => {
  const realFetch = fetchApi.getMockImplementation()!;
  let own = OWN.map((a) => ({ ...a }));
  const reset: string[] = [];
  fetchApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const m = /^\/api\/agents\/(\w+)\/model$/.exec(path);
    if (m && init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({ model: null }); // même effet que « Comme mes autres agents »
      reset.push(m[1]);
      own = own.filter((a) => a.id !== m[1]);
      return Response.json({ model: null, mode: null, raisonnement: null });
    }
    if (path === "/api/modes/cerveau") {
      const r = await realFetch(path, init);
      return Response.json({ ...(await r.json()), agents_propres: init?.method === "PUT" ? own : [] });
    }
    return realFetch(path, init);
  });
  await render();
  expect(host.querySelector('[aria-label="Agents avec leur propre modèle"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
  const line = host.querySelector('[aria-label="Agents avec leur propre modèle"]')!;
  expect(line.textContent).toMatch(/^Noah et BMD gardent leur propre modèle \(OpenRouter · .*6\.1.*Terra.*\)\. Ce cerveau ne s'applique pas à eux\./i);
  fetchApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/modes/cerveau" && !init?.method) return Response.json({ ...modes, agents_propres: own });
    const m = /^\/api\/agents\/(\w+)\/model$/.exec(path);
    if (m && init?.method === "PUT") { reset.push(m[1]); own = own.filter((a) => a.id !== m[1]); return Response.json({ model: null }); }
    return realFetch(path, init);
  });
  await act(async () => button("Leur appliquer ce cerveau").click());
  expect(reset).toEqual(["noah", "bmd"]);
  expect(host.querySelector('[aria-label="Agents avec leur propre modèle"]')).toBeNull();
});

it("chaque agent avec le sien quand leurs modèles diffèrent, au singulier pour un seul", async () => {
  const realFetch = fetchApi.getMockImplementation()!;
  let own: OwnBrain[] = [OWN[0], { id: "bmd", nom: "BMD", modele: null, mode: "fast", fournisseur: null, fournisseur_nom: null }];
  fetchApi.mockImplementation(async (path: string, init?: RequestInit) =>
    path === "/api/modes/cerveau" && !init?.method ? Response.json({ ...modes, agents_propres: own }) : realFetch(path, init));
  await render();
  expect(host.querySelector('[aria-label="Agents avec leur propre modèle"]')!.textContent).toMatch(/^Noah \(OpenRouter · .+\) et BMD \(mode Rapide\) gardent leur propre modèle\./);
  await act(async () => root.unmount());
  root = createRoot(host);
  own = [OWN[1]];
  await render();
  expect(host.querySelector('[aria-label="Agents avec leur propre modèle"]')!.textContent).toMatch(/^BMD garde son propre modèle \(OpenRouter · .+\)\. Ce cerveau ne s'applique pas à lui\./);
  expect(button("Lui appliquer ce cerveau")).toBeTruthy();
});

it("branche cet écran dans Réglages > Modèles et budget > Cerveau", async () => {
  await act(async () => root.render(<SettingsDialog open tab="brain" owner onTab={() => {}} onOpenChange={() => {}} onBrainSaved={() => {}} />));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('[aria-label="Cerveau par défaut"]')).not.toBeNull();
  expect(dialog.querySelectorAll('[aria-label="Niveaux Auto"] li')).toHaveLength(3);
  expect(dialog.textContent).not.toContain("Comme mes autres agents");
});
