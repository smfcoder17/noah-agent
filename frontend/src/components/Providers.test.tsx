// A5 (lot A, 0.3.0) puis lot 044 : sur le web et le téléphone, « Claude Code (ton ordinateur seulement) » et « ChatGPT (ton ordinateur
// seulement) » se choisissent comme les autres, et un texte simple dit d'ouvrir l'app de bureau (téléchargement tant qu'aucun ordinateur
// n'est relié). Dans l'app de bureau : « (ton ordinateur) », un seul « Brancher » qui enchaîne tout sur place par le pont, jamais de renvoi
// au menu ni à « ouvre Noah Agent ».
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
let ready = false, relie = false;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  ready = false;
  relie = false;
  fetchApi.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/fournisseurs") return Response.json(list(ready).map((p) => (p.ordinateur ? { ...p, relie } : p)));
    if (path === "/api/fournisseurs/ordinateur%3Aclaude-code" && init?.method === "PUT") {
      return ready ? Response.json({ connected: true, models: 3 })
        : Response.json({ detail: "Cet abonnement n'est pas encore prêt : branche-le depuis l'application de bureau Noah Agent (Réglages > Fournisseurs), puis réessaie." }, { status: 400 });
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

it("web : « (ton ordinateur seulement) », un texte simple dit d'ouvrir l'app de bureau, avec le téléchargement tant qu'aucun ordinateur n'est relié", async () => {
  await render();
  expect(host.textContent).toContain("Claude Code (ton ordinateur seulement)");
  expect(host.textContent).toContain("ChatGPT (ton ordinateur seulement)");
  await click(button("Claude Code (ton ordinateur seulement)"));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-label")).toBe("Claude Code (ton ordinateur seulement)");
  expect(dialog.textContent).toContain("Ouvre l'application de bureau Noah Agent sur ton ordinateur");
  expect(dialog.textContent).not.toContain("Continue sur ton ordinateur");
  expect([...dialog.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://github.com/smfcoder17/noah-agent/releases/latest"]);
  expect(host.querySelector('input[type="password"]')).toBeNull(); // aucune clé à coller
  expect(button("Brancher")).toBeUndefined(); // rien à brancher d'ici : l'ordinateur n'est pas prêt
  expect(fetchApi.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it("web : un ordinateur déjà relié, plus de lien de téléchargement", async () => {
  relie = true;
  await render();
  await click(button("Claude Code (ton ordinateur seulement)"));
  expect(host.querySelector('[role="dialog"]')!.textContent).toContain("Ouvre l'application de bureau");
  expect(host.querySelectorAll('[role="dialog"] a')).toHaveLength(0);
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

/** Une app de bureau 0.4.3 : le pont enchaîne les étapes, la page les montre, puis branche côté serveur. */
const bridge = (steps: Array<Record<string, unknown>>, final: Record<string, unknown>, delay = 1600) => {
  let i = 0;
  const abonnementBrancher = vi.fn(async (_page: string) => { await new Promise((r) => setTimeout(r, delay)); ready = true; return final; });
  const abonnementEtat = vi.fn(async (_page: string) => ({ etat: steps[Math.min(i++, steps.length - 1)], installe: true, connecte: true, cerveau: false, occupe: true }));
  (window as { noahDesktop?: unknown }).noahDesktop = { forgetServer: async () => {}, pickFolder: async () => null, openPath: async () => {}, abonnementBrancher, abonnementEtat };
  return { abonnementBrancher, abonnementEtat };
};

it("app de bureau : jamais « ouvre Noah Agent », un seul « Brancher » qui enchaîne sur place puis branche côté serveur", async () => {
  const { abonnementBrancher } = bridge([{ etape: "installation", detail: "telechargement" }, { etape: "connexion" }, { etape: "accord" }], { etape: "pret" });
  await render();
  expect(host.textContent).toContain("Claude Code (ton ordinateur)");
  expect(host.textContent).not.toContain("ton ordinateur seulement");
  await click(button("Claude Code (ton ordinateur)"));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).not.toMatch(/Ouvre l'application|Open the Noah|noah-agent:\/\/|Ouvrir Noah Agent|menu Abonnements|Continue sur ton ordinateur/);
  expect(dialog.querySelectorAll("a")).toHaveLength(0);
  expect(dialog.textContent).toContain("Un seul bouton");
  await click(button("Brancher"));
  expect(abonnementBrancher).toHaveBeenCalledWith("claude");
  expect(host.textContent).toContain("Je regarde ce qui est installé");
  await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
  expect(host.textContent).toContain("Installation : téléchargement…"); // l'état de l'ordinateur est montré
  await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
  const put = fetchApi.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(JSON.parse(put[1].body)).toEqual({ api_key: null, base_url: null });
  expect(host.textContent).not.toMatch(/Ouvre Noah Agent|Open Noah Agent/);
}, 15000);

it("app de bureau : un refus (accord, installation) se lit clairement, sans renvoi au menu", async () => {
  bridge([{ etape: "accord" }], { etape: "erreur", erreur: "refus_accord" }, 10);
  await render();
  await click(button("Claude Code (ton ordinateur)"));
  await click(button("Brancher"));
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  expect(host.textContent).toContain("Accord refusé");
  expect(host.textContent).not.toMatch(/Ouvre Noah Agent|menu Abonnements|noah-agent:\/\//);
  expect(fetchApi.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it("app de bureau d'avant le pont (0.4.2) : on dit de la mettre à jour, jamais d'ouvrir l'app où l'on est", async () => {
  (window as { noahDesktop?: unknown }).noahDesktop = { forgetServer: async () => {}, pickFolder: async () => null, openPath: async () => {} };
  await render();
  await click(button("Claude Code (ton ordinateur)"));
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("trop ancienne");
  expect(dialog.textContent).not.toMatch(/Ouvre l'application|Ouvrir Noah Agent|Continue sur/);
  expect(dialog.querySelectorAll("a")).toHaveLength(0);
  expect(button("Brancher")).toBeUndefined();
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
