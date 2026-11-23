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

// X12 : autant de fournisseurs « autres » que voulu, chacun avec son nom, son adresse et sa clé ; on les débranche un à un.
it("X12 : « Un autre fournisseur » demande nom, adresse et clé, les envoie ensemble, et les autres branchés se listent à part", async () => {
  const others = [
    { id: "autre:vllm", label: "vLLM", connected: true, models: 4, base_url: "http://vllm.local:8000/v1", needs_key: false, own_url: true, autre: true, en_service: false },
    { id: "autre:ollama", label: "Ollama maison", connected: true, models: 2, base_url: "http://nas:11434/v1", needs_key: false, own_url: true, autre: true, en_service: true },
  ];
  fetchApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/fournisseurs" && !init?.method) return Response.json([...list(false), ...others]);
    if (path === "/api/fournisseurs" && init?.method === "POST") return Response.json({ id: "autre:lm", connected: true, models: 1 });
    if (path === "/api/fournisseurs/autre%3Avllm" && init?.method === "DELETE") return Response.json({ ok: true });
    throw new Error(`Appel inattendu : ${path}`);
  });
  await render();
  expect(host.textContent).toContain("vLLM");
  expect(host.textContent).toContain("Ollama maison");
  await click(button("Un autre fournisseur"));
  const field = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const type = async (el: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type(field("Nom du fournisseur"), "LM Studio");
  await type(field("Adresse du fournisseur"), "http://pc:1234/v1");
  await type(field("Clé API du fournisseur"), "cle-lm");
  await click(button("Brancher"));
  const post = fetchApi.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(post[1].body)).toEqual({ nom: "LM Studio", base_url: "http://pc:1234/v1", api_key: "cle-lm" });
  // Un fournisseur qui n'est pas le cerveau se débranche ; celui qui l'est l'explique au lieu de proposer le bouton.
  await click(button("vLLM"));
  await click(button("Débrancher"));
  expect(fetchApi.mock.calls.some(([p, init]) => p === "/api/fournisseurs/autre%3Avllm" && init?.method === "DELETE")).toBe(true);
  await click(button("Ollama maison"));
  expect(button("Débrancher")).toBeUndefined();
  expect(host.textContent).toContain("Ce fournisseur est ton cerveau");
});
