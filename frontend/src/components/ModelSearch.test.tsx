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

it("montre la recherche sous un filtre par fournisseur connecté, avec son compte et Tous", async () => {
  await render();
  const bar = host.querySelector('[aria-label="Fournisseurs"]')!;
  expect(bar).toBeTruthy();
  expect([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-pressed") === "true")).toEqual([true, false, false, false]);
  expect(bar.textContent).toContain("Anthropic (Claude)1");
  expect(bar.textContent).toContain("Ollama1");
  expect(bar.textContent).toContain("OpenRouter61");
  expect(bar.textContent).toContain("Tous63");
});

it("classe tout par fournisseur, rien n'enterre une clé, et le choix sert en tête de son groupe", async () => {
  await render("claude-sonnet-4-5");
  const groupes = [...host.querySelectorAll('[aria-label="Modèles"] section')];
  expect(groupes.map((g) => g.getAttribute("aria-label"))).toEqual(["Anthropic (Claude)", "OpenRouter", "Ollama"]);
  const openrouter = groupes.find((g) => g.getAttribute("aria-label") === "OpenRouter")!;
  expect(openrouter.querySelectorAll('[role="radio"]').length).toBe(61); // la clé entière est rendue, rien n'est coupé
  expect(openrouter.querySelector("h4")?.textContent).toContain("OpenRouter");
  // Le modèle en service sort premier de son groupe, avec sa rangée marquée « Utilisé ».
  const used = host.querySelector('[aria-checked="true"]');
  expect(used?.textContent).toContain("Claude Sonnet 4.5");
  expect(used?.closest("section")!.getAttribute("aria-label")).toBe("Anthropic (Claude)");
});

it("le filtre isole un fournisseur, Tous remet tout", async () => {
  await render();
  await press("Anthropic (Claude)1");
  const radios = host.querySelectorAll('[role="radio"]');
  expect(radios.length).toBe(1);
  expect(radios[0].textContent).toContain("Claude Sonnet 4.5");
  await press("Tous");
  expect(host.querySelectorAll('[role="radio"]').length).toBe(63);
});

it("une recherche ne touche que le texte, un clic choisit exactement le modèle visé", async () => {
  await render();
  const field = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const fieldSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    fieldSetter.call(field, "llama");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const picks = [...host.querySelectorAll('[role="radio"]')];
  expect(picks.length).toBe(2); // le même identifiant, un rang par fournisseur
  expect(picks.map((p) => p.closest("section")!.getAttribute("aria-label"))).toEqual(["OpenRouter", "Ollama"]);
  const target = picks.find((p): p is HTMLButtonElement => p.closest("section")!.getAttribute("aria-label") === "Ollama")!;
  await act(async () => target.click());
  expect(chain).toHaveBeenCalledOnce();
  expect(chain.mock.calls[0][0].fournisseur).toBe("ollama");
});
