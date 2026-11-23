import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelSearch } from "./Modes";
import type { ListedModel } from "@/lib/modes";

// Deux clés branchées : OpenRouter en propose beaucoup, Anthropic quelques-unes ; le même identifiant chez les deux reste distinct.
const rows: ListedModel[] = [
  ...Array.from({ length: 60 }, (_, i) => ({
    id: `lab/modele-${i}`, name: `Lab: Modèle ${i}`, lab: "lab", created: 1700000000 + i, context: 128000,
    price_in: 0.1, price_out: 0.5, vision: false, free: false, fournisseur: "openrouter",
  })),
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", lab: "anthropic", created: 1500000000, context: 200000,
    price_in: 3, price_out: 15, vision: true, free: false, fournisseur: "anthropic" },
  { id: "meta/llama-4", name: "Meta: Llama 4", lab: "meta", created: 1500000000, context: 128000,
    price_in: 0.01, price_out: 0.04, vision: false, free: true, fournisseur: "openrouter" },
  { id: "meta/llama-4", name: "Meta: Llama 4", lab: "meta", created: 1500000000, context: 128000,
    price_in: 0, price_out: 0, vision: false, free: true, fournisseur: "ollama" },
];
const fournisseurs = [{ id: "anthropic", label: "Anthropic (Claude)" }, { id: "ollama", label: "Ollama" }, { id: "openrouter", label: "OpenRouter" }];

let host: HTMLDivElement, root: Root;
const chain = vi.fn();
const fetchApi = vi.fn();
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fetchApi.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/modes/cerveau/modeles") return Response.json({ modeles: rows, fournisseurs });
    throw new Error(`Appel inattendu : ${path}`);
  });
  vi.stubGlobal("fetch", fetchApi);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const render = async (selected: string | null = null) => {
  await act(async () => root.render(<ModelSearch level="cerveau" selected={selected} onPick={chain} />));
};

const press = async (label: string) => {
  const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent?.includes(label));
  expect(b, label).toBeTruthy();
  await act(async () => b!.click());
};
const type = async (text: string) => {
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const heads = () => [...host.querySelectorAll('[role="presentation"]')].map((h) => h.textContent);
const box = () => host.querySelector<HTMLElement>('[aria-label="Modèles"]')!;
const checkbox = (label: string) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${label}"]`)!;

it("la recherche est en haut, les fournisseurs se cochent (plusieurs) avec leur compte, Tous les remet", async () => {
  await render();
  const first = host.querySelector("input, button")!;
  expect(first.getAttribute("type")).toBe("search"); // la recherche d'abord
  const chooser = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tous les fournisseurs"))!;
  expect(chooser.textContent).toContain("63");
  expect(chooser.getAttribute("aria-expanded")).toBe("false");
  await act(async () => chooser.click());
  const bar = host.querySelector('[aria-label="Fournisseurs"]')!;
  expect([...bar.querySelectorAll('input[type="checkbox"]')].map((c) => c.getAttribute("aria-label"))).toEqual(["Anthropic (Claude)", "Ollama", "OpenRouter"]);
  expect(bar.textContent).toContain("OpenRouter61");
  await act(async () => checkbox("Anthropic (Claude)").click());
  await act(async () => checkbox("Ollama").click());
  expect(chooser.textContent).toContain("2 fournisseurs");
  expect(radios().map((r) => r.textContent)).toEqual([expect.stringContaining("Claude Sonnet 4.5"), expect.stringContaining("Llama 4")]); // deux fournisseurs, deux modèles
  await act(async () => checkbox("Ollama").click());
  expect(chooser.textContent).toContain("Anthropic (Claude)"); // un seul coché : son nom
  expect(radios()).toHaveLength(1);
  await press("Tous les fournisseurs");
  expect(chooser.textContent).toContain("Tous les fournisseurs");
  expect(radios().length).toBeGreaterThan(4); // la fenêtre, pas les 63
});

it("groupe par entreprise, le modèle en service en tête de la sienne, et ne rend que les rangées visibles", async () => {
  await render("claude-sonnet-4-5");
  expect(heads()).toEqual([expect.stringContaining("Anthropic"), expect.stringContaining("Lab")]); // la fenêtre ne montre pas encore Meta
  const used = host.querySelector('[aria-checked="true"]');
  expect(used?.textContent).toContain("Claude Sonnet 4.5");
  expect(radios()[0]).toBe(used); // premier de la liste
  expect(radios().length).toBeLessThan(25); // 63 modèles, quelques rangées seulement dans le DOM
  // Défiler fait apparaître la suite, groupes d'entreprise compris.
  await act(async () => { box().scrollTop = 60 * 56; box().dispatchEvent(new Event("scroll")); });
  expect(heads()).toContain("Meta2");
  expect(radios().some((r) => r.textContent?.includes("Llama 4"))).toBe(true);
  // Le même modèle chez deux fournisseurs reste deux rangées, chacune dit son fournisseur.
  expect(radios().filter((r) => r.textContent?.includes("Llama 4")).map((r) => r.textContent)).toEqual([expect.stringContaining("OpenRouter"), expect.stringContaining("Ollama")]);
});

it("une recherche ne touche que le texte, un clic choisit exactement le modèle visé", async () => {
  await render();
  await type("llama");
  const picks = radios();
  expect(picks.length).toBe(2); // le même identifiant, un rang par fournisseur
  const target = picks.find((p) => p.textContent?.includes("Ollama"))!;
  await act(async () => target.click());
  expect(chain).toHaveBeenCalledOnce();
  expect(chain.mock.calls[0][0].fournisseur).toBe("ollama");
});

it("la recherche remet la liste en haut, et rien ne correspond : un mot clair", async () => {
  await render();
  await act(async () => { box().scrollTop = 600; box().dispatchEvent(new Event("scroll")); });
  await type("modele-5");
  expect(box().scrollTop).toBe(0);
  expect(radios().length).toBeGreaterThan(0);
  await type("introuvable");
  expect(host.textContent).toContain("Aucun modèle ne correspond.");
  expect(radios()).toHaveLength(0);
});


it("une étiquette Ollama garde son nom : « glm-5.3:cloud » ne s'affiche pas « cloud »", async () => {
  const { shortName } = await import("./Modes");
  expect(shortName("glm-5.3:cloud")).not.toBe("cloud");
  expect(shortName("glm-5.3:cloud").toLowerCase()).toContain("glm");
  expect(shortName("Anthropic: Claude Sonnet 4.5")).toBe("Claude Sonnet 4.5");
});
