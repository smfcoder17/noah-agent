// Réglages > Fournisseurs en anglais, avec des réponses simulées et des clés factices : les libellés écrits par le serveur (en français) sont
// traduits, brancher avec une clé refusée dit pourquoi en anglais, brancher avec une clé acceptée, ajouter un autre service, et le débrancher.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { choisirLangue } from "@/i18n";
import { Providers } from "./Providers";

const P = { base_url: "", needs_key: true, own_url: false, ordinateur: false, pret: null };
let listing: object[];
const fetchApi = vi.fn();
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  choisirLangue("en", false);
  listing = [
    { ...P, id: "openrouter", label: "OpenRouter", connected: true, models: 300 },
    { ...P, id: "ollama-cloud", label: "Ollama Cloud", connected: false, models: 0 },
    { ...P, id: "ollama", label: "Ollama (cette machine ou une adresse)", connected: false, models: 0, needs_key: false, own_url: true },
    { ...P, id: "custom", label: "Autre service compatible OpenAI", connected: false, models: 0, needs_key: false, own_url: true },
    { ...P, id: "ordinateur:claude-code", label: "Claude Code (ton ordinateur)", connected: false, models: 0, needs_key: false, ordinateur: true, pret: false, relie: true },
    { ...P, id: "autre:lm-studio", label: "LM Studio", connected: true, models: 4, needs_key: false, own_url: true, autre: true, en_service: false },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", fetchApi);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); choisirLangue("fr", false); });

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const click = async (el: Element | null | undefined) => { await act(async () => (el as HTMLElement).click()); };
const fill = async (label: string, value: string) => {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
};
const calls = () => fetchApi.mock.calls.map(([p, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${p}`);

it("la liste est en anglais, avec le logo de chaque fournisseur ; un nom choisi par la personne reste tel quel", async () => {
  fetchApi.mockImplementation(async (path: string) => {
    if (path === "/api/fournisseurs") return Response.json(listing);
    return Response.json({ abonnements: [], en_ligne: true });
  });
  await act(async () => root.render(<Providers />));
  const text = host.textContent!;
  expect(text).toContain("Claude Code (your computer only)");
  expect(text).toContain("Other OpenAI-compatible service");
  expect(text).toContain("Ollama (this machine or an address)");
  expect(text).toContain("LM Studio");
  expect(text).not.toMatch(/ton ordinateur|Autre service|cette machine/);
  const row = button("Claude Code")!;
  expect(row.querySelector("img"), "logo Claude").toBeTruthy();
});

it("une clé refusée dit pourquoi en anglais ; une clé acceptée branche le fournisseur (clé factice)", async () => {
  let accepted = false;
  fetchApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/fournisseurs" && !init?.method) return Response.json(listing);
    if (path === "/api/fournisseurs/ollama-cloud" && init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({ api_key: "cle-factice", base_url: null });
      if (!accepted) return Response.json({ detail: "Connexion impossible. Vérifie l'adresse et la clé, puis réessaie." }, { status: 400 });
      listing = listing.map((p) => ((p as { id: string }).id === "ollama-cloud" ? { ...p, connected: true, models: 12 } : p));
      return Response.json({ connected: true, models: 12 });
    }
    return Response.json({ abonnements: [], en_ligne: true }); // l'utilisation des abonnements
  });
  await act(async () => root.render(<Providers />));
  await click(button("Ollama Cloud"));
  expect(host.querySelector("h3")?.textContent).toBe("Ollama Cloud");
  await fill("Provider API key", "cle-factice");
  await click(button("Connect"));
  expect(host.textContent).toContain("Couldn't connect. Check the address and the key, then try again.");
  expect(host.textContent).not.toMatch(/Connexion impossible/);
  accepted = true;
  await click(button("Connect"));
  expect(calls().filter((c) => c.startsWith("PUT"))).toHaveLength(2);
  await act(async () => {});
  expect(button("Ollama Cloud")!.textContent).toContain("12 models");
});

it("ajouter un autre service (nom, adresse, clé factice) puis le débrancher", async () => {
  fetchApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/fournisseurs" && !init?.method) return Response.json(listing);
    if (path === "/api/fournisseurs" && init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({ nom: "Mon LLM", base_url: "http://llm.test/v1", api_key: "cle-factice" });
      return Response.json({ connected: true, models: 2, id: "autre:mon-llm" });
    }
    if (path === "/api/fournisseurs/autre%3Alm-studio" && init?.method === "DELETE") return Response.json({ ok: true });
    return Response.json({ abonnements: [], en_ligne: true });
  });
  await act(async () => root.render(<Providers />));
  await click(button("Another provider"));
  await fill("Provider name", "Mon LLM");
  await fill("Provider address", "http://llm.test/v1");
  await fill("Provider API key", "cle-factice");
  await click(button("Connect"));
  expect(calls()).toContain("POST /api/fournisseurs");
  await click(button("LM Studio"));
  await click(button("Disconnect"));
  expect(calls()).toContain("DELETE /api/fournisseurs/autre%3Alm-studio");
});
