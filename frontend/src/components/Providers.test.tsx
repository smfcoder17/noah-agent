// A5 (lot A, 0.3.0) : sur le web et le téléphone, « Claude Code (ton ordinateur seulement) » et « ChatGPT (ton ordinateur seulement) »
// se choisissent comme les autres ; les choisir ouvre « Continue sur ton ordinateur », avec le lien noah-agent:// qui ouvre l'app sur la
// bonne page, et le téléchargement. Dans l'app de bureau : « (ton ordinateur) », sans lien de téléchargement. « Brancher » sans clé.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Providers } from "./Providers";
import { costLabel } from "./Modes";

const list = (pret: boolean) => [
  { id: "openrouter", label: "OpenRouter", connected: true, models: 300, base_url: "", needs_key: true, own_url: false, ordinateur: false, pret: null },
  { id: "ordinateur:claude-code", label: "Claude Code (ton ordinateur)", connected: false, models: 0, base_url: "", needs_key: false, own_url: false, ordinateur: true, pret },
  { id: "ordinateur:chatgpt", label: "ChatGPT (ton ordinateur)", connected: false, models: 0, base_url: "", needs_key: false, own_url: false, ordinateur: true, pret: false },
];

let host: HTMLDivElement, root: Root;
const fetchApi = vi.fn();
let ready = false;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  ready = false;
  fetchApi.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/fournisseurs") return Response.json(list(ready));
    if (path === "/api/fournisseurs/ordinateur%3Aclaude-code" && init?.method === "PUT") {
      return ready ? Response.json({ connected: true, models: 3 })
        : Response.json({ detail: "Ouvre Noah Agent sur ton ordinateur et allume cet abonnement dans son menu Abonnements, puis réessaie." }, { status: 400 });
    }
    throw new Error(`Appel inattendu : ${path}`);
  });
  vi.stubGlobal("fetch", fetchApi);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  delete (window as { noahDesktop?: unknown }).noahDesktop;
});

const render = async () => { await act(async () => root.render(<Providers />)); };
const click = async (el: Element | null | undefined) => { await act(async () => (el as HTMLElement).click()); };
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

it("web : « (ton ordinateur seulement) », la boîte propose d'ouvrir l'app sur la bonne page, ou de la télécharger", async () => {
  await render();
  expect(host.textContent).toContain("Claude Code (ton ordinateur seulement)");
  expect(host.textContent).toContain("ChatGPT (ton ordinateur seulement)");
  await click(button("Claude Code (ton ordinateur seulement)"));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("Claude Code (ton ordinateur seulement)");
  expect(dialog.textContent).toContain("Continue sur ton ordinateur");
  const links = [...dialog.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(links).toEqual(["noah-agent://abonnements/claude", "https://github.com/smfcoder17/noah-agent/releases/latest"]);
  expect(host.querySelector('input[type="password"]')).toBeNull(); // aucune clé à coller
  await click(button("Brancher"));
  expect(host.textContent).toContain("Ouvre Noah Agent sur ton ordinateur");
  await click(button("Retour aux fournisseurs"));
  await click(button("ChatGPT (ton ordinateur seulement)"));
  expect(host.querySelector('[role="dialog"] a')?.getAttribute("href")).toBe("noah-agent://abonnements/chatgpt");
});

it("ordinateur prêt : « Brancher » sans clé, et le fournisseur passe dans les branchés", async () => {
  ready = true;
  await render();
  await click(button("Claude Code (ton ordinateur seulement)"));
  expect(host.textContent).toContain("Ton ordinateur est prêt.");
  expect(host.textContent).not.toContain("Continue sur ton ordinateur");
  await click(button("Brancher"));
  const put = fetchApi.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(put[1].body)).toEqual({ api_key: null, base_url: null });
});

it("app de bureau : « (ton ordinateur) », le lien ramène l'app sur l'abonnement, sans téléchargement", async () => {
  (window as { noahDesktop?: unknown }).noahDesktop = { forgetServer: async () => {}, pickFolder: async () => null, openPath: async () => {} };
  await render();
  expect(host.textContent).toContain("Claude Code (ton ordinateur)");
  expect(host.textContent).not.toContain("ton ordinateur seulement");
  await click(button("Claude Code (ton ordinateur)"));
  expect([...host.querySelectorAll('[role="dialog"] a')].map((a) => a.getAttribute("href"))).toEqual(["noah-agent://abonnements/claude"]);
});

it("A7 : un modèle d'abonnement affiche « Compris dans l'abonnement », jamais « Prix inconnu »", () => {
  expect(costLabel({ free: false, price_in: null, price_out: null, prix: "compris dans l'abonnement", abonnement: true })).toBe("Compris dans l'abonnement");
  expect(costLabel({ free: false, price_in: null, price_out: null })).toBe("Prix inconnu");
});
